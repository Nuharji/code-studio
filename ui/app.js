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
const DEF = {lang: 'auto', theme: 'dark', dock: true, dockTab: 'project', dockW: 320, bottom: false, bottomTab: 'terminal', bottomH: 260,
  fontSize: 14, tabSize: 4, wordWrap: false, minimap: true, whitespace: false, sticky: true, ligatures: true,
  autoSave: true, singleClick: true, reopen: true, shell: ''};
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
  'semanticHighlighting.enabled': true, theme: 'studio-' + settings.theme
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
  $('#emptyState').hidden = true; $('#editors').hidden = false;
  await monacoReady;
  ensureGroups(sess && sess.split ? 2 : 1);
  await refreshTree();
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
      expanded: [...tree.expanded].slice(0, 400), recent: recentFiles.slice(0, 30)
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
  g.editor.onDidChangeModelContent(() => { renderTabs(g); updateUI(); scheduleStructure(); });
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
    LSP.saved(f.path);
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
window.addEventListener('focus', () => { checkDisk(); });
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
    <span class="tw">${r.dir ? (tree.expanded.has(r.path) ? '&#9660;' : '&#9654;') : ''}</span>${fileIcon(r.path, r.dir)}<span class="nm">${esc(r.name)}</span>${r.root ? `<span class="hint">${esc(r.path)}</span>` : ''}</div>`).join('');
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
async function newTerminal(cwd) {
  if (!project) return toast(t('toast.needProject'));
  if (!invoke) return;
  const el = document.createElement('div'); el.className = 'term-host'; $('#terms').append(el);
  const xterm = new Terminal({fontFamily: cssVar('--font-code') || 'Consolas, monospace', fontSize: Math.max(11, settings.fontSize - 1), cursorBlink: true,
    theme: termTheme(), scrollback: 5000, allowProposedApi: true, macOptionIsMeta: true});
  const fit = new FitAddon.FitAddon(); xterm.loadAddon(fit);
  const term = {n: ++termSeq, el, xterm, fit, id: null, exited: false, title: t('ui.terminal') + (termSeq > 1 ? ' ' + termSeq : '')};
  terms.push(term); activeTerm = term;
  showBottom('terminal'); renderBottomTabs();
  xterm.open(el);
  await new Promise(r => requestAnimationFrame(r));
  try { fit.fit(); } catch (e) {}
  try { term.id = await invoke('term_start', {cwd: cwd || project.root, cols: xterm.cols, rows: xterm.rows, shell: settings.shell || null}); }
  catch (e) { xterm.writeln(`\x1b[31m${t('toast.termFail', {e})}\x1b[0m`); term.exited = true; }
  xterm.onData(d => { if (term.id != null && !term.exited) invoke('term_write', {id: term.id, data: d}).catch(() => {}); });
  xterm.onResize(({cols, rows}) => { if (term.id != null && !term.exited) invoke('term_resize', {id: term.id, cols, rows}).catch(() => {}); });
  xterm.focus();
}
if (invoke) {
  window.__TAURI__.event.listen('term-data', ev => { const tm = terms.find(x => x.id === ev.payload.id); if (tm) tm.xterm.write(ev.payload.data); });
  window.__TAURI__.event.listen('term-exit', ev => {
    const tm = terms.find(x => x.id === ev.payload); if (!tm) return;
    tm.exited = true; tm.xterm.writeln(`\r\n\x1b[90m[${t('ui.termExit')}]\x1b[0m`); renderBottomTabs();
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
function renderBottomTabs() {
  const pc = problemCount();
  const tabs = [`<button class="pt${settings.bottomTab === 'problems' ? ' active' : ''}" data-bt="problems">${esc(t('ui.problems'))}${pc.e + pc.w ? ` <span style="opacity:.7">${pc.e + pc.w}</span>` : ''}</button>`,
    `<button class="pt${settings.bottomTab === 'find' ? ' active' : ''}" data-bt="find">${esc(t('ui.find'))}</button>`,
    ...terms.map(tm => `<button class="pt${settings.bottomTab === 'terminal' && tm === activeTerm ? ' active' : ''}" data-term="${tm.n}">${esc(tm.title)}${tm.exited ? ' ✕' : ''}<span class="x" data-term-close="${tm.n}">&#10005;</span></button>`)];
  if (!terms.length) tabs.push(`<button class="pt${settings.bottomTab === 'terminal' ? ' active' : ''}" data-bt="terminal">${esc(t('ui.terminal'))}</button>`);
  $('#bottomTabs').innerHTML = tabs.join('');
  $('#bottomBtns').innerHTML = `<button class="ibtn" data-act="newTerminal" title="${esc(t('a.newTerminal'))}">${ICONS.plus}</button>`;
  $$('.ppanel').forEach(p => p.classList.toggle('active', p.dataset.pp === settings.bottomTab));
  terms.forEach(tm => tm.el.classList.toggle('active', tm === activeTerm));
}
$('#bottomTabs').addEventListener('click', e => {
  const c = e.target.closest('[data-term-close]'); if (c) { closeTerminal(terms.find(x => x.n === +c.dataset.termClose)); if (!terms.length) settings.bottomTab = 'find'; applyLayout(); return; }
  const tb = e.target.closest('[data-term]'); if (tb) { activeTerm = terms.find(x => x.n === +tb.dataset.term); settings.bottomTab = 'terminal'; showBottom(); renderBottomTabs(); return; }
  const b = e.target.closest('[data-bt]'); if (b) showBottom(b.dataset.bt);
});

/* ================= Problems (from language servers) ================= */
function problemCount() {
  let e = 0, w = 0;
  for (const list of LSP.diags.values()) for (const d of list) { if (d.severity === 1) e++; else if (d.severity === 2) w++; }
  return {e, w, f: LSP.diags.size};
}
function renderProblems() {
  const box = $('#problemList'); if (!box) return;
  const pc = problemCount();
  $('#problemSum').textContent = pc.e + pc.w ? t('ui.problemsSum', {e: num(pc.e), w: num(pc.w), f: num(pc.f)}) : '';
  let html = '';
  const sev = ['', '#d7373f', '#e68619', '#378ef0', '#7f8c99'];
  for (const [path, list] of [...LSP.diags].sort((a, b) => a[0].localeCompare(b[0]))) {
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
  if (settings.dock) { if (tab === 'project') $('#tree').focus(); if (tab === 'structure') { buildStructure(); $('#symFilter').focus(); } if (tab === 'todo') refreshTodo(); }
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
  newProject, openFolder: async () => { const p = await invoke('pick_folder'); if (p) openProject(p); }, closeProject: () => closeProject(false),
  newFile: () => newFile(), newFolder: () => newFolder(), saveAll: () => saveAll(), localHistory: () => localHistory(),
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
  formatCode: () => { const ed = curEditor(); if (!ed) return; const s = ed.getSelection(); edCmd(s && !s.isEmpty() ? 'editor.action.formatSelection' : 'editor.action.formatDocument')(); },
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
    ['togglePanels', 'Ctrl+\\', () => settings.dock], ['toggleBottom', null, () => settings.bottom], ['hideAll', 'Ctrl+Shift+F12'], '-',
    ['splitRight'], ['unsplit'], '-', ['wordWrap', null, () => settings.wordWrap], ['minimap', null, () => settings.minimap], ['whitespace', null, () => settings.whitespace]]],
  ['navigate', [['searchEverywhere', 'Shift Shift', null, true], ['goToFile', 'Ctrl+Shift+N'], ['goToSymbol', 'Ctrl+Alt+Shift+N'], ['findAction', 'Ctrl+Shift+A', null, false, ['F1']],
    ['recentFiles', 'Ctrl+E'], '-', ['goToLine', 'Ctrl+G'], ['back', 'Ctrl+Alt+ArrowLeft'], ['forward', 'Ctrl+Alt+ArrowRight'], '-',
    ['goToDefinition', 'Ctrl+B'], ['goToImplementation', 'Ctrl+Alt+B'], ['findUsages', 'Alt+F7'], ['selectInProject', 'Alt+F1'], '-', ['nextTab', 'Alt+ArrowRight'], ['prevTab', 'Alt+ArrowLeft']]],
  ['code', [['quickFix', 'Alt+Enter'], ['quickDoc', 'Ctrl+Q'], ['parameterInfo', 'Ctrl+P'], '-', ['formatCode', 'Ctrl+Alt+L'], ['commentLine', 'Ctrl+/'], ['blockComment', 'Ctrl+Shift+/', null, false, ['Ctrl+?']], '-', ['renameSymbol', 'Shift+F6'], '-',
    ['fold', 'Ctrl+-'], ['unfold', 'Ctrl+=', null, false, ['Ctrl++']], ['foldAll', 'Ctrl+Shift+-', null, false, ['Ctrl+_']], ['unfoldAll', 'Ctrl+Shift+=']]],
  ['settings', [['settings', 'Ctrl+Alt+S'], '-', '#menu.language',
    ['langAuto', null, () => settings.lang === 'auto'], ['langEn', null, () => settings.lang === 'en'], ['langDe', null, () => settings.lang === 'de'],
    '-', '#menu.theme',
    ['themeDark', null, () => settings.theme === 'dark'], ['themeLight', null, () => settings.theme === 'light'],
    ['themeGithub', null, () => settings.theme === 'github'], ['themeGithubDark', null, () => settings.theme === 'github-dark']]],
  ['help', [['shortcuts'], '-', ['about']]]
];
const KEYMAP = {};
MENUS.forEach(([, items]) => items.forEach(it => { if (!Array.isArray(it)) return; if (it[1] && !it[3]) KEYMAP[it[1]] = it[0]; (it[4] || []).forEach(k => KEYMAP[k] = it[0]); }));
const NEEDS_EDITOR = new Set(['undo', 'redo', 'duplicateLine', 'deleteLine', 'moveLineUp', 'moveLineDown', 'expandSelection', 'shrinkSelection', 'addNextOccurrence',
  'selectAllOccurrences', 'find', 'replace', 'goToLine', 'goToDefinition', 'goToImplementation', 'findUsages', 'quickFix', 'quickDoc', 'parameterInfo', 'formatCode', 'commentLine', 'blockComment', 'fold', 'unfold', 'foldAll', 'unfoldAll', 'localHistory']);
const NO_PROJECT = new Set(['newProject', 'openFolder', 'settings', 'langAuto', 'langEn', 'langDe', 'themeDark', 'themeLight', 'themeGithub', 'themeGithubDark',
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
$$('#dockTabs button').forEach(b => b.onclick = () => { settings.dock = true; settings.dockTab = b.dataset.tab; applyLayout(); if (b.dataset.tab === 'structure') buildStructure(); if (b.dataset.tab === 'todo') refreshTodo(); });

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
    general: `<h3>${t('set.language')}</h3><p class="hint">${t('set.languageHint')}</p>
      <select class="wide-sel" data-sel="lang">${opt('auto', t('a.langAuto'), settings.lang)}${opt('en', 'English', settings.lang)}${opt('de', 'Deutsch', settings.lang)}</select>
      <h3>${t('set.startup')}</h3>${sw('reopen', t('set.reopen'))}${sw('autoSave', t('set.autoSave'))}${sw('singleClick', t('set.singleClick'))}`,
    appearance: `<h3>${t('set.theme')}</h3><div class="theme-grid">` + THEMES.map(th =>
      `<button class="theme-card${settings.theme === th ? ' active' : ''}" data-theme-pick="${th}">${mock(th)}
       <div class="theme-name">${esc(t('theme.' + th))}<span>${settings.theme === th ? '&#10003;' : ''}</span></div></button>`).join('') + `</div>`,
    editor: `<h3>${t('set.font')}</h3><select class="num-in" data-sel="fontSize">${[11, 12, 13, 14, 15, 16, 18, 20, 22, 24].map(n => opt(n, n + ' px', settings.fontSize)).join('')}</select>
      <h3>${t('set.tabSize')}</h3><select class="num-in" data-sel="tabSize">${[2, 4, 8].map(n => opt(n, n, settings.tabSize)).join('')}</select>
      <h3>${t('set.view')}</h3>${sw('wordWrap', t('a.wordWrap'))}${sw('minimap', t('a.minimap'))}${sw('whitespace', t('a.whitespace'))}${sw('sticky', t('set.sticky'))}${sw('ligatures', t('set.ligatures'))}`,
    terminal: `<h3>${t('set.shell')}</h3><p class="hint">${t('set.shellHint')}</p><input class="field-in wide-sel" data-text="shell" value="${esc(settings.shell)}" spellcheck="false">`
  };
  $('#modalTitle').textContent = t('set.title');
  $('#modalBody').innerHTML = `<div class="prefs"><nav>${Object.keys(body).map(k =>
    `<button data-sec="${k}" class="${k === prefsSection ? 'active' : ''}">${esc(t('set.' + k))}</button>`).join('')}</nav><section>${body[prefsSection]}</section></div>`;
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
function applySettings() {
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
      return [{id: 'ed:cut', label: t('ctx.cut'), accel: 'Ctrl+X'}, {id: 'ed:copy', label: t('ctx.copy'), accel: 'Ctrl+C'}, {id: 'ed:paste', label: t('ctx.paste'), accel: 'Ctrl+V'}, null,
        item('goToDefinition'), item('findUsages'), item('renameSymbol'), item('quickFix'), null, item('formatCode'), item('commentLine'), null,
        item('find'), item('findInFiles'), null, item('localHistory'), item('selectInProject'), item('copyPath')];
    }
    const hit = e.target.closest('#findList .hit');
    if (hit) { ctx = {hit: findState.hits[+hit.dataset.hit]}; return [{id: 'hit:open', label: t('ctx.open')}, {id: 'hit:copy', label: t('ctx.copy')}]; }
    return null;
  });
  Native.setHandler(async id => {
    const [scope, what] = id.split(':');
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

/* ================= Boot ================= */
(async function boot() {
  if (invoke) I18N = await invoke('texts');
  applyLanguage();
  applySettings();
  renderRecent(); renderFind(); renderTodo(); buildStructure();
  await monacoReady;
  defineThemes();
  monaco.editor.setTheme('studio-' + settings.theme);
  booted = true;
  let start = invoke ? await invoke('initial_path').catch(() => null) : null, file = null;
  if (start && !(await invoke('list_dir', {path: start}).then(() => true, () => false))) { file = start; start = dirName(start); }
  if (!start && settings.reopen) { try { const s = JSON.parse(localStorage.getItem(STORE) || 'null'); start = s && s.last; } catch (e) {} }
  if (start) { await openProject(start); if (file) openFile(file); }
  updateUI(); syncDisabled();
  document.body.dataset.ready = '1';
})();
