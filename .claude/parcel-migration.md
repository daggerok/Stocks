# Journal: Babel standalone runtime -> Parcel build into dist (2026-10-04, branch `build/parcel-dist`)

Goal set by the owner: move the browser app from the in-browser Babel + Tailwind Play CDN setup to the build setup of daggerok/csv and daggerok/options-desk (Parcel, Tailwind CSS v4 via PostCSS, `src/` layout, data copied into `dist`), keep no `tsconfig.json`, do not change the GitHub Pages deployment yet. The same migration is expected for the other repos, so every step and gotcha is recorded here

## Why
- Tailwind Play CDN re-scans the whole DOM on every mutation: about 50 ms per change at 1200 mounted rows (measured: blocking `cdn.tailwindcss.com` dropped class toggles from ~70 ms to ~18 ms per frame)
- Babel standalone (several MB) compiled 3800 lines of TypeScript in the browser on every load
- Result of the migration: `dist/` is 97 kB JS + 48 kB CSS + html, built in ~3 s

## Reference setup (what was copied exactly)
- `src/index.html`, `src/main.tsx`, `src/index.css`, `src/favicon.ico`; `package.json` has `"source": "src/index.html"`
- index.html: `<link rel="icon" type="image/x-icon" href="./favicon.ico">`, `<link href="./index.css" type="text/css" rel="stylesheet" />`, `<script src="./main.tsx" type="module"></script>`
- index.css: `@import "tailwindcss";` then `@custom-variant dark (&:where(.dark, .dark *));` then `@theme { ... }`
- package.json: scripts `clean`, `ncp`, `build-github-pages`, `preserve`, `serve`, `prebuild`, `build`, `postbuild`, `start`, `restart`, `ps`, `logs`, `stop`; `"postcss": { "plugins": { "@tailwindcss/postcss": {} } }`; exact versions (`bun install -E`); tools parcel, @parcel/transformer-sass, @tailwindcss/postcss, tailwindcss, rimraf, ncp, pm2
- Data folder: options-desk copies `data/` to `dist/data` with `ncp` (`postbuild`, and `preserve` for the dev server). Stocks does the same with `ncp api dist/api`; the app fetches `./api/stocks/` relative to the page, so it works under `--public-url=/Stocks/` too
- No `tsconfig.json`, no `typescript`; Parcel transpiles `.tsx` with swc

## Steps done
1. `git switch -c build/parcel-dist origin/main`
2. `git mv index.html src/index.html`, `app.tsx -> src/main.tsx`, `favicon.ico -> src/favicon.ico`
3. `src/index.css` = header comment + tailwind import + dark variant + `@theme { --font-sans: 'Inter', sans-serif; }` + a v4 compat layer + the two inline `<style>` blocks of the old index.html moved verbatim
4. `src/index.html`: removed the Tailwind CDN script and `tailwind.config`, the Babel standalone script, both `<style>` blocks, the `text/babel` script and the inline summary-popover script; kept the Inter font links and the synchronous theme init (prevents a flash); added the css link and the module script
5. The inline summary-popover script became a typed IIFE at the end of `src/main.tsx`
6. `package.json` rewritten after options-desk (see above); `bun install -E`; `.gitignore` already had `dist/` and `.parcel-cache/`
7. README: run commands and the build section; `.claude/rules/*`: `app.tsx` -> `src/main.tsx`

## Gotchas (check these in the next repo)
- Tailwind v3 -> v4 defaults: default border color became `currentColor` (compat rule in `@layer base` restores `gray-200`), buttons lost `cursor: pointer` (compat rule restores it); renamed utilities (`shadow-sm` -> `shadow-xs`, `rounded` -> `rounded-sm`, `ring` width) can shift looks, compare visually
- `darkMode: 'class'` of the v3 config is the `@custom-variant dark` line in v4; a `@media (prefers-color-scheme: dark)` rule next to a class based theme is a bug (the page theme is the class), remove it
- The old classic script made every top-level function a window global; a module does not. The browser UI tests in `../ETFs/.claude/tools/ui-std/` call `state`, `render`, `catalogIds`, `store`, `catalogFilterColumns`, `detectedCatalogType`, `filterExpressionFor`, `gridTypeCache`, `menuColumns`: they are exposed at the end of `main.tsx` (`Object.assign(window, ...)` plus a getter for the reassigned `store`). Find the list for a new repo with: top-level names of the app file that appear in the test file
- Those tests also assume `render()` is synchronous after a click (`cycleColumnType` must not go through the deferred `renderBusy`)
- Parcel names the bundles after the package name and hashes them; nothing in the app may refer to `app.tsx` or the old file names
- `bun pm untrusted` lists `@swc/core` and `@parcel/watcher` postinstalls as blocked: the build works anyway
- `bun run build` runs `clean` first (`prebuild`) and copies the data last (`postbuild`); the data folder is large (api/ is 261 MB here), copy time shows in the build
- `dist/` is gitignored, so `main` no longer holds a servable site: Pages must be switched from legacy (`main` `/`) to "GitHub Actions" (`gh api -X PUT repos/daggerok/Stocks/pages -f build_type=workflow`) when the migration merges, otherwise the live site breaks. The deployment workflow is `.github/workflows/github-pages.yml`, copied from options-desk (checkout, setup-bun, `bun install -E`, `bun run build-github-pages`, upload `./dist`, deploy), with a `workflow_run` trigger on the data workflow because its token-pushed commits do not start push workflows

## Verification on this branch
- `bun test` 24 pass; `bun run build` ok; `check.sh . scripts/update-data.ts scripts/update-data.test.ts src/main.tsx` prints nothing
- Browser tests against `bunx serve dist -p 4789`: `stocks-columns-uitest` 20 passed 0 failed, `stocks-filters-uitest` 30 passed 2 failed (the same two stale expectations as on `main`)

## Open for later
- CI workflow and dependency-updates workflow like csv (`ci.yaml`, `dependency-updates.yml`)

## Later changes on the same branch
- Footer (disclaimer, license and links line) removed from `src/index.html` on the owner's request
- `--dist-dir ./dist` is explicit in `serve` and `build`
- the busy spinner of the chunk growth has no 150 ms grace period (`.is-instant`): a lag without a spinner was visible when scrolling
- the second panel (detail tabs) is always shown, with disabled placeholders when no stock is active
- profiling (CDP, a battery of 23 user actions, long tasks vs the overlay): typing in the search blocked 740 ms per keystroke without a spinner and a column filter 120-630 ms; the cost is forced layout of the whole table (`getBoundingClientRect` in the view-anchor logic, about 0.4 ms per mounted row, 1000+ rows after a few scroll chunks) plus re-mounting chunks up to the anchor row. Search now debounces (200 ms) and, like the debounced column filter, runs under the spinner; blur/Enter filter commits stay synchronous (the UI tests expect that). The root cost remains: bounded DOM (windowing) or fixed table layout would remove it
- the busy overlay showed a `progress` cursor immediately but the spinner only after 150 ms, so the two were out of sync; the cursor now switches inside the same keyframes as the visibility
- first scroll after the spinner (profiled with CDP tracing, DPR 2, 4x CPU throttle): two causes, both after the spinner had hidden. (1) Inter is requested per weight and per script the first time such text is laid out; the Greek delta of the "Δ" column headers pulled four more Inter files when the rows rendered and "Fonts changed" re-laid-out 4389 of 35513 nodes after the spinner was gone. Fix: `loadFonts()` (all weights) and `loadFontsForText()` (the non-Latin-1 glyphs of the headers and the data) run while the spinner is up. (2) The spinner hid right after `render()`, so the layout and paint of the first frame ran without it; it now hides after a forced layout and the next painted frame (`nextPaint()`). `backdrop-filter` was tested and is not a factor (A/B, within noise)
- the lag after the spinner with a saved scroll position (reproduced: saved view anchored on row 1900, DPR 2, 4x CPU throttle): `restoreViewAnchor` mounted every row above the anchor (2000 rows, one 5.5 s block at 4x) and ran AFTER the spinner had hidden. Now (1) the catalog mounts a window of rows around the anchor, the rows above it are one spacer row (`catalogRenderedFrom`, `catalogRowHeight`; 400 mounted rows instead of 2000), scrolling up prepends chunks and a jump into the spacer remounts the window around the scroll offset; (2) the spinner waits for the restore (`viewRestoreDone`, capped at 3 s) and for the next painted frame. After the fix no long task and no frame gap after the spinner hides. A spinner cannot be drawn while the main thread is blocked, so "show it whenever we lag" means covering each known heavy path before it starts; a frame-gap watchdog would only show it after the lag
