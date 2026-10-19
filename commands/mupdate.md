---
description: Sync GUI edits from a Figma Make file into the local repo for free, then push back (figma-make-cli)
argument-hint: "[make-file-key] [local-dir]"
---

Bring the user's Figma Make GUI edits into code without spending Make AI credits, using the
`figma-make` CLI (skill: figma-make-cli). Arguments: `[make-file-key] [local-dir]`: $ARGUMENTS
If none are given, use the file → dir mapping in `~/.config/figma-make/bridge.json` (if it has exactly one
entry, use that; otherwise ask which file).

Steps, in order. Stop and report if any step fails.

1. `figma-make status` — the desktop debug port must be up and the Make file open
   (else `figma-make launch` + `figma-make open <url>`).
2. **Applied / code-editor changes:** `figma-make pull <file> <dir>`. It refuses if the local repo is
   dirty (commit first), mirrors Make into the repo and commits "Sync from Make" — show the user the
   file stat it prints.
3. **Pending (un-applied) Edit-mode changes:** `figma-make pending <dir>` diffs the live desktop preview
   against the baseline taken after the last push. For each change:
   - `text` → find the old string in `src/` (it may be split across JSX lines or come from data in
     `App.tsx`) and replace it with the new one.
   - `cls` / `style` → translate to Tailwind classes on the element in the block file (never leave
     inline styles; use the existing token classes). Change only the property that changed, on the
     side that changed (`padding-top` → `pt-*`, not `py-*`), and keep responsive variants: the user
     edited at the preview's width, so put the new value on that breakpoint (e.g. `lg:pt-32`) and leave
     `sm:`/base values alone. Exact palette matches are fine (`#EEF2FF` → `bg-indigo-50`).
   - `src` → swap the image URL.
   - `added` / `removed` → mirror in the JSX.
   `pending` reads whichever preview the transport reaches: the desktop app over CDP, or the user's browser
   tab when `FIGMA_MAKE_VIA=ext` (extension + `figma-make bridge`). Without the bridge, browser-tab edits
   are invisible — ask the user to describe them.
4. `pnpm exec tsc --noEmit -p .` in the dir; fix errors. `git commit -am "Apply Make GUI edits: <summary>"`.
5. `figma-make push <file> <dir>` (it refuses if Make changed since step 2 — pull again if so).
6. Wait ~15 s, then `figma-make baseline <dir>` so the next `/mupdate` diffs against the new state.
7. Tell the user what changed, and to click **Discard** on the pending changes in Make's tray (they
   are now in the code; Applying them would spend credits and duplicate the edit).
8. End with the line MUPDATE_OK if all edits were committed and pushed.
