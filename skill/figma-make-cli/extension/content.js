// Figma Make Bridge - content script (top frame of www.figma.com/make/*).
// - Chat overlay (Shadow DOM) over Make's left AI chat column, talking to local Claude Code.
// - Intercepts the Edit-mode tray's Apply button (Alt+click = Make's real Apply).
// - Clicks Discard when the daemon reports a successful apply.

(() => {
  if (window.top !== window || window.__makeBridgeLoaded) return;
  window.__makeBridgeLoaded = true;

  // No chat column on screen (preview-only view, narrow window): float a card from a launcher instead.
  let floatOpen = false;
  let composerH = 0; // height of Make's input area, measured once and reused

  let port = null;
  let connected = false;
  let busy = false;
  let applying = false;
  let showMakeAI = false;
  let currentAssistant = null; // element receiving chat-delta text

  const fileKey = () => (location.pathname.match(/^\/make\/([^/]+)/) || [])[1] || '';
  const text = (el) => (el && (el.innerText || el.textContent) || '').trim();

  // -------------------------------------------------------------------------
  // Port to background (reconnects if the service worker restarts)

  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: 'make-bridge' });
    } catch {
      return; // extension reloaded; this content script is orphaned
    }
    port.onMessage.addListener(onBackgroundMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      setConnected(false);
      setTimeout(connectPort, 1000);
    });
  }

  function post(msg) {
    if (!port) connectPort();
    try { port && port.postMessage(msg); return !!port; } catch { return false; }
  }

  setInterval(() => post({ type: 'ping' }), 20000);

  function onBackgroundMessage(msg) {
    switch (msg.type) {
      case 'status': setConnected(msg.connected); break;
      case 'chat-delta': currentThinking = null; appendAssistant(msg.text || ''); break;
      case 'chat-thinking': appendThinking(msg.text || ''); break;
      case 'chat-status': setStatus(msg.text || 'Working'); break;
      case 'chat-tool': addLine('tool', msg.text || ''); currentAssistant = null; currentThinking = null; setStatus('Working'); break;
      case 'chat-done':
        if (!msg.ok && msg.error && msg.error !== 'stopped') addLine('error', msg.error);
        if (msg.error === 'stopped') addLine('info', 'Stopped.');
        currentAssistant = null;
        currentThinking = null;
        setBusy(false);
        applying = false;
        sendNextQueued();
        break;
      case 'discard': clickDiscard(); break;
      default: break;
    }
  }

  // -------------------------------------------------------------------------
  // Overlay UI

  const host = document.createElement('div');
  host.id = 'make-bridge-overlay-host';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel {
        position: fixed; display: flex; flex-direction: column; pointer-events: auto;
        background: #2c2c2c; color: #e6e6e6; border-right: 1px solid #3d3d3d;
        font: 13px/1.45 Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      .panel.hidden { display: none; }
      .panel.float {
        border: 1px solid #3d3d3d; border-radius: 12px; overflow: hidden;
        box-shadow: 0 12px 40px rgba(0,0,0,.45);
      }
      .fab {
        position: fixed; left: 16px; bottom: 16px; pointer-events: auto; display: none;
        align-items: center; gap: 6px; cursor: pointer;
        background: #2c2c2c; color: #e6e6e6; border: 1px solid #4a4a4a; border-radius: 999px;
        padding: 7px 12px; font: 600 12px/1 Inter, system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.35);
      }
      .fab.show { display: flex; }
      .fab .dot { width: 7px; height: 7px; }
      button.close { display: none; background: none; border: 0; color: #aaa; font-size: 16px; line-height: 1; cursor: pointer; padding: 0 2px; }
      .float button.close { display: block; }
      .float label.toggle { display: none; }
      header {
        display: flex; align-items: center; gap: 8px; padding: 10px 12px;
        border-bottom: 1px solid #3d3d3d; flex: none;
      }
      header .title { font-weight: 600; flex: 1; white-space: nowrap; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #777; flex: none; }
      .dot.on { background: #2fbf71; }
      label.toggle { display: flex; align-items: center; gap: 4px; color: #aaa; font-size: 11px; cursor: pointer; }
      .msgs { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
      .msg { white-space: pre-wrap; word-wrap: break-word; }
      .user { align-self: flex-end; background: #0d99ff; color: #fff; padding: 6px 10px; border-radius: 10px; max-width: 85%; }
      .assistant { align-self: stretch; white-space: normal; }
      .assistant p { margin: 0 0 6px; }
      .assistant ul, .assistant ol { margin: 0 0 6px; padding-left: 18px; }
      .assistant li { margin: 2px 0; }
      .assistant .h { font-weight: 600; margin: 8px 0 4px; }
      .assistant code { font: 12px/1.4 ui-monospace, Menlo, monospace; background: #383838; border-radius: 4px; padding: 1px 4px; }
      .assistant pre { background: #232323; border: 1px solid #3d3d3d; border-radius: 6px; padding: 8px; overflow-x: auto; margin: 0 0 6px; }
      .assistant pre code { background: none; padding: 0; }
      .assistant a { color: #4db2ff; }
      .tool { font: 11px/1.4 ui-monospace, Menlo, monospace; color: #8a8a8a; }
      .status { color: #8a8a8a; font-size: 12px; display: none; align-items: center; gap: 6px; }
      .status.show { display: flex; }
      .status i { width: 6px; height: 6px; border-radius: 50%; background: #0d99ff; animation: pulse 1s ease-in-out infinite; }
      .status i:nth-child(2) { animation-delay: .15s; } .status i:nth-child(3) { animation-delay: .3s; }
      @keyframes pulse { 0%, 100% { opacity: .25; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
      details.thinking { color: #8a8a8a; font-size: 12px; border-left: 2px solid #4a4a4a; padding-left: 8px; }
      details.thinking summary { cursor: pointer; font-style: italic; }
      details.thinking div { white-space: pre-wrap; margin-top: 4px; max-height: 160px; overflow-y: auto; }
      .queue { flex: none; display: flex; flex-direction: column; gap: 4px; padding: 6px 10px 0; }
      .queue:empty { display: none; }
      .queued { display: flex; align-items: center; gap: 6px; background: #383838; border: 1px dashed #5a5a5a; border-radius: 8px; padding: 4px 6px 4px 8px; font-size: 12px; }
      .queued span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #cfcfcf; }
      .queued button { background: none; border: 0; color: #7cc4ff; cursor: pointer; font: 600 11px/1 Inter, system-ui, sans-serif; padding: 2px 4px; }
      .queued button.rm { color: #aaa; font-size: 14px; }
      .error { color: #ff7a6b; }
      .info { color: #aaa; font-style: italic; }
      .empty { color: #8a8a8a; text-align: center; margin-top: 24px; }
      .hole { flex: none; height: 0; }
      .composer { flex: none; display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid #3d3d3d; align-items: flex-end; min-height: 56px; }
      textarea {
        flex: 1; resize: none; max-height: 160px; min-height: 36px; height: 64px;
        background: #383838; color: #e6e6e6; border: 1px solid #4a4a4a; border-radius: 8px;
        padding: 8px; font: inherit; outline: none;
      }
      textarea:focus { border-color: #0d99ff; }
      .composer { flex-wrap: wrap; }
      .chips { flex: 1 0 100%; display: flex; flex-wrap: wrap; gap: 4px; }
      .chips:empty { display: none; }
      .chip {
        display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
        border: 1px solid #0d99ff; color: #7cc4ff; background: rgba(13,153,255,.12); border-radius: 4px;
        padding: 1px 4px 1px 6px; font: 12px/1.5 Inter, system-ui, sans-serif;
      }
      .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .chip button { background: none; border: 0; color: inherit; cursor: pointer; padding: 0 2px; font-size: 13px; line-height: 1; }
      .composer.under-tray { align-items: stretch; }
      .composer.under-tray textarea { height: auto; max-height: none; }
      .composer.under-tray button.send { align-self: flex-end; }
      button.send {
        flex: none; background: #0d99ff; color: #fff; border: 0; border-radius: 8px;
        padding: 8px 12px; font: inherit; font-weight: 600; cursor: pointer;
      }
      button.send.stop { background: #e5484d; }
      button.send:disabled { opacity: .5; cursor: default; }
      .pill {
        position: fixed; pointer-events: auto; display: none; cursor: pointer;
        background: #2c2c2c; color: #e6e6e6; border: 1px solid #4a4a4a; border-radius: 999px;
        padding: 3px 10px; font: 600 11px/1.4 Inter, system-ui, sans-serif;
      }
      .pill.show { display: block; }
      .badge {
        position: fixed; display: none; pointer-events: none;
        background: #0d99ff; color: #fff; border-radius: 4px; padding: 1px 5px;
        font: 600 10px/1.4 Inter, system-ui, sans-serif; white-space: nowrap;
      }
      .badge.show { display: block; }
    </style>
    <div class="panel">
      <header>
        <span class="dot"></span>
        <span class="title">Claude Code (local)</span>
        <label class="toggle"><input type="checkbox" class="showmake"> Show Make AI</label>
        <button class="close" title="Close">&times;</button>
      </header>
      <div class="msgs"><div class="empty">Messages go to local Claude Code, not Make AI.</div></div>
      <div class="queue"></div>
      <div class="hole"></div>
      <div class="composer">
        <div class="chips"></div>
        <textarea rows="2" placeholder="Ask Claude Code..."></textarea>
        <button class="send">Send</button>
      </div>
    </div>
    <div class="pill">Claude Code</div>
    <div class="fab"><span class="dot"></span>Claude</div>
    <div class="badge">&rarr; Claude</div>
  `;

  const $ = (s) => root.querySelector(s);
  const panel = $('.panel');
  const dot = $('.dot');
  const msgs = $('.msgs');
  const hole = $('.hole');
  const composer = $('.composer');
  const input = $('textarea');
  const sendBtn = $('button.send');
  const toggle = $('.showmake');
  const pill = $('.pill');
  const badge = $('.badge');
  const fab = $('.fab');
  const chipsEl = $('.chips');
  const queueEl = $('.queue');

  // Activity row ("Thinking…", "Running Edit…") kept at the bottom of the message list while busy.
  const statusEl = document.createElement('div');
  statusEl.className = 'status';
  statusEl.innerHTML = '<i></i><i></i><i></i><span></span>';
  function setStatus(label) {
    statusEl.querySelector('span').textContent = label + '…';
    statusEl.classList.toggle('show', busy);
    msgs.appendChild(statusEl);
    scrollDown();
  }

  // Claude's thinking, when the stream includes it, in a collapsed block.
  let currentThinking = null;
  function appendThinking(str) {
    if (!str) return;
    if (!currentThinking) {
      currentThinking = document.createElement('details');
      currentThinking.className = 'thinking';
      currentThinking.innerHTML = '<summary>Thinking</summary><div></div>';
      msgs.insertBefore(currentThinking, statusEl.parentNode === msgs ? statusEl : null);
      currentAssistant = null;
    }
    currentThinking.querySelector('div').textContent += str;
    scrollDown();
  }

  // Messages typed while Claude works wait here; "Send now" (or Cmd/Ctrl+Enter) stops the run and sends.
  const queue = [];
  let sendNowPending = false;
  function renderQueue() {
    queueEl.textContent = '';
    queue.forEach((q, i) => {
      const row = document.createElement('div');
      row.className = 'queued';
      const label = document.createElement('span');
      label.textContent = q.text;
      label.title = q.text;
      const now = document.createElement('button');
      now.textContent = 'Send now';
      now.addEventListener('click', () => sendNow(i));
      const rm = document.createElement('button');
      rm.className = 'rm';
      rm.textContent = '×';
      rm.title = 'Remove';
      rm.addEventListener('click', () => { queue.splice(i, 1); renderQueue(); });
      row.append(label, now, rm);
      queueEl.appendChild(row);
    });
    layout();
  }
  function sendNow(i) {
    const [q] = queue.splice(i, 1);
    queue.unshift(q);
    renderQueue();
    if (!busy) return sendNextQueued();
    sendNowPending = true;
    stopRun();
  }
  function sendNextQueued() {
    sendNowPending = false;
    if (busy || !queue.length) return;
    const q = queue.shift();
    renderQueue();
    sendText(q.text, q.selection);
  }

  // Edit-mode selection (from selection.js, page world) shown as chips and sent as context.
  let selection = [];
  let dismissed = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !Array.isArray(e.data.__makeBridgeSelection)) return;
    // Keep the last selection as context until a new one replaces it or the user removes it:
    // Make clears its selection on clicks outside the canvas, e.g. into this input.
    if (!e.data.__makeBridgeSelection.length) return;
    selection = e.data.__makeBridgeSelection;
    dismissed = new Set();
    renderChips();
  });
  const activeSelection = () => selection.filter((s) => !dismissed.has(s.id));
  function renderChips() {
    chipsEl.textContent = '';
    for (const s of activeSelection()) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.title = s.file;
      const label = document.createElement('span');
      label.textContent = '◇ ' + (s.name || s.id);
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = 'Remove from context';
      x.addEventListener('click', () => { dismissed.add(s.id); renderChips(); });
      chip.append(label, x);
      chipsEl.appendChild(chip);
    }
  }
  fab.addEventListener('click', () => { floatOpen = true; layout(); input.focus(); });
  $('button.close').addEventListener('click', () => { floatOpen = false; layout(); });

  (document.body || document.documentElement).appendChild(host);

  // Make deselects on pointer events outside its canvas; keep ours to ourselves.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  // Keep Make's global keyboard shortcuts from seeing our typing.
  for (const type of ['keydown', 'keyup', 'keypress', 'input', 'paste', 'copy', 'cut']) {
    input.addEventListener(type, (e) => e.stopPropagation());
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChat({ now: e.metaKey || e.ctrlKey });
    }
  });
  sendBtn.addEventListener('click', () => (busy && !input.value.trim() ? stopRun() : sendChat()));
  input.addEventListener('input', () => setBusy(busy));

  toggle.addEventListener('change', () => setShowMakeAI(toggle.checked));
  pill.addEventListener('click', () => setShowMakeAI(false));
  chrome.storage.local.get({ showMakeAI: false }, (v) => setShowMakeAI(!!v.showMakeAI, false));

  function setShowMakeAI(on, persist = true) {
    showMakeAI = on;
    toggle.checked = on;
    panel.classList.toggle('hidden', on);
    pill.classList.toggle('show', on);
    if (persist) chrome.storage.local.set({ showMakeAI: on });
    layout();
  }

  function setConnected(on) {
    connected = !!on;
    dot.classList.toggle('on', connected);
    dot.title = connected ? 'Bridge connected' : 'Bridge offline (run `figma-make bridge`)';
    layout();
  }

  function setBusy(on) {
    const was = busy;
    busy = on;
    // While busy: Stop, or Queue once something is typed.
    const queueing = on && !!input.value.trim();
    sendBtn.textContent = on ? (queueing ? 'Queue' : 'Stop') : 'Send';
    sendBtn.classList.toggle('stop', on && !queueing);
    if (on && !was) setStatus('Thinking');
    if (!on) statusEl.classList.remove('show');
  }

  function addLine(kind, str) {
    const empty = msgs.querySelector('.empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'msg ' + kind;
    el.textContent = str;
    msgs.appendChild(el);
    if (statusEl.parentNode === msgs) msgs.appendChild(statusEl);
    scrollDown();
    return el;
  }

  function appendAssistant(str) {
    if (!currentAssistant) { currentAssistant = addLine('assistant', ''); currentAssistant._raw = ''; }
    currentAssistant._raw += str;
    currentAssistant.innerHTML = renderMarkdown(currentAssistant._raw);
    scrollDown();
  }

  // Minimal Markdown for Claude's replies. HTML is escaped first, so only these tags can appear.
  function renderMarkdown(src) {
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (t) => esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const out = [];
    let list = null, code = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    src = src.replace(/\n?MUPDATE_OK\s*$/, "");
    for (const line of src.split('\n')) {
      if (code !== null) {
        if (/^```/.test(line)) { out.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`); code = null; }
        else code += line + '\n';
        continue;
      }
      if (/^```/.test(line)) { closeList(); code = ''; continue; }
      let m;
      if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
      if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
      closeList();
      if ((m = line.match(/^#{1,6}\s+(.*)/))) { out.push(`<div class="h">${inline(m[1])}</div>`); continue; }
      out.push(line.trim() ? `<p>${inline(line)}</p>` : '');
    }
    if (code !== null) out.push(`<pre><code>${esc(code)}</code></pre>`); // still streaming
    closeList();
    return out.join('');
  }

  // Follow new output unless the user scrolled up to read; re-stick when they scroll back down.
  let stick = true;
  msgs.addEventListener('scroll', () => { stick = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40; });
  function scrollDown() {
    if (stick) requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
  }

  function sendChat({ now = false } = {}) {
    stick = true;
    const t = input.value.trim();
    if (!t) return;
    if (!connected) {
      addLine('error', 'Bridge offline. Start it with `figma-make bridge`.');
      return;
    }
    input.value = '';
    if (busy) {
      // Claude is working: queue it (Cmd/Ctrl+Enter pushes it in right away instead).
      queue.push({ text: t, selection: activeSelection() });
      renderQueue();
      if (now) sendNow(queue.length - 1);
      setBusy(true);
      return;
    }
    sendText(t, activeSelection());
  }

  function sendText(t, sel = []) {
    addLine('user', t);
    currentAssistant = null;
    currentThinking = null;
    setBusy(true);
    if (sel.length) addLine('tool', 'context: ' + sel.map((s) => s.name || s.id).join(', '));
    post({ type: 'chat', fileKey: fileKey(), text: t, selection: sel });
  }

  function stopRun() {
    post({ type: 'stop' });
    addLine('info', sendNowPending ? 'Stopping to send your next message...' : 'Stopping...');
  }

  // -------------------------------------------------------------------------
  // Locating Make's chat column and Edit-mode change tray

  let cachedInput = null;
  let lastMiss = 0;
  function findMakeInput() {
    if (cachedInput && cachedInput.isConnected) return cachedInput;
    // The text-node walk is expensive; when there's no chat column, retry at most every 2s.
    if (Date.now() - lastMiss < 2000) return null;
    cachedInput = locateMakeInput();
    if (!cachedInput) lastMiss = Date.now();
    return cachedInput;
  }

  function locateMakeInput() {
    const sel = '[placeholder*="Describe your idea" i], [data-placeholder*="Describe your idea" i], [aria-placeholder*="Describe your idea" i]';
    const el = document.querySelector(sel);
    if (el) return el;
    // Placeholder might be rendered as a text node over a contenteditable.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (/Describe your idea/i.test(walker.currentNode.nodeValue)) return walker.currentNode.parentElement;
    }
    return null;
  }

  // Climb from the input to the tallest ancestor that is still a narrow left column.
  function measureColumn() {
    const start = findMakeInput();
    if (!start) return null;
    const vw = window.innerWidth;
    let best = null;
    for (let el = start; el && el !== document.body; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.width > vw * 0.6) break;
      if (r.left > vw * 0.5) break;
      best = r;
    }
    if (!best || best.height < 200) return null;
    return { left: best.left, top: best.top, width: best.width, bottom: window.innerHeight - best.bottom };
  }

  function isOurs(el) { return el === host || host.contains(el); }

  // Returns { apply, discard, row, tray } for the pending-changes tray, or null.
  function findTray(fromButton) {
    const buttons = fromButton ? [fromButton] : [...document.querySelectorAll('button')].filter((b) => text(b) === 'Apply');
    for (const apply of buttons) {
      if (isOurs(apply)) continue;
      // Smallest ancestor (within a few levels) that also contains a Discard button = the action row.
      let row = apply.parentElement;
      let discard = null;
      for (let i = 0; row && i < 5; i++, row = row.parentElement) {
        discard = [...row.querySelectorAll('button')].find((b) => text(b) === 'Discard');
        if (discard) break;
      }
      if (!discard) continue;
      // Grow upward to include the change rows, but never Make's chat input.
      let tray = row;
      for (let i = 0; i < 6; i++) {
        const p = tray.parentElement;
        if (!p || p === document.body) break;
        if (p.querySelector('textarea, [contenteditable="true"], input[type="text"]')) break;
        if (/Describe your idea/i.test(p.textContent || '')) break;
        tray = p;
      }
      return { apply, discard, row, tray };
    }
    return null;
  }

  function trayItems(t) {
    const rowText = new Set(text(t.row).split('\n').map((s) => s.trim()));
    const lines = text(t.tray).split('\n').map((s) => s.trim()).filter(Boolean)
      .filter((s) => !rowText.has(s) && !/^\d+\s+changes?$/i.test(s) && s !== 'Apply' && s !== 'Discard');
    // Labels are truncated with "..."; prefer a full title/aria-label when one exists.
    const full = [...t.tray.querySelectorAll('[title], [aria-label]')]
      .map((el) => el.getAttribute('title') || el.getAttribute('aria-label')).filter(Boolean);
    const out = lines.map((l) => {
      const stem = l.replace(/[….]+$/, '');
      return (l !== stem && full.find((f) => f.startsWith(stem) && f.length > stem.length)) || l;
    });
    return [...new Set(out)];
  }

  // -------------------------------------------------------------------------
  // Layout: cover the chat column, cut a hole where the change tray is

  function layout() {
    const docked = measureColumn();
    const vh = window.innerHeight;
    panel.classList.toggle('float', !docked);
    fab.classList.toggle('show', !docked && !floatOpen);
    fab.querySelector('.dot').classList.toggle('on', connected);
    if (!docked) {
      // Floating card above the launcher; the toggle for Make AI makes no sense without its column.
      pill.classList.remove('show');
      panel.classList.toggle('hidden', !floatOpen);
      const w = Math.min(380, window.innerWidth - 32), h = Math.min(560, vh - 32);
      Object.assign(panel.style, { left: '16px', top: (vh - 16 - h) + 'px', width: w + 'px', height: h + 'px', clipPath: '' });
      composer.style.height = ''; hole.style.height = '0';
      placeBadge();
      return;
    }
    panel.classList.toggle('hidden', showMakeAI);
    pill.classList.toggle('show', showMakeAI);
    const col = docked;
    const top = col.top;
    const height = vh - col.bottom - top;
    Object.assign(panel.style, {
      left: col.left + 'px', top: top + 'px', width: col.width + 'px', height: height + 'px',
    });
    pill.style.left = (col.left + col.width - 100) + 'px';
    pill.style.top = (top + 10) + 'px';

    const t = findTray();
    if (t && !showMakeAI) {
      const r = t.tray.getBoundingClientRect();
      const holeTop = Math.max(0, r.top - top);
      const holeBottom = Math.min(height, r.bottom - top);
      // Composer covers Make's own input below the tray.
      composerH = Math.max(56, height - holeBottom); // = Make's own input area under the tray
      composer.style.height = composerH + 'px';
      composer.classList.add('under-tray');
      hole.style.height = Math.max(0, holeBottom - holeTop) + 'px';
      panel.style.clipPath = `polygon(0 0, 100% 0, 100% ${holeTop}px, 0 ${holeTop}px, 0 ${holeBottom}px, 100% ${holeBottom}px, 100% 100%, 0 100%)`;
    } else {
      // Same size as with the tray: cover Make's input area exactly, so the box never jumps.
      if (!composerH) {
        const inp = findMakeInput();
        if (inp) composerH = Math.max(56, top + height - inp.getBoundingClientRect().top + 12);
      }
      composer.classList.toggle('under-tray', !!composerH);
      composer.style.height = composerH ? composerH + 'px' : '';
      hole.style.height = '0';
      panel.style.clipPath = '';
    }

    placeBadge(t);
    scrollDown();
  }

  function placeBadge(t = findTray()) {
    if (t && connected) {
      const b = t.apply.getBoundingClientRect();
      badge.style.left = Math.max(0, b.right - 52) + 'px';
      badge.style.top = Math.max(0, b.top - 16) + 'px';
      badge.classList.add('show');
    } else {
      badge.classList.remove('show');
    }
  }

  window.addEventListener('resize', layout);
  setInterval(layout, 1000);
  new MutationObserver(debounce(layout, 150)).observe(document.body, { childList: true, subtree: true });

  function debounce(fn, ms) {
    let t;
    return () => { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  // -------------------------------------------------------------------------
  // Apply interception (capture phase, before React sees it)

  function interceptable(e) {
    if (!connected || e.altKey) return null;
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (!btn || isOurs(btn) || text(btn) !== 'Apply') return null;
    return findTray(btn);
  }

  // Block the whole pointer sequence, in case Make acts on pointerdown rather than click.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    window.addEventListener(type, (e) => {
      if (interceptable(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }

  window.addEventListener('click', (e) => {
    const t = interceptable(e);
    if (!t) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (applying) { addLine('info', 'Claude is already applying...'); return; }
    applying = true;
    if (showMakeAI) setShowMakeAI(false);
    const items = trayItems(t);
    addLine('info', 'Claude is applying ' + items.length + ' change(s)...');
    for (const it of items) addLine('tool', '• ' + it);
    currentAssistant = null;
    setBusy(true);
    post({ type: 'apply', fileKey: fileKey(), trayItems: items });
  }, true);

  // -------------------------------------------------------------------------
  // Discard after a successful apply

  function synthClick(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...o, pointerId: 1, pointerType: 'mouse', buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...o, pointerId: 1, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  // Trusted click through chrome.debugger; our overlay must not sit on top of the point.
  function trustedClick(el) {
    const r = el.getBoundingClientRect();
    post({ type: 'trusted-click', x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }

  function confirmDialogDiscard() {
    const dlg = document.querySelector('[role="alertdialog"], [role="dialog"]');
    if (!dlg) return false;
    const btn = [...dlg.querySelectorAll('button')].find((b) => /^(Discard|Discard changes|Confirm)$/i.test(text(b)));
    if (btn) { synthClick(btn); return true; }
    return false;
  }

  function clickDiscard(retried = false) {
    const t = findTray();
    if (!t) {
      // The tray only shows in the Browser (preview) tab; switch back once and retry.
      const browserTab = !retried && [...document.querySelectorAll('button, [role=tab]')]
        .find((e) => !isOurs(e) && e.getBoundingClientRect().top < 40 && /^(Browser)+$/.test(text(e)));
      if (browserTab) { trustedClick(browserTab); setTimeout(() => clickDiscard(true), 1500); return; }
      addLine('info', 'No change tray to discard.');
      return;
    }
    synthClick(t.discard);
    setTimeout(() => {
      if (confirmDialogDiscard()) return;
      const still = findTray();
      if (still && still.discard.isConnected) {
        trustedClick(still.discard);
        setTimeout(confirmDialogDiscard, 600);
      } else {
        addLine('info', 'Discarded Make’s pending edits (now in code).');
      }
    }, 700);
  }

  connectPort();
  layout();
})();
