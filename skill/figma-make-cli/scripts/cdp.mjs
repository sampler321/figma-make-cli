#!/usr/bin/env node
// Minimal Chrome DevTools Protocol client for the Figma desktop app.
// Usage:
//   cdp.mjs targets                       list page targets
//   cdp.mjs eval <match> <js|@file>       evaluate JS (awaited) in the first target whose url/title contains <match>
// FIGMA_MAKE_VIA=ext routes everything through the figma-make bridge + Chrome extension instead (no desktop app).
import http from 'node:http'
const PORT = process.env.FIGMA_CDP_PORT || 9222
const EXT = process.env.FIGMA_MAKE_VIA === 'ext'
const BRIDGE_PORT = Number(process.env.FIGMA_MAKE_BRIDGE_PORT || 47123)

// POST /rpc on the bridge. node:http (not fetch) so long evaluates aren't cut by undici's 300s timeouts.
function rpc(method, params = {}) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ method, params })
    const req = http.request({ host: '127.0.0.1', port: BRIDGE_PORT, path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, r => {
      let d = ''
      r.on('data', c => { d += c })
      r.on('end', () => {
        let m; try { m = JSON.parse(d) } catch { return rej(new Error(`bridge: bad response (${r.statusCode})`)) }
        m.ok ? res(m.result) : rej(new Error(m.error || `bridge error ${r.statusCode}`))
      })
    })
    req.on('error', e => rej(new Error(e.code === 'ECONNREFUSED' ? 'figma-make bridge not running — start it with: figma-make bridge' : e.message)))
    req.end(body)
  })
}

const extTargets = async () => (await rpc('list')).map(t => ({ id: t.tabId, tabId: t.tabId, url: t.url, title: t.title, type: 'page', frame: 'top' }))

export async function targets() {
  if (EXT) return extTargets()
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return (await r.json()).filter(t => t.type === 'page')
}

export async function frameTargets() {
  if (EXT) return (await extTargets()).filter(t => t.url.includes('/make/')).map(t => ({ ...t, type: 'iframe', frame: 'preview' }))
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return (await r.json()).filter(t => t.type === 'iframe' && t.url.includes('makeproxy'))
}

export async function findTarget(match) {
  if (match === '@preview') {
    const fs = await frameTargets()
    if (!fs.length) throw new Error(EXT ? 'no figma.com/make tab open in Chrome' : 'no Make preview iframe found — open the Browser tab of the Make file in Figma desktop')
    return fs[0]
  }
  const ts = await targets()
  const t = ts.find(t => t.url.includes(match) || t.title.includes(match))
  if (!t) throw new Error(`no Figma tab matching "${match}". Open: ${ts.map(t => t.title).join(' | ')}`)
  return t
}

export async function evaluate(match, expression, { timeout = 120000 } = {}) {
  const t = await findTarget(match)
  if (EXT) return rpc('evaluate', { tabId: t.tabId, frame: t.frame, expression, timeout })
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  try {
    const result = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('CDP evaluate timed out')), timeout)
      ws.onmessage = ev => {
        const msg = JSON.parse(ev.data)
        if (msg.id !== 1) return
        clearTimeout(timer)
        if (msg.error) return rej(new Error(msg.error.message))
        const r = msg.result
        if (r.exceptionDetails) return rej(new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
        res(r.result.value)
      }
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
    return result
  } finally {
    ws.close()
  }
}

// PNG screenshot of the tab (returns a Buffer).
export async function screenshot(match) {
  const t = await findTarget(match)
  if (EXT) return Buffer.from(await rpc('screenshot', { tabId: t.tabId, frame: t.frame }), 'base64')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  try {
    const data = await new Promise((res, rej) => {
      ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id === 1) m.error ? rej(new Error(m.error.message)) : res(m.result.data) }
      ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }))
    })
    return Buffer.from(data, 'base64')
  } finally {
    ws.close()
  }
}

// Trusted mouse click at viewport coordinates (some Figma UI ignores synthetic DOM events).
export async function click(match, x, y) {
  const t = await findTarget(match)
  if (EXT) { await rpc('click', { tabId: t.tabId, x, y }); return }
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const send = (method, params) => new Promise(res => {
    const my = ++id
    ws.addEventListener('message', function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener('message', h); res(m) } })
    ws.send(JSON.stringify({ id: my, method, params }))
  })
  try {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  } finally {
    ws.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, match, js] = process.argv.slice(2)
  if (cmd === 'targets') {
    for (const t of await targets()) console.log(`${t.title}\t${t.url}`)
  } else if (cmd === 'eval') {
    const fs = await import('node:fs')
    const code = js.startsWith('@') ? fs.readFileSync(js.slice(1), 'utf8') : js
    const v = await evaluate(match, `(async()=>{${code}})()`)
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  } else {
    console.error('usage: cdp.mjs targets | eval <match> <js|@file>')
    process.exit(1)
  }
}
