#!/usr/bin/env node
// make-sync — move code between a local folder and a Figma Make file's sandbox,
// driving the Make tab in the Figma desktop app over CDP (no LLM in the data path).
//
//   make-sync.mjs exec <tab> "<shell cmd>"         run a command in the sandbox, print output
//   make-sync.mjs push <tab> <localDir> [--delete] tar localDir -> sandbox workspace, then save
//   make-sync.mjs pull <tab> <localDir>             sandbox workspace -> localDir
//   make-sync.mjs save <tab>                        trigger Make's save (tiny editor edit)
//
// <tab> is a substring of the Make tab's title or URL in Figma desktop (e.g. the file key).
// Figma desktop must run with --remote-debugging-port=9222 (see SKILL.md).
import { evaluate, click } from './cdp.mjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const WORKSPACE = '/workspaces/default/code'
const CA = 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/cloudflare-containers-ca.crt'
const EXCLUDES = ['node_modules', '.git', 'dist', '.DS_Store', '.env', '.env.*', '.figma-make-sync.json']

// In-page helpers, injected once per evaluate. They locate the xterm instance behind
// Make's Terminal tab (opening one if needed), send input, and read the buffer.
const PAGE_LIB = String.raw`
const sleep = ms => new Promise(r => setTimeout(r, ms))
function findTerms() {
  const found = [], seen = new WeakSet()
  const isTerm = o => { try { return o && typeof o === 'object' && o.buffer && o.buffer.active && typeof o.buffer.active.getLine === 'function' && o._core } catch { return false } }
  const scan = (o, d) => { if (!o || typeof o !== 'object' || seen.has(o) || d > 6) return; seen.add(o); if (isTerm(o)) { found.push(o); return } let ks; try { ks = Object.keys(o) } catch { return } for (const k of ks.slice(0, 60)) { if (k === 'return' || k === '_owner') continue; try { scan(o[k], d + 1) } catch {} } }
  // Make keeps inactive terminal tabs mounted, so a hidden terminal works and the user's view stays put.
  document.querySelectorAll('.xterm').forEach(el => { let n = el; for (let i = 0; i < 8 && n; i++, n = n.parentElement) for (const k of Object.keys(n)) if (k.startsWith('__reactFiber')) { let f = n[k]; for (let j = 0; j < 15 && f; j++) { scan(f.memoizedProps, 0); scan(f.memoizedState, 0); scan(f.stateNode, 0); f = f.return } } })
  return found
}
function press(el) {
  const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, button: 0 }
  for (const ty of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new (ty.startsWith('pointer') ? PointerEvent : MouseEvent)(ty, o))
}
// Screen position of an existing workspace tab ('term' or 'files'); tabs only react to trusted clicks.
// Make's file system service (the code editor writes through it; writes are persisted + committed).
function makeFs() {
  if (window.__mfs && typeof window.__mfs.writeFile === 'function') return window.__mfs
  for (const el of document.querySelectorAll('div')) for (const k of Object.keys(el)) if (k.startsWith('__reactFiber')) {
    for (let f = el[k], j = 0; j < 60 && f; j++, f = f.return) { const v = f.memoizedProps && f.memoizedProps.value; if (v && typeof v.writeFile === 'function' && typeof v.writeBinaryFile === 'function') return (window.__mfs = v) }
  }
  throw new Error("Make's file system not found (open the Make file's workspace)")
}
function tabPos(kind) {
  if (kind === 'browser') {
    const el = [...document.querySelectorAll('button, [role=tab]')].find(e => e.getBoundingClientRect().top < 40 && /^(Browser)+$/.test(e.textContent.trim()))
    if (!el) return null
    const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }
  const bs = [...document.querySelectorAll('[aria-label^="Close "]')].filter(b => b.getBoundingClientRect().top < 40)
  const b = bs.find(b => kind === 'files' ? b.getAttribute('aria-label') === 'Close Files tab' && /^Files/.test(b.parentElement.textContent.trim()) : b.getAttribute('aria-label') !== 'Close Files tab')
  if (!b) return null
  const r = b.getBoundingClientRect(); return { x: Math.max(r.left - 50, 1), y: r.top + r.height / 2 }
}
async function openTerminal() {
  if (findTerms().length) return findTerms()[0]
  // An existing (inactive) terminal tab: activate it.
  const tabBtn = [...document.querySelectorAll('button')].find(b => b.getBoundingClientRect().top < 40 && b.querySelector('svg') && /\$|terminal/i.test(b.getAttribute('aria-label') || ''))
  if (tabBtn) { press(tabBtn); await sleep(800); if (findTerms().length) return findTerms()[0] }
  let plus = document.querySelector('button[aria-label="Add workspace tab"]')
  if (!plus) {
    // Fresh Make file (prompt screen only): open the code workspace via Make settings → Access code editor.
    const settings = document.querySelector('button[aria-label="Make settings"], button[aria-label="Settings"]')
    if (!settings) throw new Error('no "Add workspace tab" or "Make settings" button; is this a Make file?')
    press(settings); await sleep(500)
    const acc = [...document.querySelectorAll('[role=menuitem], [role=option]')].find(e => /access code editor/i.test(e.textContent))
    if (!acc) throw new Error('"Access code editor" not found in Make settings')
    press(acc); await sleep(4000)
    plus = document.querySelector('button[aria-label="Add workspace tab"]')
    if (!plus) throw new Error('code workspace did not open')
  }
  press(plus); await sleep(500)
  const item = [...document.querySelectorAll('[role=menuitem], [role=option]')].find(e => e.textContent.trim() === 'Terminal')
  if (!item) throw new Error('Terminal menu item not found; open one manually (+ → Terminal) and retry')
  press(item); await sleep(3000)
  const t = findTerms()[0]; if (!t) throw new Error('terminal did not appear'); return t
}
function bufferText(t) { const b = t.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + (l.isWrapped ? '' : '\n') } return s }
function send(t, data) { t._core.coreService.triggerDataEvent(data, true) }
async function run(t, cmd, timeoutMs) {
  const id = Math.random().toString(36).slice(2, 10)
  const start = '__MS_S_' + id + '__', end = '__MS_E_' + id + '__'
  t.clear()
  // Split the markers with "" so the echoed command line never contains them literally.
  const q = s => s.slice(0, 6) + '""' + s.slice(6)
  send(t, '\x15echo ' + q(start) + '; ' + cmd + '; echo ' + q(end) + ' $?\r')
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await sleep(300)
    const s = bufferText(t)
    const e = s.lastIndexOf(end + ' ')
    if (e >= 0 && s.indexOf('\n', e) > 0) {
      const a = s.lastIndexOf(start + '\n', e)
      const code = parseInt(s.slice(e + end.length + 1).trim(), 10)
      return { out: s.slice(a + start.length + 1, e).replace(/\n+$/, ''), code }
    }
  }
  throw new Error('timed out waiting for: ' + cmd.slice(0, 80))
}
`

async function page(tab, body, timeout = 600000) {
  return evaluate(tab, `(async()=>{${PAGE_LIB}\n${body}})()`, { timeout })
}

async function focusTab(tab, kind) {
  const pos = await page(tab, {
    term: `if (findTerms().length) return null; return tabPos('term')`,
    files: `if (document.querySelector('.cm-content') || document.querySelector('[role=treeitem]')) return null; return tabPos('files')`,
    browser: `if ([...document.querySelectorAll('iframe')].some(f => f.src.includes('makeproxy') && f.offsetParent)) return null; return tabPos('browser')`,
  }[kind])
  if (pos) { await click(tab, pos.x, pos.y); await new Promise(r => setTimeout(r, 1200)) }
}

async function sandboxRun(tab, cmd, timeoutMs = 300000) {
  const hadTerminal = await page(tab, `return findTerms().length > 0`)
  const r = await page(tab, `const t = await openTerminal(); return await run(t, ${JSON.stringify(cmd)}, ${timeoutMs})`, timeoutMs + 30000)
  // A freshly created terminal tab comes to the front; put the preview back (it keeps running hidden).
  if (!hadTerminal) await focusTab(tab, 'browser')
  return r
}

async function exec(tab, cmd) {
  const r = await sandboxRun(tab, `cd ${WORKSPACE} && ${CA} && ${cmd}`)
  await focusTab(tab, 'browser') // only switches if a new terminal had to be opened
  process.stdout.write(r.out + '\n')
  if (r.code) process.exitCode = r.code
  return r
}


// --- sync safety: fingerprint of the sandbox project at the last pull/push ---------------
function statePath(dir) {
  return fs.existsSync(path.join(dir, '.git')) ? path.join(dir, '.git', 'figma-make-sync.json') : path.join(dir, '.figma-make-sync.json')
}
function readState(dir) { try { return JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) } catch { return null } }
function writeState(dir, tab, fp) { fs.writeFileSync(statePath(dir), JSON.stringify({ tab, fingerprint: fp, at: new Date().toISOString() }, null, 2)) }
async function remoteFingerprint(tab) {
  const h = await remoteHashes(tab)
  return crypto.createHash('sha256').update(Object.keys(h).sort().map(f => `${h[f]}  ${f}`).join('\n')).digest('hex')
}
// Sync scope = the files Make's file system manages (everything the app is made of). Make's own
// scaffolding (.figma/make/*, dotfiles, lockfile, AGENTS/CLAUDE.md) stays out of it on both sides.
const unmanaged = f => /(^|\/)\./.test(f) || ['AGENTS.md', 'CLAUDE.md', 'pnpm-lock.yaml'].includes(f) || /(^|\/)(node_modules|dist)\//.test(f)
// Hashes of every file in Make, read through its file system API (no terminal).
async function remoteHashes(tab) {
  return page(tab, `const fs = makeFs(); const out = {}
    for (const p of fs.deprecatedGetFilePaths()) {
      const e = await fs.fetchEntry(p); let c = e.asyncContents; if (c && c.then) c = await c
      const bytes = typeof c === 'string' ? new TextEncoder().encode(c) : c
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      out[p.slice(1)] = [...d].map(b => b.toString(16).padStart(2, '0')).join('')
    }
    return out`)
}
function localHashes(dir) {
  const out = {}
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (['node_modules', '.git', 'dist', '.DS_Store', '.figma-make-sync.json'].includes(e.name) || e.name.startsWith('.env')) continue
      if (unmanaged(r)) continue
      if (e.isDirectory()) walk(r)
      else if (e.isFile()) out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, r))).digest('hex')
    }
  }
  walk('')
  return out
}
function git(dir, args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim() }
const isGit = dir => fs.existsSync(path.join(dir, '.git'))

function tarBase64(dir) {
  const args = ['-czf', '-', ...EXCLUDES.flatMap(e => ['--exclude', e]), '-C', dir, '.']
  return execFileSync('tar', args, { maxBuffer: 1 << 30, env: { ...process.env, COPYFILE_DISABLE: '1' } }).toString('base64')
}

async function push(tab, dir, { del = false, force = false } = {}) {
  dir = path.resolve(dir)
  const st = readState(dir)
  if (st && !force) {
    const fp = await remoteFingerprint(tab)
    if (fp !== st.fingerprint) throw new Error('Make changed since your last sync (edits in the browser?). Run pull first, or push --force to overwrite them.')
  } else if (!st && !force) {
    console.log('push: no sync record yet — pushing and recording one (pull first next time to be safe)')
  }
  // Delta push: hash every file on both sides and only send what differs (binaries never round-trip).
  const remote = await remoteHashes(tab)
  const local = localHashes(dir)
  const changed = Object.keys(local).filter(f => local[f] !== remote[f])
  const gone = del ? Object.keys(remote).filter(f => !(f in local)) : []
  if (!changed.length && !gone.length) { console.log('push: sandbox already matches, nothing to send'); writeState(dir, tab, await remoteFingerprint(tab)); return }
  // Write through Make's own file system (the code editor's path): persisted and committed by Make,
  // no terminal transfer, no save trick, and the user's view never changes.
  const BIN = /\.(png|jpe?g|gif|webp|avif|ico|mp4|webm|mov|woff2?|ttf|otf|pdf)$/i
  console.log(`push: ${changed.length} changed, ${gone.length} deleted: ${[...changed, ...gone].slice(0, 8).join(', ')}${changed.length + gone.length > 8 ? ' …' : ''}`)
  let batch = [], size = 0
  const flush = async () => {
    if (!batch.length) return
    await page(tab, `const fs = makeFs(); for (const op of ${JSON.stringify(batch)}) {
      if (op.del) await fs.deleteFile(op.path)
      else if (op.b64) await fs.writeBinaryFile(op.path, Uint8Array.from(atob(op.b64), c => c.charCodeAt(0)))
      else await fs.writeFile(op.path, op.text)
    } return true`)
    batch = []; size = 0
  }
  for (const f of changed) {
    const buf = fs.readFileSync(path.join(dir, f))
    const op = BIN.test(f) ? { path: '/' + f, b64: buf.toString('base64') } : { path: '/' + f, text: buf.toString('utf8') }
    batch.push(op); size += (op.b64 || op.text).length
    if (size > 4e6) await flush()
  }
  for (const f of gone) batch.push({ path: '/' + f, del: true })
  await flush()
  console.log('push: written through Make (persisted)')
  await new Promise(r => setTimeout(r, 2000)) // let the sandbox catch up before fingerprinting
  writeState(dir, tab, await remoteFingerprint(tab))
}

async function pull(tab, dir, { force = false } = {}) {
  dir = path.resolve(dir)
  fs.mkdirSync(dir, { recursive: true })
  if (isGit(dir) && !force && git(dir, ['status', '--porcelain'])) throw new Error('local folder has uncommitted changes — commit or stash first (or pull --force)')
  const target = dir
  // Delta pull: compare hashes, fetch changed binaries raw over the preview's HTTP server,
  // and send only changed text files through the terminal.
  const remote = await remoteHashes(tab)
  const local = localHashes(target)
  const changed = Object.keys(remote).filter(f => remote[f] !== local[f])
  const gone = Object.keys(local).filter(f => !(f in remote))
  console.log(`pull: ${changed.length} changed, ${gone.length} removed in Make`)
  for (let k = 0; k < changed.length; k += 20) {
    const files = await page(tab, `const fs = makeFs(); const out = {}
      for (const f of ${JSON.stringify(changed.slice(k, k + 20))}) {
        const e = await fs.fetchEntry('/' + f); let c = e.asyncContents; if (c && c.then) c = await c
        if (typeof c === 'string') { out[f] = { text: c }; continue }
        let bin = ''; for (let i = 0; i < c.length; i += 0x8000) bin += String.fromCharCode(...c.subarray(i, i + 0x8000))
        out[f] = { b64: btoa(bin) }
      }
      return out`)
    for (const [f, v] of Object.entries(files)) {
      const buf = v.b64 != null ? Buffer.from(v.b64, 'base64') : Buffer.from(v.text, 'utf8')
      if (crypto.createHash('sha256').update(buf).digest('hex') !== remote[f]) throw new Error(`pull: ${f} doesn't match Make's hash`)
      fs.mkdirSync(path.dirname(path.join(target, f)), { recursive: true })
      fs.writeFileSync(path.join(target, f), buf)
    }
  }
  for (const f of gone) fs.rmSync(path.join(target, f), { force: true })
  writeState(target, tab, await remoteFingerprint(tab))
  if (isGit(target)) {
    const changes = git(target, ['status', '--porcelain'])
    if (changes) {
      git(target, ['add', '-A'])
      git(target, ['commit', '-qm', `Sync from Make (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`])
      console.log('pull: changes from Make committed:\n' + git(target, ['show', '--stat', '--format=', 'HEAD']))
    } else console.log('pull: already in sync, nothing changed in Make')
  } else console.log('pull: done')
}

// Make persists sandbox changes when an editor edit triggers a save. Open a file in the
// code editor and append+remove a newline.
async function save(tab) {
  // Make sure some file is open in the code editor; the tree needs a trusted click.
  await focusTab(tab, 'files')
  const pos = await page(tab, `
    const el = document.querySelector('.cm-content'); if (el && el.cmView) return null
    const filesTab = [...document.querySelectorAll('button, [role=tab]')].find(b => /^Files$/.test(b.textContent.trim()))
    if (filesTab) { press(filesTab); await sleep(1200) }
    else { const plus = document.querySelector('button[aria-label="Add workspace tab"]'); if (plus) { press(plus); await sleep(500); const it = [...document.querySelectorAll('[role=menuitem]')].find(e => e.textContent.trim() === 'Files'); if (it) { press(it); await sleep(1500) } } }
    const item = [...document.querySelectorAll('[role=treeitem]')].find(e => /^package\\.json$/.test((e.getAttribute('aria-label') || e.innerText.split('\\n')[0]).trim()))
    if (!item) return 'none'
    const r = item.getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }`)
  if (pos === 'none') throw new Error('could not find package.json in the file tree; open any file in the code editor and retry')
  if (pos) { await click(tab, pos.x, pos.y); await new Promise(r => setTimeout(r, 1500)) }
  const res = await page(tab, `
    const getView = () => { const el = document.querySelector('.cm-content'); return el && el.cmView && el.cmView.view }
    let v = getView()
    if (!v) {
      const filesTab = [...document.querySelectorAll('button, [role=tab]')].find(b => /^Files$/.test(b.textContent.trim()))
      if (filesTab) { press(filesTab); await sleep(1200) }
      else {
        const plus = document.querySelector('button[aria-label="Add workspace tab"]')
        if (plus) { press(plus); await sleep(500); const it = [...document.querySelectorAll('[role=menuitem]')].find(e => e.textContent.trim() === 'Files'); if (it) { press(it); await sleep(1500) } }
      }
      const item = [...document.querySelectorAll('[role=treeitem]')].find(e => /package\\.json/.test(e.getAttribute('aria-label') || e.textContent))
      if (!item) throw new Error('could not find package.json in the file tree; open any file in the code editor and retry')
      press(item)
      await sleep(1500); v = getView()
      if (!v) throw new Error('editor did not open; open any file in the code editor and retry')
    }
    const n = v.state.doc.length
    v.dispatch({ changes: { from: n, insert: '\\n' }, userEvent: 'input.type' })
    await sleep(600)
    v.dispatch({ changes: { from: n, to: n + 1, insert: '' }, userEvent: 'delete' })
    return 'saved'`)
  console.log('save: triggered (give Make ~20s before reloading)')
  await focusTab(tab, 'browser')
  return res
}

export { page, sandboxRun, push, pull, save, exec }

if (import.meta.url === `file://${process.argv[1]}`) {
const [cmd, tab, a, ...rest] = process.argv.slice(2)
try {
  if (cmd === 'exec') await exec(tab, a)
  else if (cmd === 'push') await push(tab, a, { del: rest.includes('--delete'), force: rest.includes('--force') })
  else if (cmd === 'pull') await pull(tab, a, { force: rest.includes('--force') })
  else if (cmd === 'save') await save(tab)
  else { console.error('usage: make-sync.mjs exec|push|pull|save <tab> [...]'); process.exitCode = 1 }
} catch (e) { console.error('make-sync:', e.message); process.exitCode = 1 }
}
