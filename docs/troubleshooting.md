# Troubleshooting

Start with `figma-make doctor`. It checks tools, install, config, bridge, extension, Claude (run
the way the bridge runs it) and the Make tab, and prints a fix next to each failure.

**The panel shows a grey dot / "Bridge offline".**
The bridge isn't running or the extension can't reach it. Run `curl -s 127.0.0.1:47123/`. If nothing
answers, start `figma-make bridge` (or check `~/Library/Logs/figma-make-bridge.log` for the service).
If `ext` is `false`, reload the extension.

**Two "Figma Make Bridge" cards in chrome://extensions / the dot keeps flickering / doctor says "two copies".**
Older versions got a different ID per folder they were loaded from. Remove every Figma Make Bridge
card, then Load unpacked once from `skill/figma-make-cli/extension`. Since 0.3.0 the ID is fixed
(`pdihomdlefdamkalilgnakikkgjlbgoi`), so this can't happen again.

**Claude replies "No local directory configured for Make file …".**
Run `figma-make link <KEY> <dir>`.

**The service fails with "OAuth session expired" in the log.**
launchd's environment is missing `USER`/`LOGNAME` (needed for the keychain), or `PATH` finds a
different `claude`. Re-run `./install.sh --service`, which writes both.

**`push` says "Make changed since your last sync".**
Someone, or Make's AI, or an applied Edit-mode change, modified the file in Make. Run `pull` first
(it commits Make's version), then push. Use `--force` only if you're sure Make's changes can go.

**`pull` says the folder has uncommitted changes.**
Commit or stash first; pull never overwrites uncommitted work.

**`pending` lists changes you didn't make.**
The baseline is from before your last push. Run `figma-make baseline <dir>` with the preview showing
the current state and no pending tray changes.

**The preview shows only a reduced view: no Edit button, "Make a copy" instead of the workspace.**
The URL has `fullscreen=1` (Make's fullscreen preview). Open
`https://www.figma.com/make/<KEY>/<name>` without it.

**Make's terminal tab pops up.**
Only `figma-make exec` (and the legacy `save`) use the terminal. Sync never does. The first `exec`
after a page reload has to create or show a terminal; later ones run hidden.

**Edit-mode selection doesn't show a chip.**
Reload the Make tab after installing or updating the extension (content scripts load with the page).
The selection is read from the Elements panel, so the selected row must exist there.

**"Detached while handling command" from an RPC.**
The extension reloaded or the tab navigated mid-command. Re-run it.

**Recent Figma desktop won't open the debug port (desktop mode).**
Newer Figma desktop builds block `--remote-debugging-port`. Use browser mode, or patch Figma desktop
with a tool such as figma-use (`figma-use patch`).
