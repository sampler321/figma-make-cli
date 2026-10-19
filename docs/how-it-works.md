# How it works

## Pieces

| Piece | Runs in | Job |
|---|---|---|
| `extension/content.js` | Make tab (isolated world) | Claude panel (Shadow DOM), Apply interception, Discard click, selection chips |
| `extension/selection.js` | Make tab (page world) | Reads the Edit-mode selection from Make's Elements panel (React props) |
| `extension/background.js` | Extension service worker | WebSocket to the bridge; runs RPCs against the tab with `chrome.debugger` |
| `scripts/bridge.mjs` | Local daemon, `127.0.0.1:47123` | Routes chat/apply to `claude -p`; exposes `/rpc` for the CLI |
| `scripts/cdp.mjs` | CLI | Transport: Figma desktop over CDP, or `/rpc` on the bridge (`FIGMA_MAKE_VIA=ext`) |
| `scripts/make-sync.mjs` | CLI | pull / push / hashing through Make's file system; `exec` through Make's terminal |
| `scripts/figma-make.mjs` | CLI | Commands, preview snapshot/diff (`baseline`/`pending`) |

The extension ⇄ bridge protocol is specified in
[`BRIDGE-SPEC.md`](../skill/figma-make-cli/BRIDGE-SPEC.md). Briefly:

- The bridge sends the extension `rpc` messages (`list`, `evaluate`, `click`, `screenshot`, `reload`).
- The extension sends the bridge `chat` / `apply` / `stop`.
- The bridge streams `chat-delta` / `chat-tool` / `chat-done` back, and `discard` after a successful
  apply.

`evaluate` runs JavaScript in the Make page (`frame: 'top'`) or in the preview iframe
(`frame: 'preview'`). The preview is a cross-origin iframe, reached through
`Target.setAutoAttach` (iframes only). The debugger detaches after 15 s idle; staying attached to all
of Make's targets stalls its Edit mode.

## Make internals it relies on

These are undocumented and may change. They're all located defensively at runtime.

- **File system service.** A React context value in the Make page exposes `writeFile`,
  `writeBinaryFile`, `deleteFile`, `fetchEntry` and `deprecatedGetFilePaths`. Make's code editor
  writes through it. Writes are persisted and committed by Make (its sandbox git shows `fs write`
  commits). Paths look like `/src/App.tsx`; `fetchEntry(p).asyncContents` is a string (text) or a
  `Uint8Array` (binary). `makeFs()` in `make-sync.mjs` finds it by walking React fibers. All of
  push, pull and change detection use it, so syncing never touches Make's UI.
- **Sandbox terminal.** `exec` types into Make's xterm (found via React fibers) with split markers,
  so the echoed command isn't mistaken for output. Make keeps terminal tabs mounted while hidden, so
  commands run without switching tabs. A brand-new terminal does come to the front once.
- **Preview.** A Vite dev server on a `*.makeproxy-*.figma.site` origin. Every element carries
  `data-fge-id`. `baseline`/`pending` snapshot text, classes, inline styles and `src` per element
  (skipping Make's inspector overlay, `[data-h2d-ignore]`), so un-applied Edit-mode changes show up as
  a diff.
- **Elements panel.** Each row's React props carry `node = { id, displayName, definitionFilePath,
  children, … }`. DOM nodes have `fge-N` ids; component nodes have synthetic ids, so their first
  `fge` descendant locates them in the preview. Rows marked "locked" have `isEditBlocked`.
- **Change tray.** The Apply/Discard buttons sit together in the chat column. The extension blocks
  the click sequence on Apply in the capture phase (Alt passes through) and draws its badge in its own
  layer, never in Make's DOM.
- **Sandbox network.** Outbound traffic goes through a Cloudflare proxy (Node needs
  `NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/cloudflare-containers-ca.crt`; `exec` sets it).
  `api.anthropic.com` is blocked from the sandbox, which is why Claude has to run locally.

## Safety

- `push` stores a fingerprint of Make's files in `<dir>/.git/figma-make-sync.json` and refuses if Make
  changed since then, so edits made in Make are never overwritten. `--force` overrides.
- `pull` refuses if the local folder has uncommitted changes, and commits every sync.
- Claude commits each change, so `git revert` undoes anything.
- The bridge only listens on `127.0.0.1`. By default Claude runs with edits auto-accepted, but Bash is
  limited to `figma-make`, `pnpm`, `git`, `ls` and `cat`. `"skipPermissions": true` lifts all limits.
- Nothing extracts or reuses Make's credentials (the sandbox git token, the private npm registry token).
