# figma-make-cli

Build [Figma Make](https://www.figma.com/make/) apps with **Claude Code running on your machine**
instead of Make's built-in AI. You keep Make's live preview, its Edit mode and its hosting, but no
Make AI credits are spent.

- **Claude chat inside Make.** A browser extension replaces Make's AI chat panel with a chat to your
  local Claude Code. Claude edits a local git repo and pushes the result back into Make.
- **Select a layer, then instruct.** Layers selected in Make's Edit mode appear as blue chips and are
  sent to Claude with their source file, classes, text and HTML.
- **Free "Apply".** Make's Edit-mode changes (text, colours, spacing) normally cost credits when you
  click Apply. The extension intercepts Apply, has Claude write the same change into the code, pushes
  it, and discards Make's pending tray. Alt-click still runs Make's own Apply.
- **A real sync CLI.** `figma-make pull/push` moves code between a local folder and Make through
  Make's own file system: sha256 deltas, persisted by Make, with a safety check against overwriting
  changes made in Make.
- **Claude Code skill + `/mupdate` command**, so Claude knows how Make works and how to keep apps
  GUI-editable.

**Setting this up with an AI agent?** Point it at [docs/agent-install.md](docs/agent-install.md):
*"Install and verify https://github.com/sampler321/figma-make-cli following docs/agent-install.md."*
You'll only need to click **Load unpacked** once and paste your Make file's URL.

> Unofficial. This drives Figma Make's web app from the outside and relies on internals that can
> change at any time. Use it on your own files.

## How it fits together

```
Make tab in Chrome ──(extension: chrome.debugger + content scripts)──┐
                                                                      │ WebSocket
                         figma-make bridge (127.0.0.1:47123) ─────────┘
                           │  spawns `claude -p` in the mapped local folder
                           │  CLI calls (figma-make push/pull/…) go back through the extension
                           ▼
                     local git repo  ⇄  Make's file system (writeFile / fetchEntry)
```

There is also a **desktop mode** that drives the Figma desktop app over the Chrome DevTools
Protocol instead of the browser extension. The CLI is the same.

## Quick start (browser mode, macOS or Linux, Chrome-based browser)

Requirements: Node.js 22+, [Claude Code](https://claude.com/claude-code) logged in, git, pnpm
(for type-checking Make projects), a Figma account with Make.

```bash
git clone https://github.com/sampler321/figma-make-cli.git
cd figma-make-cli
./install.sh --service          # macOS: also runs the bridge at login; omit --service elsewhere
```

1. Load the extension: open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked**, and pick `skill/figma-make-cli/extension`.
2. Get the app's code locally and link it:
   ```bash
   mkdir -p ~/make-apps/my-app && cd ~/make-apps/my-app && git init
   figma-make link <make-file-key> .            # key = the id in figma.com/make/<key>/…
   FIGMA_MAKE_VIA=ext figma-make pull <make-file-key> .   # with the Make file open in Chrome
   ```
3. Start the bridge if you didn't install the service: `figma-make bridge`.
4. Open the Make file in Chrome. The **Claude Code (local)** panel covers Make's chat. A green dot
   means it's connected.
5. Check everything: `figma-make doctor`.

Full instructions: [docs/setup.md](docs/setup.md). Day-to-day use: [docs/usage.md](docs/usage.md).

## Documentation

| | |
|---|---|
| [Agent install](docs/agent-install.md) | Step-by-step install + verification for an AI agent |
| [Setup](docs/setup.md) | Install, extension, bridge service, config, desktop mode |
| [Usage](docs/usage.md) | Chat panel, selection context, Apply interception, `/mupdate`, CLI reference |
| [How it works](docs/how-it-works.md) | Architecture, Make internals it relies on, protocol |
| [Building GUI-editable apps](docs/editable-apps.md) | Keeping every layer editable in Make (no locked layers), shadcn blocks |
| [Troubleshooting](docs/troubleshooting.md) | Common problems and fixes |
| [`SKILL.md`](skill/figma-make-cli/SKILL.md) | What Claude Code reads (the skill) |
| [`BRIDGE-SPEC.md`](skill/figma-make-cli/BRIDGE-SPEC.md) | Extension ⇄ bridge protocol spec |

## Repository layout

```
skill/figma-make-cli/      Claude Code skill (installed to ~/.claude/skills/figma-make-cli)
  SKILL.md                 instructions Claude loads
  BRIDGE-SPEC.md           extension ⇄ bridge protocol
  scripts/figma-make.mjs   the CLI (linked to ~/.local/bin/figma-make)
  scripts/make-sync.mjs    pull / push / exec through Make's file system and terminal
  scripts/cdp.mjs          transport: Figma desktop over CDP, or the bridge (FIGMA_MAKE_VIA=ext)
  scripts/bridge.mjs       local daemon: WebSocket to the extension, runs `claude -p`
  extension/               Chrome MV3 extension (load unpacked)
commands/mupdate.md        /mupdate slash command (installed to ~/.claude/commands)
launchd/                   macOS login-service template for the bridge
config/bridge.example.json Make file key → local folder mapping
install.sh                 installer / uninstaller
```

## License

MIT, see [LICENSE](LICENSE). Not affiliated with Figma or Anthropic.
