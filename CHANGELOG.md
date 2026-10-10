# Changelog

## 0.2.1 — 2026-10-10
- The app icon follows the theme: a light fade in dark themes, a dark fade in light themes — in the menu bar, on the start screen and in the window/taskbar icon.
- All Studio icons now have exactly the same rounded corners.

## 0.2.0 — 2026-10-10
- Code intelligence through language servers (stage 2): autocomplete across files, documentation on hover (Ctrl+Q), parameter info (Ctrl+P), Go to Declaration (Ctrl+B / Ctrl+Click) and Implementation (Ctrl+Alt+B) — also into other files, Find Usages (Alt+F7), Rename everywhere (Shift+F6), quick fixes (Alt+Enter), Reformat Code with the language's formatter.
- Live errors and warnings in the editor and in the new Problems panel (Alt+6); counts in the status bar.
- Supported: Rust (rust-analyzer), Python (Pyright) and TypeScript/JavaScript (typescript-language-server). The status bar shows the server's state (e.g. indexing) and offers to install a missing one in the terminal.
- Fixed: files could open twice when a path was spelled with a lower-case drive letter.
## 0.1.0 — 2026-10-10
- First version of Code Studio, the IDE of the Studio family (stage 1 of 3): same layout and themes as Markdown, PDF and Data Studio.
- Projects: open a folder or create one from a template (Rust, Node.js + TypeScript, Python, static website, empty); recent projects on the start screen; tabs and layout are remembered per project.
- Editor with Monaco (the engine of VS Code): syntax highlighting for 80+ languages, multi-cursor, folding, minimap, sticky scroll, split editor.
- JetBrains-style navigation: Search Everywhere (Double Shift), Go to File / Symbol / Action, Recent Files (Ctrl+E), Back / Forward, Go to Line, JetBrains shortcuts (Ctrl+D duplicate, Ctrl+Y delete line, Ctrl+W extend selection, Ctrl+Alt+L format, Alt+J next occurrence …).
- Project tree with file icons, new file/folder, rename, delete to the recycle bin; respects .gitignore in search.
- Find and Replace in Files with live results and preview; results panel.
- Structure and TODO panels, breadcrumb in the status bar, line endings / indentation switch.
- Built-in terminal (PowerShell on Windows, your shell on macOS/Linux), several tabs.
- Local history: every save is kept; compare any version side by side and revert.
- Saves automatically when you switch apps, close tabs or quit; reloads files changed by other programs.
