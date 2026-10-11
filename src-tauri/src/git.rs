//! Git for Code Studio, through the installed git — so credentials, hooks and settings behave as on the command line.
//! Status (branch, ahead/behind, changed files), the committed text of a file (diff view, change markers in the gutter),
//! stage / unstage / discard, commit and branches. Push and pull run in a terminal tab (the UI), where prompts show.

use serde::Serialize;
use similar::{DiffOp, TextDiff};
use std::{path::Path, process::Command};

fn git_raw(root: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut c = Command::new("git");
    c.arg("-C").arg(root).args(args);
    // No prompts from a background call; status shouldn't take locks another git might need.
    c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = c.output().map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "git is not installed".to_string() } else { e.to_string() })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err });
    }
    Ok(out.stdout)
}

fn git(root: &str, args: &[&str]) -> Result<String, String> {
    git_raw(root, args).map(|b| String::from_utf8_lossy(&b).into_owned())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct FileStatus {
    /// relative to the repository's top folder, with "/"
    pub path: String,
    /// index (staged) and worktree letters as git writes them: "M", "A", "D", "R", "?", " "
    pub x: String,
    pub y: String,
    /// the old path of a renamed file
    pub orig: Option<String>,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Status {
    pub repo: bool,
    /// the repository's top folder
    pub top: String,
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileStatus>,
}

/// `git status --porcelain=v1 -z -b`: "## main...origin/main [ahead 1, behind 2]\0XY path\0R  new\0old\0…"
pub fn parse_status(out: &str) -> Status {
    let mut s = Status { repo: true, ..Default::default() };
    let mut it = out.split('\0').filter(|e| !e.is_empty());
    while let Some(e) = it.next() {
        if let Some(head) = e.strip_prefix("## ") {
            let (names, counts) = match head.split_once(" [") { Some((n, c)) => (n, c.trim_end_matches(']')), None => (head, "") };
            let names = names.strip_prefix("No commits yet on ").unwrap_or(names);
            match names.split_once("...") {
                Some((b, u)) => { s.branch = b.into(); s.upstream = Some(u.into()); }
                None => s.branch = names.into(),
            }
            for part in counts.split(", ") {
                if let Some(n) = part.strip_prefix("ahead ") { s.ahead = n.parse().unwrap_or(0); }
                if let Some(n) = part.strip_prefix("behind ") { s.behind = n.parse().unwrap_or(0); }
            }
            continue;
        }
        if e.len() < 4 { continue; }
        let (x, y, path) = (&e[0..1], &e[1..2], &e[3..]);
        let orig = if x == "R" || x == "C" { it.next().map(String::from) } else { None };
        s.files.push(FileStatus { path: path.into(), x: x.into(), y: y.into(), orig });
    }
    s
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<Status, String> {
    let Ok(top) = git(&root, &["rev-parse", "--show-toplevel"]) else { return Ok(Status::default()) };
    let out = git(&root, &["status", "--porcelain=v1", "-z", "-b"])?;
    Ok(Status { top: top.trim().to_string(), ..parse_status(&out) })
}

/// The file as committed (HEAD), or None (new file, not text, no repository).
fn head_text(path: &str) -> Option<String> {
    let p = Path::new(path);
    let dir = p.parent()?.to_str()?;
    let name = p.file_name()?.to_str()?;
    let bytes = git_raw(dir, &["show", &format!("HEAD:./{name}")]).ok()?;
    String::from_utf8(bytes).ok()
}

#[tauri::command]
pub async fn git_head_text(path: String) -> Option<String> {
    head_text(&path)
}

/// Changed lines against the committed text, for the gutter: [first line, last line (1-based), kind] with kind
/// "added", "modified" or "deleted" (deleted: the line after which lines went missing; 0 = before the first).
pub fn line_changes(base: &str, text: &str) -> Vec<(usize, usize, &'static str)> {
    let (a, b) = (base.replace("\r\n", "\n"), text.replace("\r\n", "\n"));
    let diff = TextDiff::from_lines(&a, &b);
    let mut out = Vec::new();
    for op in diff.ops() {
        match *op {
            DiffOp::Equal { .. } => {}
            DiffOp::Insert { new_index, new_len, .. } => out.push((new_index + 1, new_index + new_len, "added")),
            DiffOp::Delete { new_index, .. } => out.push((new_index, new_index, "deleted")),
            DiffOp::Replace { new_index, new_len, .. } => out.push((new_index + 1, new_index + new_len, "modified")),
        }
    }
    out
}

/// Gutter marks for a file's current text; None outside a repository. A new (uncommitted) file is all added.
#[tauri::command]
pub async fn git_line_changes(path: String, text: String) -> Option<Vec<(usize, usize, &'static str)>> {
    let dir = Path::new(&path).parent()?.to_str()?.to_string();
    git(&dir, &["rev-parse", "--is-inside-work-tree"]).ok()?;
    match head_text(&path) {
        Some(base) => Some(line_changes(&base, &text)),
        None => {
            // Ignored files get no marks.
            if git(&dir, &["check-ignore", "-q", &path]).is_ok() { return Some(vec![]); }
            let n = text.lines().count().max(1);
            Some(vec![(1, n, "added")])
        }
    }
}

fn with_paths<'a>(args: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    let mut v: Vec<&str> = args.to_vec();
    v.push("--");
    v.extend(paths.iter().map(String::as_str));
    v
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    git(&root, &with_paths(&["add", "-A"], &paths)).map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    if git(&root, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok() {
        git(&root, &with_paths(&["restore", "--staged"], &paths)).map(|_| ())
    } else {
        // No commit yet: take the files out of the index.
        git(&root, &with_paths(&["rm", "--cached", "-q", "-r"], &paths)).map(|_| ())
    }
}

/// Throws away the uncommitted changes of tracked files (back to the staged / committed version).
#[tauri::command]
pub async fn git_discard(root: String, paths: Vec<String>) -> Result<(), String> {
    git(&root, &with_paths(&["restore"], &paths)).map(|_| ())
}

#[tauri::command]
pub async fn git_commit(root: String, message: String, amend: bool) -> Result<String, String> {
    let mut args = vec!["commit", "-m", message.as_str()];
    if amend { args.push("--amend"); }
    git(&root, &args).map(|o| o.lines().next().unwrap_or_default().to_string())
}

#[derive(Serialize)]
pub struct Branches {
    current: String,
    local: Vec<String>,
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<Branches, String> {
    let out = git(&root, &["for-each-ref", "--format=%(HEAD)%(refname:short)", "refs/heads"])?;
    let mut b = Branches { current: String::new(), local: Vec::new() };
    for l in out.lines() {
        let (cur, name) = l.split_at(1);
        if cur == "*" { b.current = name.to_string(); }
        b.local.push(name.to_string());
    }
    Ok(b)
}

/// Switches to a branch; `create` makes a new one from the current commit.
#[tauri::command]
pub async fn git_switch(root: String, branch: String, create: bool) -> Result<(), String> {
    let args: Vec<&str> = if create { vec!["switch", "-c", &branch] } else { vec!["switch", &branch] };
    git(&root, &args).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_lines() {
        let s = parse_status("## main...origin/main [ahead 2, behind 1]\0 M src/a.rs\0A  new.txt\0R  b.rs\0old b.rs\0?? notes.md\0");
        assert_eq!((s.branch.as_str(), s.upstream.as_deref(), s.ahead, s.behind), ("main", Some("origin/main"), 2, 1));
        let f: Vec<String> = s.files.iter().map(|f| format!("{}{}:{}:{}", f.x, f.y, f.path, f.orig.as_deref().unwrap_or(""))).collect();
        assert_eq!(f, [" M:src/a.rs:", "A :new.txt:", "R :b.rs:old b.rs", "??:notes.md:"]);
        assert_eq!(parse_status("## No commits yet on main\0?? a\0").branch, "main");
    }

    #[test]
    fn gutter_marks() {
        let base = "a\nb\nc\nd\n";
        assert_eq!(line_changes(base, "a\nB\nc\nd\ne\n"), [(2, 2, "modified"), (5, 5, "added")]);
        assert_eq!(line_changes(base, "a\nd\n"), [(1, 1, "deleted")]);
        assert_eq!(line_changes("x\r\ny\r\n", "x\ny\n"), []);
    }

    /// A real repository: commit, change, stage, branch.
    #[test]
    fn real_repository() {
        if Command::new("git").arg("--version").output().is_err() { return; }
        let dir = std::env::temp_dir().join(format!("cd-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        let run = |args: &[&str]| { git(&root, args).unwrap(); };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.name", "Test"]);
        run(&["config", "user.email", "test@example.com"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        tauri::async_runtime::block_on(async {
            git_stage(root.clone(), vec![dir.join("a.txt").to_string_lossy().into()]).await.unwrap();
            git_commit(root.clone(), "first".into(), false).await.unwrap();
            std::fs::write(dir.join("a.txt"), "one\nTWO\nthree\n").unwrap();
            std::fs::write(dir.join("b.txt"), "new\n").unwrap();
            let s = git_status(root.clone()).await.unwrap();
            assert!(s.repo && s.branch == "main");
            let f: Vec<String> = s.files.iter().map(|f| format!("{}{}{}", f.x, f.y, f.path)).collect();
            assert_eq!(f, [" Ma.txt", "??b.txt"]);
            let a = dir.join("a.txt").to_string_lossy().to_string();
            assert_eq!(git_head_text(a.clone()).await.as_deref(), Some("one\ntwo\n"));
            assert_eq!(git_line_changes(a.clone(), "one\nTWO\nthree\n".into()).await, Some(vec![(2, 3, "modified")]));
            git_stage(root.clone(), vec![a.clone()]).await.unwrap();
            assert_eq!(git_status(root.clone()).await.unwrap().files[0].x, "M");
            git_unstage(root.clone(), vec![a.clone()]).await.unwrap();
            git_discard(root.clone(), vec![a.clone()]).await.unwrap();
            assert_eq!(std::fs::read_to_string(&a).unwrap().replace("\r\n", "\n"), "one\ntwo\n");
            git_switch(root.clone(), "feature".into(), true).await.unwrap();
            let b = git_branches(root.clone()).await.unwrap();
            assert_eq!((b.current.as_str(), b.local.len()), ("feature", 2));
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
