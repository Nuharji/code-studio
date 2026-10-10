/* Symbols of a source file (Structure panel, Go to Symbol, status bar breadcrumb).
   Stage 1 uses fast per-language patterns; language servers replace this in stage 2.
   Symbols.of(text, lang) -> [{name, kind, line (1-based), depth}] */
(() => {
  'use strict';
  const KIND = {
    fn: ['f', '#b073e0'], method: ['m', '#b073e0'], class: ['C', '#3d8ee8'], struct: ['S', '#3d8ee8'], enum: ['E', '#2bb3a3'],
    iface: ['I', '#45a35d'], trait: ['T', '#45a35d'], impl: ['i', '#7f8c99'], mod: ['M', '#c28a2c'], type: ['t', '#2bb3a3'],
    var: ['v', '#e0864a'], const: ['c', '#e0864a'], heading: ['#', '#e8710a'], key: ['k', '#7f8c99'], selector: ['s', '#3d8ee8'], macro: ['!', '#d65b8b']
  };
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'with', 'new', 'typeof', 'await', 'do', 'try', 'super', 'constructor']);

  /* Strips string and comment contents so braces in them don't confuse nesting (keeps line structure). */
  function blank(text, lang) {
    const hash = lang === 'python' || lang === 'shell' || lang === 'yaml' || lang === 'toml' || lang === 'ruby' || lang === 'perl' || lang === 'r';
    let out = '', i = 0, n = text.length;
    while (i < n) {
      const c = text[i], d = text[i + 1];
      if (!hash && c === '/' && d === '/') { while (i < n && text[i] !== '\n') { out += ' '; i++; } continue; }
      if (!hash && c === '/' && d === '*') { while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
      if (hash && c === '#') { while (i < n && text[i] !== '\n') { out += ' '; i++; } continue; }
      if (c === '"' || c === '`' || (c === "'" && lang !== 'rust')) {
        out += c; i++;
        while (i < n && text[i] !== c) { if (text[i] === '\\') { out += ' '; i++; } out += text[i] === '\n' ? '\n' : ' '; i++; if (c !== '`' && text[i - 1] === '\n') break; }
        out += c; i++; continue;
      }
      out += c; i++;
    }
    return out;
  }

  /* Brace-based languages: a symbol's depth is the number of open braces before its line. */
  function braced(text, lang, rules) {
    const src = blank(text, lang).split('\n'), raw = text.split('\n'), out = [];
    let depth = 0;
    const stack = [];   // brace depth at which each open symbol started
    src.forEach((line, i) => {
      for (const [re, kind, pick] of rules) {
        const m = re.exec(line);
        if (!m) continue;
        const name = (pick ? pick(m, raw[i]) : m[1] || '').trim();
        if (!name || KEYWORDS.has(name)) continue;
        while (stack.length && stack[stack.length - 1] >= depth) stack.pop();
        out.push({name, kind, line: i + 1, depth: stack.length});
        if (/\{\s*$/.test(line) || /\{[^}]*$/.test(line) || (src[i + 1] || '').trim().startsWith('{')) stack.push(depth);
        break;
      }
      for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') { depth = Math.max(0, depth - 1); while (stack.length && stack[stack.length - 1] >= depth) stack.pop(); } }
    });
    return out;
  }

  const JS = [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/, 'class'],
    [/^\s*(?:export\s+)?(?:declare\s+)?interface\s+([\w$]+)/, 'iface'],
    [/^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([\w$]+)/, 'enum'],
    [/^\s*(?:export\s+)?(?:declare\s+)?type\s+([\w$]+)\s*(?:<[^=]*>)?\s*=/, 'type'],
    [/^\s*(?:export\s+)?(?:declare\s+)?namespace\s+([\w$.]+)/, 'mod'],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/, 'fn'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/, 'fn'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:\{|\[|new\b|class\b)/, 'const'],
    [/^\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*(#?[\w$]+)\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::\s*[^{]+)?\{\s*$/, 'method'],
    [/^\s*([\w$]+)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)/, 'method']
  ];
  const RULES = {
    rust: [
      [/^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"\w+"\s+)?fn\s+(\w+)/, 'fn'],
      [/^\s*(?:pub(?:\([\w:]+\))?\s+)?struct\s+(\w+)/, 'struct'],
      [/^\s*(?:pub(?:\([\w:]+\))?\s+)?enum\s+(\w+)/, 'enum'],
      [/^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:unsafe\s+)?trait\s+(\w+)/, 'trait'],
      [/^\s*(?:unsafe\s+)?impl\b(?:\s*<[^>]*>)?\s+([^{]+?)\s*(?:where\b.*)?\{?\s*$/, 'impl'],
      [/^\s*(?:pub(?:\([\w:]+\))?\s+)?mod\s+(\w+)/, 'mod'],
      [/^\s*(?:pub(?:\([\w:]+\))?\s+)?type\s+(\w+)/, 'type'],
      [/^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:const|static(?:\s+mut)?)\s+(\w+)\s*:/, 'const'],
      [/^\s*macro_rules!\s*(\w+)/, 'macro']
    ],
    javascript: JS, typescript: JS,
    go: [
      [/^func\s+\(\s*\w+\s+\*?(\w+)[^)]*\)\s*(\w+)/, 'method', m => `${m[1]}.${m[2]}`],
      [/^func\s+(\w+)/, 'fn'],
      [/^type\s+(\w+)\s+struct/, 'struct'], [/^type\s+(\w+)\s+interface/, 'iface'], [/^type\s+(\w+)/, 'type']
    ],
    java: [
      [/^\s*(?:(?:public|private|protected|static|final|abstract|sealed|partial|internal|data|open)\s+)*(?:class|record)\s+(\w+)/, 'class'],
      [/^\s*(?:(?:public|private|protected|static|internal)\s+)*interface\s+(\w+)/, 'iface'],
      [/^\s*(?:(?:public|private|protected|static|internal)\s+)*enum\s+(?:class\s+)?(\w+)/, 'enum'],
      [/^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|override|virtual|async|internal|suspend)\s+)*(?:fun\s+)?[\w<>\[\],.?\s]*?\b(\w+)\s*\([^;]*$/, 'method']
    ],
    c: [
      [/^\s*(?:typedef\s+)?struct\s+(\w+)/, 'struct'], [/^\s*(?:enum\s+(?:class\s+)?)(\w+)/, 'enum'], [/^\s*class\s+(\w+)/, 'class'],
      [/^\s*namespace\s+(\w+)/, 'mod'],
      [/^[A-Za-z_][\w\s\*&:<>,]*?\b([\w:~]+)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{?\s*$/, 'fn']
    ],
    php: [[/^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, 'class'], [/^\s*interface\s+(\w+)/, 'iface'], [/^\s*trait\s+(\w+)/, 'trait'],
      [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)/, 'fn']],
    css: [[/^\s*([^{};@][^{};]*?)\s*\{\s*$/, 'selector'], [/^\s*(@[\w-]+[^{]*?)\s*\{\s*$/, 'mod']]
  };
  RULES.csharp = RULES.kotlin = RULES.scala = RULES.java;
  RULES.cpp = RULES.objective_c = RULES.c;
  RULES.scss = RULES.less = RULES.css;

  function indented(text, re, kindOf) {
    const out = [], stack = [];
    text.split('\n').forEach((line, i) => {
      const m = re.exec(line); if (!m) return;
      const ind = m[1].replace(/\t/g, '    ').length;
      while (stack.length && stack[stack.length - 1] >= ind) stack.pop();
      out.push({name: m[3], kind: kindOf(m[2], stack.length), line: i + 1, depth: stack.length});
      stack.push(ind);
    });
    return out;
  }

  function of(text, lang) {
    if (!text) return [];
    if (text.length > 3_000_000) return [];
    switch (lang) {
      case 'python': return indented(text, /^(\s*)(?:async\s+)?(def|class)\s+(\w+)/, (k, d) => k === 'class' ? 'class' : d ? 'method' : 'fn');
      case 'ruby': return indented(text, /^(\s*)(def|class|module)\s+([\w.:?!]+)/, k => k === 'def' ? 'method' : k === 'class' ? 'class' : 'mod');
      case 'markdown': {
        const out = []; let fence = false;
        text.split('\n').forEach((l, i) => {
          if (/^\s*(```|~~~)/.test(l)) fence = !fence;
          const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
          if (m) out.push({name: m[2], kind: 'heading', line: i + 1, depth: m[1].length - 1});
        });
        return out;
      }
      case 'ini': case 'toml': {
        const out = [];
        text.split('\n').forEach((l, i) => {
          let m = /^\s*\[\[?([^\]]+)\]\]?/.exec(l);
          if (m) return out.push({name: m[1].trim(), kind: 'mod', line: i + 1, depth: 0});
          m = /^([\w.-]+)\s*=/.exec(l);
          if (m) out.push({name: m[1], kind: 'key', line: i + 1, depth: out.length && out.some(s => s.kind === 'mod') ? 1 : 0});
        });
        return out;
      }
      case 'yaml': return indented(text, /^(\s*)(-\s+)?([\w.-]+):(?:\s|$)/, () => 'key').filter(s => s.depth < 3);
      case 'json': {
        // Top two levels of keys.
        const out = [], lines = blank(text, 'json').split('\n'), raw = text.split('\n');
        let depth = 0;
        lines.forEach((l, i) => {
          const m = /^\s*"(?:\s*)"\s*:/.test(l) ? null : /^\s*"/.exec(l) && /^\s*("(?:[^"\\]|\\.)*")\s*:/.exec(raw[i]);
          if (m && depth >= 1 && depth <= 2) out.push({name: JSON.parse(m[1]), kind: 'key', line: i + 1, depth: depth - 1});
          for (const ch of l) { if (ch === '{' || ch === '[') depth++; else if (ch === '}' || ch === ']') depth--; }
        });
        return out;
      }
      case 'html': case 'xml': {
        const out = [];
        text.split('\n').forEach((l, i) => {
          const m = /<(h[1-6]|section|nav|header|footer|main|template|script|style|svg|form|table)\b[^>]*?(?:id="([^"]+)")?[^>]*>/i.exec(l);
          if (m) out.push({name: m[1].toLowerCase() + (m[2] ? '#' + m[2] : ''), kind: 'selector', line: i + 1, depth: 0});
        });
        return out;
      }
      case 'shell': case 'powershell': {
        const out = [];
        text.split('\n').forEach((l, i) => {
          const m = /^\s*(?:function\s+([\w:-]+)|([\w-]+)\s*\(\)\s*\{)/i.exec(l);
          if (m) out.push({name: m[1] || m[2], kind: 'fn', line: i + 1, depth: 0});
        });
        return out;
      }
    }
    const rules = RULES[lang];
    return rules ? braced(text, lang, rules) : [];
  }

  /* The innermost symbol that contains a line (approximation: last symbol starting at or before it, preferring deeper ones). */
  function at(list, line) {
    let best = null;
    for (const s of list) { if (s.line > line) break; best = s; }
    if (!best) return [];
    const path = [best];
    for (let i = list.indexOf(best) - 1; i >= 0 && path[0].depth > 0; i--) if (list[i].depth < path[0].depth) path.unshift(list[i]);
    return path;
  }

  window.Symbols = {of, at, KIND};
})();
