/* Git blame and file history (P-004), through git.rs:
   - Git → Annotate with Git Blame: date and author of the last change in front of each block of lines (colored by
     age); click one to see that commit in the file's history.
   - Inline blame: the cursor line shows who changed it last, and when (Settings → Editor, on by default).
   - Git → Show History for File: the commits that changed the file (following renames) with the file's changes in
     each, “Compare with Current” and copying the revision number.
   Blame runs on the editor's text (unsaved lines count as not committed yet).
   Uses app.js globals at call time (invoke, git, files, settings, t, esc, lang, monaco, modal, toast …). */
const GitBlame = (() => {
  'use strict';
  const timers = new WeakMap();
  const WIDTH = 24;   // characters of an annotation: "2026-11-12 Author······  "

  const locale = () => lang === 'de' ? 'de-DE' : 'en-US';
  const day = s => { const d = new Date(s * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  function ago(s) {
    const sec = Math.round(s - Date.now() / 1000), rtf = new Intl.RelativeTimeFormat(locale(), {numeric: 'auto'});
    for (const [u, n] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]])
      if (Math.abs(sec) >= n) return rtf.format(Math.round(sec / n), u);
    return rtf.format(0, 'minute');
  }
  const fullDate = s => new Date(s * 1000).toLocaleString(locale());
  const fit = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);

  /* Blame of a file's current text, cached per model version. */
  async function blameOf(f) {
    if (!f || !f.model || f.model.isDisposed() || !git.repo || !invoke) return null;
    const v = f.model.getVersionId();
    if (f.blame && f.blame.v === v) return f.blame.data;
    if (f.blamePending && f.blamePending.v === v) return f.blamePending.p;
    const p = invoke('git_blame', {path: f.path, text: f.model.getValue()}).catch(() => null);
    f.blamePending = {v, p};
    const data = await p;
    if (f.blamePending && f.blamePending.p === p) f.blamePending = null;
    if (!f.model.isDisposed() && f.model.getVersionId() === v) f.blame = {v, data};
    return data;
  }
  const editorsOf = f => groups.filter(g => g.active === f.path).map(g => g.editor);

  /* The annotation column. */
  async function renderAnnotations(f) {
    if (!f.model || f.model.isDisposed()) return;
    if (!f.blameOn) { f.blameDeco = f.model.deltaDecorations(f.blameDeco || [], []); return; }
    const b = await blameOf(f); if (!b || f.model.isDisposed() || !f.blameOn) return;
    const times = b.commits.filter(c => c.committed).map(c => c.time), lo = Math.min(...times), hi = Math.max(...times);
    const deco = [];
    b.lines.forEach((ci, i) => {
      const c = b.commits[ci], first = i === 0 || b.lines[i - 1] !== ci;
      if (i + 1 > f.model.getLineCount()) return;
      const age = !c.committed ? 'new' : hi > lo ? Math.min(4, Math.floor((hi - c.time) / (hi - lo + 1) * 5)) : 0;
      const text = first ? (c.committed ? fit(day(c.time) + ' ' + c.author, WIDTH - 2) : fit(t('blame.notCommitted'), WIDTH - 2)) + '  ' : ' '.repeat(WIDTH);
      deco.push({range: new monaco.Range(i + 1, 1, i + 1, 1), options: {before: {content: text, inlineClassName: 'blame-ann blame-age' + age, cursorStops: monaco.editor.InjectedTextCursorStops.None}}});
    });
    f.blameDeco = f.model.deltaDecorations(f.blameDeco || [], deco);
  }

  /* The cursor line's blame at its end. */
  async function renderInline(g) {
    const ed = g.editor, f = files.get(g.active);
    if (!f || !f.model || ed.getModel() !== f.model) return;
    const clear = () => { f.inlineDeco = f.model.deltaDecorations(f.inlineDeco || [], []); };
    if (!settings.inlineBlame || f.blameOn || !git.repo || g !== curGroup()) return clear();
    const pos = ed.getPosition(), sel = ed.getSelection();
    if (!pos || (sel && !sel.isEmpty() && sel.startLineNumber !== sel.endLineNumber)) return clear();
    const b = await blameOf(f);
    if (!b || f.model.isDisposed() || ed.getModel() !== f.model) return;
    const now = ed.getPosition(); if (!now || now.lineNumber !== pos.lineNumber) return;
    const c = b.commits[b.lines[pos.lineNumber - 1]];
    if (!c || !c.committed) return clear();
    const col = f.model.getLineMaxColumn(pos.lineNumber);
    f.inlineDeco = f.model.deltaDecorations(f.inlineDeco || [], [{range: new monaco.Range(pos.lineNumber, col, pos.lineNumber, col),
      options: {after: {content: `    ${c.author}, ${ago(c.time)} · ${c.summary}`, inlineClassName: 'blame-inline', cursorStops: monaco.editor.InjectedTextCursorStops.None}}}]);
  }

  /* Hooks from app.js. */
  function cursor(g) {
    clearTimeout(timers.get(g));
    timers.set(g, setTimeout(() => renderInline(g), 120));
  }
  function changed(f) {
    if (!f || !f.model) return;
    if (f.inlineDeco && f.inlineDeco.length) f.inlineDeco = f.model.deltaDecorations(f.inlineDeco, []);
    if (!f.blameOn) return;
    clearTimeout(timers.get(f)); timers.set(f, setTimeout(() => renderAnnotations(f), 900));
  }
  /* After a commit, switching branches …: everything is blamed anew. */
  function gitChanged() {
    for (const f of files.values()) { if (f.kind !== 'text') continue; f.blame = null; if (f.blameOn) renderAnnotations(f); }
    groups.forEach(cursor);
  }
  function toggle(f = curFile()) {
    if (!f || f.kind !== 'text') return;
    if (!git.repo) return toast(t('git.noRepo'));
    f.blameOn = !f.blameOn;
    renderAnnotations(f); groups.forEach(cursor);
    buildMenubar();
  }
  /* A click on an annotation opens that commit in the history. */
  function click(g, e) {
    const f = files.get(g.active);
    if (!f || !f.blameOn || !f.blame || !e.target.detail || !e.target.detail.injectedText || !e.target.position) return false;
    const c = f.blame.data && f.blame.data.commits[f.blame.data.lines[e.target.position.lineNumber - 1]];
    if (!c) return false;
    if (c.committed) history(f.path, c.hash); else toast(t('blame.notCommitted'));
    return true;
  }

  /* ---------- File history ---------- */
  async function history(path = curPath(), select = null) {
    if (!path || !invoke) return;
    if (!git.repo) return toast(t('git.noRepo'));
    const log = await invoke('git_file_log', {path}).catch(e => { toast(t('git.fail', {e})); return null; });
    if (!log) return;
    if (!log.length) return toast(t('blame.noHistory', {f: baseName(path)}));
    const top = git.top;
    modal(t('blame.historyOf', {f: baseName(path)}), `<div class="hist git-hist"><div class="col" id="ghList">${log.map((c, i) =>
      `<div class="pp-item" data-v="${i}" title="${esc(c.hash)}"><span class="nm">${esc(c.subject)}</span><small>${esc(c.short)} · ${esc(c.author)} · ${esc(fullDate(c.time))}</small></div>`).join('')}</div>
      <div class="diff"><div class="diff-head" id="ghHead"></div><div class="diff-host" id="ghDiff"></div></div></div>`,
      [{label: t('blame.copyHash'), onClick: () => cur >= 0 && copyText(log[cur].hash)},
       {label: t('blame.compareCurrent'), onClick: () => cur >= 0 && pick(cur, true)},
       {label: t('blame.close'), primary: true, onClick: closeModal}], 'huge');
    const diff = monaco.editor.createDiffEditor($('#ghDiff'), {...editorOptions(), readOnly: true, originalEditable: false, renderSideBySide: true, minimap: {enabled: false}, automaticLayout: true});
    const lang = langFor(path);
    let models = [], cur = -1, seq = 0;
    modalOnClose = () => { diff.dispose(); models.forEach(m => m.dispose()); };
    async function pick(i, withCurrent = false) {
      cur = i; const n = ++seq, c = log[i];
      $$('#ghList .pp-item').forEach((el, k) => el.classList.toggle('sel', k === i));
      const head = $('#ghHead');
      let left, right, label;
      if (withCurrent) {
        const open = files.get(canon(path));
        left = await invoke('git_show_file', {top, rev: c.hash, rel: c.path});
        right = open && open.model ? open.model.getValue() : await readText(path).catch(() => '');
        label = t('blame.vsCurrent', {h: c.short});
      } else {
        const parent = await invoke('git_parent', {top, rev: c.hash});
        const older = log[i + 1];
        left = parent ? await invoke('git_show_file', {top, rev: parent, rel: older ? older.path : c.path}) : '';
        right = await invoke('git_show_file', {top, rev: c.hash, rel: c.path});
        label = parent ? t('blame.changesIn', {h: c.short}) : t('blame.firstCommit', {h: c.short});
      }
      if (n !== seq || !$('#ghDiff')) return;
      head.innerHTML = `<b>${esc(c.short)}</b><span>${esc(label)}</span><span class="flex"></span><small>${esc(c.author)} · ${esc(ago(c.time))}</small>`;
      const old = models;
      models = [monaco.editor.createModel(left || '', lang), monaco.editor.createModel(right || '', lang)];
      diff.setModel({original: models[0], modified: models[1]});
      old.forEach(m => m.dispose());
    }
    $('#ghList').addEventListener('click', e => { const el = e.target.closest('[data-v]'); if (el) pick(+el.dataset.v); });
    const start = select ? Math.max(0, log.findIndex(c => c.hash === select)) : 0;
    pick(start);
    const el = $(`#ghList [data-v="${start}"]`); if (el) el.scrollIntoView({block: 'nearest'});
  }

  return {toggle, cursor, changed, gitChanged, click, history, isOn: f => !!(f && f.blameOn)};
})();
