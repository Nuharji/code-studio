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

/// Like `git_raw`, with `input` written to git's stdin (for `blame --contents -`).
fn git_stdin(root: &str, args: &[&str], input: &str) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut c = Command::new("git");
    c.arg("-C").arg(root).args(args);
    c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0");
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let data = input.as_bytes().to_vec();
    // Write on another thread so a full stdout pipe can't block us.
    let writer = std::thread::spawn(move || { let _ = stdin.write_all(&data); });
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let _ = writer.join();
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
pub struct BlameCommit {
    pub hash: String,
    pub author: String,
    /// seconds since 1970
    pub time: i64,
    pub summary: String,
    /// false for lines that aren't committed yet
    pub committed: bool,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Blame {
    pub commits: Vec<BlameCommit>,
    /// for each line (0-based) the index into `commits`
    pub lines: Vec<usize>,
}

/// `git blame --porcelain`: a header "<hash> <orig line> <final line> [<group size>]", the commit's details the first
/// time a commit appears, then the line's text after a tab.
pub fn parse_blame(out: &str) -> Blame {
    let mut b = Blame::default();
    let mut index: std::collections::HashMap<String, usize> = Default::default();
    let mut cur: Option<usize> = None;
    for l in out.lines() {
        if l.starts_with('\t') {
            if let Some(i) = cur { b.lines.push(i); }
            continue;
        }
        let first = l.split(' ').next().unwrap_or_default();
        if first.len() == 40 && first.bytes().all(|c| c.is_ascii_hexdigit()) && l.split(' ').count() >= 3 {
            let i = *index.entry(first.to_string()).or_insert_with(|| {
                b.commits.push(BlameCommit { hash: first.to_string(), committed: first.bytes().any(|c| c != b'0'), ..Default::default() });
                b.commits.len() - 1
            });
            cur = Some(i);
            continue;
        }
        let Some(i) = cur else { continue };
        let c = &mut b.commits[i];
        if let Some(v) = l.strip_prefix("author ") { c.author = v.to_string(); }
        else if let Some(v) = l.strip_prefix("author-time ") { c.time = v.trim().parse().unwrap_or(0); }
        else if let Some(v) = l.strip_prefix("summary ") { c.summary = v.to_string(); }
    }
    b
}

/// Who changed each line last — for the text as it is in the editor (`text`), so unsaved lines show as not committed.
/// None outside a repository or for a file git doesn't know.
#[tauri::command]
pub async fn git_blame(path: String, text: String) -> Option<Blame> {
    let p = Path::new(&path);
    let dir = p.parent()?.to_str()?;
    let name = p.file_name()?.to_str()?;
    git(dir, &["ls-files", "--error-unmatch", "--", name]).ok()?;
    let out = git_stdin(dir, &["blame", "--porcelain", "--contents", "-", "--", name], &text).ok()?;
    Some(parse_blame(&out))
}

#[derive(Serialize, Debug, PartialEq)]
pub struct LogEntry {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub time: i64,
    pub subject: String,
    /// the file's path in this commit (relative to the top folder) — differs after a rename
    pub path: String,
}

/// `git log --follow --name-only --format=%x1e%H%x1f%h%x1f%an%x1f%at%x1f%s`
pub fn parse_log(out: &str) -> Vec<LogEntry> {
    out.split('\u{1e}').filter_map(|rec| {
        let mut lines = rec.lines();
        let head = lines.next()?;
        let f: Vec<&str> = head.split('\u{1f}').collect();
        if f.len() < 5 { return None; }
        let path = lines.map(str::trim).rfind(|l| !l.is_empty()).unwrap_or_default().to_string();
        Some(LogEntry { hash: f[0].into(), short: f[1].into(), author: f[2].into(), time: f[3].parse().unwrap_or(0), subject: f[4].into(), path })
    }).collect()
}

/// The commits that changed a file (newest first, at most 300), following renames.
#[tauri::command]
pub async fn git_file_log(path: String) -> Result<Vec<LogEntry>, String> {
    let p = Path::new(&path);
    let dir = p.parent().and_then(|d| d.to_str()).ok_or("bad path")?;
    let name = p.file_name().and_then(|n| n.to_str()).ok_or("bad path")?;
    let out = git(dir, &["log", "--follow", "-n", "300", "--name-only", "--format=%x1e%H%x1f%h%x1f%an%x1f%at%x1f%s", "--", name])?;
    Ok(parse_log(&out))
}

/// A file's text in a commit (`rel` relative to the top folder `top`); None when it didn't exist there or isn't text.
#[tauri::command]
pub async fn git_show_file(top: String, rev: String, rel: String) -> Option<String> {
    if rev.starts_with('-') || rev.contains(':') { return None; }
    let bytes = git_raw(&top, &["show", &format!("{rev}:{rel}")]).ok()?;
    String::from_utf8(bytes).ok()
}

/// The first parent of a commit, None for the first commit.
#[tauri::command]
pub async fn git_parent(top: String, rev: String) -> Option<String> {
    if rev.starts_with('-') { return None; }
    git(&top, &["rev-parse", "-q", "--verify", &format!("{rev}^")]).ok().map(|s| s.trim().to_string())
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

    #[test]
    fn blame_porcelain() {
        let h1 = "a".repeat(40); let z = "0".repeat(40);
        let out = format!("{h1} 1 1 2\nauthor Ann\nauthor-mail <a@x>\nauthor-time 1700000000\nsummary First\nfilename f\n\tone\n{h1} 2 2\n\ttwo\n{z} 3 3 1\nauthor Not Committed Yet\nauthor-time 1800000000\nsummary Version of f from -\n\tthree\n");
        let b = parse_blame(&out);
        assert_eq!(b.lines, [0, 0, 1]);
        assert_eq!((b.commits[0].author.as_str(), b.commits[0].time, b.commits[0].summary.as_str(), b.commits[0].committed), ("Ann", 1700000000, "First", true));
        assert!(!b.commits[1].committed);
    }

    #[test]
    fn log_records() {
        let out = "\u{1e}abc\u{1f}ab\u{1f}Ann\u{1f}17\u{1f}Rename\n\nsrc/new.rs\n\u{1e}def\u{1f}de\u{1f}Bob\u{1f}16\u{1f}Start\n\nold.rs\n";
        let l = parse_log(out);
        assert_eq!(l.len(), 2);
        assert_eq!((l[0].short.as_str(), l[0].path.as_str(), l[1].author.as_str(), l[1].path.as_str(), l[1].time), ("ab", "src/new.rs", "Bob", "old.rs", 16));
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
            // Blame with an unsaved line, the file's history and its text in a commit.
            let bl = git_blame(a.clone(), "one\ntwo\nnew\n".into()).await.unwrap();
            assert_eq!(bl.lines.len(), 3);
            assert!(bl.commits[bl.lines[0]].committed && !bl.commits[bl.lines[2]].committed);
            assert_eq!(bl.commits[bl.lines[0]].summary, "first");
            let log = git_file_log(a.clone()).await.unwrap();
            assert_eq!((log.len(), log[0].subject.as_str(), log[0].path.as_str()), (1, "first", "a.txt"));
            let top = git_status(root.clone()).await.unwrap().top;
            assert_eq!(git_show_file(top.clone(), log[0].hash.clone(), "a.txt".into()).await.as_deref().map(|s| s.replace("\r\n", "\n")), Some("one\ntwo\n".into()));
            assert_eq!(git_parent(top, log[0].hash.clone()).await, None);
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
