# figma-make bridge: browser-only Make ⇄ local Claude Code

Goal: the user works ONLY in Chrome on figma.com/make/<KEY>. No Figma desktop app.
- Make's **Apply** button (Edit-mode change tray) is intercepted → local Claude Code implements the
  pending GUI edits in code (free), pushes, then the extension clicks **Discard**.
- A **Claude chat overlay** covers Make's left chat panel; messages go to local Claude Code
  (`claude -p`, resumed session per Make file), responses stream back into the overlay.
- The existing `figma-make` CLI (push/pull/exec/save/preview/baseline/pending) works through the
  extension instead of the desktop CDP port when `FIGMA_MAKE_VIA=ext`.

## Pieces
1. `extension/` — Chrome MV3 extension (load unpacked). Path: `~/.claude/skills/figma-make-cli/extension/`
2. `scripts/bridge.mjs` — local daemon, started with `figma-make bridge`.
3. `scripts/cdp.mjs` — gains an ext transport (same exported API).

## Transport: daemon ⇄ extension
Daemon listens on `127.0.0.1:47123`:
- `GET /ext` → WebSocket upgrade; the extension's background service worker connects here and
  reconnects every 2s when disconnected. Only one extension socket at a time (newest wins).
- `POST /rpc` (JSON `{method, params}`) → used by cdp.mjs; daemon forwards to the extension as an
  `rpc` message and responds `{ok:true,result}` or `{ok:false,error}` (HTTP 200 either way, 503 if no
  extension connected). Timeout from `params.timeout` ms (default 120000).

WebSocket messages (JSON):

Daemon → extension:
- `{type:'rpc', id, method, params}`
- `{type:'chat-delta', tabId, text}` — append streamed assistant text to the overlay
- `{type:'chat-tool', tabId, text}` — short tool-activity line, e.g. "Edit hero-section-09.tsx", "$ figma-make push…"
- `{type:'chat-done', tabId, ok, error?}`
- `{type:'discard', tabId}` — click the tray's Discard button (after a successful apply)

Extension → daemon:
- `{type:'hello', version}`
- `{type:'rpc-result', id, ok, result?, error?}`
- `{type:'chat', tabId, fileKey, text}` — user message from the overlay
- `{type:'apply', tabId, fileKey, trayItems:[string]}` — user clicked Apply (intercepted)
- `{type:'stop', tabId}` — user pressed Stop in the overlay (daemon kills the running claude)

RPC methods (implemented in the extension background with `chrome.debugger`, protocol "1.3"):
- `list` → `[{tabId, url, title}]` for tabs whose url matches `https://www.figma.com/make/*`
- `evaluate` `{tabId, frame:'top'|'preview', expression, timeout?}` → value
  (`Runtime.evaluate` with `awaitPromise:true, returnByValue:true`; exceptions → error with description).
  `frame:'preview'` = the Make preview iframe (url contains `makeproxy`). It is an out-of-process
  iframe: use `Target.setAutoAttach {autoAttach:true, flatten:true, waitForDebuggerOnStart:false}` on
  the tab and send commands with `chrome.debugger.sendCommand({tabId, sessionId}, …)` for the child
  target whose url contains `makeproxy`. If several, prefer the one most recently attached/visible.
- `click` `{tabId, x, y}` → trusted click via `Input.dispatchMouseEvent` mouseMoved/Pressed/Released (top frame, CSS px)
- `screenshot` `{tabId, frame}` → base64 PNG (`Page.captureScreenshot`)
Attach lazily (`chrome.debugger.attach({tabId}, '1.3')`) and stay attached; handle `onDetach`.

## cdp.mjs ext transport
If `process.env.FIGMA_MAKE_VIA === 'ext'`, the exported functions route via `POST /rpc`:
- `targets()` → `list` mapped to `{id: tabId, url, title, type:'page'}`
- `findTarget(match)`: `'@preview'` → `{tabId of the first make tab, frame:'preview'}`; else first tab whose url/title includes match.
- `evaluate(match, expr, {timeout})`, `click(match,x,y)`, `screenshot(match)` → same signatures and return types as today.
Keep the CDP-port behaviour unchanged when the env var isn't set. figma-make.mjs/make-sync.mjs must keep working unmodified on top of this (they only use those exports).

## Daemon behaviour (bridge.mjs)
- Config `~/.config/figma-make/bridge.json`: `{ "files": { "<makeFileKey>": "<abs local dir>" } }`.
  Created empty on first run. Unknown key → reply in chat with an
  error telling the user to add it.
- **chat**: spawn `claude -p <text> --output-format stream-json --include-partial-messages --verbose
  --permission-mode acceptEdits --allowedTools "Bash(figma-make:*)" "Bash(pnpm:*)" "Bash(git:*)" "Bash(ls:*)" "Bash(cat:*)" Read Edit Write Glob Grep
  --append-system-prompt <CTX>` with `cwd` = local dir, env `FIGMA_MAKE_VIA=ext`, `--resume <sessionId>`
  when one is stored for the file (store in `~/.config/figma-make/sessions.json` from the stream's
  `session_id`). CTX explains: you are editing Make file <KEY> mirrored in this dir; keep blocks
  GUI-editable (see skill figma-make-cli SKILL.md lessons); after code changes run
  `pnpm exec tsc --noEmit -p .`, `git commit -am`, then `figma-make push <KEY> .`; never spend Make credits;
  be brief. Stream text deltas (`stream_event` content_block_delta text) as `chat-delta`; tool_use blocks
  as one-line `chat-tool`; on exit `chat-done`. One run per file at a time (queue or reject with a message).
- **apply**: same runner with the prompt = the body of `~/.claude/commands/mupdate.md` (strip
  frontmatter, substitute `$ARGUMENTS` with `<KEY> <dir>`) plus: "The user clicked Apply in the browser.
  Tray items: …. End your final message with the line MUPDATE_OK only if the edits are committed and pushed."
  If the run exits 0 and output contains `MUPDATE_OK` → send `discard`. Otherwise leave the tray alone.
- Log to stdout one line per event.

## Extension behaviour
- `manifest.json` MV3: permissions `debugger`, `tabs`, `scripting`, `storage`; host_permissions
  `https://www.figma.com/*`, `http://127.0.0.1:47123/*`; background service worker; content script
  (isolated world) on `https://www.figma.com/make/*`, `run_at: document_idle`.
- Keep the MV3 service worker alive while the socket is open (e.g. chrome.alarms ping every 25s and a
  content-script port).
- **Content script** (top frame of figma.com/make/*):
  - fileKey from `location.pathname` (`/make/<KEY>/…`).
  - **Apply interception**: capture-phase `click` listener on `document`; if the target is inside a
    `button` whose trimmed text is exactly `Apply` and which sits in the change tray (sibling `Discard`
    button nearby), and the bridge is connected, and not `event.altKey`: `preventDefault()`,
    `stopImmediatePropagation()`, collect tray item labels (text of rows above the buttons), send `apply`,
    show "Claude is applying…" in the overlay. Alt-click = real Make Apply. When the bridge is offline, let the click through.
    Mark the intercepted button visually (small "→ Claude" badge next to it, via a sibling element, not by
    changing Make's React-owned text).
  - **discard**: find the `Discard` button in the tray and click it (synthetic pointer+mouse events; if that
    doesn't work, ask background for an rpc-style trusted click at its centre via chrome.debugger).
  - **Chat overlay**: a fixed-position panel (Shadow DOM, own styles, dark theme matching Make:
    bg #2c2c2c, text #e6e6e6, 13px Inter/system) positioned over Make's left chat column (measure the
    column containing the "Describe your idea" input / "New chat" header; fall back to left:0 top:52px
    width:360px bottom:0) and re-measured on resize. Contents: header "Claude Code (local)" + status dot
    (green connected / grey offline) + toggle "Show Make AI" (hides the overlay to reveal Make's own chat),
    a scrolling message list (user bubbles, assistant text rendered as plain text with line breaks,
    tool lines in dim monospace), and an input (textarea, Enter sends, Shift+Enter newline) + Send/Stop
    button. Persist the toggle in chrome.storage.
  - Content script ⇄ background via a long-lived `chrome.runtime.connect` port; background routes
    chat-delta/tool/done/discard to the port for the matching tabId.
- Background: WebSocket client to `ws://127.0.0.1:47123/ext`, rpc executor (chrome.debugger), router.

## Done criteria
- Load unpacked extension, run `figma-make bridge`, open the Make file in Chrome: overlay appears,
  typing "what file renders the hero?" streams an answer; `FIGMA_MAKE_VIA=ext figma-make exec <KEY> 'ls'`
  prints the sandbox listing; Apply on a pending text edit results in a commit + push + Discard.
