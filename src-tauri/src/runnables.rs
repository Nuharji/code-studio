//! "Run from the code": the places in a file that can be run — `fn main`, tests and test modules (Rust, Go, Python,
//! JavaScript/TypeScript) — each with the command that runs exactly that, and the parsing of test output into
//! passed / failed per test (for the ▶ marks next to the line numbers and the Tests panel).

use crate::symbols::blank;
use regex::Regex;
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::LazyLock,
};

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Runnable {
    /// 1-based line of the ▶
    pub line: usize,
    /// "main", "test" or "suite" (a module / class / describe with tests)
    pub kind: &'static str,
    /// shown in menus and the run tab
    pub name: String,
    /// matches the ids in the test output (see `parse_results`)
    pub id: String,
    pub command: String,
    pub cwd: String,
    /// cargo, pytest, go, jest, vitest, node, run
    pub framework: &'static str,
}

macro_rules! re {
    ($s:expr) => {{ static R: LazyLock<Regex> = LazyLock::new(|| Regex::new($s).unwrap()); &*R }};
}

/// The nearest folder (from the file's folder upwards) that contains `marker`.
fn find_up(file: &Path, marker: &str) -> Option<PathBuf> {
    file.ancestors().skip(1).find(|d| d.join(marker).is_file()).map(Path::to_path_buf)
}

fn s(p: &Path) -> String { p.to_string_lossy().into_owned() }
fn q(x: &str) -> String { format!("\"{}\"", x.replace('"', "")) }

/* ---------- Rust ---------- */

/// The crate target of a file and its module path inside it: ("", ["a", "b"]) for src/a/b.rs,
/// ("--bin x", []) for src/bin/x.rs, ("--test x", []) for tests/x.rs, ("--example x", []) for examples/x.rs.
fn rust_target(krate: &Path, file: &Path) -> (String, Vec<String>) {
    let rel: Vec<String> = file.strip_prefix(krate).map(|r| r.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    let stem = |n: &str| n.trim_end_matches(".rs").to_string();
    match rel.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["src", "bin", name] => (format!("--bin {}", stem(name)), vec![]),
        ["src", "bin", name, ..] => (format!("--bin {name}"), vec![]),
        ["tests", name] => (format!("--test {}", stem(name)), vec![]),
        ["examples", name] => (format!("--example {}", stem(name)), vec![]),
        ["src", rest @ ..] => {
            let mut m: Vec<String> = rest.iter().map(|x| x.to_string()).collect();
            if let Some(last) = m.pop() {
                if last != "main.rs" && last != "lib.rs" && last != "mod.rs" { m.push(stem(&last)); }
            }
            (String::new(), m)
        }
        _ => (String::new(), vec![]),
    }
}

fn rust(path: &Path, text: &str) -> Vec<Runnable> {
    let Some(krate) = find_up(path, "Cargo.toml") else { return vec![] };
    let (target, base) = rust_target(&krate, path);
    let cwd = s(&krate);
    let tgt = if target.is_empty() { String::new() } else { format!(" {target}") };
    let src = blank(text, "rust");
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut mods: Vec<(String, usize)> = Vec::new(); // inline modules and the depth inside them
    let mut test_attr = false;
    for (i, line) in src.lines().enumerate() {
        let l = line.trim();
        if re!(r"^#\[(?:[\w:]+::)?test\b|^#\[(?:tokio|async_std|rstest)::test|^#\[rstest\]").is_match(l) { test_attr = true; }
        let path_of = |name: &str, mods: &[(String, usize)]| {
            base.iter().cloned().chain(mods.iter().map(|m| m.0.clone())).chain((!name.is_empty()).then(|| name.to_string())).collect::<Vec<_>>().join("::")
        };
        if let Some(c) = re!(r"^(?:pub(?:\([\w:]+\))?\s+)?mod\s+(\w+)\s*\{").captures(l) {
            let name = c[1].to_string();
            let p = path_of(&name, &mods);
            // A module is worth a ▶ when it holds tests (checked later: only keep it if a test follows inside).
            out.push(Runnable { line: i + 1, kind: "suite", name: format!("{name} (tests)"), id: p.clone(),
                command: format!("cargo test{tgt} {p}::"), cwd: cwd.clone(), framework: "cargo" });
            mods.push((name, depth + 1));
        } else if let Some(c) = re!(r"^(?:pub(?:\([\w:]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)").captures(l) {
            let name = &c[1];
            if test_attr {
                let p = path_of(name, &mods);
                out.push(Runnable { line: i + 1, kind: "test", name: name.to_string(), id: p.clone(),
                    command: format!("cargo test{tgt} {p} -- --exact"), cwd: cwd.clone(), framework: "cargo" });
            } else if name == "main" && mods.is_empty() && depth == 0 {
                let run = if target.is_empty() { "cargo run".to_string() } else { format!("cargo run{tgt}") };
                out.push(Runnable { line: i + 1, kind: "main", name: run.clone(), id: String::new(), command: run, cwd: cwd.clone(), framework: "run" });
            }
            test_attr = false;
        } else if !l.is_empty() && !l.starts_with("#[") && !l.starts_with("//") {
            test_attr = false;
        }
        for ch in line.chars() {
            match ch {
                '{' => depth += 1,
                '}' => { depth = depth.saturating_sub(1); while mods.last().is_some_and(|m| m.1 > depth) { mods.pop(); } }
                _ => {}
            }
        }
    }
    // Modules without tests get no ▶.
    let tests: Vec<String> = out.iter().filter(|r| r.kind == "test").map(|r| r.id.clone()).collect();
    out.retain(|r| r.kind != "suite" || tests.iter().any(|t| t.starts_with(&format!("{}::", r.id))));
    out
}

/* ---------- Python ---------- */

fn python(path: &Path, text: &str) -> Vec<Runnable> {
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    // pytest runs from the project's configuration folder, so test ids are relative to it.
    let root = ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"].iter().find_map(|m| find_up(path, m)).unwrap_or_else(|| dir.clone());
    let rel = path.strip_prefix(&root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| s(path));
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let is_test_file = file_name.starts_with("test_") || file_name.ends_with("_test.py");
    let mut out = Vec::new();
    let mut class: Option<String> = None;
    let test = |line: usize, kind, name: String, id: String| Runnable { line, kind, name, command: format!("python -m pytest -v {}", q(&id)), id, cwd: s(&root), framework: "pytest" };
    for (i, line) in text.lines().enumerate() {
        let indent = line.len() - line.trim_start().len();
        if indent == 0 && !line.trim().is_empty() { class = None; }
        if let Some(c) = re!(r"^class\s+(Test\w*)").captures(line) {
            class = Some(c[1].to_string());
            out.push(test(i + 1, "suite", c[1].to_string(), format!("{rel}::{}", &c[1])));
        } else if let Some(c) = re!(r"^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(").captures(line) {
            let name = &c[2];
            let id = match (&class, c[1].is_empty()) { (Some(cl), false) => format!("{rel}::{cl}::{name}"), (_, true) => format!("{rel}::{name}"), _ => continue };
            if is_test_file || name.starts_with("test_") { out.push(test(i + 1, "test", name.to_string(), id)); }
        } else if re!(r#"^if\s+__name__\s*==\s*['"]__main__['"]\s*:"#).is_match(line) {
            out.push(Runnable { line: i + 1, kind: "main", name: format!("python {file_name}"), id: String::new(),
                command: format!("python {}", q(&file_name)), cwd: s(&dir), framework: "run" });
        }
    }
    out
}

/* ---------- Go ---------- */

fn go(path: &Path, text: &str) -> Vec<Runnable> {
    let dir = s(path.parent().unwrap_or(Path::new(".")));
    let mut out = Vec::new();
    let is_main = re!(r"(?m)^package\s+main\b").is_match(text);
    for (i, line) in text.lines().enumerate() {
        if let Some(c) = re!(r"^func\s+(Test\w*|Benchmark\w*|Example\w*)\s*\(").captures(line) {
            let name = &c[1];
            out.push(Runnable { line: i + 1, kind: "test", name: name.to_string(), id: name.to_string(),
                command: format!("go test -v -run \"^{name}$\" ."), cwd: dir.clone(), framework: "go" });
        } else if is_main && re!(r"^func\s+main\s*\(\s*\)").is_match(line) {
            out.push(Runnable { line: i + 1, kind: "main", name: "go run .".into(), id: String::new(), command: "go run .".into(), cwd: dir.clone(), framework: "run" });
        }
    }
    out
}

/* ---------- JavaScript / TypeScript ---------- */

fn js(path: &Path, text: &str) -> Vec<Runnable> {
    let pkg_dir = find_up(path, "package.json");
    let pkg = pkg_dir.as_ref().and_then(|d| std::fs::read_to_string(d.join("package.json")).ok()).unwrap_or_default();
    let framework = if pkg.contains("\"vitest\"") { "vitest" } else if pkg.contains("\"jest\"") { "jest" } else { "node" };
    let cwd = pkg_dir.clone().unwrap_or_else(|| path.parent().map(Path::to_path_buf).unwrap_or_default());
    let rel = path.strip_prefix(&cwd).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| s(path));
    let pattern = |n: &str| regex::escape(n).replace('"', "");
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let Some(c) = re!(r#"^\s*(describe|test|it)(?:\.(?:only|skip|each\([^)]*\)))?\s*\(\s*(['"`])(.+?)['"`]"#).captures(line) else { continue };
        let (kind, name) = (if &c[1] == "describe" { "suite" } else { "test" }, c[3].to_string());
        let p = pattern(&name);
        let command = match framework {
            "vitest" => format!("npx vitest run {} -t \"{p}\"", q(&rel)),
            "jest" => format!("npx jest {} -t \"{p}\"", q(&rel)),
            _ => format!("node --test --test-name-pattern=\"{p}\" {}", q(&rel)),
        };
        out.push(Runnable { line: i + 1, kind, name: name.clone(), id: name, command, cwd: s(&cwd), framework });
    }
    out
}

pub fn find(path: &Path, text: &str, lang: &str) -> Vec<Runnable> {
    match lang {
        "rust" => rust(path, text),
        "python" => python(path, text),
        "go" => go(path, text),
        "javascript" | "typescript" => js(path, text),
        _ => vec![],
    }
}

#[tauri::command]
pub async fn runnables(path: String, text: String, lang: String) -> Vec<Runnable> {
    find(Path::new(&path), &text, &lang)
}

/* ---------- Results ---------- */

/// Passed / failed per test id from a test run's output (colors and control codes are removed first).
pub fn parse_results(framework: &str, output: &str) -> Vec<(String, bool)> {
    let clean = re!(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r").replace_all(output, "");
    let mut out: Vec<(String, bool)> = Vec::new();
    let mut add = |id: &str, ok: bool| { let id = id.trim().to_string(); if let Some(e) = out.iter_mut().find(|e| e.0 == id) { e.1 = ok; } else { out.push((id, ok)); } };
    for line in clean.lines() {
        match framework {
            "cargo" => if let Some(c) = re!(r"^test (\S+) \.\.\. (ok|FAILED|ignored)").captures(line) { if &c[2] != "ignored" { add(&c[1], &c[2] == "ok"); } },
            "pytest" => if let Some(c) = re!(r"^(\S+::\S+) (PASSED|FAILED|ERROR)").captures(line) { add(&c[1], &c[2] == "PASSED"); },
            "go" => if let Some(c) = re!(r"^\s*--- (PASS|FAIL): (\S+)").captures(line) { add(&c[2], &c[1] == "PASS"); },
            "node" => if let Some(c) = re!(r"^\s*(✔|✖|ok \d+ -|not ok \d+ -) (.+?)(?: \(\d[\d.]*m?s\))?$").captures(line) { add(&c[2], c[1].starts_with('✔') || c[1].starts_with("ok")); },
            "jest" | "vitest" => if let Some(c) = re!(r"^\s*(✓|√|✔|✕|×|✗) (.+?)(?: \(\d[\d.]* ?m?s\))?$").captures(line) { add(&c[2], matches!(&c[1], "✓" | "√" | "✔")); },
            _ => {}
        }
    }
    out
}

#[tauri::command]
pub fn test_results(framework: String, output: String) -> Vec<(String, bool)> {
    parse_results(&framework, &output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("runnables-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("crate/src/net")).unwrap();
        fs::create_dir_all(dir.join("crate/src/bin")).unwrap();
        fs::create_dir_all(dir.join("py/tests")).unwrap();
        fs::write(dir.join("crate/Cargo.toml"), "[package]").unwrap();
        fs::write(dir.join("py/pyproject.toml"), "").unwrap();
        fs::write(dir.join("package.json"), r#"{"devDependencies": {"vitest": "1"}}"#).unwrap();
        dir
    }

    #[test]
    fn rust_tests_and_main() {
        let dir = project("rust");
        let src = "fn main() {}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn adds() { let s = \"}\"; }\n\n    #[tokio::test]\n    async fn waits() {}\n    fn helper() {}\n}\nmod empty {\n    fn x() {}\n}\n";
        let r = find(&dir.join("crate/src/net/http.rs"), src, "rust");
        let v: Vec<String> = r.iter().map(|x| format!("{}:{}:{}", x.line, x.kind, x.command)).collect();
        assert_eq!(v, ["1:main:cargo run", "4:suite:cargo test net::http::tests::", "7:test:cargo test net::http::tests::adds -- --exact",
            "10:test:cargo test net::http::tests::waits -- --exact"]);
        let b = find(&dir.join("crate/src/bin/tool.rs"), "fn main() {}\n", "rust");
        assert_eq!(b[0].command, "cargo run --bin tool");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn python_go_js() {
        let dir = project("other");
        let py = "import x\n\ndef test_one():\n    pass\n\nclass TestThing:\n    def test_two(self):\n        pass\n    def helper(self):\n        pass\n\nif __name__ == \"__main__\":\n    main()\n";
        let r = find(&dir.join("py/tests/test_a.py"), py, "python");
        let v: Vec<String> = r.iter().map(|x| format!("{}:{}:{}", x.line, x.kind, x.id)).collect();
        assert_eq!(v, ["3:test:tests/test_a.py::test_one", "6:suite:tests/test_a.py::TestThing", "7:test:tests/test_a.py::TestThing::test_two", "12:main:"]);
        assert_eq!(r[0].command, "python -m pytest -v \"tests/test_a.py::test_one\"");
        let g = find(&dir.join("x/main_test.go"), "package main\n\nfunc TestAdd(t *testing.T) {}\nfunc main() {}\n", "go");
        assert_eq!(g.iter().map(|x| x.command.as_str()).collect::<Vec<_>>(), ["go test -v -run \"^TestAdd$\" .", "go run ."]);
        let j = find(&dir.join("src/a.test.ts"), "describe('math', () => {\n  it(\"adds 1+1\", () => {});\n  test.skip(`later`, () => {});\n});\n", "typescript");
        assert_eq!(j.iter().map(|x| format!("{}:{}", x.kind, x.command)).collect::<Vec<_>>(),
            ["suite:npx vitest run \"src/a.test.ts\" -t \"math\"", "test:npx vitest run \"src/a.test.ts\" -t \"adds 1\\+1\"", "test:npx vitest run \"src/a.test.ts\" -t \"later\""]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn results() {
        let cargo = "running 2 tests\ntest net::tests::adds ... ok\ntest net::tests::waits ... \x1b[31mFAILED\x1b[0m\r\ntest x ... ignored\n";
        assert_eq!(parse_results("cargo", cargo), [("net::tests::adds".to_string(), true), ("net::tests::waits".to_string(), false)]);
        assert_eq!(parse_results("pytest", "tests/test_a.py::test_one PASSED  [50%]\ntests/test_a.py::TestThing::test_two FAILED [100%]\n"),
            [("tests/test_a.py::test_one".to_string(), true), ("tests/test_a.py::TestThing::test_two".to_string(), false)]);
        assert_eq!(parse_results("go", "=== RUN   TestAdd\n--- PASS: TestAdd (0.00s)\n    --- FAIL: TestAdd/sub (0.00s)\n"),
            [("TestAdd".to_string(), true), ("TestAdd/sub".to_string(), false)]);
        assert_eq!(parse_results("node", "▶ math\n  ✔ adds (0.5ms)\n  ✖ subtracts (1.2ms)\n"), [("adds".to_string(), true), ("subtracts".to_string(), false)]);
        assert_eq!(parse_results("vitest", " ✓ src/a.test.ts > math > adds 2ms\n × math > fails\n").len(), 2);
    }
}
