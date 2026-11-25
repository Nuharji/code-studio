# Code Studio

> **Status: Pre-Alpha** — early version (0.x). Things may still change or break.

The IDE of the Studio family (Rust / Tauri 2) — works like a JetBrains IDE (Search Everywhere, Go to File/Symbol,
JetBrains shortcuts, project tree, Find in Files, terminal, local history) and looks like Markdown, PDF and Data Studio.

- UI: `ui/` (Monaco editor, xterm.js), symbols for the Structure panel: `ui/symbols.js`
- Native backend: `src-tauri/src/main.rs` (files, search, local history), `src-tauri/src/terminal.rs` (pseudo terminal)

Language servers (stage 2): `ui/lsp.js` (protocol client) and `src-tauri/src/lsp.rs` (starts the server, moves messages).
Live templates (postfix, Surround With): `ui/templates.js`, built-in sets in `src-tauri/templates/builtin.json`, logic in `src-tauri/src/templates.rs`.
Git blame and file history: `ui/blame.js`, backend in `src-tauri/src/git.rs`.
Roadmap: debugger (P-002), merge conflicts (rest of P-004). No Flatpak: inside its sandbox the terminal can't reach the system's tools.

## Shared with the other Studio apps
Theme, layout and language are shared with the other Studio apps (`shared.rs` / `ui/shared.js`, the same files in every
app; layouts in `ui/layouts.css`): a change in Studio Hub or another app shows up here too — or, with
Settings → Appearance → “Only for this app”, Code Studio keeps its own theme and layout. Folder dialogs start in the
shared work folder. “Send to Agent Studio…” (Code menu, right-click in the editor or the project tree) hands the open
file, the selection or a folder with a task to Agent Studio (`agentlink.rs` / `ui/agentlink.js`).

## MCP
Code Studio is also an MCP server, so Claude (Desktop or Code), ChatGPT and other MCP clients can use what it can do:
started with `--mcp`, the program opens no window and speaks MCP on stdin / stdout until the client closes it.

- `project_overview` — number of files, the run configurations Code Studio finds and the git state of a project folder.
- `project_files` — the files of a project (`.gitignore` respected), optionally filtered.
- `find_in_files` — Find in Files: every match with file, line, column and text (regex, case, whole word, file mask).
- `file_symbols` — the structure of a source file (functions, types, classes … with line and depth).
- `file_runnables` — mains, tests and test modules of a file, each with the command that runs exactly that.
- `format_file` — the file formatted by the project's own formatter (the file itself is not changed).

Nothing is written. Files and folders are given as full paths.

Claude Code: `claude mcp add code-studio -- "/Applications/Code Studio.app/Contents/MacOS/code-studio" --mcp`.
Claude Desktop (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "code-studio": {
      "command": "/Applications/Code Studio.app/Contents/MacOS/code-studio",
      "args": [
        "--mcp"
      ]
    }
  }
}
```
The program is `/Applications/Code Studio.app/Contents/MacOS/code-studio` on macOS, `code-studio.exe` in the install folder on
Windows, and `code-studio` (or the AppImage) on Linux.

## Build (Windows x64)

```powershell
.\build-windows.ps1          # installers + portable exe in .\dist
```