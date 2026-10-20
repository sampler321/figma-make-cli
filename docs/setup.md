# Setup

## Requirements

- **Node.js 22+** (the scripts use the built-in WebSocket client and `fetch`; no npm dependencies).
- **Claude Code**, installed and logged in (`claude -p "hi"` must work in a terminal).
- **git**, and **pnpm** for type-checking Make projects locally (`pnpm install` in the app folder once).
- A Chromium-based browser (Chrome, Arc, Brave, Helium, Edge), Chrome 125 or later.
- A Figma account with access to Figma Make.

## 1. Install

```bash
git clone https://github.com/sampler321/figma-make-cli.git
cd figma-make-cli
./install.sh            # or: ./install.sh --service   (macOS: run the bridge at login)
```

`install.sh` symlinks, so `git pull` in the repo updates everything:

| Link | Points to |
|---|---|
| `~/.claude/skills/figma-make-cli` | `skill/figma-make-cli` |
| `~/.claude/commands/mupdate.md` | `commands/mupdate.md` |
| `~/.local/bin/figma-make` | `skill/figma-make-cli/scripts/figma-make.mjs` |

It also creates `~/.config/figma-make/bridge.json` if it doesn't exist. Make sure `~/.local/bin` is
on your `PATH`. Uninstall with `./install.sh --uninstall` (your config is kept).

## 2. Load the browser extension

1. Open `chrome://extensions` (or your browser's equivalent, e.g. `helium://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select `skill/figma-make-cli/extension` in this repo (the
   `~/.claude/skills/figma-make-cli/extension` link works too).

The extension has a fixed ID, `pdihomdlefdamkalilgnakikkgjlbgoi` (pinned with `key` in its manifest), so
loading it again from another path replaces it instead of adding a second copy. Two copies fight over
the bridge connection; `figma-make doctor` flags that.

The extension asks for the `debugger` permission. While it runs a command against a Make tab, the
browser shows a "started debugging this browser" bar. That's expected. It detaches 15 s after the last
command so it doesn't interfere with Make.

After editing extension files, reload it without the extensions page:
`curl -s -X POST 127.0.0.1:47123/rpc -d '{"method":"reload","params":{}}'`, then reload the Make tab.

## 3. Run the bridge

The bridge is a small local daemon on `127.0.0.1:47123`. The extension connects to it and reconnects
every 2 s, so the start order doesn't matter.

- **Foreground:** `figma-make bridge` (logs one line per event).
- **macOS login service:** `./install.sh --service` installs
  `~/Library/LaunchAgents/com.figma-make.bridge.plist` (KeepAlive, log at
  `~/Library/Logs/figma-make-bridge.log`).
  - Restart after editing `bridge.mjs`: `launchctl kickstart -k gui/$(id -u)/com.figma-make.bridge`
  - Stop: `launchctl unload ~/Library/LaunchAgents/com.figma-make.bridge.plist`
- **Status:** `curl -s 127.0.0.1:47123/` returns `{"ok":true,"ext":true,"running":[]}`. `ext` is true
  when the extension is connected.

The service sets `PATH` (node and claude), `HOME`, `USER` and `LOGNAME`. Without `USER`/`LOGNAME`,
`claude` can't read its login from the macOS keychain and fails with "OAuth session expired".

Check the result any time with `figma-make doctor`.

## 4. Link a Make file to a local folder

The bridge needs to know which local folder holds each Make file's code. The key is the id in the
URL: `https://www.figma.com/make/<KEY>/<name>`.

```bash
mkdir -p ~/make-apps/my-app && cd ~/make-apps/my-app && git init
figma-make link <KEY> .
```

This writes `~/.config/figma-make/bridge.json` (see `config/bridge.example.json`):

```json
{ "files": { "<KEY>": "/Users/you/make-apps/my-app" } }
```

### Permissions

By default the bridge runs Claude with edits auto-accepted and Bash limited to `figma-make`, `pnpm`,
`git`, `ls` and `cat`. Anything else (`npx shadcn add`, `curl`, web fetches) would wait for an approval
the headless run can't show, so Claude reports it's blocked. To let it run everything, as Claude Code's
`--dangerously-skip-permissions` does, set:

```json
{ "files": { … }, "skipPermissions": true }
```

Claude can then run any command on your machine from the Make chat. Only enable it on a machine and
for projects you trust. The setting is read on every message, so no restart is needed.

Then fetch the code with the Make file open in your browser:

```bash
FIGMA_MAKE_VIA=ext figma-make pull <KEY> .
pnpm install            # once, so `pnpm exec tsc --noEmit -p .` works locally
```

Keep the folder a git repo: `pull` refuses to overwrite uncommitted work and commits each sync, and
Claude commits each change, so everything is reversible.

Claude's conversation per Make file is resumed across messages. The session ids live in
`~/.config/figma-make/sessions.json`. Delete an entry to start a fresh conversation.

## Optional: desktop mode (Figma desktop app over CDP)

Without the extension, the CLI can drive the Figma desktop app instead. It must run with a remote
debugging port:

```bash
figma-make launch                       # relaunch Figma desktop with --remote-debugging-port=9222
figma-make open "https://www.figma.com/make/<KEY>/<name>"
figma-make status                       # lists open Make files and their keys
figma-make pull <KEY> ~/make-apps/my-app
```

Recent Figma desktop versions block the debugging flag. Tools such as
figma-use (`figma-use patch`) re-enable it. In desktop mode
there is no chat panel or Apply interception; use `/mupdate` from Claude Code in a terminal instead.

## Using it from Claude Code in a terminal

The skill and command also work without the browser panel. In Claude Code:

- Ask about your Make app normally. The `figma-make-cli` skill loads when you mention Make, push or
  pull.
- Run `/mupdate [<KEY> <dir>]` to turn Make Edit-mode changes into code (see [usage](usage.md#mupdate)).
- Set `FIGMA_MAKE_VIA=ext` in that shell to go through the browser extension instead of Figma desktop.
