'use strict';
/* Code intelligence through language servers (stage 2): completion across files, hover docs, go to declaration,
   find usages, rename everywhere, quick fixes (Alt+Enter), formatting and live errors (Problems panel).
   The Rust side (lsp.rs) only starts the server and moves messages; the protocol lives here. */
const LSP = (() => {
  const SERVERS = {
    rust: {name: 'rust-analyzer', langs: ['rust'], cmd: 'rust-analyzer', args: [], version: '--version', install: 'rustup component add rust-analyzer',
      init: {checkOnSave: true, cargo: {buildScripts: {enable: true}}, procMacro: {enable: true}}},
    python: {name: 'Pyright', langs: ['python'], cmd: 'pyright-langserver', args: ['--stdio'], version: null, install: 'npm install -g pyright'},
    ts: {name: 'TypeScript', langs: ['typescript', 'javascript'], cmd: 'typescript-language-server', args: ['--stdio'], version: '--version',
      install: 'npm install -g typescript-language-server typescript'}
  };
  const serverFor = lang => Object.entries(SERVERS).find(([, s]) => s.langs.includes(lang));
  const clients = new Map();     // key -> Client
  const checked = new Map();     // key -> Promise<path|null>
  const diags = new Map();       // path -> [{severity, message, line, col, endLine, endCol, source}]
  let listeners = false, onChange = () => {};

  const toUri = path => monaco.Uri.file(path).toString(true);
  /* Monaco writes the Windows drive letter in lower case (c:\…); the app uses the folder's own spelling (C:\…). */
  const toPath = uri => canon(monaco.Uri.parse(String(uri)).fsPath);
  const toRange = r => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
  const toPos = p => ({line: p.lineNumber - 1, character: p.column - 1});
  const md = c => !c ? '' : typeof c === 'string' ? c : Array.isArray(c) ? c.map(md).join('\n\n') : c.kind ? c.value : c.language ? '```' + c.language + '\n' + c.value + '\n```' : String(c.value || '');

  class Client {
    constructor(key, def) {
      Object.assign(this, {key, def, id: null, seq: 0, pending: new Map(), docs: new Map(), caps: {}, state: 'starting', progress: new Map(), ready: null});
    }
    async start(root) {
      this.root = root;
      this.id = await invoke('lsp_start', {command: this.def.cmd, args: this.def.args, cwd: root});
      const res = await this.request('initialize', {
        processId: null, rootUri: toUri(root), rootPath: root, workspaceFolders: [{uri: toUri(root), name: baseName(root)}],
        initializationOptions: this.def.init || {},
        capabilities: {
          general: {positionEncodings: ['utf-16']},
          window: {workDoneProgress: true, showMessage: {}},
          workspace: {configuration: true, workspaceFolders: true, applyEdit: true, workspaceEdit: {documentChanges: true}},
          textDocument: {
            synchronization: {didSave: true, dynamicRegistration: false},
            completion: {completionItem: {snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], resolveSupport: {properties: ['documentation', 'detail', 'additionalTextEdits']}}, contextSupport: true},
            hover: {contentFormat: ['markdown', 'plaintext']}, signatureHelp: {signatureInformation: {documentationFormat: ['markdown', 'plaintext'], parameterInformation: {labelOffsetSupport: true}}},
            definition: {linkSupport: true}, declaration: {linkSupport: true}, typeDefinition: {linkSupport: true}, implementation: {linkSupport: true},
            references: {}, rename: {prepareSupport: true}, formatting: {}, documentSymbol: {hierarchicalDocumentSymbolSupport: true},
            publishDiagnostics: {relatedInformation: false},
            codeAction: {codeActionLiteralSupport: {codeActionKind: {valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source']}}, resolveSupport: {properties: ['edit']}}
          }
        }
      }, 60000);
      this.caps = res.capabilities || {};
      this.notify('initialized', {});
      this.state = 'ready';
      onChange();
    }
    send(obj) { return invoke('lsp_send', {id: this.id, msg: JSON.stringify({jsonrpc: '2.0', ...obj})}); }
    request(method, params, timeout = 15000) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out')); }, timeout);
        this.pending.set(id, {resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); }});
        this.send({id, method, params}).catch(e => { this.pending.delete(id); clearTimeout(timer); reject(e); });
      });
    }
    notify(method, params) { return this.send({method, params}).catch(() => {}); }
    reply(id, result) { this.send({id, result}); }
    handle(m) {
      if (m.id != null && !m.method) {
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
        return;
      }
      switch (m.method) {
        case 'textDocument/publishDiagnostics': return setDiagnostics(m.params);
        case '$/progress': {
          const v = m.params.value || {};
          if (v.kind === 'end') this.progress.delete(m.params.token);
          else this.progress.set(m.params.token, {title: v.title || (this.progress.get(m.params.token) || {}).title || '', pct: v.percentage, msg: v.message});
          return onChange();
        }
        case 'window/showMessage': if (m.params.type <= 1) toast(`${this.def.name}: ${m.params.message}`); return;
        case 'workspace/configuration': return this.reply(m.id, (m.params.items || []).map(it => it.section === 'rust-analyzer' ? this.def.init || {} : null));
        case 'workspace/applyEdit': return applyWorkspaceEdit(m.params.edit).then(() => this.reply(m.id, {applied: true}), () => this.reply(m.id, {applied: false}));
        case 'window/workDoneProgress/create': case 'client/registerCapability': case 'client/unregisterCapability':
        case 'workspace/workspaceFolders': return m.id != null && this.reply(m.id, m.method === 'workspace/workspaceFolders' ? [{uri: toUri(this.root), name: baseName(this.root)}] : null);
        default: if (m.id != null) this.send({id: m.id, error: {code: -32601, message: 'not supported'}});
      }
    }
    /* Keeps the server's copy of a file in sync with the editor (whole text, at most every 150 ms). */
    open(model) {
      const uri = toUri(model.uri.fsPath);
      if (this.docs.has(uri)) return;
      const doc = {model, version: 1, timer: null};
      this.docs.set(uri, doc);
      this.notify('textDocument/didOpen', {textDocument: {uri, languageId: model.getLanguageId(), version: 1, text: model.getValue()}});
      doc.sub = model.onDidChangeContent(() => { clearTimeout(doc.timer); doc.timer = setTimeout(() => this.flush(uri), 150); });
      doc.dispose = model.onWillDispose(() => this.close(uri));
    }
    flush(uri) {
      const doc = this.docs.get(uri); if (!doc || !doc.timer && doc.sent === doc.model.getVersionId()) return;
      clearTimeout(doc.timer); doc.timer = null;
      if (doc.sent === doc.model.getVersionId()) return;
      doc.sent = doc.model.getVersionId();
      this.notify('textDocument/didChange', {textDocument: {uri, version: ++doc.version}, contentChanges: [{text: doc.model.getValue()}]});
    }
    flushModel(model) { this.flush(toUri(model.uri.fsPath)); }
    saved(path) { const uri = toUri(path); if (this.docs.has(uri)) { this.flush(uri); this.notify('textDocument/didSave', {textDocument: {uri}}); } }
    close(uri) {
      const doc = this.docs.get(uri); if (!doc) return;
      clearTimeout(doc.timer); doc.sub.dispose(); doc.dispose.dispose();
      this.docs.delete(uri);
      this.notify('textDocument/didClose', {textDocument: {uri}});
    }
    async stop() {
      this.state = 'stopped';
      try { await this.request('shutdown', null, 2000); this.notify('exit', null); } catch (e) {}
      setTimeout(() => invoke('lsp_stop', {id: this.id}).catch(() => {}), 500);
    }
  }

  function setDiagnostics({uri, diagnostics}) {
    const path = toPath(uri);
    const list = (diagnostics || []).map(d => ({severity: d.severity || 1, message: d.message, source: d.source || '', code: d.code,
      line: d.range.start.line + 1, col: d.range.start.character + 1, endLine: d.range.end.line + 1, endCol: d.range.end.character + 1, raw: d}));
    if (list.length) diags.set(path, list); else diags.delete(path);
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (model) monaco.editor.setModelMarkers(model, 'lsp', list.map(d => ({
      severity: [0, monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint][d.severity] || monaco.MarkerSeverity.Info,
      message: d.message, source: d.source, code: d.code != null ? String(d.code) : undefined, startLineNumber: d.line, startColumn: d.col, endLineNumber: d.endLine, endColumn: d.endCol})));
    onChange();
  }

  /* Applies a WorkspaceEdit: open files are changed in the editor (undoable), others on disk. */
  async function applyWorkspaceEdit(edit) {
    const byPath = new Map();
    const add = (uri, edits) => { const p = toPath(uri); byPath.set(p, [...(byPath.get(p) || []), ...edits]); };
    if (edit.documentChanges) for (const dc of edit.documentChanges) { if (dc.edits) add(dc.textDocument.uri, dc.edits); }
    if (edit.changes) for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits);
    for (const [path, edits] of byPath) {
      const open = files.get(path);
      const f = open || await loadFile(path, true);
      if (!f || f.kind !== 'text') continue;
      f.model.pushEditOperations([], edits.map(e => ({range: toRange(e.range), text: e.newText})), () => null);
      if (!open || !groups.some(g => g.tabs.includes(path))) { await saveFile(f); disposeFile(f); }
    }
    groups.forEach(renderTabs); updateUI();
    return byPath.size;
  }

  const KINDS = () => {
    const K = monaco.languages.CompletionItemKind;
    return [K.Text, K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class, K.Interface, K.Module, K.Property, K.Unit, K.Value, K.Enum,
      K.Keyword, K.Snippet, K.Color, K.File, K.Reference, K.Folder, K.EnumMember, K.Constant, K.Struct, K.Event, K.Operator, K.TypeParameter];
  };
  const clientOf = model => { const e = serverFor(model.getLanguageId()); const c = e && clients.get(e[0]); return c && c.state === 'ready' ? c : null; };
  const docParams = (model, pos) => ({textDocument: {uri: toUri(model.uri.fsPath)}, ...(pos ? {position: toPos(pos)} : {})});
  async function call(model, method, params) {
    const c = clientOf(model); if (!c) return null;
    c.flushModel(model);
    try { return await c.request(method, params); } catch (e) { return null; }
  }
  /* Locations in other files need an editor model so Monaco can show them; they are loaded on demand. */
  async function locations(res) {
    if (!res) return [];
    const list = (Array.isArray(res) ? res : [res]).map(l => l.targetUri ? {uri: l.targetUri, range: l.targetSelectionRange || l.targetRange} : l);
    for (const l of list) { const p = toPath(l.uri); if (!monaco.editor.getModel(monaco.Uri.file(p))) await loadFile(p, true); }
    return list.map(l => ({uri: monaco.Uri.file(toPath(l.uri)), range: toRange(l.range)}));
  }

  const registered = new Set();
  function registerProviders(lang, key) {
    if (registered.has(lang)) return;
    registered.add(lang);
    const caps = () => (clients.get(key) || {}).caps || {};
    const L = monaco.languages;
    L.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.', ':', '<', '"', '/', '\'', '@', '('],
      async provideCompletionItems(model, pos, ctx) {
        const res = await call(model, 'textDocument/completion', {...docParams(model, pos), context: {triggerKind: ctx.triggerKind + 1, triggerCharacter: ctx.triggerCharacter}});
        if (!res) return {suggestions: []};
        const items = Array.isArray(res) ? res : res.items || [], word = model.getWordUntilPosition(pos), K = KINDS();
        const def = new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, pos.column);
        return {incomplete: !!res.isIncomplete, suggestions: items.slice(0, 400).map(it => {
          const te = it.textEdit, range = te ? (te.range ? toRange(te.range) : {insert: toRange(te.insert), replace: toRange(te.replace)}) : def;
          return {label: it.labelDetails && it.labelDetails.detail ? {label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description} : it.label,
            kind: K[it.kind] ?? K[1], detail: it.detail, documentation: it.documentation ? {value: md(it.documentation)} : undefined,
            insertText: te ? te.newText : it.insertText || it.label, range, sortText: it.sortText, filterText: it.filterText, preselect: it.preselect,
            insertTextRules: it.insertTextFormat === 2 ? L.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
            additionalTextEdits: (it.additionalTextEdits || []).map(e => ({range: toRange(e.range), text: e.newText})), _raw: it};
        })};
      },
      async resolveCompletionItem(item) {
        const c = clients.get(key);
        if (!c || !(c.caps.completionProvider || {}).resolveProvider || item.documentation) return item;
        try {
          const r = await c.request('completionItem/resolve', item._raw, 3000);
          if (r.documentation) item.documentation = {value: md(r.documentation)};
          if (r.detail) item.detail = r.detail;
          if (r.additionalTextEdits) item.additionalTextEdits = r.additionalTextEdits.map(e => ({range: toRange(e.range), text: e.newText}));
        } catch (e) {}
        return item;
      }
    });
    L.registerHoverProvider(lang, {async provideHover(model, pos) {
      const r = await call(model, 'textDocument/hover', docParams(model, pos));
      return r && r.contents ? {contents: [{value: md(r.contents)}], range: r.range ? toRange(r.range) : undefined} : null;
    }});
    L.registerSignatureHelpProvider(lang, {signatureHelpTriggerCharacters: ['(', ','], async provideSignatureHelp(model, pos) {
      const r = await call(model, 'textDocument/signatureHelp', docParams(model, pos));
      if (!r || !r.signatures || !r.signatures.length) return null;
      return {value: {activeSignature: r.activeSignature || 0, activeParameter: r.activeParameter || 0, signatures: r.signatures.map(s => ({label: s.label,
        documentation: s.documentation ? {value: md(s.documentation)} : undefined, parameters: (s.parameters || []).map(p => ({label: p.label, documentation: p.documentation ? {value: md(p.documentation)} : undefined}))}))}, dispose() {}};
    }});
    L.registerDefinitionProvider(lang, {provideDefinition: async (model, pos) => locations(await call(model, 'textDocument/definition', docParams(model, pos)))});
    L.registerImplementationProvider(lang, {provideImplementation: async (model, pos) => locations(await call(model, 'textDocument/implementation', docParams(model, pos)))});
    L.registerTypeDefinitionProvider(lang, {provideTypeDefinition: async (model, pos) => locations(await call(model, 'textDocument/typeDefinition', docParams(model, pos)))});
    L.registerReferenceProvider(lang, {provideReferences: async (model, pos) => locations(await call(model, 'textDocument/references', {...docParams(model, pos), context: {includeDeclaration: true}}))});
    L.registerRenameProvider(lang, {
      async provideRenameEdits(model, pos, newName) {
        const r = await call(model, 'textDocument/rename', {...docParams(model, pos), newName});
        if (!r) return {edits: [], rejectReason: t('toast.noRename')};
        await applyWorkspaceEdit(r);
        return {edits: []};
      },
      async resolveRenameLocation(model, pos) {
        if (!(caps().renameProvider || {}).prepareProvider) { const w = model.getWordAtPosition(pos); return w ? {range: new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn), text: w.word} : {rejectReason: t('toast.noRename')}; }
        const r = await call(model, 'textDocument/prepareRename', docParams(model, pos));
        if (!r) return {range: null, text: '', rejectReason: t('toast.noRename')};
        const range = toRange(r.range || r);
        return {range, text: r.placeholder || model.getValueInRange(range)};
      }
    });
    L.registerDocumentFormattingEditProvider(lang, {async provideDocumentFormattingEdits(model, o) {
      const r = await call(model, 'textDocument/formatting', {...docParams(model), options: {tabSize: o.tabSize, insertSpaces: o.insertSpaces}});
      return (r || []).map(e => ({range: toRange(e.range), text: e.newText}));
    }});
    L.registerCodeActionProvider(lang, {async provideCodeActions(model, range, ctx) {
      const c = clientOf(model); if (!c || !c.caps.codeActionProvider) return {actions: [], dispose() {}};
      const ds = (diags.get(toPath(model.uri)) || []).filter(d => d.line <= range.endLineNumber && d.endLine >= range.startLineNumber).map(d => d.raw);
      const r = await call(model, 'textDocument/codeAction', {...docParams(model), range: {start: toPos(range.getStartPosition()), end: toPos(range.getEndPosition())}, context: {diagnostics: ds, triggerKind: 1}});
      const actions = (r || []).slice(0, 40).map(a => ({title: a.title, kind: a.kind || 'quickfix', isPreferred: a.isPreferred, diagnostics: [],
        command: {id: 'codeStudio.lspAction', title: a.title, arguments: [key, a]}}));
      return {actions, dispose() {}};
    }});
  }
  /* Quick fixes are run through one command, so edits that need resolving or a server command work too. */
  async function runAction(key, a) {
    const c = clients.get(key); if (!c) return;
    let act = a;
    if (!act.edit && !act.command && c.caps.codeActionProvider && c.caps.codeActionProvider.resolveProvider) { try { act = await c.request('codeAction/resolve', a); } catch (e) {} }
    if (act.edit) await applyWorkspaceEdit(act.edit);
    const cmd = act.command && typeof act.command === 'object' ? act.command : act.command ? act : null;
    if (cmd && cmd.command) { try { await c.request('workspace/executeCommand', {command: cmd.command, arguments: cmd.arguments}); } catch (e) {} }
  }

  function bindEvents() {
    if (listeners || !invoke) return;
    listeners = true;
    window.__TAURI__.event.listen('lsp-msg', ev => {
      const c = [...clients.values()].find(x => x.id === ev.payload.id); if (!c) return;
      let m; try { m = JSON.parse(ev.payload.msg); } catch (e) { return; }
      c.handle(m);
    });
    window.__TAURI__.event.listen('lsp-exit', ev => {
      const c = [...clients.values()].find(x => x.id === ev.payload); if (!c || c.state === 'stopped') return;
      c.state = 'crashed'; onChange();
    });
    monaco.editor.registerCommand('codeStudio.lspAction', (_, key, a) => runAction(key, a));
    // Declarations in other files open as normal tabs.
    monaco.editor.registerEditorOpener({openCodeEditor(src, resource, sel) {
      const r = sel && (sel.startLineNumber ? sel : {startLineNumber: sel.lineNumber, startColumn: sel.column});
      openFile(toPath(resource), r ? {line: r.startLineNumber, col: r.startColumn} : {});
      return true;
    }});
  }

  /* Starts the server for a file's language the first time such a file is opened in a project. */
  async function attach(model) {
    if (!project || !invoke) return;
    const e = serverFor(model.getLanguageId()); if (!e) return;
    const [key, def] = e;
    bindEvents();
    if (!checked.has(key)) checked.set(key, invoke('lsp_check', {command: def.cmd, versionArg: def.version}).catch(() => null));
    if (!await checked.get(key)) { onChange(); return; }
    let c = clients.get(key);
    if (!c) {
      c = new Client(key, def); clients.set(key, c);
      registerProviders(def.langs[0], key); def.langs.slice(1).forEach(l => registerProviders(l, key));
      if (key === 'ts') monaco.languages.typescript.typescriptDefaults.setModeConfiguration({completionItems: false, hovers: false, definitions: false, references: false,
        documentHighlights: true, rename: false, diagnostics: false, documentRangeFormattingEdits: false, signatureHelp: false, onTypeFormattingEdits: false, codeActions: false, inlayHints: false});
      c.ready = c.start(project.root).catch(err => { c.state = 'crashed'; c.error = String(err); onChange(); });
      onChange();
    }
    await c.ready;
    if (c.state === 'ready' && !model.isDisposed()) c.open(model);
  }
  async function stopAll() {
    for (const c of clients.values()) await c.stop();
    clients.clear(); diags.clear(); onChange();
  }
  /* Status for the status bar: {name, state: 'missing'|'starting'|'indexing'|'ready'|'crashed', text, install} for the current file. */
  async function status(lang) {
    const e = serverFor(lang); if (!e) return null;
    const [key, def] = e, c = clients.get(key);
    if (!c) { const ok = checked.has(key) ? await checked.get(key) : true; return ok ? null : {name: def.name, state: 'missing', install: def.install}; }
    if (c.state === 'ready' && c.progress.size) { const p = [...c.progress.values()].pop(); return {name: def.name, state: 'indexing', text: `${p.title}${p.pct != null ? ' ' + p.pct + '%' : ''}`}; }
    return {name: def.name, state: c.state, text: c.error};
  }
  const hasClient = lang => { const e = serverFor(lang); const c = e && clients.get(e[0]); return !!c && c.state === 'ready'; };
  async function references(model, pos) {
    const r = await call(model, 'textDocument/references', {...docParams(model, pos), context: {includeDeclaration: false}});
    return (r || []).map(l => ({path: toPath(l.uri), line: l.range.start.line + 1, col: l.range.start.character + 1, len: Math.max(1, l.range.end.character - l.range.start.character)}));
  }
  return {toPath, attach, stopAll, status, hasClient, references, diags, client: key => clients.get(key), applyEdit: applyWorkspaceEdit, saved: path => clients.forEach(c => c.saved(path)), onChange: fn => { onChange = fn; }, SERVERS};
})();
