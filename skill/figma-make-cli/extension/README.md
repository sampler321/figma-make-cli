# Figma Make Bridge (Chrome extension)

Connects Figma Make in Chrome to local Claude Code through the `figma-make bridge` daemon
(`ws://127.0.0.1:47123/ext`). Protocol: see `../BRIDGE-SPEC.md`.

## Install
1. Open `chrome://extensions`, turn on **Developer mode** (top right).
2. **Load unpacked** and pick this folder (`~/.claude/skills/figma-make-cli/extension`).
3. Run `figma-make bridge` in a terminal (or install it as a service: `./install.sh --service`), then open
   (or reload) `https://www.figma.com/make/<KEY>/...`.

After editing these files: `curl -s -X POST 127.0.0.1:47123/rpc -d '{"method":"reload","params":{}}'`
(or the reload icon on the extension card), then reload the Make tab.

## What you get
- **Chat overlay** over Make's left AI panel: "Claude Code (local)". The dot is green when the
  daemon is connected. Enter sends, Shift+Enter is a newline, the button becomes **Stop** during a run.
  **Show Make AI** hides the overlay (a small "Claude Code" pill brings it back).
- **Apply interception**: in Edit mode, clicking **Apply** in the pending-changes tray sends the
  changes to Claude Code instead of Make AI (a "→ Claude" badge marks the button). On success the
  extension clicks **Discard**, since the edits now live in code.
  **Alt+click Apply** = Make's real Apply. If the bridge is offline, Apply works normally.
- **Selection as context**: layers selected in Edit mode appear as blue chips above the input and are
  sent with the message (source file + live classes/text/HTML). × removes one; they stay until you
  select something else.
- RPC (`list`, `evaluate`, `click`, `screenshot`, `reload`) for `FIGMA_MAKE_VIA=ext figma-make ...`.

## Expected oddities
- Chrome shows a **"... started debugging this browser"** bar while the extension is attached to the
  tab (it attaches on an RPC and detaches after 15 s idle). That's normal. Clicking *Cancel* detaches it, and the next RPC re-attaches.
- Attaching fails while DevTools is open on the same tab.
- Requires Chrome 125+ (flattened child sessions for the preview iframe).
