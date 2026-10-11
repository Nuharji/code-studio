'use strict';
/* Code Studio — a JetBrains-style IDE in the Studio family layout.
   Stage 1: projects, editor (Monaco), tabs + split, Search Everywhere, Go to File/Symbol/Action, Recent Files,
   Find/Replace in Files, Structure, TODO, terminal, local history. */
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const IS_MAC = /Mac/.test(navigator.platform);

/* ================= Texts (English / German) ================= */
/* The texts (English / German) live in src-tauri/i18n/*.json and are loaded from Rust at start. */
let I18N = {en: {}, de: {}};
let lang = 'en';
const t = (k, vars) => {
  let s = (I18N[lang] && I18N[lang][k]) ?? I18N.en[k] ?? k;
  if (vars) for (const [a, b] of Object.entries(vars)) s = s.split('{' + a + '}').join(b);
  return s;
};
const num = n => Number(n).toLocaleString(lang === 'de' ? 'de-DE' : 'en-US');
const fmtKey = k => {
  if (!k) return '';
  let s = k.replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓');
  if (IS_MAC) s = s.replace('Ctrl+', '⌘').replace('Alt+', '⌥').replace('Shift+', '⇧');
  else if (lang === 'de') s = s.replace('Ctrl+', 'Strg+').replace('Shift+', 'Umschalt+').replace('Shift Shift', '2× Umschalt');
  return s;
};

/* ================= Settings & state ================= */
const STORE = 'code-studio';
const THEMES = ['dark', 'light', 'github', 'github-dark'];
const DEF = {keys: {}, autoHide: false, lang: 'auto', theme: 'dark', dock: true, dockTab: 'project', dockW: 320, bottom: false, bottomTab: 'terminal', bottomH: 260,
  fontSize: 14, tabSize: 4, wordWrap: false, minimap: true, whitespace: false, sticky: true, ligatures: true,
  autoSave: true, singleClick: true, reopen: true, shell: '', spell: 'auto', formatOnSave: false, lintOnSave: true, useClippy: false};
let settings = {...DEF}, recentProjects = [], booted = false;
const effectiveLang = () => settings.lang === 'auto' ? ((navigator.language || 'en').toLowerCase().startsWith('de') ? 'de' : 'en') : settings.lang;
function saveState() {
  try { localStorage.setItem(STORE, JSON.stringify({settings, recentProjects, last: project && project.root})); } catch (e) {}
}
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (saved) { settings = {...DEF, ...saved.settings}; recentProjects = saved.recentProjects || []; }
} catch (e) {}
lang = effectiveLang();

/* ================= Backend access ================= */
const enc = s => encodeURIComponent(s);
async function readBytes(path) { return new Uint8Array(await invoke('read_file', {path})); }
async function writeText(path, text) { return invoke('save_file', new TextEncoder().encode(text), {headers: {'x-path': enc(path)}}); }
let sep = '\\';
const join = (...parts) => parts.filter(Boolean).join(sep).replace(/[\\/]+/g, sep);
const baseName = p => p.split(/[\\/]/).pop();
const dirName = p => p.slice(0, Math.max(0, p.search(/[\\/][^\\/]*$/)));
const relPath = p => project && p.startsWith(project.root) ? p.slice(project.root.length).replace(/^[\\/]/, '').replace(/\\/g, '/') : p;
const absPath = r => join(project.root, r.replace(/\//g, sep));
const isUnder = (p, dir) => p === dir || p.startsWith(dir + sep);
/* One spelling per file: Windows drive letters in upper case (Monaco and language servers may use c:\…). */
const canon = p => /^[a-z]:[\\/]/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
const extOf = p => { const n = baseName(p).toLowerCase(), i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1) : ''; };

/* ================= Monaco ================= */
let monaco = null;
const monacoReady = new Promise(resolve => {
  // Absolute path: the language workers (JSON, TypeScript, CSS, HTML) load their code relative to it.
  window.require.config({paths: {vs: new URL('vendor/monaco/vs', location.href).href}});
  const go = () => window.require(['vs/editor/editor.main'], () => { monaco = window.monaco; resolve(monaco); });
  if (lang === 'de') {
    const s = document.createElement('script');
    s.src = 'vendor/monaco/vs/nls.messages.de.js'; s.onload = s.onerror = go;
    document.head.append(s);
  } else go();
});
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function defineThemes() {
  const T = {
    dark: ['vs-dark', '#1e1e1e', '#262626', '#f5922e', '#3a2a1a'], light: ['vs', '#ffffff', '#f5f5f5', '#c25a00', '#fde3c8'],
    github: ['vs', '#ffffff', '#f6f8fa', '#0969da', '#ddf4ff'], 'github-dark': ['vs-dark', '#0d1117', '#151b23', '#4493f8', '#1f2a3a']
  };
  for (const [k, [base, bg, line, accent, sel]] of Object.entries(T)) monaco.editor.defineTheme('studio-' + k, {
    base, inherit: true, rules: [],
    colors: {'editor.background': bg, 'editorGutter.background': bg, 'minimap.background': bg, 'editor.lineHighlightBackground': line,
      'editor.lineHighlightBorder': line, 'editorCursor.foreground': accent, 'editorLineNumber.activeForeground': accent,
      'editor.selectionHighlightBackground': sel + '99', 'editorWidget.background': base === 'vs' ? '#f8f8f8' : bg === '#1e1e1e' ? '#2c2c2c' : '#151b23',
      'stickyScroll.background': bg, 'editorStickyScrollHover.background': line}
  });
}
let EXT_LANG = null;
function langFor(path) {
  if (!EXT_LANG) {
    EXT_LANG = {names: {}, exts: {}};
    for (const l of monaco.languages.getLanguages()) {
      (l.extensions || []).forEach(e => { EXT_LANG.exts[e.toLowerCase()] ??= l.id; });
      (l.filenames || []).forEach(f => { EXT_LANG.names[f.toLowerCase()] = l.id; });
    }
    Object.assign(EXT_LANG.exts, {'.toml': 'ini', '.lock': 'ini', '.mjs': 'javascript', '.cjs': 'javascript', '.mts': 'typescript', '.cts': 'typescript', '.jsonc': 'json', '.svelte': 'html', '.vue': 'html'});
    Object.assign(EXT_LANG.names, {'.gitignore': 'ini', '.env': 'ini', 'cargo.lock': 'ini', 'makefile': 'shell'});
  }
  const n = baseName(path).toLowerCase();
  if (EXT_LANG.names[n]) return EXT_LANG.names[n];
  const i = n.lastIndexOf('.');
  return (i >= 0 && EXT_LANG.exts[n.slice(i)]) || 'plaintext';
}
const langName = id => { const l = monaco.languages.getLanguages().find(x => x.id === id); return l && l.aliases ? l.aliases[0] : id; };
const editorOptions = () => ({
  fontSize: settings.fontSize, fontFamily: cssVar('--font-code') || 'Consolas, monospace', fontLigatures: settings.ligatures, tabSize: settings.tabSize,
  wordWrap: settings.wordWrap ? 'on' : 'off', minimap: {enabled: settings.minimap}, renderWhitespace: settings.whitespace ? 'all' : 'selection',
  stickyScroll: {enabled: settings.sticky}, lineNumbers: 'on', bracketPairColorization: {enabled: true}, guides: {bracketPairs: 'active', indentation: true},
  smoothScrolling: true, cursorBlinking: 'smooth', cursorSmoothCaretAnimation: 'on', automaticLayout: true, contextmenu: false, fixedOverflowWidgets: true,
  mouseWheelZoom: true, scrollBeyondLastLine: true, renderLineHighlight: 'all', padding: {top: 6}, multiCursorModifier: 'alt', linkedEditing: true,
  'semanticHighlighting.enabled': true, theme: 'studio-' + settings.theme, glyphMargin: true
});

/* ================= Project ================= */
let project = null;          // {root, name}
let fileList = null;         // cached relative paths for Go to File
let recentFiles = [];        // absolute paths, most recent first
const AV_COLORS = ['#e8710a', '#378ef0', '#12a06b', '#e5384f', '#7b4dff', '#22b8b0', '#c2410c', '#6366f1'];
const avColor = name => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return AV_COLORS[h % AV_COLORS.length]; };
const avText = name => { const w = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean); return ((w[0] || '?')[0] + (w[1] ? w[1][0] : (w[0] || '')[1] || '')).toUpperCase(); };
const sessionKey = root => 'code-studio:project:' + root.toLowerCase();

async function openProject(root, opts = {}) {
  root = canon(root.replace(/[\\/]+$/, ''));
  try { await invoke('list_dir', {path: root}); } catch (e) { toast(t('toast.noFolder')); recentProjects = recentProjects.filter(p => p.path !== root); renderRecent(); saveState(); return false; }
  if (project) await closeProject(true);
  sep = root.includes('\\') ? '\\' : '/';
  project = {root, name: baseName(root) || root};
  recentProjects = [{path: root, name: project.name}, ...recentProjects.filter(p => p.path.toLowerCase() !== root.toLowerCase())].slice(0, 20);
  fileList = null;
  let sess = null;
  try { sess = JSON.parse(localStorage.getItem(sessionKey(root)) || 'null'); } catch (e) {}
  tree.expanded = new Set([root, ...((sess && sess.expanded) || []).filter(p => isUnder(p, root))]);
  tree.children.clear(); tree.sel = null;
  recentFiles = ((sess && sess.recent) || []).filter(p => isUnder(p, root));
  runState = {custom: (sess && sess.run && sess.run.custom) || [], selected: (sess && sess.run && sess.run.selected) || null};
  $('#emptyState').hidden = true; $('#editors').hidden = false;
  await monacoReady;
  ensureGroups(sess && sess.split ? 2 : 1);
  await refreshTree();
  loadRunConfigs(); refreshGit();
  if (sess && !opts.fresh) {
    for (let gi = 0; gi < groups.length; gi++) {
      for (const p of (sess.tabs && sess.tabs[gi]) || []) await openFile(p, {group: gi, focus: false, quiet: true, noRecent: true});
      const act = sess.active && sess.active[gi];
      if (act && groups[gi].tabs.includes(act)) setActive(groups[gi], act);
    }
  }
  groups.forEach(renderGroup);
  focusGroup(groups[0]);
  applyLayout(); updateUI(); saveState(); saveSession();
  refreshTodo();
  if (settings.bottom && settings.bottomTab === 'terminal') newTerminal();
  return true;
}
function saveSession() {
  if (!project) return;
  try {
    localStorage.setItem(sessionKey(project.root), JSON.stringify({
      tabs: groups.map(g => g.tabs), active: groups.map(g => g.active), split: groups.length > 1,
      expanded: [...tree.expanded].slice(0, 400), recent: recentFiles.slice(0, 30), run: runState
    }));
  } catch (e) {}
}
async function closeProject(switching) {
  if (!project) return;
  if (dirtyFiles().length) { if (settings.autoSave) await saveAll(true); else if (await ask(t('confirm.close'), t('confirm.saveAll'), t('confirm.discard'))) await saveAll(true); }
  saveSession();
  LSP.stopAll();
  for (const term of terms) invoke('term_kill', {id: term.id}).catch(() => {});
  terms.forEach(x => { x.xterm.dispose(); x.el.remove(); }); terms = []; activeTerm = null;
  groups.forEach(g => { g.tabs = []; g.active = null; });
  for (const f of files.values()) disposeFile(f);
  files.clear(); project = null; fileList = null; findState.hits = []; todoHits = [];
  if (!switching) {
    while (groups.length > 1) removeGroup(groups[groups.length - 1]);
    $('#emptyState').hidden = false; $('#editors').hidden = true;
    renderRecent(); renderTree(); buildStructure(); renderFind(); renderTodo(); applyLayout(); updateUI(); saveState();
  }
}
function renderRecent() {
  const box = $('#recent');
  if (!recentProjects.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="sect">${esc(t('ui.recentProjects'))}</div>` + recentProjects.slice(0, 10).map((p, i) =>
    `<div class="proj" data-recent="${i}"><span class="av" style="background:${avColor(p.name)}">${esc(avText(p.name))}</span><span>${esc(p.name)}</span><small>${esc(p.path)}</small>
     <button class="rm" data-rm="${i}" title="${esc(t('ui.remove'))}">&#10005;</button></div>`).join('');
}
$('#recent').addEventListener('click', e => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { recentProjects.splice(+rm.dataset.rm, 1); renderRecent(); saveState(); return; }
  const it = e.target.closest('[data-recent]');
  if (it) openProject(recentProjects[+it.dataset.recent].path);
});

/* ================= Files, tabs & editor groups ================= */
const files = new Map();     // path -> {path, kind: 'text'|'image', model, saved, mtime, bom, url}
let groups = [], focused = null;
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const isDirty = f => f && f.kind === 'text' && f.model.getAlternativeVersionId() !== f.saved;
const dirtyFiles = () => [...files.values()].filter(isDirty);
const curGroup = () => focused || groups[0];
const curPath = () => curGroup() && curGroup().active;
const curFile = () => files.get(curPath());
const curEditor = () => { const g = curGroup(); const f = g && files.get(g.active); return f && f.kind === 'text' ? g.editor : null; };

function makeGroup() {
  const el = document.createElement('div'); el.className = 'group-ed';
  el.innerHTML = `<div class="tabs"></div><div class="ed-host"><div class="monaco"></div><div class="img-view" hidden><img alt=""><span class="cap"></span></div>
    <div class="ed-empty"><div class="hint"></div></div></div>`;
  $('#editors').append(el);
  const g = {el, tabs: [], active: null, views: new Map(), tabsEl: el.querySelector('.tabs'), host: el.querySelector('.monaco'), img: el.querySelector('.img-view'), emptyEl: el.querySelector('.ed-empty')};
  g.editor = monaco.editor.create(g.host, {...editorOptions(), model: null});
  g.editor.onDidFocusEditorWidget(() => focusGroup(g));
  g.editor.onDidChangeCursorPosition(e => { if (g === focused) { updateStatus(); scheduleCrumbs(); } if (e.reason === 3 || e.source === 'api') return; });
  g.editor.onDidChangeCursorSelection(() => { if (g === focused) updateStatus(); });
  g.editor.onDidChangeModelContent(() => { renderTabs(g); updateUI(); scheduleStructure(); scheduleSpell(g.editor.getModel()); scheduleGutter(files.get(g.active)); scheduleRunnables(files.get(g.active)); });
  g.editor.onMouseDown(e => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.event.leftButton) return;
    const r = runnableAt(files.get(g.active), e.target.position.lineNumber); if (r) runRunnable(r);
  });
  el.addEventListener('mousedown', () => focusGroup(g), true);
  fillEmptyHints(g);
  return g;
}
function fillEmptyHints(g) {
  const parts = t('ui.edHints').split('|');
  let h = '';
  for (let i = 0; i < parts.length; i += 2) h += `<span>${esc(parts[i])}</span><span><kbd>${esc(IS_MAC ? fmtKey(parts[i + 1].replace('Strg', 'Ctrl')) : parts[i + 1])}</kbd></span>`;
  g.emptyEl.querySelector('.hint').innerHTML = h;
}
function ensureGroups(n) { while (groups.length < n) groups.push(makeGroup()); }
function removeGroup(g) {
  const i = groups.indexOf(g); if (i < 0 || groups.length === 1) return;
  const target = groups[i === 0 ? 1 : 0];
  for (const p of g.tabs) if (!target.tabs.includes(p)) target.tabs.push(p);
  if (!target.active && g.active) target.active = g.active;
  g.editor.dispose(); g.el.remove(); groups.splice(i, 1);
  if (focused === g) focused = target;
  renderGroup(target); updateUI(); saveSession();
}
function focusGroup(g) {
  if (focused === g) return;
  focused = g;
  groups.forEach(x => x.el.classList.toggle('focused', x === g));
  updateUI(); buildStructure(); scheduleCrumbs();
}

async function loadFile(path, quiet) {
  path = canon(path);
  if (files.has(path)) return files.get(path);
  const name = baseName(path), ext = extOf(path);
  let bytes;
  try { bytes = await readBytes(path); } catch (e) { if (!quiet) toast(t('toast.openFail', {e})); return null; }
  if (bytes.length > 20e6) { if (!quiet) toast(t('toast.tooBig', {name})); return null; }
  if (IMAGE_EXT.has(ext)) {
    const type = ext === 'jpg' ? 'image/jpeg' : ext === 'ico' ? 'image/x-icon' : 'image/' + ext;
    const f = {path, kind: 'image', url: URL.createObjectURL(new Blob([bytes], {type})), size: bytes.length};
    files.set(path, f); return f;
  }
  const bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  let text;
  try {
    if (bytes.subarray(0, 8000).includes(0)) throw new Error('binary');
    text = new TextDecoder('utf-8', {fatal: true}).decode(bom ? bytes.subarray(3) : bytes);
  } catch (e) { if (!quiet) toast(t('toast.binary', {name})); return null; }
  const uri = monaco.Uri.file(path);
  const old = monaco.editor.getModel(uri); if (old) old.dispose();
  const model = monaco.editor.createModel(text, langFor(path), uri);
  const f = {path, kind: 'text', model, saved: model.getAlternativeVersionId(), bom, mtime: 0};
  LSP.attach(model);
  [f.mtime] = await invoke('stat_files', {paths: [path]});
  files.set(path, f);
  return f;
}
function disposeFile(f) {
  if (f.kind === 'text') f.model.dispose(); else URL.revokeObjectURL(f.url);
  files.delete(f.path);
}
/* Opens a file in a group (the focused one by default) and optionally jumps to a line/column. */
async function openFile(path, o = {}) {
  if (!project) return;
  path = canon(path);
  const g = o.group != null ? groups[o.group] || groups[0] : curGroup();
  const before = currentLocation();
  const f = await loadFile(path, o.quiet);
  if (!f) return;
  if (!g.tabs.includes(path)) { const i = g.tabs.indexOf(g.active); g.tabs.splice(i < 0 ? g.tabs.length : i + 1, 0, path); }
  setActive(g, path);
  if (o.line && f.kind === 'text') {
    const sel = new monaco.Range(o.line, o.col || 1, o.line, (o.col || 1) + (o.len || 0));
    g.editor.setSelection(sel); g.editor.revealRangeInCenterIfOutsideViewport(sel, 0);
  }
  if (!o.noRecent) { recentFiles = [path, ...recentFiles.filter(p => p !== path)].slice(0, 50); }
  if (o.line || before && before.path !== path) pushNav(before);
  if (o.focus !== false) { focusGroup(g); if (f.kind === 'text') g.editor.focus(); }
  saveSession();
}
function setActive(g, path) {
  if (g.active && files.get(g.active) && files.get(g.active).kind === 'text' && g.editor.getModel()) g.views.set(g.active, g.editor.saveViewState());
  g.active = path;
  renderGroup(g);
  if (g === curGroup()) { updateUI(); buildStructure(); scheduleCrumbs(); }
  const f = files.get(path); if (f && f.kind === 'text' && f.model) { scheduleSpell(f.model, 150); scheduleGutter(f, 150); scheduleRunnables(f, 100); }
}
function renderGroup(g) {
  const f = files.get(g.active);
  g.host.hidden = !f || f.kind !== 'text'; g.img.hidden = !f || f.kind !== 'image'; g.emptyEl.hidden = !!f;
  if (f && f.kind === 'text') {
    if (g.editor.getModel() !== f.model) { g.editor.setModel(f.model); const vs = g.views.get(f.path); if (vs) g.editor.restoreViewState(vs); }
  } else g.editor.setModel(null);
  if (f && f.kind === 'image') { g.img.querySelector('img').src = f.url; g.img.querySelector('.cap').textContent = `${baseName(f.path)} · ${(f.size / 1024).toFixed(1)} KB`; }
  renderTabs(g);
}
function renderTabs(g) {
  g.tabsEl.innerHTML = g.tabs.map(p => {
    const f = files.get(p);
    return `<div class="tab${p === g.active ? ' active' : ''}${isDirty(f) ? ' dirty' : ''}" data-path="${esc(p)}" title="${esc(relPath(p))}">${fileIcon(p)}
      <span class="name">${esc(baseName(p))}</span><button class="x" data-close="1">&#10005;</button></div>`;
  }).join('');
  const act = g.tabsEl.querySelector('.tab.active'); if (act) act.scrollIntoView({block: 'nearest', inline: 'nearest'});
}
document.addEventListener('click', e => {
  const tab = e.target.closest('.tab'); if (!tab) return;
  const g = groups.find(x => x.tabsEl.contains(tab)); if (!g) return;
  if (e.target.closest('[data-close]')) closeTab(g, tab.dataset.path); else { setActive(g, tab.dataset.path); focusGroup(g); const ed = curEditor(); if (ed) ed.focus(); }
});
document.addEventListener('auxclick', e => {
  const tab = e.button === 1 && e.target.closest('.tab'); if (!tab) return;
  const g = groups.find(x => x.tabsEl.contains(tab)); if (g) closeTab(g, tab.dataset.path);
});
async function closeTab(g, path) {
  if (!path) return;
  const f = files.get(path), elsewhere = groups.some(x => x !== g && x.tabs.includes(path));
  if (isDirty(f) && !elsewhere) {
    if (settings.autoSave) await saveFile(f);
    else if (await ask(t('confirm.closeTab', {name: baseName(path)}), t('confirm.save'), t('confirm.discard'))) await saveFile(f);
  }
  const i = g.tabs.indexOf(path); if (i < 0) return;
  g.tabs.splice(i, 1); g.views.delete(path);
  if (g.active === path) g.active = g.tabs[Math.min(i, g.tabs.length - 1)] || null;
  if (f && !elsewhere) disposeFile(f);
  renderGroup(g);
  if (!g.tabs.length && groups.length > 1) removeGroup(g);
  updateUI(); buildStructure(); saveSession();
}
async function closeTabs(g, keep) { for (const p of [...g.tabs]) if (p !== keep) await closeTab(g, p); }

/* ================= Saving & changes on disk ================= */
async function saveFile(f) {
  if (!f || f.kind !== 'text') return false;
  const id = f.model.getAlternativeVersionId();
  try {
    const text = (f.bom ? '﻿' : '') + f.model.getValue();
    f.mtime = await writeText(f.path, text);
    f.saved = id;
    LSP.saved(f.path); scheduleGit(600);
    if (settings.lintOnSave) scheduleLint(f);
    return true;
  } catch (e) { toast(t('toast.saveFail', {e})); return false; }
}
async function saveAll(quiet) {
  const list = dirtyFiles();
  let n = 0;
  for (const f of list) if (await saveFile(f)) n++;
  groups.forEach(renderTabs); updateUI();
  if (n && !quiet) toast(t('toast.saved', {n}));
  if (n) scheduleTodo();
  return n;
}
/* Files changed by other programs (Git, a build, another editor) are reloaded if they have no unsaved changes here. */
async function checkDisk() {
  if (!project || !invoke) return;
  const list = [...files.values()].filter(f => f.kind === 'text');
  if (list.length) {
    const times = await invoke('stat_files', {paths: list.map(f => f.path)});
    for (let i = 0; i < list.length; i++) {
      const f = list[i], m = times[i];
      if (!m || m === f.mtime) continue;
      if (isDirty(f)) { toast(t('toast.conflict', {name: baseName(f.path)})); f.mtime = m; continue; }
      try {
        const bytes = await readBytes(f.path), bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
        const text = new TextDecoder().decode(bom ? bytes.subarray(3) : bytes);
        if (text !== f.model.getValue()) {
          f.model.pushEditOperations([], [{range: f.model.getFullModelRange(), text}], () => null);
          toast(t('toast.reloaded', {name: baseName(f.path)}));
        }
        f.saved = f.model.getAlternativeVersionId(); f.mtime = m; f.bom = bom;
      } catch (e) {}
    }
    groups.forEach(renderTabs); updateUI();
  }
  fileList = null;
  await refreshTree(true);
}
window.addEventListener('blur', () => { if (settings.autoSave && project) saveAll(true); });
window.addEventListener('focus', () => { checkDisk(); scheduleGit(200); });
if (invoke) {
  const win = window.__TAURI__.window.getCurrentWindow();
  let closing = false;
  win.onCloseRequested(async e => {
    if (closing) return;
    e.preventDefault();
    if (dirtyFiles().length) {
      if (settings.autoSave || await ask(t('confirm.close'), t('confirm.saveAll'), t('confirm.discard'))) await saveAll(true);
    }
    saveSession(); saveState();
    closing = true;
    win.destroy();
  });
}

/* ================= Project tree ================= */
const tree = {expanded: new Set(), children: new Map(), sel: null, rows: []};
const ICON_COLORS = {
  rs: ['RS', '#ce6a2a'], js: ['JS', '#c9a400'], mjs: ['JS', '#c9a400'], cjs: ['JS', '#c9a400'], jsx: ['JX', '#2fa0c4'], ts: ['TS', '#3178c6'], tsx: ['TX', '#3178c6'],
  py: ['PY', '#3776ab'], go: ['GO', '#00a7d0'], java: ['JV', '#b0702c'], kt: ['KT', '#7f52ff'], cs: ['C#', '#68217a'], c: ['C', '#5b6f9b'], h: ['H', '#5b6f9b'],
  cpp: ['C+', '#00599c'], hpp: ['H+', '#00599c'], php: ['PH', '#777bb3'], rb: ['RB', '#cc342d'], swift: ['SW', '#f05138'],
  html: ['<>', '#e34c26'], htm: ['<>', '#e34c26'], css: ['#', '#2965f1'], scss: ['#', '#c6538c'], less: ['#', '#1d365d'], vue: ['V', '#41b883'], svelte: ['S', '#ff3e00'],
  json: ['{}', '#a0841c'], toml: ['TM', '#9c4221'], yaml: ['YM', '#cb171e'], yml: ['YM', '#cb171e'], xml: ['<>', '#8a6d3b'], md: ['M↓', '#4d7cc3'], txt: ['TX', '#7f8c99'],
  sh: ['$', '#4eaa25'], ps1: ['PS', '#3d6fb4'], bat: ['>', '#4d4d4d'], cmd: ['>', '#4d4d4d'], sql: ['SQ', '#e38c00'], lock: ['🔒', '#7f8c99'],
  png: ['IM', '#2bb3a3'], jpg: ['IM', '#2bb3a3'], jpeg: ['IM', '#2bb3a3'], gif: ['IM', '#2bb3a3'], svg: ['SV', '#e8a33d'], ico: ['IM', '#2bb3a3'], webp: ['IM', '#2bb3a3']
};
const FOLDER_SVG = '<svg viewBox="0 0 24 24"><path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/></svg>';
function fileIcon(path, dir) {
  if (dir) return `<span class="fi folder">${FOLDER_SVG}</span>`;
  const n = baseName(path).toLowerCase(), ext = extOf(path);
  let [txt, col] = ICON_COLORS[ext] || [ext ? ext.slice(0, 2).toUpperCase() : '··', '#7f8c99'];
  if (n === 'cargo.toml') [txt, col] = ['RS', '#ce6a2a'];
  else if (n === 'package.json') [txt, col] = ['NP', '#cb3837'];
  else if (n.startsWith('.git')) [txt, col] = ['GI', '#f05032'];
  else if (n === 'dockerfile') [txt, col] = ['DK', '#2496ed'];
  return `<span class="fi" style="background:${col}">${esc(txt)}</span>`;
}
async function loadDir(dir, force) {
  if (!force && tree.children.has(dir)) return tree.children.get(dir);
  try { const list = await invoke('list_dir', {path: dir}); tree.children.set(dir, list); return list; }
  catch (e) { tree.children.set(dir, []); return []; }
}
/* Reloads the folders that are expanded (keeps the tree as it is). */
async function refreshTree(force) {
  if (!project) return;
  const dirs = [...tree.expanded].filter(d => isUnder(d, project.root));
  if (force) tree.children.clear();
  await Promise.all(dirs.map(d => loadDir(d)));
  // Expanded folders that no longer exist are dropped.
  for (const d of dirs) if (d !== project.root) { const parent = tree.children.get(dirName(d)); if (parent && !parent.some(e => e.path === d)) tree.expanded.delete(d); }
  renderTree();
}
function renderTree() {
  const box = $('#tree');
  if (!project) { box.innerHTML = ''; tree.rows = []; return; }
  const rows = [{path: project.root, name: project.name, dir: true, depth: 0, root: true}];
  const walk = (dir, depth) => {
    for (const e of tree.children.get(dir) || []) {
      rows.push({...e, depth});
      if (e.dir && tree.expanded.has(e.path)) walk(e.path, depth + 1);
    }
  };
  if (tree.expanded.has(project.root)) walk(project.root, 1);
  tree.rows = rows;
  box.innerHTML = rows.map((r, i) => `<div class="row${r.root ? ' root' : ''}${r.path === tree.sel ? ' sel' : ''}" data-i="${i}" style="padding-left:${6 + r.depth * 16}px">
    <span class="tw">${r.dir ? (tree.expanded.has(r.path) ? '&#9660;' : '&#9654;') : ''}</span>${fileIcon(r.path, r.dir)}<span class="nm${!r.dir && gitStateOf(r.path) ? ' git-' + gitStateOf(r.path) : ''}">${esc(r.name)}</span>${r.root ? `<span class="hint">${esc(r.path)}</span>` : ''}</div>`).join('');
}
async function toggleDir(path, open) {
  const isOpen = tree.expanded.has(path);
  if (open === isOpen) return;
  if (isOpen) tree.expanded.delete(path); else { await loadDir(path); tree.expanded.add(path); }
  renderTree(); saveSession();
}
function selectRow(path, scroll) {
  tree.sel = path;
  $$('#tree .row').forEach(r => r.classList.toggle('sel', tree.rows[+r.dataset.i].path === path));
  if (scroll) { const i = tree.rows.findIndex(r => r.path === path), el = $(`#tree .row[data-i="${i}"]`); if (el) el.scrollIntoView({block: 'nearest'}); }
}
const rowOf = el => { const r = el && el.closest('#tree .row'); return r ? tree.rows[+r.dataset.i] : null; };
$('#tree').addEventListener('click', e => {
  const r = rowOf(e.target); if (!r) return;
  selectRow(r.path);
  if (r.dir) toggleDir(r.path, !tree.expanded.has(r.path));
  else if (settings.singleClick) openFile(r.path, {focus: false});
});
$('#tree').addEventListener('dblclick', e => { const r = rowOf(e.target); if (r && !r.dir) openFile(r.path); });
$('#tree').addEventListener('keydown', e => {
  const i = tree.rows.findIndex(r => r.path === tree.sel), r = tree.rows[i];
  const go = j => { const x = tree.rows[Math.max(0, Math.min(tree.rows.length - 1, j))]; if (x) selectRow(x.path, true); };
  if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1); }
  else if (!r) return;
  else if (e.key === 'ArrowRight' && r.dir) { e.preventDefault(); if (tree.expanded.has(r.path)) go(i + 1); else toggleDir(r.path, true); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); if (r.dir && tree.expanded.has(r.path)) toggleDir(r.path, false); else { const p = tree.rows.findIndex(x => x.path === dirName(r.path)); if (p >= 0) go(p); } }
  else if (e.key === 'Enter') { e.preventDefault(); if (r.dir) toggleDir(r.path, !tree.expanded.has(r.path)); else openFile(r.path); }
  else if (e.key === 'Delete') { e.preventDefault(); if (!r.root) deletePath(r.path); }
  else if (e.key === 'F2' || (e.shiftKey && e.key === 'F6')) { e.preventDefault(); e.stopPropagation(); if (!r.root) renamePath(r.path); }
});
/* Expands the folders down to the file that is open in the editor and selects it (Alt+F1). */
async function selectInProject(path = curPath()) {
  if (!project || !path || !isUnder(path, project.root)) return;
  showDock('project');
  const chain = [];
  for (let d = dirName(path); d && isUnder(d, project.root); d = dirName(d)) { chain.unshift(d); if (d === project.root) break; }
  for (const d of chain) { await loadDir(d); tree.expanded.add(d); }
  renderTree(); selectRow(path, true); $('#tree').focus();
}
const targetDir = () => { const r = tree.rows.find(x => x.path === tree.sel); return !r ? project.root : r.dir ? r.path : dirName(r.path); };
async function newFile(dir = targetDir()) {
  const name = await promptText(t('a.newFile').replace('…', ''), t('ui.newFileName'), ''); if (!name) return;
  const path = join(dir, name.replace(/\//g, sep));
  try { await invoke('create_file', {path, text: null}); } catch (e) { return toast(t('toast.fail', {e})); }
  await afterFsChange(dirName(path)); openFile(path); selectInProject(path);
}
async function newFolder(dir = targetDir()) {
  const name = await promptText(t('a.newFolder').replace('…', ''), t('ui.newFolderName'), ''); if (!name) return;
  const path = join(dir, name.replace(/\//g, sep));
  try { await invoke('create_dir', {path}); } catch (e) { return toast(t('toast.fail', {e})); }
  await afterFsChange(dir); tree.expanded.add(dirName(path)); await loadDir(path); renderTree(); selectRow(path, true);
}
async function renamePath(path) {
  const name = await promptText(t('ui.rename'), t('ui.newName'), baseName(path), true); if (!name || name === baseName(path)) return;
  const to = join(dirName(path), name);
  for (const f of [...files.values()]) if (isUnder(f.path, path) && isDirty(f)) await saveFile(f);
  try { await invoke('rename_path', {from: path, to}); } catch (e) { return toast(t('toast.fail', {e})); }
  // Open files below the renamed path move with it.
  for (const f of [...files.values()]) {
    if (!isUnder(f.path, path)) continue;
    const np = to + f.path.slice(path.length);
    for (const g of groups) { const i = g.tabs.indexOf(f.path); if (i >= 0) { g.tabs[i] = np; if (g.active === f.path) g.active = np; } }
    disposeFile(f); await loadFile(np, true);
  }
  recentFiles = recentFiles.map(p => isUnder(p, path) ? to + p.slice(path.length) : p);
  if (tree.expanded.has(path)) { tree.expanded.delete(path); tree.expanded.add(to); }
  await afterFsChange(dirName(path)); groups.forEach(renderGroup); selectRow(to, true); updateUI(); saveSession();
}
async function deletePath(path) {
  if (!await ask(t('confirm.delete', {name: baseName(path)}), t('confirm.deleteOk'))) return;
  try { await invoke('delete_path', {path}); } catch (e) { return toast(t('toast.fail', {e})); }
  for (const g of groups) for (const p of [...g.tabs]) if (isUnder(p, path)) { const f = files.get(p); if (f) f.saved = f.model ? f.model.getAlternativeVersionId() : 0; await closeTab(g, p); }
  tree.expanded.delete(path);
  await afterFsChange(dirName(path));
}
async function afterFsChange(dir) { fileList = null; await loadDir(dir, true); renderTree(); scheduleTodo(); }

/* ================= Structure, breadcrumb & status ================= */
/* Symbols are found in Rust (symbols.rs) and kept per file until its text changes. */
async function loadSymbols(f) {
  const version = f.model.getVersionId();
  if (f.syms && f.syms.version === version) return f.syms.list;
  const list = await invoke('symbols_of', {text: f.model.getValue(), lang: f.model.getLanguageId()});
  if (!f.syms || f.syms.version < version) f.syms = {version, list};
  return list;
}
/* The last known symbols right away; when the text has changed they are refreshed and the panel and breadcrumb redrawn. */
let symPending = null;
function symbolsOf(f) {
  if (!f || f.kind !== 'text' || !f.model) return [];
  if (!f.syms || f.syms.version !== f.model.getVersionId()) {
    const key = f.path + '@' + f.model.getVersionId();
    if (symPending !== key) {
      symPending = key;
      loadSymbols(f).then(() => { if (symPending === key) symPending = null; if (f === curFile()) { buildStructure(); renderCrumbs(); } }, () => {});
    }
  }
  return f.syms ? f.syms.list : [];
}
const symBadge = k => { const [c, col] = Symbols.KIND[k] || ['·', '#7f8c99']; return `<span class="sym-k" style="background:${col}">${esc(c)}</span>`; };
let structT;
const scheduleStructure = () => { clearTimeout(structT); structT = setTimeout(buildStructure, 300); };
function buildStructure() {
  const box = $('#symList'), f = curFile();
  if (!f || f.kind !== 'text') { box.innerHTML = `<div class="empty">${esc(t('ui.noFile'))}</div>`; return; }
  const q = $('#symFilter').value.trim().toLowerCase();
  const list = symbolsOf(f).filter(s => !q || s.name.toLowerCase().includes(q));
  box.innerHTML = list.length ? list.map(s => `<div class="row" data-line="${s.line}" style="padding-left:${10 + (q ? 0 : s.depth) * 16}px">${symBadge(s.kind)}<span class="nm">${esc(s.name)}</span><span class="hint">${s.line}</span></div>`).join('')
    : `<div class="empty">${esc(t('ui.noSymbols'))}</div>`;
  markStructure();
}
function markStructure() {
  const ed = curEditor(); if (!ed) return;
  const line = ed.getPosition() ? ed.getPosition().lineNumber : 0, path = Symbols.at(symbolsOf(curFile()), line), cur = path[path.length - 1];
  $$('#symList .row').forEach(r => r.classList.toggle('sel', !!cur && +r.dataset.line === cur.line));
}
$('#symFilter').addEventListener('input', buildStructure);
$('#symList').addEventListener('click', e => { const r = e.target.closest('.row'); if (r) jumpTo(curPath(), +r.dataset.line, 1); });
let crumbT;
const scheduleCrumbs = () => { clearTimeout(crumbT); crumbT = setTimeout(() => { renderCrumbs(); markStructure(); }, 80); };
function renderCrumbs() {
  const box = $('#crumbs'), p = curPath();
  if (!project) { box.innerHTML = ''; return; }
  const parts = [project.name, ...(p ? relPath(p).split('/') : [])];
  const ed = curEditor(), f = curFile();
  const syms = ed && ed.getPosition() ? Symbols.at(symbolsOf(f), ed.getPosition().lineNumber).map(s => s.name) : [];
  box.innerHTML = parts.map((x, i) => i === parts.length - 1 && !syms.length ? `<b>${esc(x)}</b>` : `<span>${esc(x)}</span>`).join('<i>›</i>') +
    syms.map((s, i) => `<i>›</i>${i === syms.length - 1 ? `<b>${esc(s)}</b>` : `<span>${esc(s)}</span>`}`).join('');
}
function updateStatus() {
  const ed = curEditor(), f = curFile(), m = f && f.kind === 'text' ? f.model : null;
  ['#stPos', '#stEol', '#stEnc', '#stIndent', '#stLang'].forEach(s => $(s).hidden = !m);
  if (!m || !ed.getPosition()) return;
  const pos = ed.getPosition(), sel = ed.getSelection(), n = sel ? m.getValueLengthInRange(sel) : 0;
  $('#stPos').textContent = t('st.pos', {l: pos.lineNumber, c: pos.column}) + (n ? ' ' + t('st.sel', {n: num(n)}) : '');
  $('#stEol').textContent = m.getEOL() === '\r\n' ? 'CRLF' : 'LF';
  $('#stEnc').textContent = f.bom ? 'UTF-8 BOM' : 'UTF-8';
  const o = m.getOptions();
  $('#stIndent').textContent = o.insertSpaces ? t('st.spaces', {n: o.tabSize}) : t('st.tab');
  $('#stLang').textContent = langName(m.getLanguageId());
  renderLspStatus();
}
$('#stEol').onclick = () => { const f = curFile(); if (!f || f.kind !== 'text') return; f.model.pushEOL(f.model.getEOL() === '\r\n' ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF); updateStatus(); };
$('#stIndent').onclick = () => { const f = curFile(); if (!f || f.kind !== 'text') return; const o = f.model.getOptions(); f.model.updateOptions({insertSpaces: !o.insertSpaces}); updateStatus(); };
function updateUI() {
  const f = curFile(), dirty = dirtyFiles().length;
  const title = project ? `${f ? baseName(f.path) + (isDirty(f) ? ' ●' : '') + ' — ' : ''}${project.name}` : '';
  $('#apptitle').textContent = project ? `${title}  —  Code Studio` : 'Code Studio';
  document.title = project ? `${title} — Code Studio` : 'Code Studio';
  const st = $('#stState');
  st.className = 'st-state' + (dirty ? ' dirty' : '');
  st.textContent = project ? (dirty ? t('st.unsaved', {n: dirty}) : t('st.saved')) : '';
  $('#layoutSeg').querySelectorAll('button').forEach(b => b.classList.toggle('active', (b.dataset.act === 'layoutSplit') === (groups.length > 1)));
  updateStatus(); renderCrumbs(); syncDisabled();
}

/* ================= Navigation (Back / Forward) ================= */
const nav = {stack: [], i: -1};
function currentLocation() {
  const g = curGroup(), f = g && files.get(g.active);
  if (!f) return null;
  const pos = f.kind === 'text' && g.editor.getPosition();
  return {path: f.path, line: pos ? pos.lineNumber : 1, col: pos ? pos.column : 1};
}
function pushNav(loc) {
  if (!loc) return;
  nav.stack = nav.stack.slice(0, nav.i + 1);
  const last = nav.stack[nav.stack.length - 1];
  if (last && last.path === loc.path && Math.abs(last.line - loc.line) < 3) return;
  nav.stack.push(loc); if (nav.stack.length > 100) nav.stack.shift();
  nav.i = nav.stack.length - 1;
}
async function navGo(d) {
  if (d < 0 && nav.i === nav.stack.length - 1) { const here = currentLocation(); pushNav(here); if (nav.stack[nav.stack.length - 1] === here) nav.i = nav.stack.length - 1; }
  const j = nav.i + d; if (j < 0 || j >= nav.stack.length) return;
  nav.i = j; const loc = nav.stack[j];
  const g = curGroup(), f = await loadFile(loc.path, true); if (!f) return;
  if (!g.tabs.includes(loc.path)) g.tabs.push(loc.path);
  setActive(g, loc.path);
  if (f.kind === 'text') { g.editor.setPosition({lineNumber: loc.line, column: loc.col}); g.editor.revealLineInCenterIfOutsideViewport(loc.line); g.editor.focus(); }
}
async function jumpTo(path, line, col, len) { await openFile(path, {line, col, len}); }

/* ================= Fuzzy matching ================= */
/* Matching and ranking happen in Rust (fuzzy.rs); results carry the matched character positions for highlighting. */
const hl = (s, pos) => { if (!pos || !pos.length) return esc(s); const set = new Set(pos); return [...s].map((c, i) => set.has(i) ? `<b>${esc(c)}</b>` : esc(c)).join(''); };
async function getFileList() {
  if (!fileList && project) fileList = await invoke('walk_files', {root: project.root});
  return fileList || [];
}

/* ================= Popups ================= */
let popup = null;   // {kind, onKey, ...}
function openPopup(kind, html, cls = '') {
  // A fresh element per popup, so no listeners of an earlier popup stay attached.
  const old = $('#popup'), p = old.cloneNode(false); old.replaceWith(p);
  p.className = 'popup ' + cls; p.innerHTML = html; p.style.width = '';
  $('#popupBg').classList.add('show');
  popup = {kind};
  return popup;
}
function closePopup() {
  if (!popup) return;
  if (popup.dispose) popup.dispose();
  popup = null; $('#popupBg').classList.remove('show'); $('#popup').innerHTML = '';
  const ed = curEditor(); if (ed) ed.focus();
}
$('#popupBg').addEventListener('mousedown', e => { if (e.target.id === 'popupBg') closePopup(); });
/* Keyboard selection in a popup list. */
function listNav(e, items, idx, set) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp') {
    e.preventDefault();
    const step = e.key.startsWith('Page') ? 10 : 1, d = e.key.endsWith('Down') ? step : -step;
    set(Math.max(0, Math.min(items.length - 1, idx + d)));
    return true;
  }
  return false;
}
function markSel(box, idx) {
  box.querySelectorAll('.pp-item').forEach((el, i) => el.classList.toggle('sel', i === idx));
  const el = box.querySelectorAll('.pp-item')[idx]; if (el) el.scrollIntoView({block: 'nearest'});
}

/* Search Everywhere (Double Shift) with tabs All / Files / Symbols / Actions. */
const SE_TABS = ['all', 'files', 'symbols', 'actions'];
async function searchEverywhere(tab = 'all', initial = '') {
  if (popup && popup.kind === 'se') { popup.setTab(tab); return; }
  const sel = curEditor() && curEditor().getSelection();
  if (!initial && sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber) initial = curFile().model.getValueInRange(sel);
  const p = openPopup('se', `<div class="pp-tabs">${SE_TABS.map(k => `<button data-se="${k}">${esc(t('ui.' + k))}</button>`).join('')}<span class="note" id="seNote"></span></div>
    <div class="pp-in"><svg class="i" viewBox="0 0 24 24" style="width:16px;height:16px;stroke:var(--dim);fill:none;stroke-width:2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
    <input id="seIn" spellcheck="false" autocomplete="off" placeholder="${esc(t('ui.typeToSearch'))}"></div><div class="pp-list" id="seList"></div>`);
  const input = $('#seIn'), box = $('#seList');
  let items = [], idx = 0, seq = 0;
  p.tab = tab;
  p.setTab = k => { p.tab = k; $$('[data-se]').forEach(b => b.classList.toggle('active', b.dataset.se === k)); $('#seNote').textContent = k === 'symbols' ? t('ui.symbolsNote') : ''; run(); input.focus(); };
  const files$ = async q => {
    const m = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(q), name = m[1], line = m[2] ? +m[2] : 0, col = m[3] ? +m[3] : 0;
    if (!name) return recentFiles.filter(x => x !== curPath()).slice(0, 15).map(x => ({kind: 'file', path: x, html: `${fileIcon(x)}<span class="nm">${esc(baseName(x))}</span><small>${esc(relPath(dirName(x)))}</small>`, line}));
    if (!project) return [];
    await getFileList();   // makes sure Rust has the current file list
    const hits = await invoke('fuzzy_files', {root: project.root, q: name, limit: 60});
    return hits.map(h => ({kind: 'file', path: absPath(h.rel), line, col,
      html: `${fileIcon(h.rel)}<span class="nm">${hl(h.name, h.name_pos)}</span><small>${hl(h.dir, h.dir_pos)}</small>${line ? `<kbd>:${line}</kbd>` : ''}`}));
  };
  // Symbols of all open files; those of the current file rank a little higher.
  const syms$ = async q => {
    const all = [];
    for (const f of files.values()) {
      if (f.kind !== 'text' || !f.model) continue;
      for (const s of await loadSymbols(f)) all.push({f, s});
    }
    const ranked = await invoke('fuzzy_rank', {q, items: all.map(x => x.s.name), bonus: all.map(x => x.f.path === curPath() ? 50 : 0), limit: 60});
    return ranked.map(([i, pos]) => { const {f, s} = all[i]; return {kind: 'sym', path: f.path, line: s.line,
      html: `${symBadge(s.kind)}<span class="nm">${hl(s.name, pos)}</span><small>${esc(baseName(f.path))}:${s.line}</small>`}; });
  };
  const acts$ = async q => {
    const acts = Object.keys(A).filter(a => I18N.en['a.' + a]);
    const ranked = await invoke('fuzzy_rank', {q, items: acts.map(a => t('a.' + a)), bonus: [], limit: 40});
    return ranked.map(([i, pos]) => { const a = acts[i]; return {kind: 'act', act: a, html: `<span class="nm">${hl(t('a.' + a), pos)}</span><kbd>${esc(fmtKey(keyOf(a)))}</kbd>`, disabled: !allowed(a)}; });
  };
  async function run() {
    const q = input.value.trim(), my = ++seq;
    let html = '';
    if (p.tab === 'all') {
      const [fl, sy, ac] = [await files$(q), q ? await syms$(q) : [], q ? await acts$(q) : []];
      if (my !== seq) return;
      items = [];
      const sect = (label, list) => { if (!list.length) return; html += `<div class="pp-sect">${esc(label)}</div>`; list.forEach(it => { html += item(it, items.length); items.push(it); }); };
      sect(q ? t('ui.files') : t('ui.recent'), fl.slice(0, q ? 8 : 15)); sect(t('ui.symbols'), sy.slice(0, 8)); sect(t('ui.actions'), ac.slice(0, 8));
    } else {
      items = p.tab === 'files' ? await files$(q) : p.tab === 'symbols' ? await syms$(q) : await acts$(q);
      if (my !== seq) return;
      html = items.map((it, i) => item(it, i)).join('');
    }
    box.innerHTML = html || `<div class="empty">${esc(t('ui.noResults'))}</div>`;
    idx = 0; markSel(box, idx);
  }
  const item = (it, i) => `<div class="pp-item" data-i="${i}"${it.disabled ? ' style="opacity:.45"' : ''}>${it.html}</div>`;
  async function choose(i) {
    const it = items[i]; if (!it) return;
    closePopup();
    if (it.kind === 'act') { if (!it.disabled) runAct(it.act); return; }
    await openFile(it.path, it.line ? {line: it.line, col: it.col || 1} : {});
  }
  input.addEventListener('input', () => { clearTimeout(p.t); p.t = setTimeout(run, 60); });
  input.addEventListener('keydown', e => {
    if (listNav(e, items, idx, v => { idx = v; markSel(box, idx); })) return;
    if (e.key === 'Enter') { e.preventDefault(); choose(idx); }
    else if (e.key === 'Tab') { e.preventDefault(); const k = SE_TABS[(SE_TABS.indexOf(p.tab) + (e.shiftKey ? 3 : 1)) % 4]; p.setTab(k); }
  });
  box.addEventListener('click', e => { const el = e.target.closest('.pp-item'); if (el) choose(+el.dataset.i); });
  $('#popup').querySelector('.pp-tabs').addEventListener('click', e => { const b = e.target.closest('[data-se]'); if (b) p.setTab(b.dataset.se); });
  input.value = initial; p.setTab(tab); input.select();
}

/* Recent Files (Ctrl+E): panels on the left, recently opened files on the right — like the JetBrains switcher. */
function recentFilesPopup() {
  const panels = [['project', 'toggleProject'], ['structure', 'toggleStructure'], ['todo', 'toggleTodo'], ['find', 'toggleFind'], ['terminal', 'toggleTerminal']];
  const list = recentFiles.filter(p => files.has(p) || true).slice(0, 30);
  openPopup('recent', `<div class="pp-tabs"><button class="active">${esc(t('ui.recent'))}</button></div>
    <div class="switcher"><div class="col" id="swPanels">${panels.map(([k, a]) => `<div class="pp-item" data-act="${a}"><span class="nm">${esc(t('a.' + a))}</span><kbd>${esc(fmtKey(keyOf(a)))}</kbd></div>`).join('')}</div>
    <div class="col" id="swFiles">${list.map((p, i) => `<div class="pp-item" data-i="${i}">${fileIcon(p)}<span class="nm">${esc(baseName(p))}</span><small>${esc(relPath(dirName(p)))}</small></div>`).join('') || `<div class="empty">${esc(t('ui.noResults'))}</div>`}</div></div>`);
  const box = $('#swFiles');
  let idx = list[0] === curPath() && list.length > 1 ? 1 : 0;
  markSel(box, idx);
  const onKey = e => {
    if (!popup || popup.kind !== 'recent') return;
    if (listNav(e, list, idx, v => { idx = v; markSel(box, idx); })) return;
    if (e.key === 'Enter') { e.preventDefault(); const p = list[idx]; closePopup(); if (p) openFile(p); }
    else if (e.key === 'e' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); idx = (idx + 1) % Math.max(1, list.length); markSel(box, idx); }
  };
  window.addEventListener('keydown', onKey, true);
  popup.dispose = () => window.removeEventListener('keydown', onKey, true);
  box.addEventListener('click', e => { const el = e.target.closest('.pp-item'); if (el) { closePopup(); openFile(list[+el.dataset.i]); } });
  $('#swPanels').addEventListener('click', e => { const el = e.target.closest('[data-act]'); if (el) { closePopup(); } });
}
function goToLine() {
  const ed = curEditor(); if (!ed) return;
  const pos = ed.getPosition();
  openPopup('line', `<div class="pp-in"><span style="color:var(--dim)">${esc(t('ui.line'))}</span><input id="lnIn" spellcheck="false" value="${pos.lineNumber}:${pos.column}"></div>`, 'small');
  $('#popup').style.width = '360px';
  const input = $('#lnIn'); input.select();
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const m = /^\s*(\d+)?(?:\s*[:,]\s*(\d+))?/.exec(input.value), path = curPath();
    closePopup();
    if (m && m[1]) jumpTo(path, Math.min(+m[1], curFile().model.getLineCount()), +(m[2] || 1));
  });
}
/* Small input dialog (new file, rename). Resolves with the text or null. */
function promptText(title, label, value, selectStem) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; closeModal(); resolve(v); };
    modal(title, `<label class="lbl">${esc(label)}</label><input class="field-in" id="promptIn" spellcheck="false" value="${esc(value)}">`, [
      {label: t('ui.cancel'), onClick: () => finish(null)}, {label: t('ui.ok'), primary: true, onClick: () => finish($('#promptIn').value.trim() || null)}]);
    modalOnClose = () => finish(null);
    const inp = $('#promptIn'); inp.focus();
    const dot = value.lastIndexOf('.');
    if (selectStem && dot > 0) inp.setSelectionRange(0, dot); else inp.select();
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); finish(inp.value.trim() || null); } };
  });
}

/* ================= Find / Replace in Files ================= */
const findState = {q: '', repl: '', case: false, word: false, regex: false, scope: 'project', dir: '', mask: '', hits: [], query: null};
const groupHits = hits => { const m = new Map(); for (const h of hits) { if (!m.has(h.path)) m.set(h.path, []); m.get(h.path).push(h); } return m; };
const hitText = h => {
  // Highlight the match inside the shown line excerpt.
  const lead = h.text.startsWith('…') ? 1 : 0, chars = [...h.text];
  const raw = chars.slice(lead).join(''), fullLine = raw.endsWith('…') ? raw.slice(0, -1) : raw;
  let start = -1;
  if (!lead) start = h.col - 1; else { const pre = 80; start = Math.min(pre, h.col - 1); }
  const arr = [...fullLine];
  if (start < 0 || start > arr.length) return esc(h.text);
  return (lead ? '…' : '') + esc(arr.slice(0, start).join('').replace(/^\s+/, '')) + `<mark>${esc(arr.slice(start, start + h.len).join(''))}</mark>` + esc(arr.slice(start + h.len).join('')) + (raw.endsWith('…') ? '…' : '');
};
const findOpts = () => ({query: findState.q, regex: findState.regex, case: findState.case, word: findState.word,
  scope: findState.scope === 'dir' && findState.dir ? relPath(findState.dir).replace(/\/?$/, '/') : '', mask: findState.mask});
async function findInFilesPopup(replace, dir) {
  if (!project) return toast(t('toast.needProject'));
  if (settings.autoSave) await saveAll(true);
  const ed = curEditor(), sel = ed && ed.getSelection();
  if (sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber) findState.q = curFile().model.getValueInRange(sel);
  if (dir) { findState.scope = 'dir'; findState.dir = dir; }
  const p = openPopup('fif', `<div class="pp-tabs"><button class="active">${esc(t(replace ? 'a.replaceInFiles' : 'a.findInFiles').replace('…', ''))}</button><span class="note" id="fifCount"></span></div>
    <div class="pp-in"><input id="fifQ" spellcheck="false" placeholder="${esc(t('ui.findPh'))}">
      <button class="tog" data-tog="case" title="${esc(t('ui.matchCase'))}">Cc</button><button class="tog" data-tog="word" title="${esc(t('ui.words'))}">W</button><button class="tog" data-tog="regex" title="${esc(t('ui.regex'))}">.*</button></div>
    ${replace ? `<div class="pp-in"><input id="fifR" spellcheck="false" placeholder="${esc(t('ui.replacePh'))}"></div>` : ''}
    <div class="fif-opts"><div class="seg" id="fifScope"><button data-scope="project">${esc(t('ui.scopeProject'))}</button><button data-scope="dir">${esc(t('ui.scopeDir'))}</button></div>
      <input class="field-in" id="fifDir" style="flex:1" spellcheck="false"><input class="field-in" id="fifMask" style="width:200px" spellcheck="false" placeholder="${esc(t('ui.mask'))}"></div>
    <div class="fif"><div class="fif-res" id="fifRes"></div><div class="fif-prev"><span class="cap" id="fifCap"></span><div id="fifPrev" style="position:absolute;inset:0"></div></div></div>
    <div class="pp-foot"><span>↑↓ Enter</span><span class="flex"></span>${replace ? `<button class="btn-sm" id="fifReplace">${esc(t('ui.replaceAll'))}</button>` : ''}
      <button class="btn-sm primary" id="fifPanel">${esc(t('ui.openInPanel'))} <kbd style="opacity:.8">${esc(fmtKey('Ctrl+Enter'))}</kbd></button></div>`, 'big');
  const qIn = $('#fifQ'), box = $('#fifRes');
  qIn.value = findState.q; $('#fifDir').value = findState.dir || targetDir(); $('#fifMask').value = findState.mask;
  if (replace) $('#fifR').value = findState.repl;
  const prev = monaco.editor.create($('#fifPrev'), {...editorOptions(), readOnly: true, minimap: {enabled: false}, model: null, lineNumbers: 'on', stickyScroll: {enabled: false}, fontSize: Math.max(11, settings.fontSize - 1)});
  let prevModel = null, deco = [], hits = [], idx = 0, seq = 0;
  p.dispose = () => { prev.dispose(); if (prevModel) prevModel.dispose(); };
  const sync = () => {
    $$('[data-tog]').forEach(b => b.classList.toggle('on', !!findState[b.dataset.tog]));
    $$('#fifScope button').forEach(b => b.classList.toggle('active', b.dataset.scope === findState.scope));
    $('#fifDir').disabled = findState.scope !== 'dir';
  };
  async function showPreview() {
    const h = hits[idx]; markSel(box, idx);
    if (!h) { prev.setModel(null); $('#fifCap').textContent = ''; return; }
    let model = files.get(h.path) && files.get(h.path).model;
    if (!model) {
      if (!prevModel || prevModel.__path !== h.path) {
        if (prevModel) prevModel.dispose();
        try { const b = await readBytes(h.path); prevModel = monaco.editor.createModel(new TextDecoder().decode(b), langFor(h.path)); prevModel.__path = h.path; } catch (e) { return; }
      }
      model = prevModel;
    }
    if (prev.getModel() !== model) prev.setModel(model);
    const r = new monaco.Range(h.line, h.col, h.line, h.col + h.len);
    deco = prev.deltaDecorations(deco, [{range: r, options: {inlineClassName: 'findMatch', className: 'currentFindMatch'}}, {range: r, options: {isWholeLine: true, className: 'rangeHighlight'}}]);
    prev.revealRangeInCenter(r, 1);
    $('#fifCap').textContent = `${relPath(h.path)}:${h.line}`;
  }
  async function search() {
    findState.q = qIn.value; findState.mask = $('#fifMask').value.trim(); findState.dir = $('#fifDir').value.trim();
    if (replace) findState.repl = $('#fifR').value;
    const my = ++seq;
    if (!findState.q) { hits = []; box.innerHTML = ''; $('#fifCount').textContent = ''; showPreview(); return; }
    $('#fifCount').textContent = t('ui.searching');
    let res;
    try { res = await invoke('find_in_files', {root: project.root, opts: findOpts()}); }
    catch (e) { if (my === seq) { hits = []; box.innerHTML = `<div class="empty">${esc(e)}</div>`; $('#fifCount').textContent = ''; } return; }
    if (my !== seq) return;
    hits = res; idx = 0;
    const nf = groupHits(hits).size;
    $('#fifCount').textContent = t('ui.findSum', {n: num(hits.length), f: num(nf), q: findState.q}) + (hits.length >= 5000 ? ' ' + t('ui.findCapped', {n: '5000'}) : '');
    box.innerHTML = hits.slice(0, 1000).map((h, i) => `<div class="pp-item" data-i="${i}" style="font-family:var(--font-code);font-size:12px"><span class="nm">${hitText(h)}</span><kbd>${esc(baseName(h.path))}:${h.line}</kbd></div>`).join('')
      || `<div class="empty">${esc(t('ui.noResults'))}</div>`;
    showPreview();
  }
  const later = () => { clearTimeout(p.t); p.t = setTimeout(search, 220); };
  [qIn, $('#fifMask'), $('#fifDir')].forEach(i => i.addEventListener('input', later));
  if (replace) $('#fifR').addEventListener('input', () => { findState.repl = $('#fifR').value; });
  $('#popup').addEventListener('click', e => {
    const tg = e.target.closest('[data-tog]'); if (tg) { findState[tg.dataset.tog] = !findState[tg.dataset.tog]; sync(); search(); return; }
    const sc = e.target.closest('[data-scope]'); if (sc) { findState.scope = sc.dataset.scope; sync(); search(); return; }
    const it = e.target.closest('#fifRes .pp-item'); if (it) { idx = +it.dataset.i; showPreview(); if (e.detail > 1) openHit(); }
  });
  const openHit = () => { const h = hits[idx]; if (!h) return; closePopup(); jumpTo(h.path, h.line, h.col, h.len); };
  const toPanel = () => { findState.hits = hits; findState.query = {...findOpts()}; closePopup(); renderFind(); showBottom('find'); };
  $('#fifPanel').onclick = toPanel;
  if (replace) $('#fifReplace').onclick = () => replaceAll(hits);
  $('#popup').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toPanel(); return; }
    if (e.target.closest('.monaco-editor')) return;
    if (listNav(e, hits, idx, v => { idx = v; showPreview(); })) return;
    if (e.key === 'Enter' && e.target.id !== 'fifR') { e.preventDefault(); openHit(); }
  });
  sync(); qIn.focus(); qIn.select(); search();
}
async function replaceAll(hits) {
  const g = groupHits(hits);
  if (!hits.length || !await ask(t('confirm.replaceAll', {n: num(hits.length), f: num(g.size)}), t('confirm.replaceOk'))) return;
  await saveAll(true);
  try {
    const n = await invoke('replace_in_files', {root: project.root, opts: findOpts(), replacement: findState.repl, paths: [...g.keys()]});
    closePopup(); toast(t('toast.replaced', {n: num(n)}));
    await checkDisk();
  } catch (e) { toast(t('toast.fail', {e})); }
}
function renderFind() {
  const box = $('#findList'), hits = findState.hits;
  if (!findState.query) { $('#findSum').textContent = ''; box.innerHTML = `<div class="empty">${esc(t('ui.findEmpty'))}</div>`; return; }
  const g = groupHits(hits);
  $('#findSum').innerHTML = esc(findState.query.usages ? t('ui.usagesOf', {name: findState.query.query}) + ' · ' + t('ui.findSum', {n: num(hits.length), f: num(g.size), q: findState.query.query}) : t('ui.findSum', {n: num(hits.length), f: num(g.size), q: findState.query.query}));
  let html = '', i = 0;
  for (const [path, list] of g) {
    html += `<div class="file-group">${fileIcon(path)}<span>${esc(baseName(path))}</span><small>${esc(relPath(dirName(path)))} · ${list.length}</small></div>`;
    for (const h of list) html += `<div class="hit" data-hit="${hits.indexOf(h, i)}"><span class="ln">${h.line}</span><span class="tx">${hitText(h)}</span></div>`;
    i += list.length;
  }
  box.innerHTML = html || `<div class="empty">${esc(t('ui.noResults'))}</div>`;
}
$('#findList').addEventListener('click', e => {
  const el = e.target.closest('[data-hit]'); if (!el) return;
  $$('#findList .hit').forEach(x => x.classList.toggle('sel', x === el));
  const h = findState.hits[+el.dataset.hit]; jumpTo(h.path, h.line, h.col, h.len);
});

/* ================= TODO ================= */
let todoHits = [], todoT;
const scheduleTodo = () => { clearTimeout(todoT); todoT = setTimeout(refreshTodo, 800); };
async function refreshTodo() {
  if (!project) { todoHits = []; renderTodo(); return; }
  try { todoHits = await invoke('find_in_files', {root: project.root, opts: {query: '\\b(TODO|FIXME)\\b', regex: true, case: true, word: false, scope: '', mask: ''}}); }
  catch (e) { todoHits = []; }
  renderTodo();
}
function renderTodo() {
  const g = groupHits(todoHits);
  $('#todoHead').innerHTML = `<span style="flex:1;color:var(--dim)">${todoHits.length ? esc(t('ui.todoSum', {n: num(todoHits.length), f: num(g.size)})) : ''}</span>` +
    `<button class="ibtn" data-act="refreshTodo" title="${esc(t('a.refreshTodo'))}">${ICONS.refresh}</button>`;
  let html = '';
  for (const [path, list] of g) {
    html += `<div class="file-group">${fileIcon(path)}<span>${esc(baseName(path))}</span><small>${esc(relPath(dirName(path)))}</small></div>`;
    for (const h of list) {
      const s = [...h.text.replace(/^…/, '')], from = Math.max(0, Math.min(h.text.startsWith('…') ? 80 : h.col - 1, s.length));
      html += `<div class="hit" data-todo="${todoHits.indexOf(h)}" style="padding-left:20px"><span class="ln">${h.line}</span><span class="tx">${esc(s.slice(from).join('').replace(/\*\/\s*$|-->\s*$/, '').trim())}</span></div>`;
    }
  }
  $('#todoList').innerHTML = html || `<div class="empty">${esc(project ? t('ui.todoEmpty') : t('toast.needProject'))}</div>`;
}
$('#todoList').addEventListener('click', e => { const el = e.target.closest('[data-todo]'); if (el) { const h = todoHits[+el.dataset.todo]; jumpTo(h.path, h.line, h.col, h.len); } });

/* ================= Terminal ================= */
let terms = [], activeTerm = null, termSeq = 0;
function termTheme() {
  const dark = settings.theme === 'dark' || settings.theme === 'github-dark';
  return {background: cssVar('--panel'), foreground: cssVar('--text'), cursor: cssVar('--accent'), cursorAccent: cssVar('--panel'),
    selectionBackground: dark ? 'rgba(245,146,46,.35)' : 'rgba(232,113,10,.25)',
    ...(dark ? {} : {black: '#1f2328', brightBlack: '#57606a', white: '#6e7781', brightWhite: '#8c959f', yellow: '#9a6700', brightYellow: '#bf8700'})};
}
async function newTerminal(cwd, run = null) {
  if (!project) return toast(t('toast.needProject'));
  if (!invoke) return;
  const el = document.createElement('div'); el.className = 'term-host'; $('#terms').append(el);
  const xterm = new Terminal({fontFamily: cssVar('--font-code') || 'Consolas, monospace', fontSize: Math.max(11, settings.fontSize - 1), cursorBlink: true,
    theme: termTheme(), scrollback: 5000, allowProposedApi: true, macOptionIsMeta: true});
  const fit = new FitAddon.FitAddon(); xterm.loadAddon(fit);
  const term = {n: ++termSeq, el, xterm, fit, id: null, exited: false, run: null,
    title: run ? '▶ ' + run.name : t('ui.terminal') + (termSeq > 1 ? ' ' + termSeq : '')};
  terms.push(term); activeTerm = term;
  showBottom('terminal'); renderBottomTabs();
  xterm.open(el);
  addOutputLinks(term);
  await new Promise(r => requestAnimationFrame(r));
  try { fit.fit(); } catch (e) {}
  if (run) await startRun(term, run, cwd || project.root);
  else {
    try { term.id = await invoke('term_start', {cwd: cwd || project.root, cols: xterm.cols, rows: xterm.rows, shell: settings.shell || null}); }
    catch (e) { xterm.writeln(`\x1b[31m${t('toast.termFail', {e})}\x1b[0m`); term.exited = true; }
  }
  xterm.onData(d => { if (term.id != null && !term.exited) invoke('term_write', {id: term.id, data: d}).catch(() => {}); });
  xterm.onResize(({cols, rows}) => { if (term.id != null && !term.exited) invoke('term_resize', {id: term.id, cols, rows}).catch(() => {}); });
  xterm.focus();
}
if (invoke) {
  window.__TAURI__.event.listen('term-data', ev => {
    const tm = terms.find(x => x.id === ev.payload.id); if (!tm) return;
    tm.xterm.write(ev.payload.data);
    if (tm.test && tm.out.length < 4e6) tm.out += ev.payload.data;
  });
  window.__TAURI__.event.listen('term-exit', ev => {
    const tm = terms.find(x => x.id === ev.payload); if (!tm) return;
    tm.exited = true; if (!tm.run) tm.xterm.writeln(`\r\n\x1b[90m[${t('ui.termExit')}]\x1b[0m`); renderBottomTabs();
  });
  // Runs end with their exit code (green for 0).
  window.__TAURI__.event.listen('term-code', ev => {
    const tm = terms.find(x => x.id === ev.payload.id); if (!tm || !tm.run) return;
    const c = ev.payload.code;
    tm.code = c;
    if (tm.run.key.startsWith('git:')) scheduleGit(100);
    if (tm.test) testsFinished(tm, c);
    tm.xterm.writeln(`\r\n\x1b[${c === 0 ? 32 : 31}m[${t('run.exited', {c: c == null ? '?' : c})}]\x1b[0m`);
  });
}
function closeTerminal(term) {
  if (!term) return;
  if (term.id != null && !term.exited) invoke('term_kill', {id: term.id}).catch(() => {});
  term.xterm.dispose(); term.el.remove();
  terms = terms.filter(x => x !== term);
  if (activeTerm === term) activeTerm = terms[terms.length - 1] || null;
  renderBottomTabs();
}
function fitTerms() { if (!settings.bottom || settings.bottomTab !== 'terminal') return; for (const tm of terms) if (tm === activeTerm) { try { tm.fit.fit(); } catch (e) {} } }
new ResizeObserver(() => fitTerms()).observe($('#terms'));

/* ================= Bottom panel (Find, Terminal) ================= */
function showBottom(tab) {
  settings.bottom = true; if (tab) settings.bottomTab = tab;
  applyLayout();
  if (settings.bottomTab === 'terminal') {
    if (!terms.length && project) { newTerminal(); return; }
    if (activeTerm) setTimeout(() => { fitTerms(); activeTerm.xterm.focus(); }, 30);
  }
}
/* Run tabs show their state: ▶ running, ✓ finished with 0, ✗ other exit code or stopped. */
const termTitle = tm => !tm.run ? tm.title + (tm.exited ? ' ✕' : '') : (!tm.exited ? '▶ ' : tm.code === 0 ? '✓ ' : '✗ ') + tm.run.name;
function renderBottomTabs() {
  const pc = problemCount();
  const tabs = [`<button class="pt${settings.bottomTab === 'problems' ? ' active' : ''}" data-bt="problems">${esc(t('ui.problems'))}${pc.e + pc.w ? ` <span style="opacity:.7">${pc.e + pc.w}</span>` : ''}</button>`,
    `<button class="pt${settings.bottomTab === 'find' ? ' active' : ''}" data-bt="find">${esc(t('ui.find'))}</button>`,
    `<button class="pt${settings.bottomTab === 'tests' ? ' active' : ''}" data-bt="tests">${esc(t('rt.tab'))}${lastTests && lastTests.results.length ? ` <span class="${lastTests.results.some(r => !r[1]) ? 'bad' : 'ok'}">${lastTests.results.filter(r => r[1]).length}/${lastTests.results.length}</span>` : ''}</button>`,
    ...terms.map(tm => `<button class="pt${settings.bottomTab === 'terminal' && tm === activeTerm ? ' active' : ''}" data-term="${tm.n}">${esc(termTitle(tm))}<span class="x" data-term-close="${tm.n}">&#10005;</span></button>`)];
  if (!terms.length) tabs.push(`<button class="pt${settings.bottomTab === 'terminal' ? ' active' : ''}" data-bt="terminal">${esc(t('ui.terminal'))}</button>`);
  $('#bottomTabs').innerHTML = tabs.join('');
  $('#bottomBtns').innerHTML = `<button class="ibtn" data-act="newTerminal" title="${esc(t('a.newTerminal'))}">${ICONS.plus}</button>`;
  $$('.ppanel').forEach(p => p.classList.toggle('active', p.dataset.pp === settings.bottomTab));
  terms.forEach(tm => tm.el.classList.toggle('active', tm === activeTerm));
}
$('#bottomTabs').addEventListener('click', e => {
  const c = e.target.closest('[data-term-close]'); if (c) { closeTerminal(terms.find(x => x.n === +c.dataset.termClose)); if (!terms.length) settings.bottomTab = 'find'; applyLayout(); return; }
  const tb = e.target.closest('[data-term]'); if (tb) { activeTerm = terms.find(x => x.n === +tb.dataset.term); settings.bottomTab = 'terminal'; showBottom(); renderBottomTabs(); return; }
  const b = e.target.closest('[data-bt]'); if (b) showBottom(b.dataset.bt); if (b && b.dataset.bt === 'tests') renderTests();
});

/* ================= Git ================= */
/* Through the installed git (Rust: git.rs). The Git panel lists changed files — a checkmark stages a file — with the
   commit message below; the status bar shows the branch (click: switch / new / push / pull); changed lines get a mark
   next to the line numbers, changed files a color in the project tree. Push and pull run in a bottom-panel tab. */
let git = {repo: false, top: '', branch: '', ahead: 0, behind: 0, files: []}, gitT = 0, gitBusy = false;
const gitAbs = rel => join(git.top, rel);
const gitStaged = f => f.x !== ' ' && f.x !== '?';
const gitChanged = f => f.y !== ' ';
const gitCode = f => f.x === '?' ? 'U' : (gitChanged(f) ? f.y : f.x);   // the letter shown
function scheduleGit(delay = 400) { clearTimeout(gitT); gitT = setTimeout(refreshGit, delay); }
async function refreshGit() {
  if (!project || !invoke) { git = {repo: false, files: []}; return renderGit(); }
  const s = await invoke('git_status', {root: project.root}).catch(e => ({repo: false, error: String(e)}));
  git = {...s, files: s.files || []};
  renderGit(); renderTree();
  const f = curFile(); if (f && f.kind === 'text' && f.model) scheduleGutter(f, 50);
}
const gitStateOf = path => { if (!git.repo) return null; const f = git.files.find(x => gitAbs(x.path) === path); return f ? gitCode(f) : null; };
function renderGit() {
  const st = $('#stBranch');
  st.hidden = !git.repo;
  if (git.repo) st.textContent = '⎇ ' + (git.branch || '?') + (git.ahead ? ' ↑' + git.ahead : '') + (git.behind ? ' ↓' + git.behind : '');
  const box = $('#gitList'); if (!box) return;
  if (!project) { box.innerHTML = ''; return; }
  if (!git.repo) { box.innerHTML = `<div class="empty">${esc(git.error && /not installed/.test(git.error) ? t('git.noGit') : t('git.noRepo'))}</div>`; $('#gitCommitBox').hidden = true; return; }
  $('#gitCommitBox').hidden = false;
  const row = (f, staged) => {
    const p = gitAbs(f.path), code = staged ? f.x : (f.x === '?' ? 'U' : f.y);
    return `<div class="row git-row" data-path="${esc(p)}" data-staged="${staged ? 1 : 0}" title="${esc(f.path)}">
      <input type="checkbox" class="git-chk"${staged ? ' checked' : ''} title="${esc(t(staged ? 'git.unstage' : 'git.stage'))}">${fileIcon(p)}
      <span class="nm git-${code}">${esc(baseName(f.path))}</span><small>${esc(dirName(f.path))}</small><b class="git-code git-${code}">${esc(code)}</b></div>`;
  };
  const staged = git.files.filter(gitStaged), changed = git.files.filter(f => gitChanged(f) || f.x === '?');
  box.innerHTML = (staged.length ? `<div class="file-group">${esc(t('git.staged'))} · ${staged.length}</div>` + staged.map(f => row(f, true)).join('') : '') +
    (changed.length ? `<div class="file-group">${esc(t('git.changes'))} · ${changed.length}</div>` + changed.map(f => row(f, false)).join('') : '') +
    (!staged.length && !changed.length ? `<div class="empty">${esc(t('git.clean'))}</div>` : '');
  $('#gitCommitBtn').disabled = !staged.length && !$('#gitAmend').checked;
  $('#gitCommitBtn').textContent = staged.length ? t('git.commitN', {n: staged.length}) : t('git.commit');
}
async function gitDo(cmd, args, okMsg) {
  if (gitBusy) return; gitBusy = true;
  try { const r = await invoke(cmd, {root: project.root, ...args}); if (okMsg) toast(okMsg(r)); return true; }
  catch (e) { toast(t('git.fail', {e})); return false; }
  finally { gitBusy = false; await refreshGit(); }
}
async function gitCommit() {
  if (!git.repo) return toast(t('git.noRepo'));
  showDockTab('git');
  const msg = $('#gitMsg').value.trim(), amend = $('#gitAmend').checked;
  if (!msg) { $('#gitMsg').focus(); return toast(t('git.needMsg')); }
  if (!git.files.some(gitStaged) && !amend) return toast(t('git.nothingStaged'));
  if (dirtyFiles().length) await saveAll(true);
  if (await gitDo('git_commit', {message: msg, amend}, r => t('git.committed', {s: r}))) { $('#gitMsg').value = ''; $('#gitAmend').checked = false; }
}
/* Push / pull / fetch run like a run configuration, so prompts and messages are visible. */
const gitRun = (name, command) => { if (!git.repo) return toast(t('git.noRepo')); runConfig({name, command, cwd: git.top, key: 'git:' + name}); };
async function showDiff(path) {
  const base = await invoke('git_head_text', {path}).catch(() => null);
  const open = files.get(path), cur = open && open.model ? open.model.getValue() : await readText(path).catch(() => '');
  modal(t('git.diffTitle', {f: baseName(path)}), '<div id="gitDiffHost" class="git-diff-host"></div>', null, 'gitdiff');
  const lang = langFor(path), orig = monaco.editor.createModel(base == null ? '' : base, lang), mod = monaco.editor.createModel(cur, lang);
  const de = monaco.editor.createDiffEditor($('#gitDiffHost'), {...editorOptions(), readOnly: true, originalEditable: false, renderSideBySide: true, minimap: {enabled: false}, automaticLayout: true});
  de.setModel({original: orig, modified: mod});
  modalOnClose = () => { de.dispose(); orig.dispose(); mod.dispose(); };
}
const readText = async p => new TextDecoder().decode(await readBytes(p));
/* Gutter: lines changed since the last commit. */
const gutterTimers = new WeakMap();
function scheduleGutter(f, delay = 700) {
  if (!f || !f.model || !invoke) return;
  clearTimeout(gutterTimers.get(f)); gutterTimers.set(f, setTimeout(() => updateGutter(f), delay));
}
async function updateGutter(f) {
  if (!f.model || f.model.isDisposed()) return;
  const v = f.model.getVersionId();
  const list = git.repo ? await invoke('git_line_changes', {path: f.path, text: f.model.getValue()}).catch(() => null) : null;
  if (f.model.isDisposed() || f.model.getVersionId() !== v) return;
  const deco = (list || []).map(([a, b, kind]) => ({range: new monaco.Range(Math.max(1, a), 1, Math.max(1, b), 1),
    options: {isWholeLine: true, linesDecorationsClassName: 'git-gutter git-' + kind, overviewRuler: {color: kind === 'added' ? '#59a869' : kind === 'modified' ? '#3d8ee8' : '#d7373f', position: 1}}}));
  f.gitDeco = f.model.deltaDecorations(f.gitDeco || [], deco);
}
async function gitBranchMenu() {
  if (!git.repo) return;
  const b = await invoke('git_branches', {root: project.root}).catch(() => null); if (!b) return;
  ctx = {branches: b.local};
  return [...b.local.slice(0, 25).map((n, i) => ({id: 'git:switch:' + i, label: n, checked: n === b.current})), null,
    {id: 'git:newBranch', label: t('git.newBranch')}, null,
    {id: 'git:pull', label: t('a.gitPull'), accel: keyOf('gitPull')}, {id: 'git:push', label: t('a.gitPush'), accel: keyOf('gitPush')}, {id: 'git:fetch', label: t('git.fetch')}];
}
$('#stBranch').addEventListener('click', async () => { const items = await gitBranchMenu(); if (items) invoke('context_menu', {items: items.map(i => i ? {id: i.id, label: i.label, enabled: i.enabled !== false, checked: i.checked, accel: i.accel || null} : {})}); });
async function gitHandle(what, arg) {
  if (what === 'switch') {
    if (dirtyFiles().length) await saveAll(true);
    if (await gitDo('git_switch', {branch: ctx.branches[+arg], create: false}, () => t('git.switched', {b: ctx.branches[+arg]}))) await reloadOpenFiles();
  } else if (what === 'newBranch') {
    const name = await promptText(t('git.newBranch'), t('git.branchName'), '');
    if (name && name.trim()) await gitDo('git_switch', {branch: name.trim(), create: true}, () => t('git.switched', {b: name.trim()}));
  } else if (what === 'push') gitRun('git push', 'git push');
  else if (what === 'pull') gitRun('git pull', 'git pull');
  else if (what === 'fetch') gitRun('git fetch', 'git fetch --prune');
  else if (what === 'open') openFile(ctx.path);
  else if (what === 'diff') showDiff(ctx.path);
  else if (what === 'stage') gitDo('git_stage', {paths: [ctx.path]});
  else if (what === 'unstage') gitDo('git_unstage', {paths: [ctx.path]});
  else if (what === 'discard') {
    if (!(await ask(t('git.discardAsk', {f: baseName(ctx.path)}), t('git.discard')))) return;
    if (await gitDo('git_discard', {paths: [ctx.path]})) await reloadOpenFiles();
  }
}
/* After a branch switch or discard, open files show what is on disk now. */
async function reloadOpenFiles() { await checkDisk(); }
$('#gitList').addEventListener('click', e => {
  const r = e.target.closest('.git-row'); if (!r) return;
  if (e.target.classList.contains('git-chk')) return gitDo(e.target.checked ? 'git_stage' : 'git_unstage', {paths: [r.dataset.path]});
  showDiff(r.dataset.path);
});
$('#gitList').addEventListener('dblclick', e => { const r = e.target.closest('.git-row'); if (r) openFile(r.dataset.path); });
$('#gitMsg').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); gitCommit(); } });
$('#gitAmend').addEventListener('change', renderGit);
$('#gitCommitBtn').addEventListener('click', gitCommit);
function showDockTab(tab) { settings.dock = true; settings.dockTab = tab; applyLayout(); }

/* ================= Format on save & linters ================= */
/* Formatting uses the project's tool (Rust: tools.rs — rustfmt, gofmt, Ruff/Black, Prettier, clang-format), else the
   language server's or the editor's own formatter; on save only when you save (Ctrl+S), not on autosave. Linters
   (ESLint, Ruff) run after saving and fill the Problems panel; rust-analyzer can check with Clippy (setting). */
const toolNotes = new Set();   // missing tools already mentioned this session
const shownEditor = model => groups.map(g => g.editor).find(e => e.getModel() === model);
async function formatFile(f, quiet) {
  if (!f || f.kind !== 'text' || !f.model) return false;
  const model = f.model, v = model.getVersionId();
  const r = await invoke('format_text', {path: f.path, text: model.getValue(), lang: model.getLanguageId()}).catch(e => ({status: 'failed', tool: '?', error: String(e)}));
  if (model.isDisposed() || model.getVersionId() !== v) return false;
  if (r.status === 'ok') { if (r.text !== model.getValue()) replaceText(model, r.text); return true; }
  if (r.status === 'failed') { if (!quiet) toast(t('fmt.failed', {tool: r.tool, e: (r.error || '').split('\n')[0]})); return false; }
  if (r.status === 'missing' && !toolNotes.has(r.tool)) { toolNotes.add(r.tool); toast(t('fmt.missing', {tool: r.tool, cmd: r.install})); }
  // No tool: the language server's / built-in formatter, when the file is shown.
  const ed = shownEditor(model), act = ed && ed.getAction('editor.action.formatDocument');
  if (act && act.isSupported()) { await act.run(); return true; }
  return false;
}
/* The whole text replaced as one undoable step; the cursor stays where it was. */
function replaceText(model, text) {
  const ed = shownEditor(model), sel = ed && ed.getSelections();
  if (ed) { ed.pushUndoStop(); ed.executeEdits('format', [{range: model.getFullModelRange(), text}]); ed.pushUndoStop(); }
  else model.pushEditOperations([], [{range: model.getFullModelRange(), text}], () => null);
  if (ed && sel) ed.setSelections(sel.map(s => { const a = model.validatePosition(s.getStartPosition()), b = model.validatePosition(s.getEndPosition()); return new monaco.Selection(a.lineNumber, a.column, b.lineNumber, b.column); }));
}
const lintDiags = new Map(), lintTimers = new Map();   // path → problems from ESLint / Ruff
const allDiags = () => { const m = new Map(); for (const [p, l] of LSP.diags) m.set(p, [...l]); for (const [p, l] of lintDiags) m.set(p, [...(m.get(p) || []), ...l]); return m; };
function scheduleLint(f) { clearTimeout(lintTimers.get(f.path)); lintTimers.set(f.path, setTimeout(() => runLint(f), 300)); }
async function runLint(f) {
  if (!f.model || f.model.isDisposed()) return;
  const list = await invoke('lint_file', {path: f.path, lang: f.model.getLanguageId()}).catch(() => null);
  if (list == null || f.model.isDisposed()) return;   // no linter for this file
  const ds = list.map(l => ({severity: l.severity, message: l.message, source: l.source, code: l.code, line: l.line, col: l.col, endLine: l.end_line, endCol: Math.max(l.end_col, l.col + 1), fixable: l.fixable}));
  if (ds.length) lintDiags.set(f.path, ds); else lintDiags.delete(f.path);
  monaco.editor.setModelMarkers(f.model, 'lint', ds.map(d => ({severity: d.severity === 1 ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
    message: d.message, source: d.source, code: d.code || undefined, startLineNumber: d.line, startColumn: d.col, endLineNumber: d.endLine, endColumn: d.endCol})));
  renderProblems(); renderBottomTabs(); renderLspStatus();
}
/* The linter's own fixes for the whole file (ESLint --fix, Ruff --fix); the file is saved first and reloaded after. */
async function lintFix(f, imports = false) {
  if (!f || !f.model) return;
  if (isDirty(f)) await saveFile(f);
  try { await invoke('lint_fix', {path: f.path, lang: f.model.getLanguageId(), imports}); }
  catch (e) { return toast(String(e)); }
  await checkDisk(); scheduleLint(f);
  toast(t(imports ? 'fmt.importsDone' : 'lint.fixed'));
}
async function optimizeImports() {
  const f = curFile(); if (!f || !f.model) return;
  if (await LSP.organizeImports(f.model).catch(() => false)) return toast(t('fmt.importsDone'));
  if (f.model.getLanguageId() === 'python') return lintFix(f, true);
  toast(t('fmt.noImports'));
}
/* Clippy's automatic fixes run in a tab (they change files on disk; open files reload). */
function clippyFix() {
  const c = runDetected.find(x => x.command.startsWith('cargo ')), cwd = c ? join(project.root, c.dir || '') : project.root;
  runConfig({name: 'cargo clippy --fix', command: 'cargo clippy --fix --allow-dirty --allow-staged', cwd, key: 'tool:clippy'});
}
function registerLintActions() {
  monaco.editor.registerCommand('codeStudio.lintFix', () => lintFix(curFile()));
  monaco.languages.registerCodeActionProvider('*', {provideCodeActions(model, range, ctx) {
    const mine = (ctx.markers || []).filter(m => m.source === 'eslint' || m.source === 'ruff');
    const fixable = (lintDiags.get(toPathOf(model)) || []).some(d => d.fixable);
    if (!mine.length || !fixable) return {actions: [], dispose() {}};
    return {actions: [{title: t('lint.fixAll', {source: mine[0].source === 'ruff' ? 'Ruff' : 'ESLint'}), kind: 'quickfix', diagnostics: mine,
      command: {id: 'codeStudio.lintFix', title: ''}}], dispose() {}};
  }});
}
const toPathOf = model => { for (const f of files.values()) if (f.model === model) return f.path; return null; };

/* ================= Built-in completion ================= */
/* Without a language server the suggestion list still has the language's keywords, common snippets (Tab moves through
   the parts) and the words of open files of that language. With a server running, it gives the suggestions. */
const KW = s => s.split(' ');
const KEYWORDS = {
  rust: KW('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err Option Result Vec String Box println format vec'),
  python: KW('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self print len range list dict set str int float bool open isinstance enumerate zip'),
  go: KW('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false error string int bool byte rune make append len cap new panic'),
  c: KW('auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while NULL include define printf malloc free'),
  cpp: KW('auto break case char class const constexpr continue default delete do double else enum explicit extern false float for friend if inline int long namespace new noexcept nullptr operator override private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while std vector string cout endl include'),
  csharp: KW('abstract as async await base bool break case catch char class const continue decimal default delegate do double else enum event explicit false finally float for foreach get if int interface internal is namespace new null object override private protected public readonly record return sealed set static string struct switch this throw true try typeof using var void while Console WriteLine'),
  java: KW('abstract boolean break byte case catch char class continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public record return short static String super switch this throw throws true false try var void while System out println'),
  php: KW('abstract array as break case catch class const continue declare default do echo else elseif empty extends final fn for foreach function global if implements include interface isset match namespace new null private protected public readonly require return static switch throw trait try unset use while'),
  shell: KW('if then else elif fi for while until do done case esac function return in echo export local read exit set unset shift source'),
  lua: KW('and break do else elseif end false for function goto if in local nil not or repeat return then true until while print require pairs ipairs table string'),
  ruby: KW('alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield puts require attr_accessor'),
  sql: KW('SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AS AND OR NOT NULL IS IN LIKE DISTINCT COUNT SUM AVG MIN MAX PRIMARY KEY FOREIGN REFERENCES'),
  kotlin: KW('as break class continue do else false for fun if in interface is null object package return super this throw true try typealias val var when while data sealed override private public internal suspend println'),
  swift: KW('associatedtype class deinit enum extension func import init inout internal let operator private protocol public static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as false is nil self Self super throw throws true try print')
};
const SNIPPETS = {
  rust: [['fn', 'fn ${1:name}(${2}) {\n\t$0\n}'], ['test', '#[test]\nfn ${1:name}() {\n\t$0\n}'], ['if', 'if ${1:condition} {\n\t$0\n}'], ['for', 'for ${1:item} in ${2:iter} {\n\t$0\n}'],
    ['match', 'match ${1:value} {\n\t${2:_} => $0,\n}'], ['struct', 'struct ${1:Name} {\n\t$0\n}'], ['impl', 'impl ${1:Name} {\n\t$0\n}'], ['println', 'println!("${1:{\\}}"${2:, value});']],
  python: [['def', 'def ${1:name}(${2}):\n\t${0:pass}'], ['class', 'class ${1:Name}:\n\tdef __init__(self${2}):\n\t\t${0:pass}'], ['if', 'if ${1:condition}:\n\t${0:pass}'],
    ['for', 'for ${1:item} in ${2:items}:\n\t${0:pass}'], ['with', 'with ${1:open(path)} as ${2:f}:\n\t${0:pass}'], ['try', 'try:\n\t${1:pass}\nexcept ${2:Exception} as e:\n\t${0:raise}'],
    ['ifmain', 'if __name__ == "__main__":\n\t${0:main()}']],
  go: [['func', 'func ${1:name}(${2}) ${3}{\n\t$0\n}'], ['iferr', 'if err != nil {\n\treturn ${1:err}\n}'], ['for', 'for ${1:i} := 0; $1 < ${2:n}; $1++ {\n\t$0\n}'],
    ['forr', 'for ${1:_}, ${2:v} := range ${3:items} {\n\t$0\n}'], ['test', 'func Test${1:Name}(t *testing.T) {\n\t$0\n}'], ['main', 'func main() {\n\t$0\n}']],
  c: [['main', 'int main(void) {\n\t$0\n\treturn 0;\n}'], ['for', 'for (int ${1:i} = 0; $1 < ${2:n}; $1++) {\n\t$0\n}'], ['if', 'if (${1:condition}) {\n\t$0\n}'], ['inc', '#include <${1:stdio.h}>']],
  cpp: [['main', 'int main() {\n\t$0\n\treturn 0;\n}'], ['for', 'for (int ${1:i} = 0; $1 < ${2:n}; ++$1) {\n\t$0\n}'], ['forr', 'for (auto& ${1:item} : ${2:items}) {\n\t$0\n}'], ['class', 'class ${1:Name} {\npublic:\n\t$0\n};']],
  csharp: [['class', 'public class ${1:Name}\n{\n\t$0\n}'], ['prop', 'public ${1:int} ${2:Name} { get; set; }'], ['foreach', 'foreach (var ${1:item} in ${2:items})\n{\n\t$0\n}'], ['cw', 'Console.WriteLine(${1});']],
  java: [['main', 'public static void main(String[] args) {\n\t$0\n}'], ['sout', 'System.out.println(${1});'], ['for', 'for (int ${1:i} = 0; $1 < ${2:n}; $1++) {\n\t$0\n}'], ['class', 'public class ${1:Name} {\n\t$0\n}']],
  shell: [['if', 'if [ ${1:condition} ]; then\n\t$0\nfi'], ['for', 'for ${1:item} in ${2:list}; do\n\t$0\ndone'], ['func', '${1:name}() {\n\t$0\n}'], ['shebang', '#!/usr/bin/env bash\nset -euo pipefail\n$0']],
  lua: [['function', 'function ${1:name}(${2})\n\t$0\nend'], ['for', 'for ${1:i} = 1, ${2:n} do\n\t$0\nend'], ['forp', 'for ${1:k}, ${2:v} in pairs(${3:t}) do\n\t$0\nend'], ['if', 'if ${1:condition} then\n\t$0\nend']],
  ruby: [['def', 'def ${1:name}\n\t$0\nend'], ['class', 'class ${1:Name}\n\t$0\nend'], ['each', '${1:items}.each do |${2:item}|\n\t$0\nend']],
  php: [['function', 'function ${1:name}(${2})\n{\n\t$0\n}'], ['class', 'class ${1:Name}\n{\n\t$0\n}'], ['foreach', 'foreach (\\$${1:items} as \\$${2:item}) {\n\t$0\n}']]
};
function registerBuiltinCompletion() {
  const K = monaco.languages.CompletionItemKind, SNIP = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  const langs = new Set([...Object.keys(KEYWORDS), ...Object.keys(SNIPPETS), 'yaml', 'ini', 'markdown', 'plaintext', 'dockerfile', 'powershell', 'perl', 'r', 'scala', 'dart', 'elixir']);
  for (const lang of langs) {
    monaco.languages.registerCompletionItemProvider(lang, {provideCompletionItems(model, pos) {
      if (LSP.hasClient(lang)) return {suggestions: []};
      const w = model.getWordUntilPosition(pos), range = new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn), seen = new Set();
      const out = [];
      for (const [label, body] of SNIPPETS[lang] || []) out.push({label, kind: K.Snippet, insertText: body, insertTextRules: SNIP, range, detail: t('ac.snippet'), sortText: '1' + label,
        documentation: {value: '```\n' + body.replace(/\$\{\d+:?([^}]*)\}/g, '$1').replace(/\$\d/g, '') + '\n```'}});
      for (const k of KEYWORDS[lang] || []) if (!seen.has(k)) { seen.add(k); out.push({label: k, kind: K.Keyword, insertText: k, range, sortText: '2' + k}); }
      // Words of the open files of this language (not the one being typed).
      const typing = w.word;
      for (const m of monaco.editor.getModels()) {
        if (m.getLanguageId() !== lang || m.getValueLength() > 2e6) continue;
        for (const word of m.getValue().match(/[\p{L}_$][\p{L}\p{N}_$]{2,}/gu) || []) {
          if (seen.has(word) || word === typing) continue;
          seen.add(word); out.push({label: word, kind: K.Text, insertText: word, range, sortText: '3' + word});
          if (seen.size > 3000) break;
        }
      }
      return {suggestions: out};
    }});
  }
}

/* ================= Run & test from the code ================= */
/* A ▶ next to fn main, tests and test modules (Rust: runnables.rs finds them with the exact command); click runs just
   that, right-click offers "save as configuration". After a test run the ▶ turns green or red and the Tests tab lists
   the results (output read in Rust: test_results). */
let testState = new Map(), lastTests = null;   // id → passed; {framework, cwd, run, results}
const runTimers = new WeakMap();
function scheduleRunnables(f, delay = 600) {
  if (!f || !f.model || !invoke) return;
  clearTimeout(runTimers.get(f)); runTimers.set(f, setTimeout(() => updateRunnables(f), delay));
}
async function updateRunnables(f) {
  if (!f.model || f.model.isDisposed()) return;
  const v = f.model.getVersionId();
  const list = await invoke('runnables', {path: f.path, text: f.model.getValue(), lang: f.model.getLanguageId()}).catch(() => []);
  if (f.model.isDisposed() || f.model.getVersionId() !== v) return;
  f.runnables = list; drawRunnables(f);
}
function drawRunnables(f) {
  if (!f.model || f.model.isDisposed()) return;
  const deco = (f.runnables || []).map(r => {
    const st = r.kind === 'suite' ? suiteState(r) : testState.get(r.id);
    return {range: new monaco.Range(r.line, 1, r.line, 1), options: {glyphMarginClassName: 'run-glyph' + (st === true ? ' run-ok' : st === false ? ' run-fail' : ''),
      glyphMarginHoverMessage: {value: t(r.kind === 'main' ? 'rt.runMain' : r.kind === 'suite' ? 'rt.runSuite' : 'rt.runTest', {n: r.name}) + '  \n`' + r.command + '`'}}};
  });
  f.runDeco = f.model.deltaDecorations(f.runDeco || [], deco);
}
// A module / class is green when all its known tests passed, red when one failed.
function suiteState(r) {
  let any = false;
  for (const [id, ok] of testState) if (id.startsWith(r.id + '::') || id.startsWith(r.id + ' ')) { if (!ok) return false; any = true; }
  return any ? true : undefined;
}
const runnableAt = (f, line) => f && (f.runnables || []).find(r => r.line === line);
const frameworkOf = cmd => /^cargo test\b/.test(cmd) ? {framework: 'cargo'} : /pytest\b.*\s-v\b|pytest -v/.test(cmd) ? {framework: 'pytest'} : /^go test\b.*-v\b/.test(cmd) ? {framework: 'go'}
  : /\bvitest\b/.test(cmd) ? {framework: 'vitest'} : /\bjest\b/.test(cmd) ? {framework: 'jest'} : /^node --test\b/.test(cmd) ? {framework: 'node'} : null;
function runRunnable(r) {
  runConfig({name: r.kind === 'main' ? r.name : (r.kind === 'suite' ? '⚑ ' : '') + r.name, command: r.command, cwd: r.cwd, key: 'rt:' + (r.id || r.command), framework: r.framework});
}
async function testsFinished(tm, code) {
  const results = await invoke('test_results', {framework: tm.test.framework, output: tm.out}).catch(() => []);
  for (const [id, ok] of results) testState.set(id, ok);
  lastTests = {framework: tm.test.framework, cwd: tm.run.cwd, run: tm.run, results};
  for (const f of files.values()) if (f.runnables) drawRunnables(f);
  const pass = results.filter(r => r[1]).length, fail = results.length - pass;
  if (results.length) toast(t(fail ? 'rt.someFailed' : 'rt.allPassed', {p: pass, f: fail}));
  else if (code !== 0 && code != null) toast(t('rt.failedCode', {c: code}));
  renderTests(); renderBottomTabs();
}
function renderTests() {
  const box = $('#testList'); if (!box) return;
  if (!lastTests) { box.innerHTML = `<div class="empty">${esc(t('rt.none'))}</div>`; $('#testSum').textContent = ''; return; }
  const {results} = lastTests, fail = results.filter(r => !r[1]);
  $('#testSum').innerHTML = `${esc(t('rt.summary', {p: results.length - fail.length, f: fail.length}))}${fail.length && canRerun() ? ` <button class="btn-sm" id="rerunFailed">${esc(t('rt.rerunFailed'))}</button>` : ''}
    <button class="btn-sm" id="rerunAll">${esc(t('rt.rerun'))}</button>`;
  box.innerHTML = results.length ? [...fail, ...results.filter(r => r[1])].map(([id, ok]) =>
    `<div class="hit test-row" data-id="${esc(id)}"><b class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</b> <span>${esc(id)}</span></div>`).join('')
    : `<div class="empty">${esc(t('rt.noDetails'))}</div>`;
}
const canRerun = () => lastTests && ['cargo', 'pytest', 'go'].includes(lastTests.framework);
function rerunFailed() {
  const ids = lastTests.results.filter(r => !r[1]).map(r => r[0]), quoteAll = ids.map(i => '"' + i + '"').join(' ');
  const cmd = {cargo: 'cargo test -- --exact ' + ids.join(' '), pytest: 'python -m pytest -v ' + quoteAll,
    go: 'go test -v -run "^(' + ids.map(i => i.split('/')[0]).join('|') + ')$" .'}[lastTests.framework];
  runConfig({name: t('rt.failedRun'), command: cmd, cwd: lastTests.cwd, key: 'rt:failed', framework: lastTests.framework});
}
$('#testSum').addEventListener('click', e => {
  if (e.target.id === 'rerunFailed') rerunFailed();
  if (e.target.id === 'rerunAll' && lastTests) runConfig({...lastTests.run, cwd: lastTests.cwd, framework: lastTests.framework});
});
// A result opens its test when the file is open.
$('#testList').addEventListener('click', e => {
  const row = e.target.closest('.test-row'); if (!row) return;
  for (const f of files.values()) { const r = (f.runnables || []).find(x => x.id === row.dataset.id); if (r) return jumpTo(f.path, r.line, 1); }
});

/* ================= Run configurations ================= */
/* What the project's build files offer (Rust: runconfig.rs), the user's own commands (kept with the project's session)
   and "run current file". Each configuration runs in its own tab of the bottom panel; running it again restarts it
   there. Positions like src/main.rs:12:5 in any terminal open the file. */
let runState = {custom: [], selected: null}, runDetected = [];
const runKey = c => c.custom ? 'c:' + c.name : 'd:' + (c.dir || '') + ':' + c.command;
const quoted = f => `"${f}"`;
const FILE_RUNNERS = {python: f => 'python ' + quoted(f), javascript: f => 'node ' + quoted(f), typescript: f => 'npx tsx ' + quoted(f), go: f => 'go run ' + quoted(f),
  ruby: f => 'ruby ' + quoted(f), shell: f => 'bash ' + quoted(f), php: f => 'php ' + quoted(f), perl: f => 'perl ' + quoted(f), lua: f => 'lua ' + quoted(f),
  powershell: f => 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + quoted(f)};
async function loadRunConfigs() {
  runDetected = project && invoke ? await invoke('run_configs', {root: project.root}).catch(() => []) : [];
  renderRunSel();
}
const allRunConfigs = () => [...runDetected, ...runState.custom.map(c => ({...c, custom: true}))];
function renderRunSel() {
  const sel = $('#runSel'); if (!sel) return;
  const list = allRunConfigs(), opt = c => `<option value="${esc(runKey(c))}">${esc(c.name)}</option>`;
  if (!list.some(c => runKey(c) === runState.selected)) runState.selected = list[0] ? runKey(list[0]) : null;
  sel.innerHTML = (list.length ? '' : `<option value="">${esc(t('run.none'))}</option>`) +
    (runDetected.length ? `<optgroup label="${esc(t('run.project'))}">${runDetected.map(opt).join('')}</optgroup>` : '') +
    (runState.custom.length ? `<optgroup label="${esc(t('run.custom'))}">${runState.custom.map(c => opt({...c, custom: true})).join('')}</optgroup>` : '') +
    (project ? `<option value="__edit">${esc(t('a.editRunConfigs'))}</option>` : '');
  sel.value = runState.selected || '';
  sel.disabled = !project;
}
$('#runSel').addEventListener('change', e => {
  if (e.target.value === '__edit') { renderRunSel(); return editRunConfigs(); }
  runState.selected = e.target.value; saveSession(); e.target.blur();
});
async function startRun(term, run, cwd) {
  term.run = {...run, cwd}; term.code = null;
  // Test commands: the output is read for passed / failed per test.
  term.test = run.framework && run.framework !== 'run' ? {framework: run.framework} : frameworkOf(run.command); term.out = '';
  term.xterm.writeln(`\x1b[90m${cwd}> ${run.command}\x1b[0m`);
  try { term.id = await invoke('term_start', {cwd, cols: term.xterm.cols, rows: term.xterm.rows, shell: null, run: run.command}); term.exited = false; }
  catch (e) { term.xterm.writeln(`\x1b[31m${t('toast.termFail', {e})}\x1b[0m`); term.exited = true; }
}
async function runConfig(c) {
  if (!project || !c || !invoke) return;
  if (dirtyFiles().length) await saveAll(true);   // like other IDEs: run what is in the editor
  const cwd = c.cwd || join(project.root, c.dir || ''), key = c.key || runKey(c);
  const run = {key, name: c.name, command: c.command, framework: c.framework};
  const term = terms.find(x => x.run && x.run.key === key);
  if (!term) return newTerminal(cwd, run);
  if (term.id != null && !term.exited) await invoke('term_kill', {id: term.id}).catch(() => {});
  term.id = null; term.xterm.reset();
  activeTerm = term; showBottom('terminal'); renderBottomTabs();
  await startRun(term, run, cwd);
  renderBottomTabs();
}
function runSelected() {
  const c = allRunConfigs().find(x => runKey(x) === runState.selected);
  return c ? runConfig(c) : editRunConfigs();
}
function runCurrentFile() {
  const f = curFile(); if (!f || f.kind !== 'text') return;
  const r = FILE_RUNNERS[f.model.getLanguageId()];
  if (!r) return toast(t('run.noRunner', {lang: f.model.getLanguageId()}));
  runConfig({name: baseName(f.path), command: r(f.path), cwd: dirName(f.path), key: 'f:' + f.path});
}
function stopRun() {
  const live = x => x.run && x.id != null && !x.exited;
  const tm = activeTerm && live(activeTerm) ? activeTerm : terms.find(live);
  if (!tm) return toast(t('run.nothing'));
  invoke('term_kill', {id: tm.id}).catch(() => {});
  tm.xterm.writeln(`\r\n\x1b[33m[${t('run.stopped')}]\x1b[0m`);
}
/* Own configurations: name, command line, folder (relative to the project). */
function editRunConfigs() {
  if (!project) return;
  const list = runState.custom.map(c => ({...c}));
  const row = (c, i) => `<div class="rc-row" data-i="${i}"><input class="field-in" data-f="name" value="${esc(c.name)}" placeholder="${esc(t('run.name'))}" spellcheck="false">
    <input class="field-in rc-cmd" data-f="command" value="${esc(c.command)}" placeholder="${esc(t('run.command'))}" spellcheck="false">
    <input class="field-in" data-f="dir" value="${esc(c.dir || '')}" placeholder="${esc(t('run.dir'))}" spellcheck="false"><button class="btn-sm" data-del="${i}" title="${esc(t('ctx.delete'))}">✕</button></div>`;
  const draw = () => { $('#rcList').innerHTML = list.length ? list.map(row).join('') : `<p class="hint">${esc(t('run.noneCustom'))}</p>`; };
  modal(t('a.editRunConfigs').replace('…', ''), `<p class="hint">${esc(t('run.hint'))}</p><div id="rcList"></div>
    <button class="btn-sm" id="rcAdd">${esc(t('run.add'))}</button>
    ${runDetected.length ? `<label class="lbl" style="margin-top:14px">${esc(t('run.project'))}</label><div class="rc-detected">${runDetected.map(c =>
      `<div><b>${esc(c.name)}</b> <code>${esc(c.command)}</code></div>`).join('')}</div>` : ''}`,
    [{label: t('ui.cancel'), onClick: closeModal}, {label: t('ui.save'), primary: true, onClick: () => {
      runState.custom = list.filter(c => c.name.trim() && c.command.trim()).map(c => ({name: c.name.trim(), command: c.command.trim(), dir: (c.dir || '').trim()}));
      saveSession(); renderRunSel(); closeModal();
    }}]);
  draw();
  $('#rcList').addEventListener('input', e => { const r = e.target.closest('.rc-row'); if (r && e.target.dataset.f) list[+r.dataset.i][e.target.dataset.f] = e.target.value; });
  $('#rcList').addEventListener('click', e => { const d = e.target.closest('[data-del]'); if (d) { list.splice(+d.dataset.del, 1); draw(); } });
  $('#rcAdd').onclick = () => { list.push({name: '', command: '', dir: ''}); draw(); $('#rcList .rc-row:last-child input').focus(); };
}
/* src/main.rs:12:5, C:\x\y.py:3, ./a/b.ts(4,2) … in terminal output open the file at that line. */
function addOutputLinks(term) {
  const re = /((?:[A-Za-z]:)?[\w.\-\/\\]*[\w\-]\.[A-Za-z][\w]{0,5})(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))/g;
  term.xterm.registerLinkProvider({provideLinks(y, done) {
    const line = term.xterm.buffer.active.getLine(y - 1); if (!line || !project) return done(undefined);
    const text = line.translateToString(true), links = [];
    for (const m of text.matchAll(re)) {
      const file = m[1], ln = +(m[2] || m[4]), col = +(m[3] || m[5] || 1);
      links.push({range: {start: {x: m.index + 1, y}, end: {x: m.index + m[0].length, y}}, text: m[0],
        activate: () => {
          const abs = /^([A-Za-z]:|[\\/])/.test(file) ? file : join((term.run && term.run.cwd) || project.root, file);
          openFile(abs, {line: ln, col});
        }});
    }
    done(links);
  }});
}

/* ================= Problems (from language servers) ================= */
function problemCount() {
  let e = 0, w = 0;
  for (const list of allDiags().values()) for (const d of list) { if (d.severity === 1) e++; else if (d.severity === 2) w++; }
  return {e, w, f: allDiags().size};
}
function renderProblems() {
  const box = $('#problemList'); if (!box) return;
  const pc = problemCount();
  $('#problemSum').textContent = pc.e + pc.w ? t('ui.problemsSum', {e: num(pc.e), w: num(pc.w), f: num(pc.f)}) : '';
  let html = '';
  const sev = ['', '#d7373f', '#e68619', '#378ef0', '#7f8c99'];
  for (const [path, list] of [...allDiags()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const shown = list.filter(d => d.severity <= 2); if (!shown.length) continue;
    html += `<div class="file-group">${fileIcon(path)}<span>${esc(baseName(path))}</span><small>${esc(relPath(dirName(path)))} · ${shown.length}</small></div>`;
    for (const d of shown.sort((a, b) => a.severity - b.severity || a.line - b.line))
      html += `<div class="hit" data-prob="${esc(path)}|${d.line}|${d.col}" style="font-family:var(--font-ui)"><span class="ln" style="color:${sev[d.severity]}">${d.severity === 1 ? '⛔' : '⚠'} ${d.line}</span><span class="tx">${esc(d.message.split('\n')[0])}</span></div>`;
  }
  box.innerHTML = html || `<div class="empty">${esc(t('ui.noProblems'))}</div>`;
}
$('#problemList').addEventListener('click', e => { const el = e.target.closest('[data-prob]'); if (!el) return; const [p, l, c] = el.dataset.prob.split('|'); jumpTo(p, +l, +c); });
let lspT;
LSP.onChange(() => { clearTimeout(lspT); lspT = setTimeout(() => { renderProblems(); renderBottomTabs(); renderLspStatus(); }, 120); });
async function renderLspStatus() {
  const el = $('#stLsp'), f = curFile(), pc = problemCount();
  $('#stProblems').hidden = !project || !(pc.e + pc.w);
  $('#stProblems').innerHTML = `<span style="color:var(--danger)">⛔ ${pc.e}</span> <span style="color:var(--warn)">⚠ ${pc.w}</span>`;
  const s = f && f.kind === 'text' ? await LSP.status(f.model.getLanguageId()) : null;
  el.hidden = !s;
  if (!s) return;
  el.dataset.state = s.state;
  el.textContent = s.state === 'indexing' ? `${s.name}: ${s.text}` : t('lsp.' + (s.state === 'ready' ? 'ready' : s.state), {name: s.name});
  el.style.color = s.state === 'missing' || s.state === 'crashed' ? 'var(--warn)' : '';
  el.title = s.text || '';
}
$('#stProblems').onclick = () => showBottom('problems');
$('#stLsp').onclick = async () => {
  const f = curFile(); if (!f || f.kind !== 'text') return;
  const s = await LSP.status(f.model.getLanguageId());
  if (!s || s.state !== 'missing') return;
  modal(t('lsp.installTitle', {name: s.name}), `<p>${esc(t('lsp.installText', {name: s.name}))}</p><p><kbd>${esc(s.install)}</kbd></p><p>${esc(t('lsp.installAfter'))}</p>`, [
    {label: t('ui.cancel'), onClick: closeModal},
    {label: t('lsp.installRun'), primary: true, onClick: async () => {
      closeModal(); await newTerminal();
      const tm = activeTerm; for (let i = 0; i < 40 && tm && tm.id == null; i++) await new Promise(r => setTimeout(r, 100));
      if (tm && tm.id != null) invoke('term_write', {id: tm.id, data: s.install + '\r'});
    }}]);
};
/* Find Usages (Alt+F7): the language server's references, shown in the Find panel. */
async function findUsages() {
  const ed = curEditor(); if (!ed) return;
  if (!LSP.hasClient(ed.getModel().getLanguageId())) { if (smart(ed)) return edCmd('editor.action.goToReferences')(); return toast(t('toast.noDef')); }
  const word = ed.getModel().getWordAtPosition(ed.getPosition());
  const refs = await LSP.references(ed.getModel(), ed.getPosition());
  if (!refs.length) return toast(t('toast.noUsages'));
  const texts = new Map();
  for (const r of refs) {
    if (!texts.has(r.path)) {
      const f = files.get(r.path);
      texts.set(r.path, f && f.kind === 'text' ? f.model.getLinesContent() : await readBytes(r.path).then(b => new TextDecoder().decode(b).split(/\r?\n/), () => []));
    }
    const line = texts.get(r.path)[r.line - 1] || '';
    r.rel = relPath(r.path); r.text = line.length > 300 ? line.slice(0, 300) + '…' : line;
  }
  findState.hits = refs; findState.query = {query: word ? word.word : '', usages: true};
  renderFind(); showBottom('find');
}

/* ================= Local history ================= */
async function localHistory(path = curPath()) {
  if (!path || !invoke) return;
  const f = await loadFile(path); if (!f || f.kind !== 'text') return;
  const versions = await invoke('history_list', {path});
  modal(t('ui.historyOf', {name: baseName(path)}), `<div class="hist"><div class="col" id="histList">${versions.length ? versions.map((v, i) =>
    `<div class="pp-item" data-v="${i}"><span class="nm">${esc(new Date(v.id).toLocaleString(lang === 'de' ? 'de-DE' : 'en-US'))}</span><small>${(v.size / 1024).toFixed(1)} KB</small></div>`).join('')
    : `<div class="empty">${esc(t('ui.noHistory'))}</div>`}</div>
    <div class="diff"><div class="diff-head">${esc(t('ui.diffHint'))}</div><div class="diff-host" id="diffHost"></div></div></div>`,
    [{label: t('ui.cancel'), onClick: closeModal}, {label: t('ui.revert'), primary: true, onClick: () => revert()}], 'huge');
  const diff = monaco.editor.createDiffEditor($('#diffHost'), {...editorOptions(), readOnly: true, originalEditable: false, renderSideBySide: true, minimap: {enabled: false}, automaticLayout: true});
  let orig = null, cur = -1;
  modalOnClose = () => { diff.dispose(); if (orig) orig.dispose(); };
  async function pick(i) {
    cur = i; $$('#histList .pp-item').forEach((el, k) => el.classList.toggle('sel', k === i));
    const bytes = new Uint8Array(await invoke('history_read', {path, id: versions[i].id}));
    const text = new TextDecoder().decode(bytes[0] === 0xEF && bytes[1] === 0xBB ? bytes.subarray(3) : bytes);
    const old = orig; orig = monaco.editor.createModel(text, f.model.getLanguageId());
    diff.setModel({original: orig, modified: f.model}); if (old) old.dispose();
  }
  async function revert() {
    if (cur < 0 || !orig) return;
    if (!await ask(t('confirm.revert', {name: baseName(path)}), t('ui.revert'))) return;
    f.model.pushEditOperations([], [{range: f.model.getFullModelRange(), text: orig.getValue()}], () => null);
    closeModal(); await openFile(path); toast(t('toast.reverted'));
  }
  $('#histList').addEventListener('click', e => { const el = e.target.closest('[data-v]'); if (el) pick(+el.dataset.v); });
  if (versions.length) pick(versions.length > 1 && versions[0].size >= 0 ? 1 : 0);
}

/* ================= New project ================= */
const TEMPLATES = {
  empty: {icon: '··', col: '#7f8c99', main: 'README.md', files: n => ({'README.md': `# ${n}\n`})},
  rust: {icon: 'RS', col: '#ce6a2a', main: 'src/main.rs', files: n => ({
    'Cargo.toml': `[package]\nname = "${n.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`,
    'src/main.rs': 'fn main() {\n    println!("Hello, world!");\n}\n', '.gitignore': '/target\n'})},
  node: {icon: 'TS', col: '#3178c6', main: 'src/index.ts', files: n => ({
    'package.json': JSON.stringify({name: n.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'), version: '0.1.0', private: true, type: 'module',
      scripts: {build: 'tsc', start: 'node dist/index.js'}, devDependencies: {typescript: '^5.6.0'}}, null, 2) + '\n',
    'tsconfig.json': JSON.stringify({compilerOptions: {target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', outDir: 'dist', rootDir: 'src', strict: true}}, null, 2) + '\n',
    'src/index.ts': 'const greet = (name: string): string => `Hello, ${name}!`;\n\nconsole.log(greet("world"));\n', '.gitignore': 'node_modules/\ndist/\n'})},
  python: {icon: 'PY', col: '#3776ab', main: 'main.py', files: n => ({
    'main.py': 'def main() -> None:\n    print("Hello, world!")\n\n\nif __name__ == "__main__":\n    main()\n', 'README.md': `# ${n}\n\nRun with \`python main.py\`.\n`, '.gitignore': '__pycache__/\n.venv/\n'})},
  web: {icon: '<>', col: '#e34c26', main: 'index.html', files: n => ({
    'index.html': `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${n}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>${n}</h1>\n  <script src="script.js"></script>\n</body>\n</html>\n`,
    'style.css': 'body {\n  font-family: system-ui, sans-serif;\n  margin: 2rem;\n}\n', 'script.js': 'console.log("Hello from script.js");\n'})}
};
function newProject() {
  let tpl = 'rust';
  const last = recentProjects[0] ? dirName(recentProjects[0].path) : '';
  modal(t('a.newProject').replace('…', ''), `<label class="lbl">${esc(t('ui.template'))}</label><div class="tpl-grid">${Object.entries(TEMPLATES).map(([k, v]) =>
    `<button class="tpl${k === tpl ? ' active' : ''}" data-tpl="${k}"><span class="fi" style="background:${v.col};width:26px;height:26px;font-size:10px">${esc(v.icon)}</span><span><b>${esc(t('tpl.' + k))}</b><small>${esc(t('tpl.' + k + 'D'))}</small></span></button>`).join('')}</div>
    <label class="lbl">${esc(t('ui.name'))}</label><input class="field-in" id="npName" value="my-project" spellcheck="false">
    <label class="lbl">${esc(t('ui.location'))}</label><div style="display:flex;gap:8px"><input class="field-in" id="npLoc" value="${esc(last)}" spellcheck="false"><button class="btn-sm" id="npBrowse">${esc(t('ui.browse'))}</button></div>`,
    [{label: t('ui.cancel'), onClick: closeModal}, {label: t('ui.create'), primary: true, onClick: create}]);
  $('#modalBody').onclick = e => { const b = e.target.closest('[data-tpl]'); if (b) { tpl = b.dataset.tpl; $$('[data-tpl]').forEach(x => x.classList.toggle('active', x === b)); } };
  $('#npBrowse').onclick = async () => { const p = await invoke('pick_folder'); if (p) $('#npLoc').value = p; };
  $('#npName').select(); $('#npName').focus();
  async function create() {
    const name = $('#npName').value.trim(), loc = $('#npLoc').value.trim();
    if (!name || !loc) return;
    const s = loc.includes('\\') ? '\\' : '/', root = loc.replace(/[\\/]+$/, '') + s + name;
    try {
      await invoke('create_dir', {path: root});
      for (const [rel, text] of Object.entries(TEMPLATES[tpl].files(name))) await invoke('create_file', {path: root + s + rel.replace(/\//g, s), text});
    } catch (e) { return toast(t('toast.fail', {e})); }
    closeModal();
    if (await openProject(root, {fresh: true})) { toast(t('toast.created')); const main = root + s + TEMPLATES[tpl].main.replace(/\//g, s); await selectInProject(main); openFile(main); }
  }
}

/* ================= Actions, menus, toolbars, shortcuts ================= */
const svg = d => `<svg viewBox="0 0 24 24">${d}</svg>`;
const ICONS = {
  run: svg('<path d="M8 5v14l11-7z" style="fill:#59a869;stroke:#59a869"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5" style="fill:#d7373f;stroke:#d7373f"/>'),
  open: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  newProject: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>'),
  newFile: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>'),
  newFolder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>'),
  save: svg('<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8M7 21v-7h10v7"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'), redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>'),
  back: svg('<path d="M19 12H5M12 19l-7-7 7-7"/>'), forward: svg('<path d="M5 12h14M12 5l7 7-7 7"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  recent: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  findFiles: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4"/><path d="M14 3v5h5"/><circle cx="16" cy="16" r="3"/><path d="m21 21-2.8-2.8"/>'),
  project: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  structure: svg('<path d="M4 5h6M7 5v14M7 12h4M7 19h4M14 12h6M14 19h6"/>'),
  todo: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 3 3 5-6"/>'),
  terminal: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>'),
  find: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  comment: svg('<path d="M8 4 4 20M14 4l-4 16"/>'), format: svg('<path d="M4 6h16M8 10h12M4 14h16M8 18h12"/>'),
  duplicate: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>'),
  fold: svg('<path d="m7 15 5-5 5 5"/><path d="M5 20h14"/>'), unfold: svg('<path d="m7 9 5 5 5-5"/><path d="M5 4h14"/>'),
  history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
  panel: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>'), bottom: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15h18"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'), collapse: svg('<path d="m7 20 5-5 5 5M7 4l5 5 5-5"/>'),
  target: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'), plus: svg('<path d="M12 5v14M5 12h14"/>'), problems: svg('<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.01"/>')
};
const edCmd = (id, args) => () => { const ed = curEditor(); if (!ed) return; ed.focus(); ed.trigger('studio', id, args || null); };
const togglePanel = tab => () => {
  if (settings.dock && settings.dockTab === tab) settings.dock = false; else { settings.dock = true; settings.dockTab = tab; }
  applyLayout();
  if (settings.dock) { if (tab === 'project') $('#tree').focus(); if (tab === 'structure') { buildStructure(); $('#symFilter').focus(); } if (tab === 'todo') refreshTodo(); if (tab === 'git') refreshGit(); }
  else { const ed = curEditor(); if (ed) ed.focus(); }
};
const toggleBottomTab = tab => () => { if (settings.bottom && settings.bottomTab === tab) { settings.bottom = false; applyLayout(); const ed = curEditor(); if (ed) ed.focus(); } else showBottom(tab); };
const setPref = (k, v) => { settings[k] = v; applySettings(); };
const copyText = async text => { await Native.clipboardWrite(text); toast(t('toast.copied')); };
function showDock(tab) { settings.dock = true; settings.dockTab = tab; applyLayout(); }
const DEF_LANGS = ['typescript', 'javascript', 'css', 'scss', 'less', 'json', 'html'];
/* Declarations, usages and rename need a language server (or Monaco's own TypeScript/CSS/HTML support). */
const smart = ed => DEF_LANGS.includes(ed.getModel().getLanguageId()) || LSP.hasClient(ed.getModel().getLanguageId());
const A = {
  gitCommit: () => gitCommit(), gitPush: () => gitHandle('push'), gitPull: () => gitHandle('pull'), gitPanel: togglePanel('git'),
  gitBranches: async () => { const items = await gitBranchMenu(); if (items) invoke('context_menu', {items: items.map(i => i ? {id: i.id, label: i.label, enabled: i.enabled !== false, checked: i.checked, accel: i.accel || null} : {})}); },
  gitRefresh: () => refreshGit(),
  run: () => runSelected(), runFile: () => runCurrentFile(), stopRun: () => stopRun(), editRunConfigs: () => editRunConfigs(),
  toggleAutoHide: () => { settings.autoHide = !settings.autoHide; applySettings(); },
  newProject, openFolder: async () => { const p = await invoke('pick_folder'); if (p) openProject(p); }, closeProject: () => closeProject(false),
  newFile: () => newFile(), newFolder: () => newFolder(), saveAll: async () => { if (settings.formatOnSave) for (const f of dirtyFiles()) await formatFile(f, true); return saveAll(); }, localHistory: () => localHistory(),
  closeTab: () => closeTab(curGroup(), curPath()), closeAllTabs: async () => { for (const g of [...groups]) await closeTabs(g, null); },
  undo: edCmd('undo'), redo: edCmd('redo'), duplicateLine: edCmd('editor.action.copyLinesDownAction'), deleteLine: edCmd('editor.action.deleteLines'),
  moveLineUp: edCmd('editor.action.moveLinesUpAction'), moveLineDown: edCmd('editor.action.moveLinesDownAction'),
  expandSelection: edCmd('editor.action.smartSelect.expand'), shrinkSelection: edCmd('editor.action.smartSelect.shrink'),
  addNextOccurrence: edCmd('editor.action.addSelectionToNextFindMatch'), selectAllOccurrences: edCmd('editor.action.selectHighlights'),
  find: edCmd('actions.find'), replace: edCmd('editor.action.startFindReplaceAction'),
  findInFiles: () => findInFilesPopup(false), replaceInFiles: () => findInFilesPopup(true),
  copyPath: () => copyText(curPath()), copyRelPath: () => copyText(relPath(curPath())),
  toggleProject: togglePanel('project'), toggleStructure: togglePanel('structure'), toggleTodo: togglePanel('todo'),
  toggleFind: toggleBottomTab('find'), toggleTerminal: toggleBottomTab('terminal'),
  togglePanels: () => { settings.dock = !settings.dock; applyLayout(); }, toggleBottom: () => { if (settings.bottom) { settings.bottom = false; applyLayout(); } else showBottom(); },
  hideAll: () => {
    if (settings.dock || settings.bottom) { hiddenPanels = {dock: settings.dock, bottom: settings.bottom}; settings.dock = settings.bottom = false; }
    else if (hiddenPanels) { settings.dock = hiddenPanels.dock; settings.bottom = hiddenPanels.bottom; hiddenPanels = null; }
    applyLayout();
  },
  splitRight: async () => { const p = curPath(); ensureGroups(2); if (p) await openFile(p, {group: 1}); groups.forEach(renderGroup); updateUI(); saveSession(); },
  unsplit: () => { if (groups.length > 1) removeGroup(groups[1]); },
  layoutSingle: () => A.unsplit(), layoutSplit: () => { if (groups.length < 2) A.splitRight(); },
  wordWrap: () => setPref('wordWrap', !settings.wordWrap), minimap: () => setPref('minimap', !settings.minimap), whitespace: () => setPref('whitespace', !settings.whitespace),
  searchEverywhere: () => searchEverywhere('all'), goToFile: () => searchEverywhere('files'), goToSymbol: () => searchEverywhere('symbols'), findAction: () => searchEverywhere('actions'),
  recentFiles: recentFilesPopup, goToLine, back: () => navGo(-1), forward: () => navGo(1), selectInProject: () => selectInProject(),
  nextTab: () => cycleTab(1), prevTab: () => cycleTab(-1),
  goToDefinition: () => { const ed = curEditor(); if (!ed) return; if (!smart(ed)) return toast(t('toast.noDef')); edCmd('editor.action.revealDefinition')(); },
  formatCode: () => { const ed = curEditor(); if (!ed) return; const s = ed.getSelection(); if (s && !s.isEmpty()) return edCmd('editor.action.formatSelection')(); formatFile(curFile(), false); },
  optimizeImports: () => optimizeImports(), fixLint: () => lintFix(curFile()), clippyFix: () => clippyFix(),
  commentLine: edCmd('editor.action.commentLine'), blockComment: edCmd('editor.action.blockComment'),
  renameSymbol: () => {
    if (document.activeElement && document.activeElement.closest('#tree') && tree.sel && tree.sel !== project.root) return renamePath(tree.sel);
    const ed = curEditor(); if (!ed) return;
    if (!smart(ed)) return toast(t('toast.noDef'));
    edCmd('editor.action.rename')();
  },
  findUsages, quickFix: edCmd('editor.action.quickFix'), quickDoc: edCmd('editor.action.showHover'), parameterInfo: edCmd('editor.action.triggerParameterHints'),
  goToImplementation: () => { const ed = curEditor(); if (!ed) return; if (!LSP.hasClient(ed.getModel().getLanguageId())) return toast(t('toast.noDef')); edCmd('editor.action.goToImplementation')(); },
  toggleProblems: toggleBottomTab('problems'),
  fold: edCmd('editor.fold'), unfold: edCmd('editor.unfold'), foldAll: edCmd('editor.foldAll'), unfoldAll: edCmd('editor.unfoldAll'),
  newTerminal: () => newTerminal(), refreshTree: async () => { fileList = null; await refreshTree(true); },
  collapseTree: () => { tree.expanded = new Set([project.root]); renderTree(); saveSession(); }, refreshTodo,
  settings: () => openSettings(),
  langAuto: () => setPref('lang', 'auto'), langEn: () => setPref('lang', 'en'), langDe: () => setPref('lang', 'de'),
  themeDark: () => setPref('theme', 'dark'), themeLight: () => setPref('theme', 'light'), themeGithub: () => setPref('theme', 'github'), themeGithubDark: () => setPref('theme', 'github-dark'),
  shortcuts: () => {
    let h = '';
    MENUS.forEach(([m, items]) => {
      const rows = items.filter(it => Array.isArray(it) && it[1]);
      if (rows.length) h += `<h4>${esc(t('menu.' + m))}</h4><table>` + rows.map(it => `<tr><td>${esc(t('a.' + it[0]))}</td><td><kbd>${esc(fmtKey(it[1]))}</kbd></td></tr>`).join('') + '</table>';
    });
    h += `<h4>${esc(t('sc.editor'))}</h4><table><tr><td>${esc(t('sc.multi'))}</td><td><kbd>${esc(fmtKey(t('sc.multiKey')))}</kbd></td></tr><tr><td>${esc(t('sc.suggest'))}</td><td><kbd>${esc(t('sc.suggestKey'))}</kbd></td></tr></table>`;
    modal(t('a.shortcuts'), h);
  },
  about: async () => {
    const v = invoke ? await window.__TAURI__.app.getVersion().catch(() => '') : '';
    modal(t('a.about'), `${v ? `<p><b>${t('about.version', {v: esc(v)})}</b></p>` : ''}<p>${t('about.p1')}</p><p>${t('about.p2')}</p><p>${t('about.p3')}</p>`);
  }
};
let hiddenPanels = null;
function cycleTab(d) { const g = curGroup(); if (!g || g.tabs.length < 2) return; const i = g.tabs.indexOf(g.active); setActive(g, g.tabs[(i + d + g.tabs.length) % g.tabs.length]); const ed = curEditor(); if (ed) ed.focus(); }
// [action, shortcut, checked(), handledElsewhere, alias shortcuts]
const MENUS = [
  ['file', [['newProject'], ['openFolder', 'Ctrl+O'], ['closeProject'], '-', ['newFile', 'Alt+Insert'], ['newFolder'], '-', ['saveAll', 'Ctrl+S'], ['localHistory'], '-',
    ['closeTab', 'Ctrl+F4'], ['closeAllTabs']]],
  ['edit', [['undo', 'Ctrl+Z'], ['redo', 'Ctrl+Shift+Z'], '-', ['duplicateLine', 'Ctrl+D'], ['deleteLine', 'Ctrl+Y'], ['moveLineUp', 'Alt+Shift+ArrowUp'], ['moveLineDown', 'Alt+Shift+ArrowDown'], '-',
    ['expandSelection', 'Ctrl+W'], ['shrinkSelection', 'Ctrl+Shift+W'], ['addNextOccurrence', 'Alt+J'], ['selectAllOccurrences', 'Ctrl+Alt+Shift+J'], '-',
    ['find', 'Ctrl+F'], ['replace', 'Ctrl+R'], ['findInFiles', 'Ctrl+Shift+F'], ['replaceInFiles', 'Ctrl+Shift+R'], '-', ['copyPath', 'Ctrl+Shift+C'], ['copyRelPath', 'Ctrl+Alt+Shift+C']]],
  ['view', [['toggleProject', 'Alt+1', () => settings.dock && settings.dockTab === 'project'], ['toggleStructure', 'Alt+7', () => settings.dock && settings.dockTab === 'structure'],
    ['toggleTodo', null, () => settings.dock && settings.dockTab === 'todo'], ['toggleFind', 'Alt+3', () => settings.bottom && settings.bottomTab === 'find'],
    ['toggleProblems', 'Alt+6', () => settings.bottom && settings.bottomTab === 'problems'],
    ['toggleTerminal', 'Alt+F12', () => settings.bottom && settings.bottomTab === 'terminal'], '-',
    ['togglePanels', 'Ctrl+\\', () => settings.dock], ['toggleAutoHide', null, () => settings.autoHide], ['toggleBottom', null, () => settings.bottom], ['hideAll', 'Ctrl+Shift+F12'], '-',
    ['splitRight'], ['unsplit'], '-', ['wordWrap', null, () => settings.wordWrap], ['minimap', null, () => settings.minimap], ['whitespace', null, () => settings.whitespace]]],
  ['navigate', [['searchEverywhere', 'Shift Shift', null, true], ['goToFile', 'Ctrl+Shift+N'], ['goToSymbol', 'Ctrl+Alt+Shift+N'], ['findAction', 'Ctrl+Shift+A', null, false, ['F1']],
    ['recentFiles', 'Ctrl+E'], '-', ['goToLine', 'Ctrl+G'], ['back', 'Ctrl+Alt+ArrowLeft'], ['forward', 'Ctrl+Alt+ArrowRight'], '-',
    ['goToDefinition', 'Ctrl+B'], ['goToImplementation', 'Ctrl+Alt+B'], ['findUsages', 'Alt+F7'], ['selectInProject', 'Alt+F1'], '-', ['nextTab', 'Alt+ArrowRight'], ['prevTab', 'Alt+ArrowLeft']]],
  ['code', [['quickFix', 'Alt+Enter'], ['quickDoc', 'Ctrl+Q'], ['parameterInfo', 'Ctrl+P'], '-', ['formatCode', 'Ctrl+Alt+L'], ['optimizeImports', 'Ctrl+Alt+O'], ['fixLint'], ['clippyFix'], ['commentLine', 'Ctrl+/'], ['blockComment', 'Ctrl+Shift+/', null, false, ['Ctrl+?']], '-', ['renameSymbol', 'Shift+F6'], '-',
    ['fold', 'Ctrl+-'], ['unfold', 'Ctrl+=', null, false, ['Ctrl++']], ['foldAll', 'Ctrl+Shift+-', null, false, ['Ctrl+_']], ['unfoldAll', 'Ctrl+Shift+=']]],
  ['git', [['gitCommit', 'Ctrl+K'], ['gitPush', 'Ctrl+Shift+K'], ['gitPull', 'Ctrl+T'], '-', ['gitBranches'], ['gitPanel', 'Alt+0'], ['gitRefresh']]],
  ['run', [['run', 'Shift+F10'], ['runFile', 'Ctrl+Shift+F10'], ['stopRun', 'Ctrl+F2'], '-', ['editRunConfigs']]],
  ['settings', [['settings', 'Ctrl+Alt+S'], '-', '#menu.language',
    ['langAuto', null, () => settings.lang === 'auto'], ['langEn', null, () => settings.lang === 'en'], ['langDe', null, () => settings.lang === 'de'],
    '-', '#menu.theme',
    ['themeDark', null, () => settings.theme === 'dark'], ['themeLight', null, () => settings.theme === 'light'],
    ['themeGithub', null, () => settings.theme === 'github'], ['themeGithubDark', null, () => settings.theme === 'github-dark']]],
  ['help', [['shortcuts'], '-', ['about']]]
];
const KEYMAP = {};
/* Built from the menu entries — again whenever a shortcut is changed in Settings (shortcuts.js). */
function buildKeymap() {
  for (const m of [KEYMAP]) for (const k in m) delete m[k];
  MENUS.forEach(([, items]) => items.forEach(it => { if (!Array.isArray(it)) return; if (it[1] && !it[3]) KEYMAP[it[1]] = it[0]; (it[4] || []).forEach(k => KEYMAP[k] = it[0]); }));
}
buildKeymap();
const NEEDS_EDITOR = new Set(['optimizeImports', 'fixLint', 'runFile', 'undo', 'redo', 'duplicateLine', 'deleteLine', 'moveLineUp', 'moveLineDown', 'expandSelection', 'shrinkSelection', 'addNextOccurrence',
  'selectAllOccurrences', 'find', 'replace', 'goToLine', 'goToDefinition', 'goToImplementation', 'findUsages', 'quickFix', 'quickDoc', 'parameterInfo', 'formatCode', 'commentLine', 'blockComment', 'fold', 'unfold', 'foldAll', 'unfoldAll', 'localHistory']);
const NO_PROJECT = new Set(['toggleAutoHide', 'newProject', 'openFolder', 'settings', 'langAuto', 'langEn', 'langDe', 'themeDark', 'themeLight', 'themeGithub', 'themeGithubDark',
  'shortcuts', 'about', 'togglePanels', 'hideAll', 'wordWrap', 'minimap', 'whitespace', 'findAction', 'searchEverywhere']);
function allowed(act) {
  if (NO_PROJECT.has(act)) return true;
  if (!project) return false;
  if (NEEDS_EDITOR.has(act)) return !!curEditor();
  if (['closeTab', 'copyPath', 'copyRelPath', 'selectInProject', 'splitRight', 'nextTab', 'prevTab'].includes(act)) return !!curPath();
  if (act === 'unsplit' || act === 'layoutSingle') return groups.length > 1;
  if (act === 'saveAll') return dirtyFiles().length > 0;
  if (act === 'back') return nav.stack.length > 0 && (nav.i > 0 || nav.i === nav.stack.length - 1);
  if (act === 'forward') return nav.i < nav.stack.length - 1;
  return true;
}
function runAct(act) { if (A[act] && allowed(act)) A[act](); }
function syncDisabled() { $$('[data-act]').forEach(b => { if (b.dataset.act in A) b.disabled = !allowed(b.dataset.act); }); }
const keyOf = act => { for (const [, items] of MENUS) for (const it of items) if (Array.isArray(it) && it[0] === act && it[1]) return it[1]; return ''; };
const tip = act => t('a.' + act) + (keyOf(act) ? ` (${fmtKey(keyOf(act))})` : '');

let menuOpen = null;
function openMenu(m, items) {
  closeMenus();
  const dd = m.querySelector('.dropdown'); dd.innerHTML = '';
  items.forEach(it => {
    if (it === '-') return dd.append(document.createElement('hr'));
    if (typeof it === 'string') { const l = document.createElement('div'); l.className = 'dd-label'; l.textContent = t(it.slice(1)); return dd.append(l); }
    const [act, key, check] = it, b = document.createElement('button');
    b.innerHTML = `<span class="chk">${check && check() ? '&#10003;' : ''}</span><span>${esc(t('a.' + act))}</span><kbd>${esc(key ? fmtKey(key) : '')}</kbd>`;
    b.disabled = !allowed(act);
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => { closeMenus(); runAct(act); };
    dd.append(b);
  });
  m.classList.add('open'); menuOpen = m;
}
function closeMenus() { $$('.menu.open').forEach(x => x.classList.remove('open')); menuOpen = null; }
function buildMenubar() {
  const navEl = $('#menus'); navEl.innerHTML = ''; menuOpen = null;
  MENUS.forEach(([name, items]) => {
    const m = document.createElement('div'), b = document.createElement('button'), dd = document.createElement('div');
    m.className = 'menu'; dd.className = 'dropdown'; b.textContent = t('menu.' + name);
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => menuOpen === m ? closeMenus() : openMenu(m, items);
    b.onmouseenter = () => { if (menuOpen && menuOpen !== m) openMenu(m, items); };
    m.append(b, dd); navEl.append(m);
  });
}
document.addEventListener('mousedown', e => { if (menuOpen && !e.target.closest('.menu')) closeMenus(); });
function makeBtn(act, html) {
  const b = document.createElement('button');
  b.className = 'ibtn'; b.innerHTML = html; b.title = tip(act); b.dataset.act = act;
  return b;
}
function buildToolbars() {
  const fill = (id, list) => { const box = $(id); box.innerHTML = ''; list.forEach(([a, i]) => box.append(makeBtn(a, i))); };
  fill('#fileBtns', [['openFolder', ICONS.open], ['newProject', ICONS.newProject], ['newFile', ICONS.newFile], ['saveAll', ICONS.save], ['undo', ICONS.undo], ['redo', ICONS.redo]]);
  fill('#runBtns', [['run', ICONS.run], ['stopRun', ICONS.stop]]);
  fill('#navBtns', [['back', ICONS.back], ['forward', ICONS.forward], ['goToFile', ICONS.file], ['recentFiles', ICONS.recent], ['findInFiles', ICONS.findFiles]]);
  fill('#viewBtns', [['toggleTerminal', ICONS.terminal], ['toggleBottom', ICONS.bottom], ['togglePanels', ICONS.panel], ['settings', ICONS.gear], ['shortcuts', ICONS.help]]);
  const tools = $('#tools'); tools.innerHTML = '';
  [['toggleProject', ICONS.project], ['toggleStructure', ICONS.structure], ['toggleTodo', ICONS.todo], '-', ['toggleFind', ICONS.find], ['toggleProblems', ICONS.problems], ['toggleTerminal', ICONS.terminal], '-',
    ['commentLine', ICONS.comment], ['formatCode', ICONS.format], ['duplicateLine', ICONS.duplicate], ['foldAll', ICONS.fold], ['unfoldAll', ICONS.unfold], '-', ['localHistory', ICONS.history]]
    .forEach(r => { if (r === '-') { const s = document.createElement('div'); s.className = 'sep'; tools.append(s); } else tools.append(makeBtn(...r)); });
  $('#layoutSeg').innerHTML = [['layoutSingle', 'ui.single'], ['layoutSplit', 'ui.split']].map(([a, l]) => `<button data-act="${a}" title="${esc(t('a.' + a))}">${esc(t(l))}</button>`).join('');
  $('#treeHead').innerHTML = `<span style="flex:1;font-weight:600;color:var(--strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="treeTitle"></span>` +
    [['selectInProject', ICONS.target], ['newFile', ICONS.newFile], ['newFolder', ICONS.newFolder], ['collapseTree', ICONS.collapse], ['refreshTree', ICONS.refresh]].map(([a, i]) => makeBtn(a, i).outerHTML).join('');
  $$('[data-tip]').forEach(b => b.title = t(b.dataset.tip));
}
document.addEventListener('mousedown', e => { if (e.target.closest('.ibtn,.cta,#layoutSeg button,.search-btn')) e.preventDefault(); });
document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && !b.disabled && !b.closest('.dropdown')) runAct(b.dataset.act); });
$$('#dockTabs button').forEach(b => b.onclick = () => { settings.dock = true; settings.dockTab = b.dataset.tab; applyLayout(); if (b.dataset.tab === 'structure') buildStructure(); if (b.dataset.tab === 'todo') refreshTodo(); if (b.dataset.tab === 'git') refreshGit(); });

/* Shortcut text for a key event: Ctrl+Alt+Shift+Key. For punctuation, Shift is part of the character, so the same
   shortcut works on US and German keyboards (Ctrl+/ is Ctrl+Shift+7 on a German keyboard). */
function comboOf(e) {
  let k = e.key, shift = e.shiftKey;
  if (/^Digit\d$/.test(e.code) && (!e.shiftKey || /^\d$/.test(k))) k = e.code.slice(5);
  else if (e.code === 'NumpadSubtract') { k = shift ? '_' : '-'; shift = false; }
  else if (e.code === 'NumpadAdd') { k = '+'; shift = false; }
  else if (k === ' ') k = 'Space';
  else if (k.length === 1 && /[a-z]/i.test(k)) k = k.toUpperCase();
  else if (k.length === 1) shift = false;
  return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (shift ? 'Shift+' : '') + k;
}
const inPlainField = () => { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || (a.tagName === 'TEXTAREA' && !a.closest('.monaco-editor,.xterm'))); };
const inTerminal = () => { const a = document.activeElement; return !!(a && a.closest && a.closest('.xterm')); };
const FIELD_OK = new Set(['searchEverywhere', 'goToFile', 'findInFiles', 'replaceInFiles', 'settings', 'toggleTerminal', 'toggleProject', 'recentFiles', 'saveAll', 'goToSymbol', 'findAction']);
let shiftAt = 0, shiftClean = true;
window.addEventListener('keydown', e => {
  if (window.Shortcuts && Shortcuts.recording) return;   // Settings → Shortcuts is taking a key
  if (e.key !== 'Shift') { shiftClean = false; shiftAt = 0; }
  if (e.key === 'Escape') {
    if ($('#modal').classList.contains('show')) { e.preventDefault(); closeModal(); }
    else if (popup) { e.preventDefault(); closePopup(); }
    else if (menuOpen) closeMenus();
    else if (inTerminal() || (document.activeElement && document.activeElement.closest('#dock'))) { const ed = curEditor(); if (ed) { e.preventDefault(); ed.focus(); } }
    return;
  }
  if (e.key === 'F5') { e.preventDefault(); return; }   // no accidental reload
  if ($('#modal').classList.contains('show')) return;
  const act = KEYMAP[comboOf(e)];
  if (popup) {
    // Inside a popup only the search shortcuts switch the popup's tab.
    if (act && ['searchEverywhere', 'goToFile', 'goToSymbol', 'findAction'].includes(act)) { e.preventDefault(); e.stopPropagation(); runAct(act); }
    return;
  }
  if (!act) return;
  if (inTerminal() && act !== 'toggleTerminal' && act !== 'newTerminal' && act !== 'hideAll') return;
  if (inPlainField() && !FIELD_OK.has(act)) return;
  e.preventDefault(); e.stopPropagation(); runAct(act);
}, true);
/* Double Shift opens Search Everywhere (two Shift presses with nothing in between). */
window.addEventListener('keyup', e => {
  if (e.key !== 'Shift') return;
  const now = performance.now();
  if (!shiftClean) { shiftClean = true; shiftAt = now; return; }
  if (shiftAt && now - shiftAt < 400 && !inTerminal() && !$('#modal').classList.contains('show')) { shiftAt = 0; if (popup && popup.kind === 'se') return; closePopup(); runAct('searchEverywhere'); }
  else shiftAt = now;
}, true);
window.addEventListener('mousedown', () => { shiftAt = 0; }, true);

/* ================= Layout: dock, bottom panel, splitters ================= */
function applyLayout() {
  const root = document.documentElement.style;
  root.setProperty('--dock-w', settings.dockW + 'px'); root.setProperty('--bottom-h', settings.bottomH + 'px');
  $('#dock').classList.toggle('hidden', !settings.dock);
  $$('#dockTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === settings.dockTab));
  $$('.dpanel').forEach(p => p.classList.toggle('active', p.dataset.panel === settings.dockTab));
  const showB = settings.bottom && !!project;
  $('#bottom').hidden = !showB; $('#bottomSplit').hidden = !showB;
  renderBottomTabs();
  // Like Markdown Studio: toolbar and rail buttons don't stay highlighted; the panel tabs show what's open.

  if (showB) setTimeout(fitTerms, 20);
  saveState();
}
function dragSize(handle, onMove) {
  handle.addEventListener('pointerdown', e => {
    e.preventDefault(); handle.setPointerCapture(e.pointerId); handle.classList.add('drag');
    const move = ev => onMove(ev);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', () => { handle.removeEventListener('pointermove', move); handle.classList.remove('drag'); applyLayout(); }, {once: true});
  });
}
dragSize($('#dockSplit'), ev => { settings.dockW = Math.round(Math.min(window.innerWidth * 0.5, Math.max(200, window.innerWidth - ev.clientX))); document.documentElement.style.setProperty('--dock-w', settings.dockW + 'px'); });
dragSize($('#bottomSplit'), ev => { const r = $('.center').getBoundingClientRect(); settings.bottomH = Math.round(Math.min(r.height - 120, Math.max(100, r.bottom - ev.clientY))); document.documentElement.style.setProperty('--bottom-h', settings.bottomH + 'px'); fitTerms(); });

/* ================= Modal, toast, confirm ================= */
let modalOnClose = null;
function modal(title, html, buttons = null, cls = '') {
  if (modalOnClose) { const f = modalOnClose; modalOnClose = null; f(); }
  $('.modal').className = 'modal' + (cls ? ' ' + cls : ''); settingsOpen = false;
  $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#modalBody').onclick = null;
  const foot = $('#modalFoot');
  foot.hidden = !buttons; foot.innerHTML = '';
  if (buttons) {
    foot.append(Object.assign(document.createElement('span'), {className: 'flex'}));
    buttons.forEach(b => { const el = document.createElement('button'); el.className = 'btn-sm' + (b.primary ? ' primary' : ''); el.textContent = b.label; el.onclick = b.onClick; foot.append(el); });
  }
  $('#modal').classList.add('show');
}
function closeModal() {
  $('#modal').classList.remove('show'); settingsOpen = false;
  if (modalOnClose) { const f = modalOnClose; modalOnClose = null; f(); }
}
$('#modalClose').onclick = closeModal;
let toastT;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 3000); }
async function ask(message, okLabel, cancelLabel) {
  return invoke ? invoke('confirm', {title: t('confirm.title'), message, okLabel, cancelLabel: cancelLabel || t('confirm.cancel')}) : confirm(message);
}
document.addEventListener('click', e => {
  const a = e.target.closest('.modal-body a[href^="http"]'); if (!a) return;
  e.preventDefault();
  if (invoke) invoke('open_url', {url: a.href}).catch(() => {}); else window.open(a.href, '_blank', 'noopener');
});

/* ================= Settings ================= */
let settingsOpen = false, prefsSection = 'general';
function openSettings() { modal(t('set.title'), '', [], 'wide'); renderSettings(); settingsOpen = true; }
function renderSettings() {
  const opt = (v, label, cv) => `<option value="${v}"${String(v) === String(cv) ? ' selected' : ''}>${esc(label)}</option>`;
  const sw = (name, label) => `<label class="switch"><input type="checkbox" data-sw="${name}"${settings[name] ? ' checked' : ''}><span></span>${esc(label)}</label>`;
  const mock = th => `<div class="tc-mock" data-theme="${th}"><div class="tc-bar"><i></i><i></i><i></i><b></b></div><div class="tc-body"><div class="tc-rail"></div>
    <div class="tc-code"><i style="width:60%;background:#c678dd"></i><i style="width:80%;background:var(--dim)"></i><i style="width:45%;background:#e5a54b"></i><i style="width:70%;background:#56b6c2"></i><i style="width:30%;background:var(--dim)"></i></div>
    <div class="tc-tree"><i></i><i></i><i style="width:70%"></i><i></i><i style="width:60%"></i></div></div></div>`;
  const body = {
    keys: `<div id="keysBox"></div>`,
    general: `<h3>${t('set.language')}</h3><p class="hint">${t('set.languageHint')}</p>
      <select class="wide-sel" data-sel="lang">${opt('auto', t('a.langAuto'), settings.lang)}${opt('en', 'English', settings.lang)}${opt('de', 'Deutsch', settings.lang)}</select>
      <h3>${t('set.startup')}</h3>${sw('reopen', t('set.reopen'))}${sw('autoSave', t('set.autoSave'))}${sw('singleClick', t('set.singleClick'))}
      <h3>${t('set.layout')}</h3>${sw('autoHide', t('set.autoHide'))}`,
    appearance: `<h3>${t('set.theme')}</h3><div class="theme-grid">` + THEMES.map(th =>
      `<button class="theme-card${settings.theme === th ? ' active' : ''}" data-theme-pick="${th}">${mock(th)}
       <div class="theme-name">${esc(t('theme.' + th))}<span>${settings.theme === th ? '&#10003;' : ''}</span></div></button>`).join('') + `</div>`,
    editor: `<h3>${t('set.font')}</h3><select class="num-in" data-sel="fontSize">${[11, 12, 13, 14, 15, 16, 18, 20, 22, 24].map(n => opt(n, n + ' px', settings.fontSize)).join('')}</select>
      <h3>${t('set.tabSize')}</h3><select class="num-in" data-sel="tabSize">${[2, 4, 8].map(n => opt(n, n, settings.tabSize)).join('')}</select>
      <h3>${t('set.view')}</h3>${sw('wordWrap', t('a.wordWrap'))}${sw('minimap', t('a.minimap'))}${sw('whitespace', t('a.whitespace'))}${sw('sticky', t('set.sticky'))}${sw('ligatures', t('set.ligatures'))}
      <h3>${t('set.onSave')}</h3>${sw('formatOnSave', t('set.formatOnSave'))}${sw('lintOnSave', t('set.lintOnSave'))}${sw('useClippy', t('set.useClippy'))}
      <h3>${t('set.spell')}</h3><p class="hint">${t('set.spellHint')}</p><select class="wide-sel" data-sel="spell">${opt('auto', t('set.spellAuto'), settings.spell)}${opt('de', 'Deutsch', settings.spell)}${opt('en', 'English', settings.spell)}${opt('off', t('set.spellOff'), settings.spell)}</select>`,
    terminal: `<h3>${t('set.shell')}</h3><p class="hint">${t('set.shellHint')}</p><input class="field-in wide-sel" data-text="shell" value="${esc(settings.shell)}" spellcheck="false">`
  };
  $('#modalTitle').textContent = t('set.title');
  $('#modalBody').innerHTML = `<div class="prefs"><nav>${Object.keys(body).filter(k => k !== 'keys').concat('keys').map(k =>
    `<button data-sec="${k}" class="${k === prefsSection ? 'active' : ''}">${esc(t('set.' + k))}</button>`).join('')}</nav><section>${body[prefsSection]}</section></div>`;
  if (prefsSection === 'keys') mountKeys();
  $('#modalFoot').hidden = false;
  $('#modalFoot').innerHTML = `<button class="btn-sm" data-pref="reset">${esc(t('set.reset'))}</button><span class="flex"></span>
    <button class="btn-sm primary" data-pref="done">${esc(t('set.done'))}</button>`;
}
$('#modal').addEventListener('click', e => {
  if (!settingsOpen) return;
  const el = e.target.closest('[data-sec],[data-theme-pick],[data-pref]'); if (!el) return;
  if (el.dataset.sec) prefsSection = el.dataset.sec;
  else if (el.dataset.themePick) settings.theme = el.dataset.themePick;
  else if (el.dataset.pref === 'done') return closeModal();
  else if (el.dataset.pref === 'reset') { settings = {...DEF}; toast(t('set.resetDone')); }
  applySettings(); renderSettings(); settingsOpen = true;
});
$('#modal').addEventListener('change', e => {
  if (!settingsOpen) return;
  const d = e.target.dataset;
  if (d.sel) { settings[d.sel] = /^\d+$/.test(e.target.value) ? +e.target.value : e.target.value; applySettings(); renderSettings(); settingsOpen = true; }
  if (d.sw) { settings[d.sw] = e.target.checked; applySettings(); }
});
$('#modal').addEventListener('input', e => { if (settingsOpen && e.target.dataset.text) { settings[e.target.dataset.text] = e.target.value; saveState(); } });
$('#modal').onmousedown = e => { if (e.target.id === 'modal') closeModal(); };

function applyLanguage() {
  document.documentElement.lang = lang;
  $$('[data-i18n]').forEach(el => el.textContent = t(el.dataset.i18n));
  $$('[data-i18n-ph]').forEach(el => el.placeholder = t(el.dataset.i18nPh));
  buildMenubar(); buildToolbars();
  if (booted) { renderRecent(); groups.forEach(fillEmptyHints); renderFind(); renderTodo(); buildStructure(); updateUI(); }
}
let lastSpell = null, lastClippy = null;
let appliedKeys = '{}';
/* Settings → Shortcuts: change a key by pressing it (shortcuts.js). */
function mountKeys() {
  Shortcuts.editor($('#keysBox'), {MENUS, keys: settings.keys || {}, t, fmtKey, comboOf, label: a => t('a.' + a),
    onChange: keys => { settings.keys = keys; applySettings(); }});
}
function applySettings() {
  if (settings.useClippy !== lastClippy) { const first = lastClippy === null; lastClippy = settings.useClippy; if (!first) LSP.configChanged(); }
  if (window.AutoHide) AutoHide.set(settings.autoHide);
  if (window.Shortcuts && JSON.stringify(settings.keys || {}) !== appliedKeys) {
    appliedKeys = JSON.stringify(settings.keys || {});
    Shortcuts.apply(MENUS, settings.keys || {}); buildKeymap();
    if (typeof buildToolbars === 'function' && document.querySelector('#menus')) buildToolbars();
  }
  if (settings.spell !== lastSpell) { const first = lastSpell === null; lastSpell = settings.spell; if (!first && window.monaco) spellRerun(); }
  if (!THEMES.includes(settings.theme)) settings.theme = 'dark';
  const nl = effectiveLang();
  if (nl !== lang) { lang = nl; applyLanguage(); }
  document.documentElement.dataset.theme = settings.theme;
  if (monaco && booted) {
    monaco.editor.setTheme('studio-' + settings.theme);
    const o = editorOptions(); delete o.theme;
    groups.forEach(g => g.editor.updateOptions(o));
    for (const f of files.values()) if (f.kind === 'text') f.model.updateOptions({tabSize: settings.tabSize});
  }
  terms.forEach(tm => { tm.xterm.options.theme = termTheme(); tm.xterm.options.fontSize = Math.max(11, settings.fontSize - 1); });
  applyLayout();
  if (booted) syncDisabled();
  saveState();
}

/* ================= Native right-click menus (see native.js) ================= */
if (window.Native) {
  const accel = k => k && !k.includes(' ') ? k.replace('ArrowLeft', 'Left').replace('ArrowRight', 'Right').replace('ArrowUp', 'Up').replace('ArrowDown', 'Down') : null;
  const item = (act, extra = {}) => ({id: act, label: t('a.' + act), accel: accel(keyOf(act)), enabled: allowed(act), ...extra});
  let ctx = {};
  Native.setProvider(e => {
    const tab = e.target.closest('.tab');
    if (tab) {
      const g = groups.find(x => x.tabsEl.contains(tab)); ctx = {g, path: tab.dataset.path};
      return [{id: 'tab:close', label: t('a.closeTab'), accel: 'Ctrl+F4'}, {id: 'tab:others', label: t('ctx.closeOthers'), enabled: g.tabs.length > 1}, {id: 'tab:all', label: t('ctx.closeAll')}, null,
        {id: 'tab:split', label: t('ctx.openSplit')}, {id: 'tab:select', label: t('a.selectInProject')}, null, {id: 'tab:copyPath', label: t('a.copyPath')}, {id: 'tab:history', label: t('a.localHistory')}];
    }
    const row = rowOf(e.target);
    if (row) {
      selectRow(row.path); ctx = {path: row.path, dir: row.dir};
      return [{id: 'tree:newFile', label: t('a.newFile')}, {id: 'tree:newFolder', label: t('a.newFolder')}, null,
        {id: 'tree:rename', label: t('ui.rename') + '…', accel: 'Shift+F6', enabled: !row.root}, {id: 'tree:delete', label: t('ctx.delete'), accel: 'Delete', enabled: !row.root}, null,
        {id: 'tree:copyPath', label: t('a.copyPath')}, {id: 'tree:copyRel', label: t('a.copyRelPath')}, {id: 'tree:reveal', label: t(IS_MAC ? 'ctx.revealMac' : 'ctx.reveal')}, null,
        {id: 'tree:terminal', label: t('ctx.openTerminal')}, {id: 'tree:find', label: t('ctx.findInFolder')}, ...(row.dir ? [] : [null, {id: 'tree:history', label: t('a.localHistory')}])];
    }
    if (e.target.closest('[data-panel="project"]')) { if (!project) return null; ctx = {path: project.root, dir: true}; return [{id: 'tree:newFile', label: t('a.newFile')}, {id: 'tree:newFolder', label: t('a.newFolder')}]; }
    const term = e.target.closest('.term-host');
    if (term) {
      const tm = terms.find(x => x.el === term); ctx = {term: tm};
      return [{id: 'term:copy', label: t('ctx.copy'), enabled: !!(tm && tm.xterm.getSelection())}, {id: 'term:paste', label: t('ctx.paste')}, null, {id: 'term:clear', label: t('ctx.clear')}, null,
        item('newTerminal'), {id: 'term:close', label: t('ctx.closeTerminal')}];
    }
    if (e.target.closest('.group-ed .ed-host') && curEditor()) {
      const tg = curEditor().getTargetAtClientPoint(e.clientX, e.clientY);
      const rn = tg && tg.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && runnableAt(curFile(), tg.position.lineNumber);
      if (rn) { ctx = {runnable: rn}; return [{id: 'rt:run', label: t('rt.runNamed', {n: rn.name})}, {id: 'rt:save', label: t('rt.saveConfig')}, null, {id: 'rt:copy', label: t('rt.copyCmd')}]; }
      const sp = spellMenu(e);
      const base = [{id: 'ed:cut', label: t('ctx.cut'), accel: 'Ctrl+X'}, {id: 'ed:copy', label: t('ctx.copy'), accel: 'Ctrl+C'}, {id: 'ed:paste', label: t('ctx.paste'), accel: 'Ctrl+V'}, null,
        item('goToDefinition'), item('findUsages'), item('renameSymbol'), item('quickFix'), null, item('formatCode'), item('commentLine'), null,
        item('find'), item('findInFiles'), null, item('localHistory'), item('selectInProject'), item('copyPath')];
      return sp ? sp.then(items => [...items, null, ...base]) : base;
    }
    const gr = e.target.closest('.git-row');
    if (gr) {
      ctx = {path: gr.dataset.path}; const f = git.files.find(x => gitAbs(x.path) === gr.dataset.path), staged = gr.dataset.staged === '1';
      return [{id: 'git:diff', label: t('git.showDiff')}, {id: 'git:open', label: t('ctx.open')}, null,
        staged ? {id: 'git:unstage', label: t('git.unstage')} : {id: 'git:stage', label: t('git.stage')},
        ...(f && f.x !== '?' && !staged ? [{id: 'git:discard', label: t('git.discard') + '…'}] : [])];
    }
    const hit = e.target.closest('#findList .hit');
    if (hit) { ctx = {hit: findState.hits[+hit.dataset.hit]}; return [{id: 'hit:open', label: t('ctx.open')}, {id: 'hit:copy', label: t('ctx.copy')}]; }
    return null;
  });
  Native.setHandler(async id => {
    const [scope, what] = id.split(':');
    if (scope === 'git') return gitHandle(what, id.split(':')[2]);
    if (scope === 'rt') {
      const r = ctx.runnable; if (!r) return;
      if (what === 'run') return runRunnable(r);
      if (what === 'copy') return Native.clipboardWrite(r.command);
      if (what === 'save') {
        const dir = isUnder(r.cwd, project.root) ? r.cwd.slice(project.root.length).replace(/^[\\/]/, '') : '';
        runState.custom = [...runState.custom.filter(c => c.name !== r.name), {name: r.name, command: r.command, dir}];
        runState.selected = 'c:' + r.name; saveSession(); renderRunSel(); return toast(t('rt.saved', {n: r.name}));
      }
    }
    if (scope === 'sp') return spellAction(what, id.split(':')[2]);
    if (scope === 'tab') {
      const {g, path} = ctx;
      if (what === 'close') return closeTab(g, path);
      if (what === 'others') return closeTabs(g, path);
      if (what === 'all') { for (const x of [...groups]) await closeTabs(x, null); return; }
      if (what === 'split') { ensureGroups(2); await openFile(path, {group: g === groups[0] ? 1 : 0}); groups.forEach(renderGroup); return updateUI(); }
      if (what === 'select') return selectInProject(path);
      if (what === 'copyPath') return copyText(path);
      if (what === 'history') return localHistory(path);
    }
    if (scope === 'tree') {
      const {path, dir} = ctx, folder = dir ? path : dirName(path);
      if (what === 'newFile') return newFile(folder);
      if (what === 'newFolder') return newFolder(folder);
      if (what === 'rename') return renamePath(path);
      if (what === 'delete') return deletePath(path);
      if (what === 'copyPath') return copyText(path);
      if (what === 'copyRel') return copyText(relPath(path) || '.');
      if (what === 'reveal') return invoke('reveal', {path}).catch(err => toast(t('toast.fail', {e: err})));
      if (what === 'terminal') return newTerminal(folder);
      if (what === 'find') return findInFilesPopup(false, folder);
      if (what === 'history') return localHistory(path);
    }
    if (scope === 'term') {
      const tm = ctx.term; if (!tm) return;
      if (what === 'copy') return copyText(tm.xterm.getSelection());
      if (what === 'paste') { const text = await Native.clipboardRead(); if (tm.id != null && !tm.exited) invoke('term_write', {id: tm.id, data: text}); return tm.xterm.focus(); }
      if (what === 'clear') return tm.xterm.clear();
      if (what === 'close') return closeTerminal(tm);
    }
    if (scope === 'ed') {
      const ed = curEditor(); if (!ed) return;
      const model = ed.getModel(), sels = ed.getSelections().filter(s => !s.isEmpty());
      if (what === 'copy' || what === 'cut') {
        // Without a selection, copy/cut take the whole line (like JetBrains).
        if (!sels.length) {
          await Native.clipboardWrite(model.getLineContent(ed.getPosition().lineNumber) + model.getEOL());
          if (what === 'cut') { ed.focus(); ed.trigger('studio', 'editor.action.deleteLines'); }
          return;
        }
        await Native.clipboardWrite(sels.map(s => model.getValueInRange(s)).join(model.getEOL()));
        if (what === 'cut') { ed.focus(); ed.executeEdits('cut', sels.map(s => ({range: s, text: ''}))); }
        return;
      }
      if (what === 'paste') { const text = await Native.clipboardRead(); ed.focus(); ed.trigger('studio', 'paste', {text, pasteOnNewLine: false, multicursorText: null, mode: null}); return; }
    }
    if (scope === 'hit') {
      const h = ctx.hit; if (!h) return;
      if (what === 'open') return jumpTo(h.path, h.line, h.col, h.len);
      if (what === 'copy') return copyText(h.text);
    }
    runAct(id);
  });
}

/* ================= Spelling & grammar ================= */
/* Comments in code — and the whole text of Markdown and plain-text files — are checked in Rust (spell.rs, codespell.rs)
   on this PC. Issues are squiggles (marker owner "spell"); fixes are in the context menu and in Quick Fix (Ctrl+.).
   In code, words that also occur as identifiers in the same file count as known. */
const PROSE_LANGS = new Set(['markdown', 'plaintext']);
const spellIgnored = new Set();   // "kind:text" ignored for this session
const spellTimers = new WeakMap(), spellIssues = new WeakMap();
let spellCtx = null;
function scheduleSpell(model, delay = 900) {
  if (!model || !invoke) return;
  clearTimeout(spellTimers.get(model));
  spellTimers.set(model, setTimeout(() => runSpell(model), delay));
}
/* The parts of a file to check, as [start, end] offsets: comments, or prose outside code in Markdown. */
function spellParts(model) {
  const text = model.getValue(), lang = model.getLanguageId(), lines = text.split('\n'), parts = [];
  let off = 0;
  const add = (a, b) => { const last = parts[parts.length - 1]; if (last && last[1] === a) last[1] = b; else if (b > a) parts.push([a, b]); };
  if (PROSE_LANGS.has(lang)) {
    let fence = false;
    for (const line of lines) {
      if (lang === 'markdown' && /^\s*(```|~~~)/.test(line)) fence = !fence;
      else if (!fence) {
        let a = 0;
        if (lang === 'markdown') for (const m of line.matchAll(/`[^`]*`/g)) { add(off + a, off + m.index); a = m.index + m[0].length; }
        add(off + a, off + line.length);
      }
      off += line.length + 1;
    }
    return {parts, prose: true};
  }
  monaco.editor.tokenize(text, lang).forEach((toks, li) => {
    const line = lines[li] || '';
    toks.forEach((tk, k) => { if (/comment/.test(tk.type)) add(off + tk.offset, off + (k + 1 < toks.length ? toks[k + 1].offset : line.length)); });
    off += line.length + 1;
  });
  return {parts, prose: false};
}
async function runSpell(model) {
  if (model.isDisposed()) return;
  const clear = () => { spellIssues.set(model, []); monaco.editor.setModelMarkers(model, 'spell', []); };
  if (settings.spell === 'off' || model.getValueLength() > 300000) return clear();
  const v = model.getVersionId(), text = model.getValue(), {parts, prose} = spellParts(model);
  if (!parts.length) return clear();
  let list = await invoke('code_spell', {text, parts, lang: settings.spell, fallback: lang}).catch(() => []);
  if (model.isDisposed() || model.getVersionId() !== v) return;
  let idents = null;
  if (!prose) {
    // Words of the code itself (everything outside the checked parts) are identifiers, not typos.
    let code = '', at = 0;
    for (const [a, b] of parts) { code += text.slice(at, a) + ' '; at = b; }
    code += text.slice(at);
    idents = new Set((code.match(/[\p{L}_][\p{L}\p{N}_]*/gu) || []).map(w => w.toLowerCase()));
  }
  list = list.filter(i => {
    const w = text.slice(i.start, i.end);
    return !spellIgnored.has(i.kind + ':' + w) && !(i.kind === 'spell' && idents && idents.has(w.toLowerCase()));
  }).map(i => ({...i, word: text.slice(i.start, i.end), range: monaco.Range.fromPositions(model.getPositionAt(i.start), model.getPositionAt(i.end))}));
  spellIssues.set(model, list);
  monaco.editor.setModelMarkers(model, 'spell', list.map(i => ({
    startLineNumber: i.range.startLineNumber, startColumn: i.range.startColumn, endLineNumber: i.range.endLineNumber, endColumn: i.range.endColumn,
    severity: i.kind === 'spell' ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Hint,
    message: i.kind === 'spell' ? t('sp.unknown', {w: i.word}) : t('sp.rule.' + i.kind), source: t('sp.source')})));
}
const spellAt = (model, pos) => (spellIssues.get(model) || []).find(i => i.range.containsPosition(pos));
/* Suggestions and actions for one issue: [{label, text}] replacements, plus the word for add / ignore. */
async function spellChoices(i) {
  if (i.kind !== 'spell') return i.fix.map(s => ({label: t('sp.fix.' + i.kind, {s}), text: s}));
  const sug = await invoke('spell_suggest', {word: i.word, lang: settings.spell}).catch(() => []);
  return sug.map(s => ({label: s, text: s}));
}
function spellRerun() { for (const m of monaco.editor.getModels()) scheduleSpell(m, 50); }
function spellApply(model, i, text) {
  if (model.isDisposed() || model.getValueInRange(i.range) !== i.word) return;
  const ed = curEditor();
  if (ed && ed.getModel() === model) { ed.pushUndoStop(); ed.executeEdits('spell', [{range: i.range, text}]); ed.pushUndoStop(); ed.focus(); }
  else model.pushEditOperations([], [{range: i.range, text}], () => null);
}
function spellIgnore(i) {
  spellIgnored.add(i.kind + ':' + i.word);
  for (const m of monaco.editor.getModels()) {
    const list = (spellIssues.get(m) || []).filter(x => !(x.kind === i.kind && x.word === i.word));
    spellIssues.set(m, list);
    monaco.editor.setModelMarkers(m, 'spell', monaco.editor.getModelMarkers({owner: 'spell', resource: m.uri}).filter(mk => !(m.getValueInRange(mk) === i.word)));
  }
}
/* Context menu on an underlined word: suggestions first. */
function spellMenu(e) {
  const ed = curEditor(); if (!ed) return null;
  const tg = ed.getTargetAtClientPoint(e.clientX, e.clientY), model = ed.getModel();
  const i = tg && tg.position && spellAt(model, tg.position); if (!i) return null;
  return spellChoices(i).then(ch => {
    spellCtx = {model, i, ch};
    const items = ch.length ? ch.map((c, k) => ({id: 'sp:fix:' + k, label: c.label})) : [{id: 'sp:none', label: t('sp.noSuggestions'), enabled: false}];
    if (i.kind !== 'spell') items.unshift({id: 'sp:rule', label: t('sp.rule.' + i.kind), enabled: false});
    return [...items, null, ...(i.kind === 'spell' ? [{id: 'sp:add', label: t('sp.add', {w: i.word})}] : []), {id: 'sp:ignore', label: t('sp.ignore')}];
  });
}
async function spellAction(what, k) {
  const c = spellCtx; if (!c) return;
  if (what === 'fix') spellApply(c.model, c.i, c.ch[+k].text);
  else if (what === 'add') { await invoke('spell_add', {word: c.i.word}).catch(() => {}); spellRerun(); }
  else if (what === 'ignore') spellIgnore(c.i);
}
/* The same choices in Quick Fix (Ctrl+. / the light bulb). */
function registerSpellActions() {
  monaco.editor.registerCommand('codeStudio.spellAdd', async (_, w) => { await invoke('spell_add', {word: w}).catch(() => {}); spellRerun(); });
  monaco.editor.registerCommand('codeStudio.spellIgnore', (_, kind, w) => spellIgnore({kind, word: w}));
  monaco.languages.registerCodeActionProvider('*', {async provideCodeActions(model, range) {
    const list = (spellIssues.get(model) || []).filter(i => monaco.Range.areIntersectingOrTouching(i.range, range));
    const actions = [];
    for (const i of list.slice(0, 3)) {
      const marker = monaco.editor.getModelMarkers({owner: 'spell', resource: model.uri}).filter(m => m.startLineNumber === i.range.startLineNumber && m.startColumn === i.range.startColumn);
      (await spellChoices(i)).slice(0, 6).forEach((c, k) => actions.push({title: c.label, kind: 'quickfix', isPreferred: k === 0, diagnostics: marker,
        edit: {edits: [{resource: model.uri, versionId: model.getVersionId(), textEdit: {range: i.range, text: c.text}}]}}));
      if (i.kind === 'spell') actions.push({title: t('sp.add', {w: i.word}), kind: 'quickfix', command: {id: 'codeStudio.spellAdd', title: '', arguments: [i.word]}});
      actions.push({title: t('sp.ignore') + ' — ' + i.word, kind: 'quickfix', command: {id: 'codeStudio.spellIgnore', title: '', arguments: [i.kind, i.word]}});
    }
    return {actions, dispose() {}};
  }});
}

/* ================= Boot ================= */
(async function boot() {
  if (invoke) I18N = await invoke('texts');
  applyLanguage();
  applySettings();
  renderRecent(); renderFind(); renderTodo(); buildStructure(); renderTests();
  await monacoReady;
  defineThemes(); registerSpellActions(); registerBuiltinCompletion(); registerLintActions();
  monaco.editor.setTheme('studio-' + settings.theme);
  booted = true;
  let start = invoke ? await invoke('initial_path').catch(() => null) : null, file = null;
  if (start && !(await invoke('list_dir', {path: start}).then(() => true, () => false))) { file = start; start = dirName(start); }
  if (!start && settings.reopen) { try { const s = JSON.parse(localStorage.getItem(STORE) || 'null'); start = s && s.last; } catch (e) {} }
  if (start) { await openProject(start); if (file) openFile(file); }
  updateUI(); syncDisabled();
  document.body.dataset.ready = '1';
})();
