// Figma Make Bridge - background service worker.
// - WebSocket client to the local daemon (ws://127.0.0.1:47123/ext), reconnecting every 2s.
// - RPC executor (list / evaluate / click / screenshot) via chrome.debugger.
// - Router between the daemon and the content script ports (one per Make tab).

const WS_URL = 'ws://127.0.0.1:47123/ext';
const VERSION = chrome.runtime.getManifest().version;
const MAKE_URL = 'https://www.figma.com/make/*';

let ws = null;
let wsOpen = false;
let reconnectTimer = null;

/** tabId -> chrome.runtime.Port (content script) */
const ports = new Map();

// ---------------------------------------------------------------------------
// WebSocket to the daemon

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  let sock;
  try {
    sock = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    wsOpen = true;
    send({ type: 'hello', version: VERSION });
    broadcastStatus();
  };
  sock.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleDaemonMessage(msg);
  };
  sock.onclose = () => {
    if (ws === sock) {
      ws = null;
      wsOpen = false;
      broadcastStatus();
      scheduleReconnect();
    }
  };
  sock.onerror = () => { /* onclose follows */ };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 2000);
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function handleDaemonMessage(msg) {
  switch (msg.type) {
    case 'rpc':
      runRpc(msg.method, msg.params || {})
        .then((result) => send({ type: 'rpc-result', id: msg.id, ok: true, result }))
        .catch((e) => send({ type: 'rpc-result', id: msg.id, ok: false, error: String(e && e.message || e) }));
      break;
    case 'chat-delta':
    case 'chat-thinking':
    case 'chat-status':
    case 'chat-tool':
    case 'chat-done':
    case 'discard': {
      const port = ports.get(Number(msg.tabId));
      if (port) port.postMessage(msg);
      break;
    }
    default:
      break;
  }
}

// Keep the service worker alive while connected; also retries the socket.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'keepalive') connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ---------------------------------------------------------------------------
// Content-script ports

function broadcastStatus() {
  for (const port of ports.values()) port.postMessage({ type: 'status', connected: wsOpen });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'make-bridge' || !port.sender || !port.sender.tab) return;
  const tabId = port.sender.tab.id;
  ports.set(tabId, port);
  connect();
  port.postMessage({ type: 'status', connected: wsOpen });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'ping':
        break; // keeps the worker alive
      case 'get-status':
        port.postMessage({ type: 'status', connected: wsOpen });
        break;
      case 'chat':
        if (!send({ type: 'chat', tabId, fileKey: msg.fileKey, text: msg.text, selection: msg.selection || [] })) {
          port.postMessage({ type: 'chat-done', tabId, ok: false, error: 'Bridge offline: run `figma-make bridge`.' });
        }
        break;
      case 'apply':
        if (!send({ type: 'apply', tabId, fileKey: msg.fileKey, trayItems: msg.trayItems || [] })) {
          port.postMessage({ type: 'chat-done', tabId, ok: false, error: 'Bridge offline: Apply not sent.' });
        }
        break;
      case 'stop':
        send({ type: 'stop', tabId });
        break;
      case 'trusted-click':
        rpcClick({ tabId, x: msg.x, y: msg.y }).catch((e) =>
          port.postMessage({ type: 'chat-tool', tabId, text: 'trusted click failed: ' + e.message }));
        break;
      default:
        break;
    }
  });
  port.onDisconnect.addListener(() => {
    if (ports.get(tabId) === port) ports.delete(tabId);
  });
});

// ---------------------------------------------------------------------------
// chrome.debugger state

/** tabId -> { sessions: Map<sessionId, {targetId, type, url, attachedAt}> } */
const dbg = new Map();
// Only iframes: attaching to Make's workers/other targets stalls its Edit mode.
const AUTO_ATTACH = { autoAttach: true, flatten: true, waitForDebuggerOnStart: false, filter: [{ type: 'iframe' }, { exclude: true }] };
// Stay attached only while the CLI is using the tab; detach after this long idle.
const IDLE_DETACH_MS = 15000;
const idleTimers = new Map();
const inflight = new Map(); // tabId -> running rpc count; never detach mid-command
function touch(tabId) {
  clearTimeout(idleTimers.get(tabId));
  idleTimers.set(tabId, setTimeout(() => {
    idleTimers.delete(tabId);
    if (inflight.get(tabId)) return touch(tabId);
    dbg.delete(tabId);
    chrome.debugger.detach({ tabId }).catch(() => {});
  }, IDLE_DETACH_MS));
}

async function ensureAttached(tabId) {
  touch(tabId);
  if (dbg.has(tabId)) return dbg.get(tabId);
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // Already attached by us (e.g. worker restarted and lost state) is fine.
    if (!/already attached/i.test(String(e && e.message))) throw e;
  }
  const state = { sessions: new Map() };
  dbg.set(tabId, state);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', AUTO_ATTACH);
  } catch (e) {
    console.warn('setAutoAttach failed', e);
  }
  return state;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const state = dbg.get(source.tabId);
  if (!state) return;
  if (method === 'Target.attachedToTarget') {
    const info = params.targetInfo || {};
    state.sessions.set(params.sessionId, {
      targetId: info.targetId, type: info.type, url: info.url || '', attachedAt: Date.now(),
    });
  } else if (method === 'Target.detachedFromTarget') {
    state.sessions.delete(params.sessionId);
  } else if (method === 'Target.targetInfoChanged') {
    const info = params.targetInfo || {};
    for (const s of state.sessions.values()) if (s.targetId === info.targetId) s.url = info.url || s.url;
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) dbg.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => { dbg.delete(tabId); });

function previewSessionId(state) {
  let best = null;
  for (const [id, s] of state.sessions) {
    if (!s.url.includes('makeproxy')) continue;
    if (!best || s.attachedAt >= best.attachedAt) best = { id, attachedAt: s.attachedAt };
  }
  return best && best.id;
}

// Find (or attach to) the preview iframe target; returns a debuggee with sessionId.
async function previewTarget(tabId) {
  const state = await ensureAttached(tabId);
  let sid = previewSessionId(state);
  if (sid) return { tabId, sessionId: sid };

  // Fallback: auto-attach gave nothing yet; look the target up and attach explicitly.
  try {
    const { targetInfos } = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargets', {});
    const cands = (targetInfos || []).filter((t) => (t.url || '').includes('makeproxy'));
    for (const t of cands.reverse()) {
      try {
        const { sessionId } = await chrome.debugger.sendCommand({ tabId }, 'Target.attachToTarget',
          { targetId: t.targetId, flatten: true });
        state.sessions.set(sessionId, { targetId: t.targetId, type: t.type, url: t.url, attachedAt: Date.now() });
        return { tabId, sessionId };
      } catch { /* try next */ }
    }
  } catch (e) {
    console.warn('getTargets failed', e);
  }
  // Last resort: re-issue auto-attach and wait briefly for the event.
  await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', AUTO_ATTACH).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  sid = previewSessionId(state);
  if (sid) return { tabId, sessionId: sid };
  throw new Error('preview iframe (makeproxy) target not found');
}

// ---------------------------------------------------------------------------
// RPC methods

async function runRpc(method, params) {
  const tabId = params && params.tabId;
  if (tabId == null) return runRpcInner(method, params);
  inflight.set(tabId, (inflight.get(tabId) || 0) + 1);
  try { return await runRpcInner(method, params); }
  finally { inflight.set(tabId, inflight.get(tabId) - 1); if (dbg.has(tabId)) touch(tabId); }
}

async function runRpcInner(method, params) {
  switch (method) {
    case 'list': return rpcList();
    case 'evaluate': return rpcEvaluate(params);
    case 'click': return rpcClick(params);
    case 'screenshot': return rpcScreenshot(params);
    case 'reload': setTimeout(() => chrome.runtime.reload(), 100); return true; // picks up edited extension files
    default: throw new Error('unknown rpc method: ' + method);
  }
}

async function rpcList() {
  const tabs = await chrome.tabs.query({ url: MAKE_URL });
  return tabs.map((t) => ({ tabId: t.id, url: t.url, title: t.title }));
}

async function evaluateOn(target, expression, timeout) {
  const call = chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  const res = await withTimeout(call, timeout || 120000, 'evaluate timed out');
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || 'evaluation failed');
  }
  return res.result ? res.result.value : undefined;
}

async function rpcEvaluate({ tabId, frame = 'top', expression, timeout }) {
  tabId = Number(tabId);
  await ensureAttached(tabId);
  if (frame !== 'preview') return evaluateOn({ tabId }, expression, timeout);
  let target = await previewTarget(tabId);
  try {
    return await evaluateOn(target, expression, timeout);
  } catch (e) {
    // Stale session (preview reloaded): drop it and retry once.
    if (!/session/i.test(String(e.message))) throw e;
    dbg.get(tabId)?.sessions.delete(target.sessionId);
    target = await previewTarget(tabId);
    return evaluateOn(target, expression, timeout);
  }
}

async function rpcClick({ tabId, x, y }) {
  tabId = Number(tabId);
  await ensureAttached(tabId);
  const t = { tabId };
  const base = { x, y, button: 'left', clickCount: 1 };
  await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
  await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
  return true;
}

async function rpcScreenshot({ tabId, frame = 'top' }) {
  tabId = Number(tabId);
  await ensureAttached(tabId);
  const t = { tabId };
  const opts = { format: 'png' };
  if (frame === 'preview') {
    // Child-frame sessions can't capture themselves; clip the top-level capture to the iframe box.
    const rect = await evaluateOn(t, `(() => {
      const frames = [...document.querySelectorAll('iframe')];
      const f = frames.find((el) => (el.src || '').includes('makeproxy'))
        || frames.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`, 10000);
    if (!rect || !rect.width || !rect.height) throw new Error('preview iframe not found');
    opts.clip = { ...rect, scale: 1 };
  }
  const { data } = await chrome.debugger.sendCommand(t, 'Page.captureScreenshot', opts);
  return data;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(label + ' after ' + ms + 'ms')), ms); }),
  ]).finally(() => clearTimeout(timer));
}
