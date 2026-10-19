# Install and verify (instructions for an AI agent)

You are setting up figma-make-cli on the user's machine so they can build a Figma Make app with
local Claude Code from inside Make. Follow the steps in order. **Stop and ask the user** where it
says ASK. Don't skip `figma-make doctor`: it is the source of truth for what works.

## 0. Prerequisites

Check, and install anything missing (ask before installing system-wide):

```bash
node --version      # must be 22 or newer
git --version
claude --version    # Claude Code CLI; the user must be logged in (`claude` once, interactively)
pnpm --version      # optional but recommended: npm i -g pnpm
```

Supported: macOS (full, including the login service) and Linux (run the bridge yourself). The user
needs a Chromium-based browser (Chrome, Arc, Brave, Edge, Helium) and a Figma account with Make.

## 1. Clone and install

```bash
git clone https://github.com/sampler321/figma-make-cli.git ~/figma-make-cli
cd ~/figma-make-cli
./install.sh --service      # macOS. On Linux: ./install.sh, then keep `figma-make bridge` running.
```

If `install.sh` reports an existing non-symlink at `~/.claude/skills/figma-make-cli` or
`~/.claude/commands/mupdate.md`, ASK the user before moving it away.

Run `figma-make doctor --skip-claude`. Tools, Install and Bridge should be ✓ at this point.
"extension not connected" and "no Make file linked" are expected until steps 2 and 3.

## 2. Load the browser extension (the user does this)

ASK the user to:

1. open `chrome://extensions` (Arc/Brave/Edge/Helium have the same page under their own scheme),
2. turn on **Developer mode**,
3. click **Load unpacked** and choose `~/figma-make-cli/skill/figma-make-cli/extension`.

Browsers don't let scripts load unpacked extensions, so this click can't be automated from a
terminal. If you have computer-use, you may do it with the user's permission. The folder picker
accepts Cmd+Shift+G to type the path.

Then run `figma-make doctor --skip-claude` until it shows **✓ extension connected**.

## 3. Link the user's Make file

ASK the user for the Make file URL, `https://www.figma.com/make/<KEY>/<name>`, and where the local
code should live (default `~/make-apps/<name>`). Ask them to open that URL in the same browser,
**not** with `fullscreen=1`, and wait until Make's workspace has loaded.

```bash
mkdir -p ~/make-apps/<name> && cd ~/make-apps/<name> && git init
figma-make link <KEY> .
FIGMA_MAKE_VIA=ext figma-make pull <KEY> .
pnpm install        # if pnpm is available; enables local type-checking
```

`pull` should report the files it fetched and commit "Sync from Make".

## 4. Permissions

ASK the user: *"Should the Claude in Make's chat panel be allowed to run any command without
asking (like `--dangerously-skip-permissions`)? Without it, things like `npx shadcn add` or fetching
URLs will be blocked."* If yes, add `"skipPermissions": true` to
`~/.config/figma-make/bridge.json`. The bridge reads it per message, so no restart is needed.

## 5. Verify

```bash
figma-make doctor          # everything should be ✓ (takes ~10 s: it asks Claude to reply "ok")
```

Then a round trip with no changes (it must not modify anything):

```bash
cd ~/make-apps/<name>
FIGMA_MAKE_VIA=ext figma-make push <KEY> .     # expect: "sandbox already matches, nothing to send"
FIGMA_MAKE_VIA=ext figma-make pull <KEY> .     # expect: "already in sync"
FIGMA_MAKE_VIA=ext figma-make baseline .        # expect: "baseline: N preview elements recorded"
```

Finally, ASK the user to reload the Make tab and type *"Which file renders the first section of the
home page? One line."* into the **Claude Code (local)** panel. It should stream an answer naming a
file. If the panel doesn't appear, run `figma-make doctor` again and see
[troubleshooting](troubleshooting.md).

## 6. Hand over

Tell the user, briefly:

- The Claude panel replaces Make's AI chat and spends no Make credits. "Show Make AI" brings Make's
  own chat back.
- **Select a layer, then instruct:** in Edit mode, selected layers become blue chips that Claude
  receives as context.
- **Apply is free:** the → Claude badge means Claude writes Edit-mode changes into code and then
  discards Make's tray. Alt-click Apply uses Make's own (paid) Apply.
- While Claude works, messages queue. Cmd/Ctrl+Enter sends one right away.
- The code lives in `~/make-apps/<name>` (a git repo, so every change can be reverted).
- More: [usage](usage.md).

## If something fails

Run `figma-make doctor` and fix the first ✗. It prints the fix next to each item. Common ones:

| Doctor says | Fix |
|---|---|
| bridge not reachable | `figma-make bridge` (or `./install.sh --service`) |
| extension not connected | step 2, then reload the Make tab |
| claude fails when run by the bridge | `claude` once in a terminal to log in; re-run `./install.sh --service` |
| Make file system not found | open the Make URL without `fullscreen=1` and let the workspace load |
| no Make tab open | open the Make URL in the browser that has the extension |
