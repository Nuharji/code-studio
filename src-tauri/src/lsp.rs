//! Language servers (rust-analyzer, pyright, typescript-language-server …) for code intelligence.
//! The UI speaks the Language Server Protocol; this module only starts the server and moves the
//! framed JSON messages: "lsp-msg" ({id, msg}) for every message from a server, "lsp-exit" (id) when it ends,
//! "lsp-log" ({id, msg}) for its error output.

use serde::Serialize;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, State};

struct Server {
    stdin: ChildStdin,
    child: Child,
}

#[derive(Default)]
pub struct Servers {
    map: Mutex<HashMap<u32, Server>>,
    next: Mutex<u32>,
}

#[derive(Serialize, Clone)]
struct Msg {
    id: u32,
    msg: String,
}

/// Folders where developer tools usually live but which may be missing from PATH of a desktop app.
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    if let Some(h) = &home {
        dirs.push(h.join(".cargo").join("bin"));
        dirs.push(h.join(".local").join("bin"));
    }
    #[cfg(windows)]
    if let Some(a) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(a).join("npm"));
    }
    #[cfg(not(windows))]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }
    dirs
}

/// Finds an executable by name in PATH and the usual tool folders (on Windows also name.exe / .cmd).
pub(crate) fn find_exe(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    if p.is_absolute() {
        return p.is_file().then(|| p.to_path_buf());
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|v| std::env::split_paths(&v).collect()).unwrap_or_default();
    dirs.extend(extra_dirs());
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
    for d in dirs {
        for e in exts {
            let c = d.join(format!("{name}{e}"));
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

pub(crate) fn command_for(exe: &Path, args: &[String]) -> Command {
    // npm installs servers as .cmd scripts, which Windows can only start through cmd.
    let script = exe.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    let mut cmd = if script {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(exe);
        c
    } else {
        Command::new(exe)
    };
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console window pops up
    }
    cmd
}

/// Whether a language server is installed and actually runs (rustup's rust-analyzer shim exists even
/// when the component is missing, so the tool is asked for its version).
#[tauri::command]
pub async fn lsp_check(command: String, version_arg: Option<String>) -> Option<String> {
    let exe = find_exe(&command)?;
    let Some(arg) = version_arg else { return Some(exe.to_string_lossy().into_owned()) };
    let out = command_for(&exe, &[arg]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| exe.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn lsp_start(app: AppHandle, state: State<Servers>, command: String, args: Vec<String>, cwd: String) -> Result<u32, String> {
    let exe = find_exe(&command).ok_or_else(|| format!("{command} not found"))?;
    let mut child = command_for(&exe, &args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{command}: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take();
    let id = {
        let mut n = state.next.lock().unwrap();
        *n += 1;
        *n
    };
    state.map.lock().unwrap().insert(id, Server { stdin, child });

    // Messages: "Content-Length: N\r\n\r\n" + N bytes of JSON.
    let a = app.clone();
    std::thread::spawn(move || {
        let mut r = BufReader::new(stdout);
        loop {
            let mut len: Option<usize> = None;
            let mut line = String::new();
            loop {
                line.clear();
                match r.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        let _ = a.emit("lsp-exit", id);
                        return;
                    }
                    Ok(_) => {}
                }
                let l = line.trim();
                if l.is_empty() {
                    if len.is_some() {
                        break;
                    }
                    continue;
                }
                if let Some(v) = l.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().ok();
                }
            }
            let mut body = vec![0u8; len.unwrap_or(0)];
            if r.read_exact(&mut body).is_err() {
                let _ = a.emit("lsp-exit", id);
                return;
            }
            let _ = a.emit("lsp-msg", Msg { id, msg: String::from_utf8_lossy(&body).into_owned() });
        }
    });
    if let Some(err) = stderr {
        let a = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = a.emit("lsp-log", Msg { id, msg: line });
            }
        });
    }
    Ok(id)
}

#[tauri::command]
pub fn lsp_send(state: State<Servers>, id: u32, msg: String) -> Result<(), String> {
    let mut map = state.map.lock().unwrap();
    let s = map.get_mut(&id).ok_or("language server stopped")?;
    write!(s.stdin, "Content-Length: {}\r\n\r\n{}", msg.len(), msg).map_err(|e| e.to_string())?;
    s.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lsp_stop(state: State<Servers>, id: u32) {
    if let Some(mut s) = state.map.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
}
