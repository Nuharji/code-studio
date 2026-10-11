/* Symbols of a source file (Structure panel, Go to Symbol, status bar breadcrumb).
   They are found in Rust (src-tauri/src/symbols.rs: symbols_of(text, lang) -> [{name, kind, line (1-based), depth}]);
   this file only has the badges and the lookup of the symbol at a line. */
(() => {
  'use strict';
  const KIND = {
    fn: ['f', '#b073e0'], method: ['m', '#b073e0'], class: ['C', '#3d8ee8'], struct: ['S', '#3d8ee8'], enum: ['E', '#2bb3a3'],
    iface: ['I', '#45a35d'], trait: ['T', '#45a35d'], impl: ['i', '#7f8c99'], mod: ['M', '#c28a2c'], type: ['t', '#2bb3a3'],
    var: ['v', '#e0864a'], const: ['c', '#e0864a'], heading: ['#', '#e8710a'], key: ['k', '#7f8c99'], selector: ['s', '#3d8ee8'], macro: ['!', '#d65b8b']
  };

  /* The innermost symbol that contains a line (approximation: last symbol starting at or before it, preferring deeper ones). */
  function at(list, line) {
    let best = null;
    for (const s of list) { if (s.line > line) break; best = s; }
    if (!best) return [];
    const path = [best];
    for (let i = list.indexOf(best) - 1; i >= 0 && path[0].depth > 0; i--) if (list[i].depth < path[0].depth) path.unshift(list[i]);
    return path;
  }

  window.Symbols = {at, KIND};
})();
