---
name: figma-make-cli
description: Build Figma Make apps with a local LLM instead of Make's AI (no Make credits) while keeping Make's live preview. Pushes/pulls code between a local folder and a Make file through Make's own file system (via a browser extension + local bridge, or the Figma desktop app over CDP), runs shell commands in the sandbox, turns Edit-mode GUI changes into code (/mupdate), installs Make kits and screenshots the preview. Use when the user wants to work on a Figma Make file locally, sync code into/out of Make, avoid Make AI credits, use a Make kit from code, or mentions figma-make / make-sync / "push to Make".
---

# figma-make-cli

`figma-make` (symlinked in `~/.local/bin`, source in `scripts/`) moves code between a local
folder and a Figma Make file. It talks to Make either through the browser extension + `figma-make bridge`
(`FIGMA_MAKE_VIA=ext`, see Browser-only mode) or the Figma desktop app over CDP (default). File contents
never pass through the LLM context and Make's AI is never used.

## Setup (desktop mode; for browser-only mode see below)

```bash
figma-make status        # port OK + open Make files with their keys
figma-make launch        # if the port is closed: relaunch Figma desktop with --remote-debugging-port=9222
figma-make open "https://www.figma.com/make/<KEY>/<name>"   # open the Make file in desktop
```
If the port never opens, run `figma-use patch` once (Figma 126+ blocks the flag; see figma-use-cli skill).
Close the same Make file in any browser tab so only the desktop client edits it.

## Commands (`<file>` = Make file key, or any substring of its tab title/URL)

| Command | What it does |
|---|---|
| `exec <file> "<cmd>"` | Run a shell command in the sandbox (cwd = project root, proxy CA exported). Prints output, returns exit code. |
| `pull <file> <dir> [--force]` | Make → `<dir>`: sha256 delta read through Make's file system, commits "Sync from Make". Refuses if `<dir>` has uncommitted changes. |
| `push <file> <dir> [--delete] [--force]` | `<dir>` → Make: writes only changed files through Make's file system (persisted, no save needed). `--delete` removes files missing locally. Refuses if Make changed since the last sync. |
| `save <file>` | Legacy: persist raw terminal writes in the sandbox (only needed after `exec` wrote files). |
| `reload <file>` | Reload the tab; the sandbox rebuilds from the saved state (use to verify persistence). |
| `preview <file> [out.png]` | Switch to the Browser tab and screenshot the live preview. `PREVIEW_WAIT=ms` to wait longer. |
| `baseline <dir>` | Snapshot the live preview (text/classes/styles per element) into `.git/figma-make-preview.json`. Take it right after a push. |
| `pending <dir>` | Diff the live preview vs the baseline → JSON of un-applied Edit-mode changes to implement in code for free. |
| `bridge` | Run the local daemon the browser extension talks to (chat overlay, Apply interception, `FIGMA_MAKE_VIA=ext`). |
| `kit-add <file> <pkg>@<ver>` | Add a Make kit/npm dep to package.json, save, reload; Make's installer fetches it. |

## Typical loop

```bash
figma-make pull KEY ~/make-apps/app      # first time: get Make's scaffold (vite.config, .figma/make/*)
# ...edit locally with your LLM...
figma-make push KEY ~/make-apps/app
figma-make preview KEY /tmp/p.png        # look at it
```

## How Make actually works (learned the hard way)

- **Persistence:** terminal/sandbox writes are NOT saved by themselves. Make snapshots the whole
  sandbox when an editor edit happens. `save` opens a file in the code editor (trusted CDP click)
  and types+deletes a newline. Give it ~20s before reloading. A reload without a save loses everything.
- **Fresh Make file** shows only the prompt screen. The CLI opens the workspace via
  Settings → "Access code editor" (no AI prompt needed).
- **Network:** sandbox egress goes through a Cloudflare proxy. Node needs
  `NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/cloudflare-containers-ca.crt` (exec sets it).
  npm, GitHub and most hosts work; api.anthropic.com is blocked ("520 origin is disallowed") —
  so the LLM must run locally, which is the point of this tool.
- **Private kits:** `@make-kits/*` lives on registry.figma.com; the token is only given to Make's
  own installer. Don't `pnpm add` a kit — put it in package.json (`kit-add`); `.figma/make/dev.json`
  makes any package.json change trigger the installer.
- **Make owns `src/index.ts` in kit files** (regenerated on publish). Put extra exports in another
  entry (e.g. `src/blocks.ts`) and publish with "Use default package configurations" unchecked.
- **Kit publish builds from the saved state** in a separate workspace — save before publishing.
- Terminal UI: menus accept synthetic pointer events; the file tree and workspace tabs need
  trusted clicks (`cdp.mjs` → `click()` uses `Input.dispatchMouseEvent`).
- **Sync goes through Make's own file system service**, the object the code editor writes with
  (a React context value with `writeFile`/`writeBinaryFile`/`deleteFile`/`fetchEntry`/
  `deprecatedGetFilePaths`; `makeFs()` in make-sync finds it). Writes are persisted and committed by
  Make ("fs write"), so push/pull/hash need no terminal, no save trick and never change the user's tab.
  Paths are `/src/App.tsx`; `fetchEntry(p).asyncContents` → string (text) or Uint8Array (binary).
  Make's scaffolding (.figma/make/*, dotfiles, lockfile, AGENTS/CLAUDE.md) isn't in it — leave it alone.
  Push/pull are deltas by sha256 (pull of an unchanged project ≈ 0.1 s).
- Binaries can also be fetched raw over HTTP from the preview (Vite serves `/src/...`).
- **Terminal (only `exec` uses it now). One terminal only.** Workspace tabs ignore synthetic clicks, and xterm is only findable while visible,
  so `sandboxRun` trusted-clicks the existing terminal tab (`focusTab`) before ever adding one; `save` does
  the same for Files. Each command starts with Ctrl-U so stray input (e.g. `secho`) can't break it.
  If a sandbox shell drops ("Connection restored"), kill the hung CLI run and retry. Don't stack runs.
- Regexes inside the in-page JS template strings need `\\s`, not `\s` (it silently becomes `s`).
- Each `exec` opens/reuses a Terminal tab; markers are split (`__MS_E""_id__`) so the echoed
  command line is never mistaken for output; stderr of `tail` must be silenced in pulls.

## Sync safety and GUI round-trips (`/mupdate`)

- Keep the local folder a git repo. `pull` refuses when it's dirty, mirrors Make (rsync --delete,
  keeping .git/node_modules/.env/dist) and commits "Sync from Make". `push` stores a sandbox
  fingerprint in `.git/figma-make-sync.json` and refuses if Make changed since (`--force` overrides).
- Make Edit-mode changes sit in a tray until Apply (Apply = AI credits). The preview iframe is its own
  CDP target (`@preview`, url contains `makeproxy`), and pending edits render there live — so
  `baseline` after push + `pending` later yields the exact text/class/style diffs to implement locally.
  Over CDP only the desktop preview is reachable; browser-tab edits need browser-only mode (below).
- `/mupdate` (~/.claude/commands/mupdate.md) runs the whole loop: pull → pending → edit code →
  tsc → commit → push → baseline → tell the user to Discard the tray.
- Elements under any library-rendered component (`motion.*` from MotionPreset) are locked in Edit mode,
  even children from your own file. Remove those wrappers for anything that must be GUI-editable.

## Browser-only mode (extension + bridge)

Work in Chrome on `figma.com/make/<KEY>` with no Figma desktop app (design: `BRIDGE-SPEC.md`).

- **Setup:** load `extension/` unpacked in `chrome://extensions` (Developer mode), then run
  `figma-make bridge` (foreground daemon on `127.0.0.1:47123`, logs one line per event). Open the Make file.
  `install.sh --service` installs it as a macOS login service instead: `~/Library/LaunchAgents/com.figma-make.bridge.plist`
  (KeepAlive; log `~/Library/Logs/figma-make-bridge.log`; restart with `launchctl kickstart -k
  gui/$(id -u)/com.figma-make.bridge` after editing bridge.mjs). Its env needs USER/LOGNAME or
  `claude` can't read its keychain login ("OAuth session expired"), and PATH with /opt/homebrew/bin first.
  The extension reconnects every 2s, so start order doesn't matter. Extension edits: `reload` rpc
  (`POST /rpc {"method":"reload"}`) reloads it without touching chrome://extensions.
- **Config** `~/.config/figma-make/bridge.json`: `{ "files": { "<KEY>": "<local dir>" } }` (created empty). Unknown keys get an error in the overlay.
  Claude session ids per file live in `sessions.json` next to it (delete an entry for a fresh chat).
  `"skipPermissions": true` in it runs Claude with `--dangerously-skip-permissions` (headless runs can't
  ask for approval; without it anything outside figma-make/pnpm/git/ls/cat gets blocked).
- **Chat overlay** covers Make's AI chat: messages run local `claude -p` in the file's dir (resumed
  session, edits auto-accepted, Bash limited to figma-make/pnpm/git/ls/cat) and stream back. One run per
  file; Stop kills it. "Show Make AI" reveals Make's own chat.
- **Apply interception:** clicking **Apply** in the change tray runs `/mupdate` locally instead of Make AI;
  if Claude ends with `MUPDATE_OK` (committed + pushed) the extension clicks **Discard**. Alt-click = real
  Make Apply (spends credits). With the bridge offline the click goes through to Make.
- **CLI:** `FIGMA_MAKE_VIA=ext figma-make …` routes every command through the bridge to the Chrome tab
  (the bridge sets it for its own Claude runs). `pending` then reads the Chrome preview, so browser edits
  are visible.

- **Selection as context:** `extension/selection.js` (page world) reads selected Elements-panel rows —
  their React props carry `node.{id: 'fge-N', displayName, definitionFilePath}` — and the overlay shows
  them as blue chips. Chat messages carry them; the bridge looks up `[data-fge-id]` in the preview and
  prepends file + tag/classes/text/HTML so "make this black" resolves to the exact element.

## Lessons: building a nice, GUI-editable Make app from shadcn/studio blocks

- **Eject blocks as source, don't import them from a kit package.** Many blocks hard-code their copy
  (hero headlines, nav links). To change text/images you need the source in `src/`. Run the shadcn
  CLI locally in the pulled project (`components.json` with the @ss-* registries, `.env` with
  EMAIL/LICENSE_KEY — never push `.env`), then push. Drop `@make-kits/*` deps locally: the private
  registry 401s on the Mac.
- **Stack:** keep Make's native scaffold — Vite 8 + React 19 + TS 5.7 + Tailwind v4 via
  `@tailwindcss/vite`, pnpm, `@/` → `./src`, `src/main.tsx` → `src/App.tsx` + `src/index.css`.
  Pull first so you keep Make's `vite.config.ts` and `.figma/make/*`.
- **Stock styling:** the CLI may not write theme vars. Add the stock shadcn neutral `:root` oklch
  tokens + `@theme inline` colour/radius mapping + `@layer base` yourself, and load Geist. Custom
  colour themes on top of stock blocks look off — default theme + good copy looks best.
- **Check deps after `shadcn add`:** compare bare imports vs package.json (e.g. `@base-ui/react`,
  `class-variance-authority` were missing). Newer styles import `cn` from the `cn` package — fine.
  Wrap the app in `TooltipProvider` when tooltip is installed.
- **Pick blocks by fit**, not first variant: read `description` in the registry JSON and the demo
  page (`registry:page` file) to see props. Prefer blocks whose content comes in as props.
- **Remove or replace stock imagery** (shadcn product mockups, food photos). For fast images use
  Unsplash at low res (`?w=900&q=60&auto=format`); verify each URL returns 200 and eyeball a contact
  sheet before using. Stock heroes often hide images below `lg` (`max-lg:hidden`) — make them stack.
- **Flip/rotating-word heroes** have a fixed-width box: use short single words (no hyphens).
- **Make Edit mode locks** any element rendered by a component in `node_modules` (e.g. `MotionPreset
  component='p'` renders `motion.p`). Fix: keep `MotionPreset` as an animation wrapper only and put
  `className`/tag on a plain child element written in your file. Then text/layout is editable.
- **Layer names in Make's Elements panel = React component names** (+ `tag .classes` for DOM).
  Give every block a descriptive const name (`SiteHeader`, `HeroSection`, `ServicesGrid`,
  `PricingPlan`, `SiteFooter`, `NotFoundPage`) and make each route a named component
  (`HomePage`, `ServicesPage`…). Rename only the `const X =` and `export default X` lines —
  a blind word replace also rewrites visible copy (e.g. a "Pricing" badge).
- **Edit-mode changes cost AI credits on Apply** (Figma docs). Pending GUI edits live in a change tray,
  not in the files — `exec 'grep …'` to check. Do copy edits in code and push for free; tell the user to
  Discard stale pending changes after a push.
- **Make chat panel can't be hidden**, only resized to a minimum; use ▶ Preview for a chat-free view.
- **Figma desktop restarted without the port** → `figma-make launch`, then `figma-make open <url>`.
  Opening a file already open creates a second tab; that's harmless.
- Type-check locally (`pnpm exec tsc --noEmit -p .`) before every push — the preview gives no clear error.

## Never

- Paste licence keys, registry tokens or OAuth tokens through this tool; ask the user to type them
  in the Make terminal themselves.
- Extract Make's sandbox credentials (git extraheader, FIGMA_NPM_TOKEN) for use outside the sandbox.
- Push to a Make file someone else is actively editing.
