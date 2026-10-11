# Changelog

## 0.4.0 — 2026-10-11
- New: Auto-hide bars (View menu, or Settings → General). The menu bar, toolbar, tool rail and status bar leave the window and slide in when the mouse touches their edge; they stay while a menu is open or you type in them. Alt alone shows the top bars (Escape or a click elsewhere hides them).

## 0.3.0 — 2026-10-11
- Spelling & grammar check, German and English, entirely on your PC: comments in code — and the whole text of Markdown and plain-text files — get squiggles for unknown words and grammar hints. Strings and code are skipped; words that also occur as identifiers in the file count as known.
- Fixes in the right-click menu and in Quick Fix (Ctrl+.): suggestions, “Add to dictionary” (a personal dictionary shared by all Studio apps), “Ignore”.
- Settings → Editor → Spelling & grammar: Automatic (German + English), German, English or Off.
- The portable .zip now includes the dictionaries (separate files with their own licenses, see dictionaries/README.md); the bare portable .exe has no spell check.

## 0.2.6 — 2026-10-11
- Search Everywhere: matching and ranking of files, symbols and actions now run in the Rust core (same results as before; the project file list no longer travels to the UI for every keystroke).

## 0.2.5 — 2026-10-11
- Symbols (Structure panel, Go to Symbol, breadcrumb) are now found by the Rust core.
- Fixed: the Structure panel of JSON files was always empty — it now lists the top two levels of keys.
- Fixed: Rust functions named `new` were missing from the Structure panel.
- Fixed: HTML sections with an id now show it (e.g. `section#intro`).

## 0.2.4 — 2026-10-11
- The English and German texts are now language files (src-tauri/i18n) delivered by the app's Rust core instead of being part of the JavaScript.

## 0.2.3 — 2026-10-10
- Toolbar and tool-rail buttons no longer stay outlined when their panel is open — like in Markdown Studio; the panel tabs show what's open.

## 0.2.2 — 2026-10-10
- Icon fades swapped: dark themes now show the dark fade and light themes the light fade — in the menu bar, on the start screen and in the taskbar.

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
