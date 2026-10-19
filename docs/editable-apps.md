# Building GUI-editable Make apps

Make's Edit mode can change any element whose JSX lives in **your** `src/` files. Elements rendered
by library code in `node_modules` show as **locked** in the Elements panel. Their children are often
locked too.

## Rules

1. **Render DOM in your own files.** If a library component renders the element (for example
   `motion.div` from an animation wrapper, or a headless UI primitive's `<button>`), Make locks it.
   - Write the element yourself and keep the library for behaviour only.
   - Or pass your own element through the library's render slot. With Base UI that's
     `render={<div className="…" />}`, which keeps the element's JSX in your file.
2. **Check whether a lock actually matters.** If the locked element only receives props from your own
   component (its `className`, its children), you can still edit it through that parent layer. That
   includes text via Typography and colours via Fill. A shadcn `Button` wrapping a primitive is an
   example. Locks matter when they hide something you'd want to edit: inner wrappers, icons, popups.
3. **Name components for humans.** The Elements panel shows React component names, so use
   `SiteHeader`, `HeroSection`, `ServicesGrid` and `PricingPlan` rather than `Block07`. Make each
   route a named component (`HomePage`, `PricingPage`). When renaming, change only the `const X =`
   and `export default X` lines; a blind find-and-replace also rewrites visible copy.
4. **Tailwind classes, not inline styles.** Make's Edit mode writes classes. Keep styling in classes
   and theme tokens, so GUI edits and code edits look the same.
5. **Keep content in props or data.** Blocks whose copy comes in as props (or from a data array in
   `App.tsx`) are easier to edit from both sides.

## shadcn / shadcn-studio blocks

- **Eject blocks as source** (`npx shadcn add …` locally, then push). Don't import them from a
  package: hard-coded copy then isn't editable.
- Keep Make's native stack: Vite + React 19 + TypeScript + Tailwind v4 (`@tailwindcss/vite`), pnpm,
  `@/` → `./src`, `src/main.tsx` → `src/App.tsx` + `src/index.css`. Pull first, so you keep Make's
  `vite.config.ts` and `.figma/make/*`.
- After `shadcn add`, compare the imports with `package.json` (e.g. `@base-ui/react`,
  `class-variance-authority`), and wrap the app in `TooltipProvider` if tooltips are used.
- Theme: add the stock neutral `:root` tokens, the `@theme inline` mapping and the `@layer base` rules
  yourself if the CLI didn't. Default theme plus good copy beats a quick custom palette.
- Replace stock imagery. For fast placeholders use small Unsplash URLs
  (`?w=900&q=60&auto=format`) and check that each URL loads.
- Don't use Make's `min-h-screen` heroes: Make's preview is very tall, which leaves big gaps. Let
  sections size to their content.

## Checking locks

In Make's Elements panel, a locked layer has a "locked" badge. The panel rows' React props carry
`isEditBlocked`. An automated audit (`figma-make locks`) is a planned addition; until then, check
the panel after adding a new block.
