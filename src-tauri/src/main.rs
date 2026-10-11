// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod codespell;
mod fuzzy;
mod git;
mod lsp;
mod runconfig;
mod runnables;
mod spell;
mod symbols;
mod terminal;
mod tools;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

/* ================= Helpers ================= */

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Header values are percent-encoded by the UI so non-ASCII paths survive.
fn header(req: &Request, key: &str) -> Option<String> {
    let raw = req.headers().get(key)?.to_str().ok()?;
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    Some(String::from_utf8_lossy(&out).into_owned()).filter(|s| !s.is_empty())
}

/// Folders that are never worth showing or searching.
const SKIP_DIRS: &[&str] = &[".git", ".hg", ".svn"];

/// A walker over the project that respects .gitignore (also outside Git repos) and skips VCS folders.
fn walker(root: &Path) -> ignore::Walk {
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| !SKIP_DIRS.iter().any(|d| e.file_name() == *d))
        .build()
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/* ================= Files & folders ================= */

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    dir: bool,
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut out: Vec<Entry> = fs::read_dir(&path)
        .map_err(|e| format!("{path}: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| !SKIP_DIRS.iter().any(|d| e.file_name() == *d))
        .map(|e| {
            let p = e.path();
            Entry { name: name_of(&p), dir: p.is_dir(), path: path_str(&p) }
        })
        .collect();
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path).map(Response::new).map_err(|e| format!("{path}: {e}"))
}

/// Modification times (ms) of files, so the UI can reload files changed outside the IDE. Missing files give 0.
#[tauri::command]
async fn stat_files(paths: Vec<String>) -> Vec<u64> {
    paths
        .iter()
        .map(|p| fs::metadata(p).and_then(|m| m.modified()).map(millis).unwrap_or(0))
        .collect()
}

/// Saves the raw request body to header `x-path` and keeps a copy in the local history.
#[tauri::command]
async fn save_file(app: AppHandle, request: Request<'_>) -> Result<u64, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a binary body".into());
    };
    let path = header(&request, "x-path").ok_or("missing path")?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))?;
    let _ = history_add(&app, &path, bytes);
    Ok(fs::metadata(&path).and_then(|m| m.modified()).map(millis).unwrap_or(0))
}

#[tauri::command]
async fn create_file(path: String, text: Option<String>) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("{} already exists", name_of(p)));
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(p, text.unwrap_or_default()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_dir(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err(format!("{} already exists", name_of(Path::new(&path))));
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("{} already exists", name_of(Path::new(&to))));
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Moves a file or folder to the recycle bin / trash (never deletes for good).
#[tauri::command]
async fn delete_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

/* ================= Project search ================= */

/// All files of the project (relative paths with /), respecting .gitignore.
/// The list is also kept for fuzzy file search (fuzzy.rs).
#[tauri::command]
async fn walk_files(lists: State<'_, fuzzy::FileLists>, root: String) -> Result<Vec<String>, String> {
    let dir = PathBuf::from(&root);
    let list: Vec<String> = walker(&dir)
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .map(|e| rel(&dir, e.path()))
        .take(100_000)
        .collect();
    lists.0.lock().unwrap().insert(root, std::sync::Arc::new(list.clone()));
    Ok(list)
}

#[derive(Deserialize)]
struct FindOpts {
    query: String,
    regex: bool,
    case: bool,
    word: bool,
    /// Only files whose relative path contains this (e.g. a folder) — empty for all.
    scope: Option<String>,
    /// File name mask like "*.rs, *.toml" — empty for all.
    mask: Option<String>,
}

#[derive(Serialize)]
struct Hit {
    path: String,
    rel: String,
    line: usize,
    col: usize,
    len: usize,
    text: String,
}

fn build_regex(o: &FindOpts) -> Result<regex::Regex, String> {
    let mut pat = if o.regex { o.query.clone() } else { regex::escape(&o.query) };
    if o.word {
        pat = format!(r"\b(?:{pat})\b");
    }
    regex::RegexBuilder::new(&pat)
        .case_insensitive(!o.case)
        .multi_line(true)
        .build()
        .map_err(|e| e.to_string())
}

fn mask_match(mask: &[String], name: &str) -> bool {
    if mask.is_empty() {
        return true;
    }
    let name = name.to_lowercase();
    mask.iter().any(|m| match m.strip_prefix("*.") {
        Some(ext) => name.ends_with(&format!(".{ext}")),
        None => name == *m,
    })
}

/// Text files of the project that the search applies to (skips binary and very large files).
fn search_files(root: &Path, o: &FindOpts) -> Vec<(PathBuf, String)> {
    let scope = o.scope.clone().unwrap_or_default().replace('\\', "/");
    let mask: Vec<String> = o
        .mask
        .clone()
        .unwrap_or_default()
        .split([',', ';'])
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let mut out = Vec::new();
    for e in walker(root).filter_map(|e| e.ok()) {
        if !e.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let r = rel(root, e.path());
        if !r.starts_with(&scope) || !mask_match(&mask, &name_of(e.path())) {
            continue;
        }
        if e.metadata().map(|m| m.len() > 4_000_000).unwrap_or(true) {
            continue;
        }
        let Ok(mut f) = fs::File::open(e.path()) else { continue };
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_err() || buf.iter().take(8000).any(|b| *b == 0) {
            continue;
        }
        if let Ok(text) = String::from_utf8(buf) {
            out.push((e.path().to_path_buf(), text));
        }
    }
    out
}

#[tauri::command]
async fn find_in_files(root: String, opts: FindOpts) -> Result<Vec<Hit>, String> {
    if opts.query.is_empty() {
        return Ok(vec![]);
    }
    let re = build_regex(&opts)?;
    let root = PathBuf::from(root);
    let mut hits = Vec::new();
    'files: for (path, text) in search_files(&root, &opts) {
        for (i, line) in text.lines().enumerate() {
            for m in re.find_iter(line) {
                if m.as_str().is_empty() {
                    continue;
                }
                let col = line[..m.start()].chars().count();
                // Show the match with a little context; very long lines (minified files) are cut.
                let start = line[..m.start()].char_indices().rev().nth(80).map(|(i, _)| i).unwrap_or(0);
                let end = line[m.end()..].char_indices().nth(200).map(|(i, _)| m.end() + i).unwrap_or(line.len());
                hits.push(Hit {
                    path: path_str(&path),
                    rel: rel(&root, &path),
                    line: i + 1,
                    col: col + 1,
                    len: m.as_str().chars().count(),
                    text: format!("{}{}{}", if start > 0 { "…" } else { "" }, &line[start..end], if end < line.len() { "…" } else { "" }),
                });
                if hits.len() >= 5000 {
                    break 'files;
                }
            }
        }
    }
    Ok(hits)
}

/// Replaces every match in the given files; returns how many replacements were made.
#[tauri::command]
async fn replace_in_files(app: AppHandle, root: String, opts: FindOpts, replacement: String, paths: Vec<String>) -> Result<usize, String> {
    let re = build_regex(&opts)?;
    let mut count = 0;
    for p in paths {
        let path = PathBuf::from(&p);
        if !path.starts_with(&root) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let n = re.find_iter(&text).count();
        if n == 0 {
            continue;
        }
        let new = if opts.regex {
            re.replace_all(&text, replacement.as_str())
        } else {
            re.replace_all(&text, regex::NoExpand(&replacement))
        };
        let _ = history_add(&app, &p, text.as_bytes());
        fs::write(&path, new.as_bytes()).map_err(|e| format!("{p}: {e}"))?;
        let _ = history_add(&app, &p, new.as_bytes());
        count += n;
    }
    Ok(count)
}

/* ================= Local history ================= */
/* Every save keeps a copy in the app data folder, so a file can be rolled back even without Git. */

const HISTORY_KEEP: usize = 60;

fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.to_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn history_dir(app: &AppHandle, path: &str) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("history").join(fnv(path)))
}

fn history_add(app: &AppHandle, path: &str, bytes: &[u8]) -> std::io::Result<()> {
    let Some(dir) = history_dir(app, path) else { return Ok(()) };
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("path.txt"), path)?;
    let mut versions = history_ids(&dir);
    if let Some(last) = versions.last() {
        if fs::read(dir.join(format!("{last}.v"))).is_ok_and(|b| b == bytes) {
            return Ok(());
        }
    }
    let id = millis(SystemTime::now());
    fs::write(dir.join(format!("{id}.v")), bytes)?;
    versions.push(id);
    while versions.len() > HISTORY_KEEP {
        let _ = fs::remove_file(dir.join(format!("{}.v", versions.remove(0))));
    }
    Ok(())
}

fn history_ids(dir: &Path) -> Vec<u64> {
    let mut ids: Vec<u64> = fs::read_dir(dir)
        .map(|r| {
            r.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().to_str()?.strip_suffix(".v")?.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids
}

#[derive(Serialize)]
struct Version {
    id: u64,
    size: u64,
}

#[tauri::command]
async fn history_list(app: AppHandle, path: String) -> Vec<Version> {
    let Some(dir) = history_dir(&app, &path) else { return vec![] };
    history_ids(&dir)
        .into_iter()
        .rev()
        .map(|id| Version { id, size: fs::metadata(dir.join(format!("{id}.v"))).map(|m| m.len()).unwrap_or(0) })
        .collect()
}

#[tauri::command]
async fn history_read(app: AppHandle, path: String, id: u64) -> Result<Response, String> {
    let dir = history_dir(&app, &path).ok_or("no history")?;
    fs::read(dir.join(format!("{id}.v"))).map(Response::new).map_err(|e| e.to_string())
}

/* ================= Desktop integration ================= */

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog().file().blocking_pick_folder().and_then(|f| f.into_path().ok()).map(|p| path_str(&p))
}

#[tauri::command]
async fn pick_file(app: AppHandle) -> Option<String> {
    app.dialog().file().blocking_pick_file().and_then(|f| f.into_path().ok()).map(|p| path_str(&p))
}

#[tauri::command]
fn reveal(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn confirm(app: AppHandle, title: String, message: String, ok_label: String, cancel_label: String) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok_label, cancel_label))
        .blocking_show()
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let allowed = ["https://", "http://", "mailto:"].iter().any(|p| url.starts_with(p));
    if !allowed {
        return Err(format!("Refusing to open {url}"));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Folder or file given on the command line ("Open with Code Studio", `code-studio .`).
struct Initial(Mutex<Option<String>>);

#[tauri::command]
fn initial_path(state: State<Initial>) -> Option<String> {
    state.0.lock().unwrap().take()
}

/// One entry of a native context menu; an entry without `id` is a separator.
#[derive(Deserialize)]
struct MenuEntry {
    id: Option<String>,
    label: Option<String>,
    enabled: Option<bool>,
    checked: Option<bool>,
    accel: Option<String>,
}

/// Shows a native (OS) context menu at the mouse position. The chosen item's id
/// reaches the UI as a "context-menu" event (see `on_menu_event` in `main`).
#[tauri::command]
fn context_menu(app: AppHandle, window: tauri::Window, items: Vec<MenuEntry>) -> Result<(), String> {
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
    let mut menu = MenuBuilder::new(&app);
    for entry in items {
        let Some(id) = entry.id else {
            menu = menu.separator();
            continue;
        };
        let label = entry.label.unwrap_or_default();
        let enabled = entry.enabled.unwrap_or(true);
        if let Some(checked) = entry.checked {
            let item = CheckMenuItemBuilder::with_id(id, label)
                .enabled(enabled)
                .checked(checked)
                .build(&app)
                .map_err(|e| e.to_string())?;
            menu = menu.item(&item);
            continue;
        }
        let plain = || MenuItemBuilder::with_id(id.clone(), label.clone()).enabled(enabled);
        // The shortcut is only shown as a hint; leave it out if the OS can't display it.
        let item = match entry.accel.as_deref() {
            Some(a) => plain().accelerator(a).build(&app).or_else(|_| plain().build(&app)),
            None => plain().build(&app),
        }
        .map_err(|e| e.to_string())?;
        menu = menu.item(&item);
    }
    let menu = menu.build().map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[tauri::command]
fn clipboard_read(app: AppHandle) -> String {
    app.clipboard().read_text().unwrap_or_default()
}

#[tauri::command]
fn clipboard_write(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

/// The app's texts in English and German (i18n/*.json, built into the program).
#[tauri::command]
fn texts() -> serde_json::Value {
    let parse = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap_or_default();
    serde_json::json!({"en": parse(include_str!("../i18n/en.json")), "de": parse(include_str!("../i18n/de.json"))})
}

fn main() {
    let initial = std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|p| p.exists())
        .and_then(|p| p.canonicalize().ok().or(Some(p)))
        .map(|p| path_str(&p).trim_start_matches(r"\\?\").to_string());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_menu_event(|app, event| {
            let _ = app.emit("context-menu", event.id().as_ref());
        })
        .manage(Initial(Mutex::new(initial)))
        .manage(terminal::Terminals::default())
        .manage(lsp::Servers::default())
        .manage(fuzzy::FileLists::default())
        .invoke_handler(tauri::generate_handler![
            texts,
            symbols::symbols_of,
            fuzzy::fuzzy_files,
            fuzzy::fuzzy_rank,
            codespell::code_spell,
            runconfig::run_configs,
            runnables::runnables,
            runnables::test_results,
            tools::format_text,
            tools::lint_file,
            tools::lint_fix,
            git::git_status,
            git::git_head_text,
            git::git_line_changes,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_branches,
            git::git_switch,
            spell::spell_check,
            spell::spell_suggest,
            spell::spell_add,
            spell::spell_ready,
            list_dir,
            read_file,
            stat_files,
            save_file,
            create_file,
            create_dir,
            rename_path,
            delete_path,
            walk_files,
            find_in_files,
            replace_in_files,
            history_list,
            history_read,
            pick_folder,
            pick_file,
            reveal,
            confirm,
            open_url,
            initial_path,
            context_menu,
            clipboard_read,
            clipboard_write,
            terminal::term_start,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_kill,
            lsp::lsp_check,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running Code Studio");
}
