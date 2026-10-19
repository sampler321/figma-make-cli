# Usage

## The Claude panel

With the bridge running and the extension loaded, a **Claude Code (local)** panel covers Make's AI
chat column. If Make's chat column isn't on screen (narrow window, preview-only view), a small
**Claude** button sits in the bottom-left corner instead.

- **Dot:** green means connected to the bridge, grey means offline. Offline, nothing is intercepted.
- **Send:** Enter sends, Shift+Enter adds a new line. Replies stream in and render Markdown. Tool
  activity shows as dim one-liners (`Edit header.tsx`, `$ figma-make push …`).
- **Stop:** the Send button turns into Stop while Claude works and stops the run.
- **Show Make AI:** reveals Make's own chat underneath (it uses credits). Uncheck it to bring Claude
  back.

Each message runs `claude -p` in the Make file's local folder, resuming that file's conversation.
Edits are auto-accepted, and shell access is limited to `figma-make`, `pnpm`, `git`, `ls` and `cat`, unless
`"skipPermissions": true` is set in the bridge config (see [setup](setup.md#permissions)).
After a change Claude type-checks, commits and runs `figma-make push`, so the preview updates by
itself within seconds.

Example messages:

- "Change the pricing headline to 'Simple, fixed-scope pricing'"
- "Add a FAQ entry about retesting"
- "Make the footer links smaller and grey"

## While Claude works

- **Activity:** a pulsing row under the messages shows what Claude is doing: *Thinking…*,
  *Writing…*, *Running Edit…*. When the stream includes Claude's thinking, it appears as a collapsed
  **Thinking** block you can open.
- **Queue:** type and press Enter while Claude is busy; the button reads **Queue**. Queued messages
  wait above the input and send one by one as each run finishes. × removes one.
- **Push in now:** click **Send now** on a queued message, or press **Cmd/Ctrl+Enter** instead of
  Enter. The current run stops and your message goes immediately. The conversation is resumed, so
  Claude keeps the context, but the interrupted step may be left half done (check `git status` in
  the app folder).
- **Stop:** with an empty input, the button reads **Stop**.

## Select a layer, then instruct

1. Turn on Make's **Edit** mode (top right of the preview).
2. Click an element in the preview, or a row in the Elements panel. Shift-click selects several.
3. Each selected layer shows as a blue chip above the input (`◇ CardContent`). × removes it from the
   context.
4. Type an instruction that refers to it: "make this text black", "tighten the spacing here".

Claude receives, per selected layer:

- the source file from Make's Elements panel;
- the live element from the preview: tag, classes, text and HTML.

For a component layer (such as `CardContent`), the file is where the component is **defined**, so
Claude finds the place it's **used** from the text. The chips stay after sending, so you can keep
instructing about the same element. They are replaced when you select something else.

## Edit mode and Apply (no credits)

Make's Edit mode lets you change text, colours, spacing and images directly in the preview. The
changes collect in a tray above the chat ("3 changes · Discard · Apply"). Normally **Apply** sends
them to Make's AI, which spends credits.

With the extension, Apply shows a **→ Claude** badge. Clicking it:

1. blocks Make's Apply (no credits);
2. runs the `/mupdate` routine with local Claude. Claude reads the pending changes by comparing the
   live preview with the snapshot taken after the last push, writes them into the code as Tailwind
   classes and text, type-checks, commits and pushes;
3. clicks **Discard** on Make's tray once Claude reports success (`MUPDATE_OK`), because the changes
   are now in the code. If Claude fails, the tray is left alone.

**Alt-click Apply** to use Make's real Apply anyway. With the bridge offline, Apply works as normal.

Notes on how changes are translated:

- Only the edited property and side change (`padding-top 128` → `lg:pt-32`, not `py-32`).
  Responsive variants are kept, and the new value goes on the breakpoint matching the preview width.
- Exact palette colours map to tokens (`#EEF2FF` → `bg-indigo-50`).

## `/mupdate`

The same routine as a Claude Code slash command, for use in a terminal:

```
/mupdate [<make-file-key> <local-dir>]
```

Without arguments it uses the single entry in `~/.config/figma-make/bridge.json`. The steps:

1. `status`
2. `pull`, for changes made in Make's code editor or applied there
3. `pending`, for un-applied Edit-mode changes, written into code
4. type-check and commit
5. `push`
6. `baseline`
7. tells you to Discard the tray

## CLI reference

`<file>` is the Make file key (or any substring of the tab title or URL). Prefix commands with
`FIGMA_MAKE_VIA=ext` to go through the browser extension. Without it they go to Figma desktop over CDP.

| Command | What it does |
|---|---|
| `figma-make status` | Is the transport up? Lists open Make files and their keys. |
| `figma-make link <key> <dir>` | Map a Make file to a local folder (bridge config). |
| `figma-make pull <file> <dir> [--force]` | Make → folder. Reads only changed files (sha256) through Make's file system and commits "Sync from Make". Refuses if the folder has uncommitted changes. |
| `figma-make push <file> <dir> [--delete] [--force]` | Folder → Make. Writes only changed files through Make's file system, which persists and commits them; there's no save step. Refuses if Make changed since your last sync, so pull first. `--delete` removes files that no longer exist locally. |
| `figma-make baseline <dir>` | Snapshot the live preview (text, classes, styles per element). Done automatically after pushes by `/mupdate`. |
| `figma-make pending <dir>` | JSON diff of the live preview against the baseline, i.e. the un-applied Edit-mode changes. |
| `figma-make exec <file> "<cmd>"` | Run a shell command in Make's sandbox (cwd = project root). Uses Make's terminal tab, which may become visible. |
| `figma-make preview <file> [out.png]` | Switch to the preview and screenshot it. |
| `figma-make reload <file>` | Reload the Make tab. |
| `figma-make kit-add <file> <pkg>@<ver>` | Add a Make kit or npm dependency to package.json; Make's installer fetches it. |
| `figma-make bridge` | Run the bridge in the foreground. |
| `figma-make launch` / `open <url>` | Desktop mode only: start Figma desktop with the debug port, open a file. |
| `figma-make save <file>` | Legacy: persist raw files written by `exec` in the sandbox. |

Not covered by sync: Make's own scaffolding (`.figma/make/*`, dotfiles, the pnpm lockfile,
`AGENTS.md`, `CLAUDE.md`). Leave those to Make.

## Typical session

```bash
cd ~/make-apps/my-app
FIGMA_MAKE_VIA=ext figma-make pull <KEY> .     # start from Make's latest
# chat in the Make panel, or edit locally with Claude Code / your editor, then:
pnpm exec tsc --noEmit -p . && git commit -am "…" && FIGMA_MAKE_VIA=ext figma-make push <KEY> .
```
