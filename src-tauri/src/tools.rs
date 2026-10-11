//! Formatters and linters (P-005): the project's own tools, found like the language servers (lsp.rs).
//! - Formatting: rustfmt, gofmt, Ruff or Black, Prettier (from the project, else installed globally), clang-format —
//!   fed the text through stdin, run in the file's folder so the project's config files apply.
//! - Linting: ESLint (the project's) and Ruff — problems for the Problems panel, and "fix all".

use crate::lsp::{command_for, find_exe};
use serde::Serialize;
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
};

/// A project-local tool (node_modules/.bin) or one on the PATH.
fn tool(name: &str, file: &Path) -> Option<PathBuf> {
    for dir in file.ancestors().skip(1) {
        let bin = dir.join("node_modules").join(".bin");
        for ext in if cfg!(windows) { &[".cmd", ".exe", ""][..] } else { &[""][..] } {
            let p = bin.join(format!("{name}{ext}"));
            if p.is_file() { return Some(p); }
        }
        if dir.join(".git").exists() { break; }
    }
    find_exe(name)
}

/// Runs a tool with `input` on stdin; its stdout, or the error it printed.
fn run(exe: &Path, args: &[String], cwd: &Path, input: Option<&str>) -> Result<(bool, String, String), String> {
    let mut c = command_for(exe, args);
    c.current_dir(cwd).stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        let text = text.to_string();
        // Written from a thread, so a large file can't block against a full output pipe.
        std::thread::spawn(move || { let _ = stdin.write_all(text.as_bytes()); });
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned()))
}

/// The Rust edition from the nearest Cargo.toml (rustfmt reading stdin can't see it).
fn rust_edition(file: &Path) -> String {
    file.ancestors().skip(1).find_map(|d| std::fs::read_to_string(d.join("Cargo.toml")).ok())
        .and_then(|t| t.lines().find_map(|l| l.trim().strip_prefix("edition").map(|r| r.trim_start_matches([' ', '=']).trim().trim_matches('"').to_string())))
        .filter(|e| !e.is_empty()).unwrap_or_else(|| "2021".into())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Formatted {
    /// formatted text
    Ok { text: String, tool: String },
    /// no formatter for this language here — the editor's own (language server / built-in) is used
    None,
    /// the formatter for this language isn't installed
    Missing { tool: String, install: String },
    /// the tool refused (usually a syntax error)
    Failed { tool: String, error: String },
}

/// Which formatter a language uses: (tool, args, install hint). Prettier only when the project or PATH has it.
fn formatter(lang: &str, file: &Path) -> Option<(&'static str, Vec<String>, &'static str)> {
    let p = file.to_string_lossy().to_string();
    Some(match lang {
        "rust" => ("rustfmt", vec!["--emit".into(), "stdout".into(), "--edition".into(), rust_edition(file)], "rustup component add rustfmt"),
        "go" => ("gofmt", vec![], "install Go from go.dev"),
        "python" => {
            if find_exe("ruff").is_some() { ("ruff", vec!["format".into(), "--stdin-filename".into(), p, "-".into()], "pip install ruff") }
            else { ("black", vec!["-q".into(), "--stdin-filename".into(), p, "-".into()], "pip install ruff  (or: pip install black)") }
        }
        "c" | "cpp" | "objective-c" | "csharp" | "java" => ("clang-format", vec![format!("--assume-filename={p}")], "winget install LLVM.LLVM  (or: brew install clang-format)"),
        "javascript" | "typescript" | "css" | "scss" | "less" | "json" | "html" | "markdown" | "yaml" => {
            tool("prettier", file)?;
            ("prettier", vec!["--stdin-filepath".into(), p], "npm install -D prettier")
        }
        _ => return None,
    })
}

pub fn format(path: &Path, text: &str, lang: &str) -> Formatted {
    let Some((name, args, install)) = formatter(lang, path) else { return Formatted::None };
    let Some(exe) = tool(name, path) else { return Formatted::Missing { tool: name.into(), install: install.into() } };
    let cwd = path.parent().unwrap_or(Path::new("."));
    match run(&exe, &args, cwd, Some(text)) {
        Ok((true, out, _)) if !out.is_empty() || text.is_empty() => Formatted::Ok { text: out, tool: name.into() },
        Ok((_, _, err)) => Formatted::Failed { tool: name.into(), error: err.lines().take(6).collect::<Vec<_>>().join("\n") },
        Err(e) => Formatted::Failed { tool: name.into(), error: e },
    }
}

#[tauri::command]
pub async fn format_text(path: String, text: String, lang: String) -> Formatted {
    format(Path::new(&path), &text, &lang)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Lint {
    pub line: usize,
    pub col: usize,
    pub end_line: usize,
    pub end_col: usize,
    /// 1 error, 2 warning
    pub severity: u8,
    pub message: String,
    pub source: &'static str,
    pub code: String,
    pub fixable: bool,
}

/// ESLint's JSON report: [{messages: [{line, column, endLine, endColumn, severity (2 = error), message, ruleId, fix}]}]
pub fn parse_eslint(json: &str) -> Vec<Lint> {
    let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    let n = |m: &serde_json::Value, k: &str| m.get(k).and_then(|x| x.as_u64()).map(|x| x as usize);
    v.as_array().into_iter().flatten().flat_map(|f| f["messages"].as_array().cloned().unwrap_or_default()).map(|m| {
        let (line, col) = (n(&m, "line").unwrap_or(1), n(&m, "column").unwrap_or(1));
        Lint { line, col, end_line: n(&m, "endLine").unwrap_or(line), end_col: n(&m, "endColumn").unwrap_or(col + 1),
            severity: if m["severity"].as_u64() == Some(2) { 1 } else { 2 }, message: m["message"].as_str().unwrap_or_default().into(),
            source: "eslint", code: m["ruleId"].as_str().unwrap_or_default().into(), fixable: m.get("fix").is_some_and(|f| !f.is_null()) }
    }).collect()
}

/// Ruff's JSON: [{code, message, location: {row, column}, end_location: {row, column}, fix}]
pub fn parse_ruff(json: &str) -> Vec<Lint> {
    let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    let n = |m: &serde_json::Value, a: &str, b: &str| m[a][b].as_u64().unwrap_or(1) as usize;
    v.as_array().into_iter().flatten().map(|m| Lint {
        line: n(m, "location", "row"), col: n(m, "location", "column"), end_line: n(m, "end_location", "row"), end_col: n(m, "end_location", "column"),
        severity: if m["code"].as_str().is_some_and(|c| c.starts_with('E') && !c.starts_with("E5")) || m["code"].is_null() { 1 } else { 2 },
        message: m["message"].as_str().unwrap_or_default().into(), source: "ruff", code: m["code"].as_str().unwrap_or_default().into(),
        fixable: m.get("fix").is_some_and(|f| !f.is_null()),
    }).collect()
}

/// Lints a saved file: ESLint (only the project's own, it needs the project's config) or Ruff. None = no linter.
#[tauri::command]
pub async fn lint_file(path: String, lang: String) -> Option<Vec<Lint>> {
    let p = Path::new(&path);
    let cwd = p.parent()?;
    match lang.as_str() {
        "javascript" | "typescript" => {
            let exe = p.ancestors().skip(1).map(|d| d.join("node_modules").join(".bin")).find_map(|b| {
                [if cfg!(windows) { "eslint.cmd" } else { "eslint" }].iter().map(|n| b.join(n)).find(|x| x.is_file())
            })?;
            let (_, out, _) = run(&exe, &["-f".into(), "json".into(), path.clone()], cwd, None).ok()?;
            Some(parse_eslint(&out))
        }
        "python" => {
            let exe = find_exe("ruff")?;
            let (_, out, _) = run(&exe, &["check".into(), "--output-format".into(), "json".into(), "--no-fix".into(), path.clone()], cwd, None).ok()?;
            Some(parse_ruff(&out))
        }
        _ => None,
    }
}

/// Applies the linter's automatic fixes to a saved file ("Fix all"); `imports` sorts Python imports with Ruff.
#[tauri::command]
pub async fn lint_fix(path: String, lang: String, imports: bool) -> Result<(), String> {
    let p = Path::new(&path);
    let cwd = p.parent().ok_or("no folder")?;
    let (exe, args): (PathBuf, Vec<String>) = match lang.as_str() {
        "javascript" | "typescript" => (tool("eslint", p).ok_or("ESLint not found (npm install -D eslint)")?, vec!["--fix".into(), path.clone()]),
        "python" if imports => (find_exe("ruff").ok_or("Ruff not installed (pip install ruff)")?, vec!["check".into(), "--select".into(), "I".into(), "--fix".into(), path.clone()]),
        "python" => (find_exe("ruff").ok_or("Ruff not installed (pip install ruff)")?, vec!["check".into(), "--fix".into(), path.clone()]),
        _ => return Err("no linter for this language".into()),
    };
    run(&exe, &args, cwd, None).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eslint_and_ruff_reports() {
        let e = parse_eslint(r#"[{"filePath":"a.js","messages":[{"ruleId":"no-unused-vars","severity":2,"message":"'x' is unused","line":3,"column":7,"endLine":3,"endColumn":8},{"ruleId":"semi","severity":1,"message":"Missing semicolon","line":4,"column":10,"fix":{"range":[1,2],"text":";"}}]}]"#);
        assert_eq!(e.iter().map(|l| (l.line, l.col, l.end_col, l.severity, l.code.as_str(), l.fixable)).collect::<Vec<_>>(),
            [(3, 7, 8, 1, "no-unused-vars", false), (4, 10, 11, 2, "semi", true)]);
        let r = parse_ruff(r#"[{"code":"F401","message":"`os` imported but unused","location":{"row":1,"column":8},"end_location":{"row":1,"column":10},"fix":{"applicability":"safe"}},{"code":"E999","message":"SyntaxError","location":{"row":5,"column":1},"end_location":{"row":5,"column":2},"fix":null}]"#);
        assert_eq!(r.iter().map(|l| (l.line, l.severity, l.code.as_str(), l.fixable)).collect::<Vec<_>>(), [(1, 2, "F401", true), (5, 1, "E999", false)]);
    }

    /// rustfmt through stdin, with the crate's edition (skipped when rustfmt isn't installed).
    #[test]
    fn rustfmt_formats() {
        if find_exe("rustfmt").is_none() { return; }
        let dir = std::env::temp_dir().join(format!("tools-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[package]\nname = \"x\"\nedition = \"2021\"\n").unwrap();
        let f = dir.join("src/main.rs");
        assert_eq!(rust_edition(&f), "2021");
        match format(&f, "fn main(){let x=1;println!(\"{}\",x);}", "rust") {
            Formatted::Ok { text, .. } => assert_eq!(text.replace("\r\n", "\n"), "fn main() {\n    let x = 1;\n    println!(\"{}\", x);\n}\n"),
            other => panic!("{other:?}"),
        }
        assert!(matches!(format(&f, "fn main( {", "rust"), Formatted::Failed { .. }));
        assert_eq!(format(&f, "x", "plaintext"), Formatted::None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
