//! Symbols of a source file (Structure panel, Go to Symbol, status bar breadcrumb): fast per-language patterns.
//! Language servers (lsp.rs) give richer results where one is installed.
//! `symbols_of(text, lang)` -> [{name, kind, line (1-based), depth}]

use regex::{Captures, Regex};
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Serialize, Debug, PartialEq)]
pub struct Sym {
    pub name: String,
    pub kind: &'static str,
    pub line: usize,
    pub depth: usize,
}

/// Words that generic "name(...) {" patterns would otherwise take for a method or function.
const KEYWORDS: &[&str] = &["if", "for", "while", "switch", "catch", "return", "function", "else", "with", "new", "typeof", "await", "do", "try", "super", "constructor"];

struct Rule {
    re: Regex,
    kind: &'static str,
    /// Go methods: "Receiver.name" from groups 1 and 2.
    join: bool,
    /// Generic patterns that also match statements ("if (…) {"): skip keywords.
    generic: bool,
}

fn rule(re: &str, kind: &'static str) -> Rule { Rule { re: Regex::new(re).unwrap(), kind, join: false, generic: false } }
fn generic(re: &str, kind: &'static str) -> Rule { Rule { generic: true, ..rule(re, kind) } }

static JS: LazyLock<Vec<Rule>> = LazyLock::new(|| vec![
    rule(r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)", "class"),
    rule(r"^\s*(?:export\s+)?(?:declare\s+)?interface\s+([\w$]+)", "iface"),
    rule(r"^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([\w$]+)", "enum"),
    rule(r"^\s*(?:export\s+)?(?:declare\s+)?type\s+([\w$]+)\s*(?:<[^=]*>)?\s*=", "type"),
    rule(r"^\s*(?:export\s+)?(?:declare\s+)?namespace\s+([\w$.]+)", "mod"),
    rule(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)", "fn"),
    rule(r"^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)", "fn"),
    rule(r"^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:\{|\[|new\b|class\b)", "const"),
    generic(r"^\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*(#?[\w$]+)\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::\s*[^{]+)?\{\s*$", "method"),
    generic(r"^\s*([\w$]+)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)", "method"),
]);

static RUST: LazyLock<Vec<Rule>> = LazyLock::new(|| vec![
    rule(r#"^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"\w+"\s+)?fn\s+(\w+)"#, "fn"),
    rule(r"^\s*(?:pub(?:\([\w:]+\))?\s+)?struct\s+(\w+)", "struct"),
    rule(r"^\s*(?:pub(?:\([\w:]+\))?\s+)?enum\s+(\w+)", "enum"),
    rule(r"^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:unsafe\s+)?trait\s+(\w+)", "trait"),
    rule(r"^\s*(?:unsafe\s+)?impl\b(?:\s*<[^>]*>)?\s+([^{]+?)\s*(?:where\b.*)?\{?\s*$", "impl"),
    rule(r"^\s*(?:pub(?:\([\w:]+\))?\s+)?mod\s+(\w+)", "mod"),
    rule(r"^\s*(?:pub(?:\([\w:]+\))?\s+)?type\s+(\w+)", "type"),
    rule(r"^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:const|static(?:\s+mut)?)\s+(\w+)\s*:", "const"),
    rule(r"^\s*macro_rules!\s*(\w+)", "macro"),
]);

static GO: LazyLock<Vec<Rule>> = LazyLock::new(|| vec![
    Rule { join: true, ..rule(r"^func\s+\(\s*\w+\s+\*?(\w+)[^)]*\)\s*(\w+)", "method") },
    rule(r"^func\s+(\w+)", "fn"),
    rule(r"^type\s+(\w+)\s+struct", "struct"),
    rule(r"^type\s+(\w+)\s+interface", "iface"),
    rule(r"^type\s+(\w+)", "type"),
]);

static JAVA: LazyLock<Vec<Rule>> = LazyLock::new(|| vec![
    rule(r"^\s*(?:(?:public|private|protected|static|final|abstract|sealed|partial|internal|data|open)\s+)*(?:class|record)\s+(\w+)", "class"),
    rule(r"^\s*(?:(?:public|private|protected|static|internal)\s+)*interface\s+(\w+)", "iface"),
    rule(r"^\s*(?:(?:public|private|protected|static|internal)\s+)*enum\s+(?:class\s+)?(\w+)", "enum"),
    generic(r"^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|override|virtual|async|internal|suspend)\s+)*(?:fun\s+)?[\w<>\[\],.?\s]*?\b(\w+)\s*\([^;]*$", "method"),
]);

static C: LazyLock<Vec<Rule>> = LazyLock::new(|| vec![
    rule(r"^\s*(?:typedef\s+)?struct\s+(\w+)", "struct"),
    rule(r"^\s*(?:enum\s+(?:class\s+)?)(\w+)", "enum"),
    rule(r"^\s*class\s+(\w+)", "class"),
    rule(r"^\s*namespace\s+(\w+)", "mod"),
    generic(r"^[A-Za-z_][\w\s\*&:<>,]*?\b([\w:~]+)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{?\s*$", "fn"),
]);

static PHP: LazyLock<Vec<Rule>> = LazyLock::new(|| vec![
    rule(r"^\s*(?:abstract\s+|final\s+)?class\s+(\w+)", "class"),
    rule(r"^\s*interface\s+(\w+)", "iface"),
    rule(r"^\s*trait\s+(\w+)", "trait"),
    rule(r"^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)", "fn"),
]);

static CSS: LazyLock<Vec<Rule>> = LazyLock::new(|| vec![
    rule(r"^\s*([^{};@][^{};]*?)\s*\{\s*$", "selector"),
    rule(r"^\s*(@[\w-]+[^{]*?)\s*\{\s*$", "mod"),
]);

fn rules_for(lang: &str) -> Option<&'static [Rule]> {
    Some(match lang {
        "rust" => &RUST,
        "javascript" | "typescript" => &JS,
        "go" => &GO,
        "java" | "csharp" | "kotlin" | "scala" => &JAVA,
        "c" | "cpp" | "objective-c" | "objective_c" => &C,
        "php" => &PHP,
        "css" | "scss" | "less" => &CSS,
        _ => return None,
    })
}

/// Blanks string and comment contents so braces in them don't confuse nesting (keeps the line structure).
fn blank(text: &str, lang: &str) -> String {
    let hash = matches!(lang, "python" | "shell" | "yaml" | "toml" | "ruby" | "perl" | "r");
    let t: Vec<char> = text.chars().collect();
    let n = t.len();
    let at = |i: usize| t.get(i).copied();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < n {
        let (c, d) = (t[i], at(i + 1));
        if !hash && c == '/' && d == Some('/') {
            while i < n && t[i] != '\n' { out.push(' '); i += 1; }
            continue;
        }
        if !hash && c == '/' && d == Some('*') {
            while i < n && !(t[i] == '*' && at(i + 1) == Some('/')) { out.push(if t[i] == '\n' { '\n' } else { ' ' }); i += 1; }
            out.push_str("  ");
            i += 2;
            continue;
        }
        if hash && c == '#' {
            while i < n && t[i] != '\n' { out.push(' '); i += 1; }
            continue;
        }
        if c == '"' || c == '`' || (c == '\'' && lang != "rust") {
            out.push(c);
            i += 1;
            while i < n && t[i] != c {
                if t[i] == '\\' { out.push(' '); i += 1; }
                out.push(if at(i) == Some('\n') { '\n' } else { ' ' });
                i += 1;
                // Only template strings span lines.
                if c != '`' && at(i - 1) == Some('\n') { break; }
            }
            out.push(c);
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Brace-based languages: a symbol's depth is the number of symbols it sits in.
fn braced(text: &str, lang: &str, rules: &[Rule]) -> Vec<Sym> {
    let blanked = blank(text, lang);
    let src: Vec<&str> = blanked.split('\n').collect();
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut stack: Vec<usize> = Vec::new(); // brace depth at which each open symbol started
    for (i, line) in src.iter().enumerate() {
        for r in rules {
            let Some(m) = r.re.captures(line) else { continue };
            let g = |k: usize| m.get(k).map_or("", |x| x.as_str());
            let name = if r.join { format!("{}.{}", g(1), g(2)) } else { g(1).to_string() };
            let name = name.trim();
            if name.is_empty() || (r.generic && KEYWORDS.contains(&name)) { continue; }
            while stack.last().is_some_and(|&s| s >= depth) { stack.pop(); }
            out.push(Sym { name: name.to_string(), kind: r.kind, line: i + 1, depth: stack.len() });
            // The symbol opens a block on this line (a "{" not closed after it) or on the next one.
            let opens = line.rfind('{').is_some_and(|o| line.rfind('}').is_none_or(|c| c < o));
            if opens || src.get(i + 1).is_some_and(|l| l.trim_start().starts_with('{')) { stack.push(depth); }
            break;
        }
        for ch in line.chars() {
            if ch == '{' { depth += 1; } else if ch == '}' {
                depth = depth.saturating_sub(1);
                while stack.last().is_some_and(|&s| s >= depth) { stack.pop(); }
            }
        }
    }
    out
}

/// Indentation-based nesting (Python, Ruby, YAML): group 1 indentation, group 2 kind word, group 3 name.
fn indented(text: &str, re: &Regex, kind_of: impl Fn(&str, usize) -> &'static str) -> Vec<Sym> {
    let (mut out, mut stack) = (Vec::new(), Vec::<usize>::new());
    for (i, line) in text.split('\n').enumerate() {
        let Some(m) = re.captures(line) else { continue };
        let g = |k: usize| m.get(k).map_or("", |x| x.as_str());
        let ind: usize = g(1).chars().map(|c| if c == '\t' { 4 } else { 1 }).sum();
        while stack.last().is_some_and(|&s| s >= ind) { stack.pop(); }
        out.push(Sym { name: g(3).to_string(), kind: kind_of(g(2), stack.len()), line: i + 1, depth: stack.len() });
        stack.push(ind);
    }
    out
}

macro_rules! re {
    ($s:expr) => {{ static R: LazyLock<Regex> = LazyLock::new(|| Regex::new($s).unwrap()); &*R }};
}

pub fn of(text: &str, lang: &str) -> Vec<Sym> {
    if text.is_empty() || text.len() > 3_000_000 { return vec![]; }
    let lines = || text.split('\n').enumerate();
    let sym = |name: &str, kind, i: usize, depth| Sym { name: name.to_string(), kind, line: i + 1, depth };
    match lang {
        "python" => indented(text, re!(r"^(\s*)(?:async\s+)?(def|class)\s+(\w+)"), |k, d| if k == "class" { "class" } else if d > 0 { "method" } else { "fn" }),
        "ruby" => indented(text, re!(r"^(\s*)(def|class|module)\s+([\w.:?!]+)"), |k, _| match k { "def" => "method", "class" => "class", _ => "mod" }),
        "yaml" => indented(text, re!(r"^(\s*)(-\s+)?([\w.-]+):(?:\s|$)"), |_, _| "key").into_iter().filter(|s| s.depth < 3).collect(),
        "markdown" => {
            let (mut out, mut fence) = (Vec::new(), false);
            for (i, l) in lines() {
                if re!(r"^\s*(```|~~~)").is_match(l) { fence = !fence; }
                if fence { continue; }
                if let Some(m) = re!(r"^(#{1,6})\s+(.+?)\s*#*\s*$").captures(l) { out.push(sym(&m[2], "heading", i, m[1].len() - 1)); }
            }
            out
        }
        "ini" | "toml" => {
            let (mut out, mut sections) = (Vec::new(), false);
            for (i, l) in lines() {
                if let Some(m) = re!(r"^\s*\[\[?([^\]]+)\]\]?").captures(l) {
                    out.push(sym(m[1].trim(), "mod", i, 0));
                    sections = true;
                } else if let Some(m) = re!(r"^([\w.-]+)\s*=").captures(l) {
                    out.push(sym(&m[1], "key", i, usize::from(sections)));
                }
            }
            out
        }
        "json" => {
            // The top two levels of keys. Keys are read from the original line; the blanked one tells where code is.
            let blanked = blank(text, "json");
            let mut out = Vec::new();
            let mut depth = 0i64;
            for ((i, raw), l) in lines().zip(blanked.split('\n')) {
                if l.trim_start().starts_with('"') && (1..=2).contains(&depth) {
                    if let Some(m) = re!(r#"^\s*("(?:[^"\\]|\\.)*")\s*:"#).captures(raw) {
                        if let Ok(name) = serde_json::from_str::<String>(&m[1]) {
                            if !name.is_empty() { out.push(sym(&name, "key", i, (depth - 1) as usize)); }
                        }
                    }
                }
                for ch in l.chars() { match ch { '{' | '[' => depth += 1, '}' | ']' => depth -= 1, _ => {} } }
            }
            out
        }
        "html" | "xml" => lines().filter_map(|(i, l)| {
            let m = re!(r#"(?i)<(h[1-6]|section|nav|header|footer|main|template|script|style|svg|form|table)\b(?:[^>]*?\bid="([^"]+)")?[^>]*>"#).captures(l)?;
            let id = m.get(2).map_or(String::new(), |x| format!("#{}", x.as_str()));
            Some(sym(&format!("{}{id}", m[1].to_lowercase()), "selector", i, 0))
        }).collect(),
        "shell" | "powershell" => lines().filter_map(|(i, l)| {
            let m: Captures = re!(r"(?i)^\s*(?:function\s+([\w:-]+)|([\w-]+)\s*\(\)\s*\{)").captures(l)?;
            Some(sym(m.get(1).or(m.get(2))?.as_str(), "fn", i, 0))
        }).collect(),
        _ => rules_for(lang).map(|r| braced(text, lang, r)).unwrap_or_default(),
    }
}

#[tauri::command]
pub async fn symbols_of(text: String, lang: String) -> Vec<Sym> {
    of(&text, &lang)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn names(v: &[Sym]) -> Vec<String> { v.iter().map(|s| format!("{}:{}:{}:{}", s.kind, s.name, s.line, s.depth)).collect() }

    #[test]
    fn rust_nesting_and_strings() {
        let src = "pub struct A {\n  x: u8,\n}\nimpl A {\n    pub fn new() -> Self { A{x:0} }\n    fn s(&self) -> &str { \"}\" }\n}\nfn main() {}\n";
        assert_eq!(names(&of(src, "rust")), ["struct:A:1:0", "impl:A:4:0", "fn:new:5:1", "fn:s:6:1", "fn:main:8:0"]);
    }

    #[test]
    fn javascript() {
        let src = "// class Fake {\nexport class Foo {\n  constructor() {}\n  async load(x) {\n    if (x) {\n    }\n  }\n}\nconst add = (a, b) => a + b;\nconst s = \"function nope() {\";\nfunction* gen() {}\n";
        assert_eq!(names(&of(src, "javascript")), ["class:Foo:2:0", "method:load:4:1", "fn:add:9:0", "fn:gen:11:0"]);
    }

    #[test]
    fn go_python_markdown() {
        assert_eq!(names(&of("func (s *Server) Run() {\n}\nfunc main() {\n}\ntype T struct {\n}", "go")), ["method:Server.Run:1:0", "fn:main:3:0", "struct:T:5:0"]);
        assert_eq!(names(&of("class A:\n    def m(self):\n        pass\ndef f():\n\tpass\n", "python")), ["class:A:1:0", "method:m:2:1", "fn:f:4:0"]);
        assert_eq!(names(&of("# T\n```\n# not\n```\n## S ##\n", "markdown")), ["heading:T:1:0", "heading:S:5:1"]);
    }

    #[test]
    fn json_toml_html_shell() {
        assert_eq!(names(&of("{\n  \"name\": \"x\",\n  \"deps\": {\n    \"a\\u00e9\": 1,\n    \"b\": {\n      \"deep\": 2\n    }\n  }\n}", "json")),
            ["key:name:2:0", "key:deps:3:0", "key:aé:4:1", "key:b:5:1"]);
        assert_eq!(names(&of("top = 1\n[package]\nname = \"x\"\n", "toml")), ["key:top:1:0", "mod:package:2:0", "key:name:3:1"]);
        assert_eq!(names(&of("<section id=\"intro\" class=\"x\">\n<H1>Hi</h1>", "html")), ["selector:section#intro:1:0", "selector:h1:2:0"]);
        assert_eq!(names(&of("function Get-Thing {\n}\nbuild() {\n}", "powershell")), ["fn:Get-Thing:1:0", "fn:build:3:0"]);
    }
}

/// Parity check against other implementations: SYM_FILES = lines of "lang<TAB>path", result JSON written to SYM_OUT.
#[cfg(test)]
#[test]
#[ignore]
fn dump_for_comparison() {
    let list = std::fs::read_to_string(std::env::var("SYM_FILES").unwrap()).unwrap();
    let mut all = serde_json::Map::new();
    for l in list.lines() {
        let (lang, path) = l.split_once('\t').unwrap();
        let text = std::fs::read_to_string(path).unwrap_or_default();
        all.insert(path.to_string(), serde_json::to_value(of(&text, lang)).unwrap());
    }
    std::fs::write(std::env::var("SYM_OUT").unwrap(), serde_json::to_string(&all).unwrap()).unwrap();
}
