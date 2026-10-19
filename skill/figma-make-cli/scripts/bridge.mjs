#!/usr/bin/env node
// figma-make bridge — local daemon between the Chrome extension (WS /ext) and the CLI (POST /rpc).
// Runs `claude -p` for the overlay chat and for intercepted Make "Apply" clicks. See ../BRIDGE-SPEC.md.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.FIGMA_MAKE_BRIDGE_PORT || 47123)
const CONF_DIR = path.join(os.homedir(), '.config', 'figma-make')
const CONF = path.join(CONF_DIR, 'bridge.json')
const SESSIONS = path.join(CONF_DIR, 'sessions.json')
const MUPDATE = path.join(os.homedir(), '.claude', 'commands', 'mupdate.md')
const SKILL_MD = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'SKILL.md')

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a)
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const expand = p => p.replace(/^~(?=\/|$)/, os.homedir())

fs.mkdirSync(CONF_DIR, { recursive: true })
if (!fs.existsSync(CONF)) fs.writeFileSync(CONF, JSON.stringify({ files: {} }, null, 2) + '\n') // map "<Make file key>": "<local dir>"
const dirFor = key => { const d = readJson(CONF, { files: {} }).files?.[key]; return d && path.resolve(expand(d)) }

// ---- minimal WebSocket server (RFC 6455: text frames, client masking, ping/pong, close) ----
let ext = null // the one extension socket (newest wins)

function wsAccept(req, sock) {
  const key = req.headers['sec-websocket-key']
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') return sock.destroy()
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  sock.setNoDelay(true)
  const c = { sock, send: obj => frame(sock, 1, Buffer.from(JSON.stringify(obj))) }
  let buf = Buffer.alloc(0), parts = [], partOp = 0
  sock.on('data', d => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      if (buf.length < 2) return
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80
      let len = buf[1] & 0x7f, off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      const mask = masked ? buf.subarray(off, off + 4) : null
      if (masked) off += 4
      if (buf.length < off + len) return
      const payload = Buffer.from(buf.subarray(off, off + len))
      buf = buf.subarray(off + len)
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      if (op === 8) { frame(sock, 8, payload.subarray(0, 2)); sock.end(); return }
      if (op === 9) { frame(sock, 10, payload); continue }
      if (op === 10) continue
      if (op === 1 || op === 2) { parts = [payload]; partOp = op } else if (op === 0) parts.push(payload)
      if (!fin) continue
      const msg = Buffer.concat(parts); parts = []
      if (partOp === 1) { let m; try { m = JSON.parse(msg.toString('utf8')) } catch { continue } onExt(c, m) }
    }
  })
  const gone = () => { if (ext === c) { ext = null; log('extension disconnected'); failPending('extension disconnected') } }
  sock.on('close', gone); sock.on('error', gone)
  if (ext) { try { frame(ext.sock, 8, Buffer.from([0x03, 0xe8])); ext.sock.end() } catch {} }
  ext = c
  log('extension connected')
}

function frame(sock, op, payload) {
  const n = payload.length
  const head = n < 126 ? Buffer.from([0x80 | op, n])
    : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255])
    : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h })()
  if (!sock.destroyed) sock.write(Buffer.concat([head, payload]))
}

// ---- rpc: CLI → daemon → extension ----
const pending = new Map()
let rpcId = 0
function failPending(err) { for (const [id, p] of pending) { clearTimeout(p.timer); p.res({ ok: false, error: err }) } pending.clear() }
const rpc = (method, params = {}) => new Promise(res => {
  if (!ext) return res(null)
  const id = ++rpcId
  const timer = setTimeout(() => { pending.delete(id); res({ ok: false, error: `rpc ${method} timed out` }) }, params.timeout || 120000)
  pending.set(id, { res, timer })
  ext.send({ type: 'rpc', id, method, params })
})

// ---- claude runner ----
const runs = new Map() // fileKey → { child, tabId }
const send = m => ext?.send(m)

function toolLine(name, inp = {}) {
  if (name === 'Bash') return '$ ' + String(inp.command || '').replace(/\s+/g, ' ').slice(0, 80)
  const f = inp.file_path || inp.notebook_path || inp.path
  if (f) return `${name} ${path.basename(f)}`
  if (inp.pattern) return `${name} ${String(inp.pattern).slice(0, 80)}`
  const s = JSON.stringify(inp)
  return s === '{}' ? name : `${name} ${s.slice(0, 80)}`
}

function context(key, dir) {
  return `You are editing the Figma Make file ${key}, mirrored in this directory (${dir}). The user talks to you from a chat overlay inside Make in Chrome; the figma-make CLI reaches Make through the browser extension (FIGMA_MAKE_VIA=ext is set).
Keep every block GUI-editable in Make's Edit mode (see the "Lessons" in skill figma-make-cli, ${SKILL_MD}): no library-rendered wrappers around editable text, descriptive component names, Tailwind classes not inline styles.
After code changes: run \`pnpm exec tsc --noEmit -p .\`, fix errors, \`git commit -am "<msg>"\`, then \`figma-make push ${key} .\`.
Never spend Make AI credits (never click Apply or use Make's AI). Don't use \`figma-make exec\`, \`save\`, \`preview\` or \`reload\` unless the user asks: they use Make's terminal or tabs and change what the user sees; push/pull/baseline/pending never do. Be brief: the overlay is narrow and renders Markdown.`
}

function run(kind, { tabId, fileKey }, prompt, onDone) {
  const dir = dirFor(fileKey)
  if (!dir) {
    send({ type: 'chat-delta', tabId, text: `No local directory configured for Make file ${fileKey}. Add it to ${CONF}: { "files": { "${fileKey}": "/abs/local/dir" } }` })
    send({ type: 'chat-done', tabId, ok: false, error: 'unknown file key' })
    return log(`${kind} ${fileKey}: unknown key`)
  }
  if (runs.has(fileKey)) {
    send({ type: 'chat-delta', tabId, text: 'Claude is still working on this file — wait for it to finish or press Stop.' })
    send({ type: 'chat-done', tabId, ok: false, error: 'busy' })
    return log(`${kind} ${fileKey}: rejected (busy)`)
  }
  const sessions = readJson(SESSIONS, {})
  // bridge.json "skipPermissions": true → no tool is ever blocked waiting for an approval nobody can give
  // in headless mode (--dangerously-skip-permissions). Default: edits auto-accepted, Bash limited to sync tools.
  const yolo = readJson(CONF, {}).skipPermissions === true
  const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    ...(yolo ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits',
      '--allowedTools', 'Bash(figma-make:*)', 'Bash(pnpm:*)', 'Bash(git:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Read', 'Edit', 'Write', 'Glob', 'Grep']),
    '--append-system-prompt', context(fileKey, dir)]
  if (sessions[fileKey]) args.push('--resume', sessions[fileKey])
  log(`${kind} ${fileKey} → claude in ${dir}${sessions[fileKey] ? ' (resume ' + sessions[fileKey].slice(0, 8) + ')' : ''}`)
  const child = spawn('claude', args, { cwd: dir, env: { ...process.env, FIGMA_MAKE_VIA: 'ext' }, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end(prompt) // prompt via stdin: safe for text starting with "-"
  runs.set(fileKey, { child, tabId })
  let out = '', result = null, err = '', line = ''
  const seen = new Set()
  child.stdout.on('data', d => {
    line += d
    let i
    while ((i = line.indexOf('\n')) >= 0) {
      const l = line.slice(0, i).trim(); line = line.slice(i + 1)
      if (!l) continue
      let m; try { m = JSON.parse(l) } catch { continue }
      if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
        const s = readJson(SESSIONS, {}); s[fileKey] = m.session_id; fs.writeFileSync(SESSIONS, JSON.stringify(s, null, 2) + '\n')
      } else if (m.type === 'stream_event' && m.event?.type === 'content_block_start') {
        const b = m.event.content_block || {}
        const status = b.type === 'thinking' || b.type === 'redacted_thinking' ? 'Thinking' : b.type === 'tool_use' ? `Running ${b.name}` : b.type === 'text' ? 'Writing' : null
        if (status) send({ type: 'chat-status', tabId, text: status })
      } else if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'thinking_delta') {
        send({ type: 'chat-thinking', tabId, text: m.event.delta.thinking || '' })
      } else if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') {
        out += m.event.delta.text
        send({ type: 'chat-delta', tabId, text: m.event.delta.text })
      } else if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'tool_use' && !seen.has(b.id)) {
          seen.add(b.id)
          const t = toolLine(b.name, b.input)
          log(`  ${fileKey} tool: ${t}`)
          send({ type: 'chat-tool', tabId, text: t })
        }
      } else if (m.type === 'result') {
        result = m
        if (m.session_id) { const s = readJson(SESSIONS, {}); s[fileKey] = m.session_id; fs.writeFileSync(SESSIONS, JSON.stringify(s, null, 2) + '\n') }
      }
    }
  })
  child.stderr.on('data', d => { err = (err + d).slice(-2000) })
  child.on('error', e => { err += e.message })
  child.on('close', code => {
    const stopped = runs.get(fileKey)?.stopped
    runs.delete(fileKey)
    const ok = !stopped && code === 0 && result && !result.is_error
    const error = ok ? undefined : stopped ? 'stopped' : (result?.is_error ? String(result.result || result.subtype || 'error') : (err.trim().split('\n').pop() || `claude exited ${code}`))
    log(`${kind} ${fileKey} done: ${ok ? 'ok' : 'error: ' + error}`)
    send({ type: 'chat-done', tabId, ok: !!ok, ...(error && { error }) })
    onDone?.({ code, ok, text: out + '\n' + (result?.result || '') })
  })
}

function mupdatePrompt(key, dir, items) {
  const body = fs.readFileSync(MUPDATE, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').replaceAll('$ARGUMENTS', `${key} ${dir}`)
  return `${body.trim()}\n\nBrowser mode: FIGMA_MAKE_VIA=ext is set, so \`figma-make status/pull/pending/push\` talk to the Make tab in Chrome and \`pending\` DOES see these browser edits (ignore the desktop-only notes above).\nThe user clicked Apply in the browser. Tray items:\n${items.map(t => '- ' + t).join('\n') || '- (none listed)'}\nEnd your final message with the line MUPDATE_OK only if the edits are committed and pushed.`
}

// Edit-mode selection → a context block: source file from Make's Elements panel, plus the live
// element (tag, classes, text, HTML) read from the preview by its data-fge-id.
async function selectionContext(tabId, sel) {
  if (!Array.isArray(sel) || !sel.length) return ''
  const ids = sel.map(s => s.id)
  const r = await rpc('evaluate', { tabId, frame: 'preview', timeout: 15000, expression: `(${JSON.stringify(ids)}).map(id => {
    const el = document.querySelector('[data-fge-id="' + id + '"]'); if (!el) return null
    const html = el.outerHTML.replace(/ data-fg[a-z-]*="[^"]*"/g, '')
    return { tag: el.tagName.toLowerCase(), cls: el.getAttribute('class') || '', text: (el.innerText || '').trim().slice(0, 300), html: html.length > 800 ? html.slice(0, 800) + '…' : html }
  })` })
  const live = r?.ok ? r.result : []
  const lines = sel.map((s, i) => {
    const l = live[i]
    return `- ${s.name || s.id}${s.component ? ' (component, defined' : ''} in ${s.file.replace(/^\//, '')}${s.component ? '; find where it is used via the text below)' : ''}` + (l ? `\n  tag: <${l.tag}> class="${l.cls}"\n  text: ${JSON.stringify(l.text)}\n  html: ${l.html}` : '')
  })
  return `The user selected ${sel.length === 1 ? 'this element' : 'these elements'} in Make's Edit mode; "this"/"it" in their message refers to ${sel.length === 1 ? 'it' : 'them'}:\n${lines.join('\n')}\n\nUser message: `
}

function onExt(c, m) {
  if (c !== ext) return
  if (m.type === 'hello') log(`extension hello v${m.version}`)
  else if (m.type === 'rpc-result') {
    const p = pending.get(m.id); if (!p) return
    pending.delete(m.id); clearTimeout(p.timer)
    p.res(m.ok ? { ok: true, result: m.result } : { ok: false, error: m.error || 'rpc failed' })
  } else if (m.type === 'chat') {
    log(`chat ${m.fileKey} tab ${m.tabId}: ${String(m.text).slice(0, 80)}${m.selection?.length ? ` [+${m.selection.length} selected]` : ''}`)
    selectionContext(m.tabId, m.selection).then(ctx => run('chat', m, ctx + String(m.text)))
  } else if (m.type === 'apply') {
    const items = m.trayItems || []
    log(`apply ${m.fileKey} tab ${m.tabId}: ${items.length} tray items`)
    const dir = dirFor(m.fileKey)
    let prompt; try { prompt = mupdatePrompt(m.fileKey, dir || '', items) } catch (e) { prompt = null; log('apply: cannot read mupdate.md: ' + e.message) }
    if (!prompt) { send({ type: 'chat-done', tabId: m.tabId, ok: false, error: 'mupdate.md missing' }); return }
    run('apply', m, prompt, ({ code, text }) => {
      if (code === 0 && text.includes('MUPDATE_OK')) { log(`apply ${m.fileKey}: MUPDATE_OK → discard`); send({ type: 'discard', tabId: m.tabId }) }
      else log(`apply ${m.fileKey}: no MUPDATE_OK, tray left alone`)
    })
  } else if (m.type === 'stop') {
    for (const [key, r] of runs) if (r.tabId === m.tabId) { log(`stop ${key}`); r.stopped = true; r.child.kill('SIGTERM'); setTimeout(() => r.child.kill('SIGKILL'), 3000).unref() }
  } else log(`unknown message ${m.type}`)
}

// ---- HTTP ----
const server = http.createServer((req, res) => {
  const reply = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (req.method === 'GET' && req.url === '/') return reply(200, { ok: true, ext: !!ext, running: [...runs.keys()] })
  if (req.method !== 'POST' || req.url !== '/rpc') return reply(404, { ok: false, error: 'not found' })
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', async () => {
    let q; try { q = JSON.parse(body) } catch { return reply(400, { ok: false, error: 'bad json' }) }
    if (!ext) return reply(503, { ok: false, error: 'extension not connected — open a figma.com/make tab with the figma-make extension loaded' })
    const t0 = Date.now()
    const r = await rpc(q.method, q.params || {})
    log(`rpc ${q.method}${q.params?.frame ? ' ' + q.params.frame : ''} ${r?.ok ? 'ok' : 'error'} ${Date.now() - t0}ms`)
    if (!r) return reply(503, { ok: false, error: 'extension not connected' })
    reply(200, r)
  })
})
server.requestTimeout = 0
server.on('upgrade', (req, sock) => req.url === '/ext' ? wsAccept(req, sock) : sock.destroy())
server.on('error', e => { console.error('bridge:', e.code === 'EADDRINUSE' ? `port ${PORT} in use — is a bridge already running?` : e.message); process.exit(1) })
server.listen(PORT, '127.0.0.1', () => log(`figma-make bridge on http://127.0.0.1:${PORT} (config ${CONF})`))
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { for (const r of runs.values()) r.child.kill('SIGTERM'); process.exit(0) })
