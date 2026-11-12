/* Live templates (P-006): abbreviation + Tab, postfix completion (value.if → if value { }) and Surround With
   (Ctrl+Alt+T). The templates — built-in sets and the user's own — come from Rust (templates.rs), which also finds the
   expression before ".abbr" and fills $EXPR / $SELECTION in. Settings → Templates edits them (Templates.editor).
   Uses app.js globals at call time (invoke, t, esc, lang, monaco, LSP, curEditor, toast, openPopup …). */
const Templates = (() => {
  'use strict';
  let list = [];
  const KINDS = ['live', 'postfix', 'surround'];
  const keyOf = x => `${x.lang}/${x.kind}/${x.abbr}`;
  const forLang = (l, kind) => list.filter(x => x.enabled && x.kind === kind && (x.lang === l || x.lang === '*'));
  /* The body as it reads after insertion (for the documentation of a suggestion and the list in Settings). */
  const preview = body => body.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}|\$\d/g, '').replace(/\\([$}\\])/g, '$1');

  async function load() { if (invoke) list = await invoke('templates_list', {uiLang: lang}).catch(() => []); }

  function register() {
    const K = monaco.languages.CompletionItemKind, SNIP = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
    // Per language, not '*': Monaco asks a weaker-matching provider only when the stronger ones found nothing.
    const provider = {triggerCharacters: ['.'], async provideCompletionItems(model, pos) {
      const l = model.getLanguageId(), out = [];
      const before = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
      const w = model.getWordUntilPosition(pos);
      // Live templates where a new word starts (not after "." or "::").
      if (!/(\.|::|->)$/.test(before.slice(0, w.startColumn - 1))) {
        const range = new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn);
        for (const x of forLang(l, 'live')) out.push({label: {label: x.abbr, description: x.desc}, kind: K.Snippet, insertText: x.body, insertTextRules: SNIP,
          range, filterText: x.abbr, detail: x.desc || t('ac.snippet'), sortText: '0' + x.abbr, documentation: {value: '```\n' + preview(x.body) + '\n```'}});
      }
      // Postfix: rust-analyzer already offers its own (.if, .dbg, .match …).
      const pf = forLang(l, 'postfix');
      if (pf.length && invoke && /\.[\p{L}\p{N}_$]*$/u.test(before) && !(l === 'rust' && LSP.hasClient('rust'))) {
        const r = await invoke('template_postfix', {line: before}).catch(() => null);
        if (r) {
          const range = new monaco.Range(pos.lineNumber, r.start + 1, pos.lineNumber, pos.column);
          const bodies = await Promise.all(pf.map(x => invoke('template_fill', {body: x.body, text: r.expr, kind: 'postfix', lines: false})));
          pf.forEach((x, i) => out.push({label: {label: '.' + x.abbr, description: x.desc}, kind: K.Snippet, insertText: bodies[i], insertTextRules: SNIP, range,
            filterText: r.expr + '.' + x.abbr, detail: t('tpl.postfix'), sortText: '0' + x.abbr, documentation: {value: '```\n' + preview(bodies[i]) + '\n```'}}));
        }
      }
      return {suggestions: out};
    }};
    for (const {id} of monaco.languages.getLanguages()) monaco.languages.registerCompletionItemProvider(id, provider);
  }

  /* Surround With: the selection (or the current line) goes into the chosen template. */
  function surround() {
    const ed = curEditor(); if (!ed) return;
    const model = ed.getModel(), items = forLang(model.getLanguageId(), 'surround');
    if (!items.length) return toast(t('tpl.noSurround', {lang: langName(model.getLanguageId())}));
    openPopup('surround', `<div class="pp-tabs"><button class="active">${esc(t('a.surroundWith'))}</button></div>
      <div class="pp-list" id="surList">${items.map((x, i) => `<div class="pp-item" data-i="${i}"><kbd class="tpl-num">${i < 9 ? i + 1 : ''}</kbd><span class="nm">${esc(x.abbr)}</span><small>${esc(x.desc)}</small></div>`).join('')}</div>`, 'small');
    $('#popup').style.width = '420px';
    const box = $('#surList');
    let idx = 0; markSel(box, idx);
    const pick = i => { closePopup(); apply(ed, items[i]); };
    const onKey = e => {
      if (!popup || popup.kind !== 'surround') return;
      if (listNav(e, items, idx, v => { idx = v; markSel(box, idx); })) return;
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pick(idx); }
      else if (/^[1-9]$/.test(e.key) && +e.key <= items.length) { e.preventDefault(); e.stopPropagation(); pick(+e.key - 1); }
    };
    window.addEventListener('keydown', onKey, true);
    popup.dispose = () => window.removeEventListener('keydown', onKey, true);
    box.addEventListener('click', e => { const el = e.target.closest('.pp-item'); if (el) pick(+el.dataset.i); });
  }
  async function apply(ed, x) {
    const model = ed.getModel();
    let sel = ed.getSelection();
    let lines = sel.isEmpty() || sel.startLineNumber !== sel.endLineNumber;
    if (!lines) {
      // The whole text of the line selected counts as the line.
      const line = model.getLineContent(sel.startLineNumber);
      lines = model.getValueInRange(sel).trim() === line.trim();
    }
    let range = sel, text;
    if (lines) {
      let end = sel.endLineNumber;
      if (end > sel.startLineNumber && sel.endColumn === 1) end--;
      const start = sel.startLineNumber;
      const first = Math.max(1, model.getLineFirstNonWhitespaceColumn(start) || model.getLineMaxColumn(start));
      text = model.getValueInRange(new monaco.Range(start, 1, end, model.getLineMaxColumn(end)));
      range = new monaco.Range(start, first, end, model.getLineMaxColumn(end));
    } else text = model.getValueInRange(sel);
    const snippet = await invoke('template_fill', {body: x.body, text, kind: 'surround', lines});
    ed.focus();
    ed.setSelection(range);
    ed.getContribution('snippetController2').insert(snippet);
  }

  /* ---------- Settings → Templates ---------- */
  function editor(box) {
    let filter = settings.tplLang || '', q = '', edit = null, note = '';   // edit = {old, x}
    const langs = () => [...new Set(list.map(x => x.lang))].sort();
    const kindName = k => t('tpl.kind.' + k);
    function draw() {
      if (edit) return drawForm();
      const shown = list.filter(x => (!filter || x.lang === filter) && (!q || (x.abbr + ' ' + x.desc + ' ' + x.body).toLowerCase().includes(q.toLowerCase())));
      shown.sort((a, b) => a.lang.localeCompare(b.lang) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.abbr.localeCompare(b.abbr));
      box.innerHTML = `<p class="hint">${t('tpl.hint')}</p>
        <div class="tpl-bar"><select class="field-in" data-tpl="lang"><option value="">${esc(t('tpl.allLangs'))}</option>${langs().map(l =>
          `<option value="${esc(l)}"${l === filter ? ' selected' : ''}>${esc(l === '*' ? t('tpl.anyLang') : langName(l))}</option>`).join('')}</select>
        <input class="field-in" data-tpl="q" placeholder="${esc(t('tpl.search'))}" value="${esc(q)}" spellcheck="false">
        <span class="flex"></span><button class="btn-sm" data-tpl-do="import">${esc(t('tpl.import'))}</button><button class="btn-sm" data-tpl-do="export">${esc(t('tpl.export'))}</button>
        <button class="btn-sm primary" data-tpl-do="new">${esc(t('tpl.new'))}</button></div>
        ${note ? `<p class="tpl-note">${esc(note)}</p>` : ''}
        <div class="tpl-list">${shown.map(x => `<div class="tpl-row${x.enabled ? '' : ' off'}" data-key="${esc(keyOf(x))}">
          <input type="checkbox" data-tpl-on${x.enabled ? ' checked' : ''} title="${esc(t('tpl.enabled'))}">
          <kbd>${esc(x.kind === 'postfix' ? '.' + x.abbr : x.abbr)}</kbd><span class="tpl-kind k-${x.kind}">${esc(kindName(x.kind))}</span>
          <span class="tpl-desc">${esc(x.desc)}</span><small>${esc(x.lang === '*' ? t('tpl.anyLang') : langName(x.lang))}${x.changed ? ' · ' + esc(t('tpl.changed')) : !x.builtin ? ' · ' + esc(t('tpl.own')) : ''}</small></div>`).join('')
          || `<div class="empty">${esc(t('ui.noResults'))}</div>`}</div>`;
    }
    function drawForm() {
      const x = edit.x, opt = (v, l, cv) => `<option value="${esc(v)}"${v === cv ? ' selected' : ''}>${esc(l)}</option>`;
      const ids = monaco.languages.getLanguages().map(l => l.id).sort();
      box.innerHTML = `<h3>${esc(edit.old ? t('tpl.edit') : t('tpl.new'))}</h3>
        <div class="tpl-form">
          <label class="lbl">${esc(t('tpl.abbr'))}<input class="field-in" data-f="abbr" value="${esc(x.abbr)}" spellcheck="false"${x.builtin ? ' disabled' : ''}></label>
          <label class="lbl">${esc(t('tpl.kind'))}<select class="field-in" data-f="kind"${x.builtin ? ' disabled' : ''}>${KINDS.map(k => opt(k, kindName(k), x.kind)).join('')}</select></label>
          <label class="lbl">${esc(t('tpl.lang'))}<select class="field-in" data-f="lang"${x.builtin ? ' disabled' : ''}>${opt('*', t('tpl.anyLang'), x.lang)}${ids.map(l => opt(l, langName(l), x.lang)).join('')}</select></label>
          <label class="lbl tpl-wide">${esc(t('tpl.desc'))}<input class="field-in" data-f="desc" value="${esc(x.desc)}"></label>
          <label class="lbl tpl-wide">${esc(t('tpl.body'))}<textarea class="field-in tpl-body" data-f="body" spellcheck="false">${esc(x.body)}</textarea></label>
        </div>
        <p class="hint">${t('tpl.bodyHint')}</p>
        ${note ? `<p class="tpl-note err">${esc(note)}</p>` : ''}
        <div class="tpl-bar">${edit.old && (x.changed || !x.builtin) ? `<button class="btn-sm" data-tpl-do="delete">${esc(x.builtin ? t('tpl.reset') : t('tpl.delete'))}</button>` : ''}
          <span class="flex"></span><button class="btn-sm" data-tpl-do="cancel">${esc(t('ui.cancel'))}</button><button class="btn-sm primary" data-tpl-do="save">${esc(t('tpl.save'))}</button></div>`;
      const body = box.querySelector('.tpl-body');
      // Tab in the body inserts a tab (that is how the template is indented).
      body.addEventListener('keydown', e => {
        if (e.key !== 'Tab' || e.shiftKey) return;
        e.preventDefault(); const s = body.selectionStart; body.setRangeText('\t', s, body.selectionEnd, 'end');
      });
    }
    const reload = async () => { await load(); draw(); };
    const formValue = () => { const f = n => box.querySelector(`[data-f="${n}"]`).value; return {...edit.x, abbr: f('abbr'), kind: f('kind'), lang: f('lang'), desc: f('desc'), body: f('body')}; };
    box.addEventListener('input', e => { if (e.target.dataset.tpl === 'q') { q = e.target.value; const pos = e.target.selectionStart; draw(); const i = box.querySelector('[data-tpl="q"]'); i.focus(); i.setSelectionRange(pos, pos); } });
    box.addEventListener('change', async e => {
      if (e.target.dataset.tpl === 'lang') { filter = e.target.value; settings.tplLang = filter; saveState(); draw(); }
      if ('tplOn' in e.target.dataset) {
        const k = e.target.closest('[data-key]').dataset.key;
        await invoke('template_enable', {key: k, on: e.target.checked}).catch(err => toast(String(err)));
        await reload();
      }
    });
    box.addEventListener('click', async e => {
      const b = e.target.closest('[data-tpl-do]');
      const row = !b && !e.target.matches('input') && e.target.closest('.tpl-row');
      if (row) { const x = list.find(y => keyOf(y) === row.dataset.key); if (x) { edit = {old: keyOf(x), x: {...x}}; note = ''; draw(); } return; }
      if (!b) return;
      const what = b.dataset.tplDo;
      note = '';
      if (what === 'new') {
        const cur = curEditor() && curEditor().getModel();
        edit = {old: null, x: {lang: filter || (cur ? cur.getLanguageId() : '*'), kind: 'live', abbr: '', desc: '', body: '', builtin: false, changed: false, enabled: true}};
        return draw();
      }
      if (what === 'cancel') { edit = null; return draw(); }
      if (what === 'save') {
        const x = formValue();
        try { await invoke('template_save', {old: edit.old, template: x}); }
        catch (err) { edit.x = x; note = t(String(err)); return draw(); }
        edit = null; note = t('tpl.saved'); return reload();
      }
      if (what === 'delete') {
        const x = edit.x;
        if (!x.builtin && !(await ask(t('tpl.askDelete', {abbr: x.abbr}), t('tpl.delete')))) return;
        await invoke('template_delete', {key: edit.old}).catch(err => toast(String(err)));
        edit = null; return reload();
      }
      if (what === 'export') {
        const path = await invoke('pick_save_file', {name: 'code-studio-templates.json'}); if (!path) return;
        try { const n = await invoke('templates_export', {path}); note = t('tpl.exported', {n}); } catch (err) { note = String(err); }
        return draw();
      }
      if (what === 'import') {
        const path = await invoke('pick_file'); if (!path) return;
        try { const n = await invoke('templates_import', {path}); note = t('tpl.imported', {n}); } catch (err) { note = t(String(err)); }
        return reload();
      }
    });
    draw();
  }

  return {load, register, surround, editor, preview};
})();
