# Bun only — no tsconfig.json, no TypeScript as a dependency, no ad-hoc tsc

This repo (like the 29 ETF repos) is zero-runtime-dependency by design (`package.json` carries no
`dependencies`, only `@types/bun`/`@types/node` in `devDependencies`). Bun
transpiles and runs `.ts` directly with no build step and no `tsconfig.json`
— that is the whole point of this stack. Do not:

- add a `tsconfig.json` to any of these repos
- add `typescript` as a dependency/devDependency
- invent ad-hoc `bunx tsc --target ... --module ... --types ...` commands
  with hand-picked flags to "type-check" a file

Bun has TypeScript support out of the box; it does not need the `typescript`
package installed to run these scripts.

**How to verify a change to `scripts/update-data.ts` or `app.tsx` (or any script here):**

- `bun test` (existing `update-data.test.ts`)
- `bun build --target=bun scripts/update-data.ts --outfile=/dev/null` and `bun build --target=bun app.tsx --outfile=/dev/null` as a
  quick syntax/bundling sanity check
- an actual run: `bun scripts/update-data.ts` (scoped with `TICKERS=...` and
  `REQUEST_SLEEP=0` for a fast, cheap dry run), then `git checkout -- api/` and delete created files
  to discard the live-fetched data changes before committing — the commit
  should only contain the source change, not incidental data refreshes

That's it. If IntelliJ's own TS language service flags something (e.g. a
missing `/// <reference types="bun" />`, or a real type error), fix the
actual file — do not reach for `tsconfig.json`/`typescript`/`@ts-ignore` to
silence it.

**Why:** user said explicitly (2026-09-26), after watching an ad-hoc
`bunx tsc ...` verification command: "why do you run it like so???? ... use
simply in this way as I want to use it: bun scripts/update-data.ts and if
you need any packages install them as dependency" — then, once offered
`typescript` as a devDependency for proper checking, corrected further:
"we must not have any tsconfigs in our repos", "we want to use bun", "we
doesnt need to install typescript - its supported out of the box by bun".
