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
  doctor [--skip-claude]         check the whole browser-mode setup and say what to fix

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

// Checks every piece of browser mode in order and prints the fix for each failure (exit 1 if any).
async function doctor({ skipClaude = false } = {}) {
  const home = process.env.HOME
  const BRIDGE = `http://127.0.0.1:${process.env.FIGMA_MAKE_BRIDGE_PORT || 47123}`
  let fails = 0
  const ok = m => console.log(`  ✓ ${m}`)
  const bad = (m, fix) => { fails++; console.log(`  ✗ ${m}${fix ? `\n      → ${fix}` : ''}`) }
  const warn = (m, fix) => console.log(`  ! ${m}${fix ? `\n      → ${fix}` : ''}`)
  const which = c => { try { return execFileSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).trim() } catch { return '' } }
  const get = async u => { try { const r = await fetch(BRIDGE + u, { signal: AbortSignal.timeout(100000) }); return await r.json() } catch { return null } }
  const rpc = async (method, params = {}) => { try { const r = await fetch(BRIDGE + '/rpc', { method: 'POST', body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(60000) }); return await r.json() } catch (e) { return { ok: false, error: e.message } } }

  console.log('Tools')
  const major = +process.versions.node.split('.')[0]
  major >= 22 ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node} (need 22+)`, 'install Node.js 22 or newer')
  which('git') ? ok('git') : bad('git not found', 'install git')
  which('claude') ? ok(`claude (${which('claude')})`) : bad('claude not found', 'install Claude Code and log in: https://claude.com/claude-code')
  which('pnpm') ? ok('pnpm') : warn('pnpm not found (needed to type-check Make projects)', 'npm i -g pnpm')

  console.log('Install')
  const skill = path.join(home, '.claude/skills/figma-make-cli/SKILL.md')
  fs.existsSync(skill) ? ok('skill ~/.claude/skills/figma-make-cli') : bad('skill not installed', 'run ./install.sh in the repo')
  fs.existsSync(path.join(home, '.claude/commands/mupdate.md')) ? ok('/mupdate command') : bad('/mupdate command missing', 'run ./install.sh in the repo')
  ;(process.env.PATH || '').split(':').includes(path.join(home, '.local/bin')) ? ok('~/.local/bin on PATH') : warn('~/.local/bin is not on PATH', 'add it to your shell profile')
  if (process.platform === 'darwin') {
    fs.existsSync(path.join(home, 'Library/LaunchAgents/com.figma-make.bridge.plist')) ? ok('bridge login service installed') : warn('bridge login service not installed', 'run ./install.sh --service, or keep `figma-make bridge` running yourself')
  }

  console.log('Config')
  const confPath = path.join(home, '.config/figma-make/bridge.json')
  let conf = null; try { conf = JSON.parse(fs.readFileSync(confPath, 'utf8')) } catch {}
  const files = conf?.files || {}
  if (!conf) bad(`${confPath} missing or invalid`, 'run ./install.sh, then figma-make link <make-file-key> <dir>')
  else if (!Object.keys(files).length) bad('no Make file linked', 'figma-make link <make-file-key> <local-dir>  (key = id in figma.com/make/<key>/…)')
  for (const [key, d] of Object.entries(files)) {
    const dir = path.resolve(d.replace(/^~(?=\/|$)/, home))
    if (!fs.existsSync(dir)) bad(`${key} → ${dir} (folder missing)`, `mkdir -p ${dir} && cd ${dir} && git init`)
    else if (!fs.existsSync(path.join(dir, '.git'))) warn(`${key} → ${dir} (not a git repo; pull/push safety needs one)`, `cd ${dir} && git init`)
    else ok(`${key} → ${dir}`)
  }
  if (conf) console.log(`  · skipPermissions: ${conf.skipPermissions === true ? 'on (Claude runs every command without asking)' : 'off (Bash limited to figma-make/pnpm/git/ls/cat)'}`)

  console.log('Bridge')
  const st = await get('/')
  if (!st?.ok) { bad(`bridge not reachable at ${BRIDGE}`, 'start it: figma-make bridge   (or ./install.sh --service on macOS)'); return finish() }
  ok('bridge running')
  if (st.duplicateExtension) bad('two copies of the extension are installed (they keep replacing each other)', 'chrome://extensions: remove every "Figma Make Bridge" card, then Load unpacked once from skill/figma-make-cli/extension')
  st.ext ? ok('extension connected') : bad('extension not connected', 'load skill/figma-make-cli/extension unpacked in chrome://extensions (Developer mode), then reload the Make tab')
  if (!skipClaude) {
    const t = await get('/selftest')
    t?.ok ? ok(`claude answers from the bridge${t.model ? ` (${t.model})` : ''}`) : bad(`claude fails when run by the bridge: ${t?.error || 'no answer'}`, 'run `claude` once in a terminal to log in; for the service re-run ./install.sh --service (sets USER/LOGNAME/PATH)')
  }
  if (!st.ext) return finish()

  console.log('Make (through the extension)')
  const tabs = (await rpc('list'))?.result || []
  if (!tabs.length) { bad('no Make tab open', 'open https://www.figma.com/make/<key>/… in the browser with the extension'); return finish() }
  for (const t of tabs) {
    const key = (t.url.match(/\/make\/([^/?#]+)/) || [])[1] || '?'
    const linked = key in files
    ;(linked ? ok : warn)(`tab ${key}${linked ? '' : ' (not linked: figma-make link ' + key + ' <dir>)'}${/fullscreen=1/.test(t.url) ? ' — fullscreen preview, open it without fullscreen=1' : ''}`)
    const fsr = await rpc('evaluate', { tabId: t.tabId, frame: 'top', expression: `(() => { for (const el of document.querySelectorAll('div')) for (const k of Object.keys(el)) if (k.startsWith('__reactFiber')) for (let f = el[k], j = 0; j < 60 && f; j++, f = f.return) { const v = f.memoizedProps && f.memoizedProps.value; if (v && typeof v.writeFile === 'function' && typeof v.deprecatedGetFilePaths === 'function') return v.deprecatedGetFilePaths().length } return -1 })()` })
    fsr?.ok && fsr.result > 0 ? ok(`Make file system reachable (${fsr.result} files)`) : bad(`Make file system not found${fsr?.error ? ': ' + fsr.error : ''}`, 'open the Make file normally (workspace visible, not fullscreen) and wait for it to load')
    const pv = await rpc('evaluate', { tabId: t.tabId, frame: 'preview', expression: `document.querySelectorAll('[data-fge-id]').length` })
    pv?.ok && pv.result > 0 ? ok(`preview reachable (${pv.result} elements)`) : warn(`preview not reachable${pv?.error ? ': ' + pv.error : ''}`, 'show the Browser (preview) tab in Make; baseline/pending/selection context need it')
  }
  return finish()

  function finish() {
    console.log(fails ? `\n${fails} problem(s) — fix the ✗ items above and re-run figma-make doctor.` : '\nAll good.')
    if (fails) process.exitCode = 1
  }
}

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
  else if (cmd === 'doctor') await doctor({ skipClaude: args.includes('--skip-claude') })
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
