//! What Code Studio offers over MCP (mcp.rs): a look at a project the way the IDE sees it — its files, run
//! configurations and git state, search in files, the symbols of a file, what in a file can be run or tested (with
//! the command), and a formatted version of a file by the project's own formatter. Nothing here writes a file.

use crate::mcp;
use serde_json::{json, Value};
use std::path::Path;

pub fn run() { mcp::serve("code-studio", env!("CARGO_PKG_VERSION"), &tools(), &call) }

fn tools() -> Vec<Value> {
    let root = json!({"type": "string", "description": "Full path of the project folder"});
    let path = json!({"type": "string", "description": "Full path of the source file"});
    vec![
        mcp::tool("project_overview", "Overview of a project folder: number of files (without .git, node_modules, target …), the run configurations Code Studio finds (cargo, npm scripts, go, python, make, dotnet) and the git state (branch, ahead/behind, changed files).", json!({"root": root}), &["root"]),
        mcp::tool("project_files", "Lists the files of a project (relative paths; .gitignore is respected), optionally only those whose path contains `filter`.", json!({"root": root,
            "filter": {"type": "string", "description": "Only paths containing this text (case-insensitive)"}, "limit": {"type": "integer", "description": "At most this many (default 2000)"}}), &["root"]),
        mcp::tool("find_in_files", "Searches the text files of a project like Find in Files: every match with file, line, column and the line's text.", json!({"root": root,
            "query": {"type": "string"}, "regex": {"type": "boolean"}, "case": {"type": "boolean", "description": "Match case"}, "word": {"type": "boolean", "description": "Whole words"},
            "mask": {"type": "string", "description": "File name mask like \"*.rs, *.toml\""}, "limit": {"type": "integer", "description": "At most this many matches (default 500)"}}), &["root", "query"]),
        mcp::tool("file_symbols", "The structure of a source file: functions, types, classes, methods … with their line and nesting depth.", json!({"path": path}), &["path"]),
        mcp::tool("file_runnables", "What in a file can be run or tested (Rust, Python, Go, JavaScript/TypeScript): main functions, tests and test modules, each with the command that runs exactly that and the folder to run it in.", json!({"path": path}), &["path"]),
        mcp::tool("format_file", "Formats a file with the project's own formatter (rustfmt, gofmt, Ruff/Black, Prettier, clang-format) and returns the result; the file itself is not changed.", json!({"path": path}), &["path"]),
    ]
}

/// The editor's language id for a file (the ids symbols.rs, runnables.rs and tools.rs know).
fn lang_of(p: &Path) -> &'static str {
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "rs" => "rust",
        "py" | "pyw" => "python",
        "go" => "go",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "ts" | "mts" | "cts" | "tsx" => "typescript",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" => "cpp",
        "cs" => "csharp",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "scala" => "scala",
        "php" => "php",
        "rb" => "ruby",
        "pl" | "pm" => "perl",
        "r" => "r",
        "sh" | "bash" | "zsh" => "shell",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "json" => "json",
        "html" | "htm" => "html",
        "md" | "markdown" => "markdown",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        _ => "plaintext",
    }
}

fn source(args: &Value) -> Result<(std::path::PathBuf, String), String> {
    let p = mcp::path(args, "path")?;
    let text = std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok((p, text))
}

fn folder(args: &Value) -> Result<std::path::PathBuf, String> {
    let r = mcp::path(args, "root")?;
    if r.is_dir() { Ok(r) } else { Err(format!("{}: not a folder", r.display())) }
}

fn limit(args: &Value, default: usize) -> usize {
    args.get("limit").and_then(Value::as_u64).map_or(default, |n| (n as usize).clamp(1, 20_000))
}

fn files_of(root: &Path) -> impl Iterator<Item = String> + '_ {
    crate::walker(root).filter_map(|e| e.ok()).filter(|e| e.file_type().is_some_and(|t| t.is_file())).map(move |e| crate::rel(root, e.path()))
}

fn call(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "project_overview" => {
            let root = folder(args)?;
            let s = crate::path_str(&root);
            let git = tauri::async_runtime::block_on(crate::git::git_status(s.clone()))?;
            Ok(json!({"root": s, "files": files_of(&root).take(100_000).count(),
                "runConfigurations": crate::runconfig::detect(&root), "git": git}))
        }
        "project_files" => {
            let root = folder(args)?;
            let filter = mcp::opt_text(args, "filter").to_lowercase();
            let list: Vec<String> = files_of(&root).filter(|f| filter.is_empty() || f.to_lowercase().contains(&filter)).take(limit(args, 2000)).collect();
            Ok(json!({"count": list.len(), "files": list}))
        }
        "find_in_files" => {
            let root = folder(args)?;
            let opts = crate::FindOpts { query: mcp::text(args, "query")?, regex: mcp::flag(args, "regex"), case: mcp::flag(args, "case"),
                word: mcp::flag(args, "word"), scope: None, mask: Some(mcp::opt_text(args, "mask")) };
            let mut hits = tauri::async_runtime::block_on(crate::find_in_files(crate::path_str(&root), opts))?;
            let total = hits.len();
            hits.truncate(limit(args, 500));
            Ok(json!({"total": total, "hits": hits}))
        }
        "file_symbols" => {
            let (p, text) = source(args)?;
            Ok(json!({"language": lang_of(&p), "symbols": crate::symbols::of(&text, lang_of(&p))}))
        }
        "file_runnables" => {
            let (p, text) = source(args)?;
            Ok(json!(crate::runnables::find(&p, &text, lang_of(&p))))
        }
        "format_file" => {
            let (p, text) = source(args)?;
            Ok(json!(crate::tools::format(&p, &text, lang_of(&p))))
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn looks_at_a_project() {
        let d = std::env::temp_dir().join(format!("code-mcp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("src")).unwrap();
        fs::write(d.join("Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n").unwrap();
        let main = d.join("src").join("main.rs");
        fs::write(&main, "fn main() {\n    println!(\"hello\");\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() { assert_eq!(1 + 1, 2); }\n}\n").unwrap();

        let o = call("project_overview", &json!({"root": d})).unwrap();
        assert_eq!(o["files"], 2);
        assert!(o["runConfigurations"].as_array().unwrap().iter().any(|c| c["command"].as_str().unwrap_or("").contains("cargo run")));

        let f = call("project_files", &json!({"root": d, "filter": "MAIN"})).unwrap();
        assert_eq!(f["files"], json!(["src/main.rs"]));

        let h = call("find_in_files", &json!({"root": d, "query": "hello", "mask": "*.rs"})).unwrap();
        assert_eq!(h["total"], 1);
        assert_eq!(h["hits"][0]["line"], 2);
        assert_eq!(call("find_in_files", &json!({"root": d, "query": "hello", "mask": "*.toml"})).unwrap()["total"], 0);

        let s = call("file_symbols", &json!({"path": main})).unwrap();
        assert_eq!(s["language"], "rust");
        assert!(s["symbols"].as_array().unwrap().iter().any(|x| x["name"] == "main"));

        let r = call("file_runnables", &json!({"path": main})).unwrap();
        assert!(r.as_array().unwrap().iter().any(|x| x["kind"] == "main"));
        assert!(r.as_array().unwrap().iter().any(|x| x["kind"] == "test"));

        assert!(call("file_symbols", &json!({"path": "src/main.rs"})).is_err(), "full paths only");
        assert!(call("project_overview", &json!({"root": main})).is_err(), "a folder is needed");
        assert_eq!(fs::read_to_string(&main).unwrap().lines().count(), 9, "nothing was changed");
        let _ = fs::remove_dir_all(d);
    }
}
