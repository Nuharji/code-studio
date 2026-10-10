//! Built-in terminal: a real shell in a pseudo console (ConPTY on Windows, a pty on macOS/Linux).
//! Output reaches the UI as "term-data" events ({id, data}); "term-exit" ({id}) when the shell ends.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, State};

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    map: Mutex<HashMap<u32, Term>>,
    next: Mutex<u32>,
}

#[derive(Serialize, Clone)]
struct Data {
    id: u32,
    data: String,
}

/// The user's shell: the configured one, else PowerShell 7 / Windows PowerShell on Windows, $SHELL elsewhere.
fn default_shell() -> String {
    #[cfg(windows)]
    {
        let has_pwsh = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).any(|d| d.join("pwsh.exe").is_file()))
            .unwrap_or(false);
        if has_pwsh { "pwsh.exe".into() } else { "powershell.exe".into() }
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

#[tauri::command]
pub fn term_start(app: AppHandle, state: State<Terminals>, cwd: String, cols: u16, rows: u16, shell: Option<String>) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let shell = shell.filter(|s| !s.trim().is_empty()).unwrap_or_else(default_shell);
    let mut parts = shell.split_whitespace();
    let mut cmd = CommandBuilder::new(parts.next().unwrap_or("sh"));
    for a in parts {
        cmd.arg(a);
    }
    if std::path::Path::new(&cwd).is_dir() {
        cmd.cwd(&cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("{shell}: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = {
        let mut n = state.next.lock().unwrap();
        *n += 1;
        *n
    };
    state.map.lock().unwrap().insert(id, Term { master: pair.master, writer, child });

    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // Only send complete UTF-8 characters; keep a cut-off one for the next read.
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(),
                    };
                    let data = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    if !data.is_empty() {
                        let _ = app.emit("term-data", Data { id, data });
                    }
                }
            }
        }
        let _ = app.emit("term-exit", id);
    });
    Ok(id)
}

#[tauri::command]
pub fn term_write(state: State<Terminals>, id: u32, data: String) -> Result<(), String> {
    let mut map = state.map.lock().unwrap();
    let t = map.get_mut(&id).ok_or("terminal closed")?;
    t.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    t.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(state: State<Terminals>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.map.lock().unwrap();
    let t = map.get(&id).ok_or("terminal closed")?;
    t.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_kill(state: State<Terminals>, id: u32) {
    if let Some(mut t) = state.map.lock().unwrap().remove(&id) {
        let _ = t.child.kill();
    }
}
