# Code Studio

> **Status: Pre-Alpha** — early version (0.x). Things may still change or break.

The IDE of the Studio family (Rust / Tauri 2) — works like a JetBrains IDE (Search Everywhere, Go to File/Symbol,
JetBrains shortcuts, project tree, Find in Files, terminal, local history) and looks like Markdown, PDF and Data Studio.

- UI: `ui/` (Monaco editor, xterm.js), symbols for the Structure panel: `ui/symbols.js`
- Native backend: `src-tauri/src/main.rs` (files, search, local history), `src-tauri/src/terminal.rs` (pseudo terminal)

Language servers (stage 2): `ui/lsp.js` (protocol client) and `src-tauri/src/lsp.rs` (starts the server, moves messages).
Live templates (postfix, Surround With): `ui/templates.js`, built-in sets in `src-tauri/templates/builtin.json`, logic in `src-tauri/src/templates.rs`.
Roadmap: debugger (P-002), Git history / blame / merge conflicts (P-004). No Flatpak: inside its sandbox the terminal can't reach the system's tools.

## Build (Windows x64)

```powershell
.\build-windows.ps1          # installers + portable exe in .\dist
```