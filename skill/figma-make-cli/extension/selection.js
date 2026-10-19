// Figma Make Bridge - page-world script (top frame of www.figma.com/make/*).
// Reads the Edit-mode selection from Make's Elements panel (React props aren't visible to the
// isolated content script) and posts it to content.js whenever it changes.

(() => {
  if (window.top !== window || window.__makeBridgeSelLoaded) return;
  window.__makeBridgeSelLoaded = true;

  // Each Elements row's React props carry its tree node: { id: 'fge-77', displayName, definitionFilePath }.
  function rowNode(row) {
    for (let n = row, i = 0; i < 3 && n; i++, n = n.parentElement) {
      for (const k of Object.keys(n)) {
        if (!k.startsWith('__reactFiber')) continue;
        for (let f = n[k], j = 0; j < 4 && f; j++, f = f.return) {
          const node = f.memoizedProps && f.memoizedProps.node;
          if (node && typeof node.id === 'string') return node;
        }
      }
    }
    return null;
  }

  function firstDomId(node, depth = 0) {
    if (!node || depth > 12) return null;
    if (typeof node.id === 'string' && node.id.startsWith('fge-')) return node.id;
    for (const c of node.children || []) {
      const id = firstDomId(c, depth + 1);
      if (id) return id;
    }
    return null;
  }

  function readSelection() {
    const out = [];
    for (const row of document.querySelectorAll('[aria-selected="true"]')) {
      const node = rowNode(row);
      if (!node) continue;
      // Component layers have synthetic ids; their first DOM descendant locates them in the preview.
      const dom = firstDomId(node);
      if (!dom) continue;
      out.push({ id: dom, name: node.displayName || '', file: node.definitionFilePath || '', component: !node.id.startsWith('fge-') });
    }
    return out;
  }

  let last = '';
  setInterval(() => {
    const sel = readSelection();
    const key = JSON.stringify(sel);
    if (key === last) return;
    last = key;
    window.postMessage({ __makeBridgeSelection: sel }, location.origin);
  }, 400);
})();
