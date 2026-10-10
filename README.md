# Code Studio

The IDE of the Studio family (Rust / Tauri 2) — works like a JetBrains IDE (Search Everywhere, Go to File/Symbol,
JetBrains shortcuts, project tree, Find in Files, terminal, local history) and looks like Markdown, PDF and Data Studio.

- UI: `ui/` (Monaco editor, xterm.js), symbols for the Structure panel: `ui/symbols.js`
- Native backend: `src-tauri/src/main.rs` (files, search, local history), `src-tauri/src/terminal.rs` (pseudo terminal)

Language servers (stage 2): `ui/lsp.js` (protocol client) and `src-tauri/src/lsp.rs` (starts the server, moves messages).
Roadmap: stage 3 adds run configurations and Git. No Flatpak: inside its sandbox the terminal can't reach the system's tools.

## Build (Windows x64)

```powershell
.\build-windows.ps1          # installers + portable exe in .\dist
```