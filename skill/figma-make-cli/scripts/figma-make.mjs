#!/usr/bin/env node
// figma-make — drive Figma Make files from the shell (browser extension + bridge, or Figma desktop over CDP).
// Local LLM writes code, Make keeps the live preview; no Make AI credits are spent.
import { targets, evaluate, screenshot, click } from './cdp.mjs'
import fs from 'node:fs'
import { exec, push, pull, save } from './make-sync.mjs'
import { execFileSync } from 'node:child_process'

const HELP = `figma-make <command>

  status                         check the desktop debug port and list open Make files
  launch                         (re)start Figma desktop with --remote-debugging-port=9222
  open <make-url>                open a Make file in Figma desktop
  exec <file> "<cmd>"            run a shell command in the file's sandbox (cwd = project root)
  pull <file> <dir> [--force]    sync Make → <dir>; in a git repo refuses if dirty, then commits "Sync from Make"
  push <file> <dir> [--delete] [--force]  <dir> → Make (changed files only, persisted); refuses if Make changed since last sync
  save <file>                    legacy: persist raw terminal writes in the sandbox
  reload <file>                  reload the Make tab (sandbox rebuilds from the saved state)
  preview <file> [out.png]       show the Browser (preview) tab and save a screenshot
  baseline <dir>                 snapshot the live preview (do this right after push, before GUI edits)
  pending <dir>                  diff the live preview vs baseline → un-applied Edit-mode changes (JSON)
  kit-add <file> <pkg>@<ver>     add a Make kit (or any npm dep) to package.json, save, reload
  bridge                         run the local daemon for the Chrome extension (browser-only mode, foreground)
  link <file-key> <dir>          map a Make file to its local folder for the bridge (~/.config/figma-make/bridge.json)

<file> = any substring of the Make tab title or URL; the file key is safest.
FIGMA_MAKE_VIA=ext → talk to Make in Chrome through the bridge + extension instead of Figma desktop.`

const wait = ms => new Promise(r => setTimeout(r, ms))
import path from 'node:path'

// Snapshot of the live preview: own text, classes and inline style per element, keyed by a DOM path.
const SNAP_JS = `(() => {
  const out = {}
  const pathOf = el => { const parts = []; for (let n = el; n && n !== document.body; n = n.parentElement) { const i = n.parentElement ? [...n.parentElement.children].indexOf(n) : 0; parts.unshift(n.tagName.toLowerCase() + ':' + i) } return parts.join('>') }
  for (const el of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'svg', 'path'].includes(el.tagName)) continue
    if (el.closest('[data-h2d-ignore], [data-html-editor-overlay]')) continue // Make's Edit-mode inspector UI
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\\s+/g, ' ').trim()
    out[pathOf(el)] = { tag: el.tagName.toLowerCase(), text: own, cls: el.getAttribute('class') || '', style: el.getAttribute('style') || '', src: el.getAttribute('src') || '' }
  }
  return { route: location.pathname, nodes: out }
})()`

function snapPath(dir) { return path.join(path.resolve(dir), '.git', 'figma-make-preview.json') }

async function baseline(dir) {
  const snap = await evaluate('@preview', SNAP_JS)
  fs.writeFileSync(snapPath(dir), JSON.stringify(snap))
  console.log(`baseline: ${Object.keys(snap.nodes).length} preview elements recorded on route ${snap.route}`)
}

async function pending(dir) {
  const base = JSON.parse(fs.readFileSync(snapPath(dir), 'utf8'))
  const now = await evaluate('@preview', SNAP_JS)
  if (now.route !== base.route) console.log(`note: preview is on ${now.route}, baseline was taken on ${base.route} — navigate back for an exact diff`)
  const changes = []
  for (const [k, n] of Object.entries(now.nodes)) {
    const b = base.nodes[k]
    if (!b) { if (n.text) changes.push({ kind: 'added', tag: n.tag, text: n.text, cls: n.cls }); continue }
    for (const f of ['text', 'cls', 'style', 'src']) if (n[f] !== b[f]) changes.push({ kind: f, tag: n.tag, from: b[f], to: n[f], context: b.text || b.cls.slice(0, 80) })
  }
  for (const [k, b] of Object.entries(base.nodes)) if (!now.nodes[k] && b.text) changes.push({ kind: 'removed', tag: b.tag, text: b.text })
  console.log(JSON.stringify({ route: now.route, changes }, null, 2))
  if (!changes.length) console.log('no pending visual changes found in the desktop preview')
}

const [cmd, ...args] = process.argv.slice(2)

async function status() {
  try {
    const ts = await targets()
    const makes = ts.filter(t => t.url.includes('/make/'))
    const via = process.env.FIGMA_MAKE_VIA === 'ext' ? 'bridge + extension' : 'desktop debug port'
    console.log(`${via}: OK (${ts.length} tabs)`)
    for (const t of makes) console.log(`  ${t.url.match(/make\/([^/]+)/)[1]}  ${t.title}`)
    if (!makes.length) console.log('  no Make files open — use: figma-make open <url>')
  } catch (e) {
    console.log(process.env.FIGMA_MAKE_VIA === 'ext' ? `bridge + extension: NOT reachable — ${e.message}` : 'desktop debug port: NOT reachable — run: figma-make launch')
    process.exitCode = 1
  }
}

function launch() {
  try { execFileSync('osascript', ['-e', 'quit app "Figma"']) } catch {}
  execFileSync('sh', ['-c', 'sleep 3; pkill -x Figma || true; sleep 1; ("/Applications/Figma.app/Contents/MacOS/Figma" --remote-debugging-port=9222 >/tmp/figma-desktop.log 2>&1 &)'])
  console.log('Figma desktop relaunching with the debug port (give it ~10s). If the port stays closed, run once: figma-use patch')
}

async function reload(tab) {
  await evaluate(tab, 'setTimeout(() => location.reload(), 100), "ok"')
  await wait(20000)
  console.log('reloaded')
}

async function kitAdd(tab, spec) {
  const at = spec.lastIndexOf('@')
  const [name, ver] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, 'latest']
  await exec(tab, `node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json"));p.dependencies=p.dependencies||{};p.dependencies[process.argv[1]]=process.argv[2];fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\\n")' ${JSON.stringify(name)} ${JSON.stringify(ver.startsWith('^') || ver === 'latest' ? ver : '^' + ver)} && grep -F ${JSON.stringify(name)} package.json`)
  await save(tab)
  await wait(20000)
  await reload(tab)
  await exec(tab, `ls node_modules/${name} >/dev/null 2>&1 && echo "installed ${name}" || echo "not installed yet — Make installs on package.json change; check again shortly"`)
}

try {
  if (cmd === 'status') await status()
  else if (cmd === 'launch') launch()
  else if (cmd === 'open') { execFileSync('open', ['-a', 'Figma', args[0]]); await wait(10000); await status() }
  else if (cmd === 'exec') await exec(args[0], args[1])
  else if (cmd === 'pull') await pull(args[0], args[1], { force: args.includes('--force') })
  else if (cmd === 'push') await push(args[0], args[1], { del: args.includes('--delete'), force: args.includes('--force') })
  else if (cmd === 'save') await save(args[0])
  else if (cmd === 'reload') await reload(args[0])
  else if (cmd === 'preview') {
    const pos = await evaluate(args[0], `(()=>{const b=[...document.querySelectorAll('button,[role=tab]')].find(e=>/^(Browser)+$/.test(e.textContent.trim())&&e.getBoundingClientRect().top<40);if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    if (pos) await click(args[0], pos.x, pos.y)
    await wait(Number(process.env.PREVIEW_WAIT || 6000))
    const out = args[1] || `/tmp/figma-make-preview-${Date.now()}.png`
    fs.writeFileSync(out, await screenshot(args[0]))
    console.log(out)
  }
  else if (cmd === 'baseline') await baseline(args[0])
  else if (cmd === 'pending') await pending(args[0])
  else if (cmd === 'kit-add') await kitAdd(args[0], args[1])
  else if (cmd === 'bridge') await import('./bridge.mjs') // keeps running in the foreground
  else if (cmd === 'link') {
    const [key, dir] = args
    if (!key || !dir) throw new Error('usage: figma-make link <file-key> <dir>')
    const conf = path.join(process.env.HOME, '.config', 'figma-make', 'bridge.json')
    fs.mkdirSync(path.dirname(conf), { recursive: true })
    const c = fs.existsSync(conf) ? JSON.parse(fs.readFileSync(conf, 'utf8')) : { files: {} }
    c.files = { ...c.files, [key]: path.resolve(dir) }
    fs.writeFileSync(conf, JSON.stringify(c, null, 2) + '\n')
    console.log(`linked ${key} → ${path.resolve(dir)} (${conf})`)
  }
  else { console.log(HELP); if (cmd && cmd !== 'help') process.exitCode = 1 }
} catch (e) {
  console.error('figma-make:', e.message)
  process.exitCode = 1
}
