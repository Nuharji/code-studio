//! Run configurations found in a project: what its build files offer (Cargo, npm scripts, Go, Python, Make, .NET).
//! The UI adds the user's own configurations and "run current file"; runs go to a terminal (terminal.rs, `run`).

use serde::Serialize;
use std::{fs, path::Path};

#[derive(Serialize, Debug, PartialEq)]
pub struct RunConfig {
    /// shown in the list, e.g. "cargo run" or "npm run dev"
    pub name: String,
    pub command: String,
    /// folder relative to the project root ("" = the root)
    pub dir: String,
}

fn cfg(name: impl Into<String>, command: impl Into<String>, dir: &str) -> RunConfig {
    RunConfig { name: name.into(), command: command.into(), dir: dir.into() }
}

/// Configurations of one folder (`dir` relative to the root, for the names).
fn in_folder(root: &Path, dir: &str, out: &mut Vec<RunConfig>) {
    let d = root.join(dir);
    let at = |name: &str| if dir.is_empty() { name.to_string() } else { format!("{name} ({dir})") };
    let has = |f: &str| d.join(f).is_file();

    if has("Cargo.toml") {
        for (n, c) in [("cargo run", "cargo run"), ("cargo test", "cargo test"), ("cargo build --release", "cargo build --release")] {
            out.push(cfg(at(n), c, dir));
        }
    }
    if let Ok(text) = fs::read_to_string(d.join("package.json")) {
        let pm = if has("pnpm-lock.yaml") { "pnpm" } else if has("yarn.lock") { "yarn" } else if has("bun.lockb") || has("bun.lock") { "bun" } else { "npm" };
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) {
                for name in scripts.keys().take(30) {
                    let c = if pm == "npm" { format!("npm run {name}") } else { format!("{pm} {name}") };
                    out.push(cfg(at(&c), c, dir));
                }
            }
        }
    }
    if has("go.mod") {
        out.push(cfg(at("go run ."), "go run .", dir));
        out.push(cfg(at("go test ./..."), "go test ./...", dir));
    }
    if has("manage.py") {
        out.push(cfg(at("python manage.py runserver"), "python manage.py runserver", dir));
    }
    for main in ["main.py", "app.py"] {
        if has(main) { out.push(cfg(at(&format!("python {main}")), format!("python {main}"), dir)); }
    }
    if has("pyproject.toml") && (d.join("tests").is_dir() || has("pytest.ini")) {
        out.push(cfg(at("pytest"), "python -m pytest", dir));
    }
    if let Ok(text) = fs::read_to_string(d.join("Makefile")) {
        // Plain targets ("build:"), not variables, patterns or special targets.
        let targets: Vec<&str> = text.lines()
            .filter_map(|l| l.split_once(':').map(|(t, rest)| (t, rest)))
            .filter(|(t, rest)| !rest.starts_with('=') && !t.is_empty() && !t.starts_with(['.', '\t', ' ', '#']) && t.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_'))
            .map(|(t, _)| t).take(12).collect();
        for t in targets { out.push(cfg(at(&format!("make {t}")), format!("make {t}"), dir)); }
    }
    let dotnet = fs::read_dir(&d).ok().map(|r| r.flatten().any(|e| e.path().extension().is_some_and(|x| x == "csproj" || x == "sln"))).unwrap_or(false);
    if dotnet {
        out.push(cfg(at("dotnet run"), "dotnet run", dir));
        out.push(cfg(at("dotnet test"), "dotnet test", dir));
    }
}

/// The project's configurations: the root and its direct subfolders (e.g. "src-tauri"), not dependencies or builds.
pub fn detect(root: &Path) -> Vec<RunConfig> {
    let mut out = Vec::new();
    in_folder(root, "", &mut out);
    if let Ok(entries) = fs::read_dir(root) {
        let mut dirs: Vec<String> = entries.flatten()
            .filter(|e| e.path().is_dir())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| !n.starts_with('.') && !["node_modules", "target", "dist", "build", "vendor", "out", "bin", "obj"].contains(&n.as_str()))
            .collect();
        dirs.sort();
        for d in dirs { in_folder(root, &d, &mut out); }
    }
    out
}

#[tauri::command]
pub async fn run_configs(root: String) -> Vec<RunConfig> {
    detect(Path::new(&root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_configurations() {
        let root = std::env::temp_dir().join(format!("runcfg-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src-tauri")).unwrap();
        fs::create_dir_all(root.join("node_modules/x")).unwrap();
        fs::write(root.join("package.json"), r#"{"scripts": {"dev": "vite", "build": "vite build"}}"#).unwrap();
        fs::write(root.join("pnpm-lock.yaml"), "").unwrap();
        fs::write(root.join("src-tauri/Cargo.toml"), "[package]").unwrap();
        fs::write(root.join("node_modules/x/Cargo.toml"), "[package]").unwrap();
        fs::write(root.join("Makefile"), "CC = gcc\nall: build\nbuild:\n\tcc x.c\n.PHONY: all\n%.o: %.c\n").unwrap();
        let names: Vec<String> = detect(&root).into_iter().map(|c| format!("{} [{}] in '{}'", c.name, c.command, c.dir)).collect();
        assert_eq!(names, [
            "pnpm build [pnpm build] in ''", "pnpm dev [pnpm dev] in ''",
            "make all [make all] in ''", "make build [make build] in ''",
            "cargo run (src-tauri) [cargo run] in 'src-tauri'", "cargo test (src-tauri) [cargo test] in 'src-tauri'",
            "cargo build --release (src-tauri) [cargo build --release] in 'src-tauri'",
        ]);
        let _ = fs::remove_dir_all(&root);
    }
}
