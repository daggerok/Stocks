# Never remove the `/// <reference types="bun" />` / `<reference types="node" />` line

Any `.ts`/`.tsx`/`.js`/`.jsx` file in this repo (`scripts/update-data.ts`, its test and `app.tsx`; the same rule holds in the 29 ETF repos and the hub) that uses Bun-style
functionality (top-level `import ... from 'node:*'` run directly by Bun,
`Bun.*` APIs, `bun:test`, `import.meta.main`, etc.) needs a triple-slash
reference directive (`/// <reference types="bun" />` or `"node"`) so
IntelliJ IDEA's TypeScript/JS language service resolves the ambient types
instead of flagging the file as errored. `scripts/update-data.ts` in every
repo already carries this, placed right before the file's own original
imports/business logic (below the shared "output*" presentation prelude
where one has been added).

Without it, IntelliJ IDEA's TS language service reports errors like:

```
TS2591: Cannot find name 'node:path'. Do you need to install type
definitions for node? Try `npm i --save-dev @types/node` and then add
`node` to the types field in your tsconfig.
```

even though `@types/node`/`@types/bun` are already installed — the project
has no `tsconfig.json` pulling them in automatically, so each file needs the
triple-slash reference itself.

When editing any such file, never delete, move, or otherwise disturb this
line. It has no reason to change — if a diff touches it, that's a mistake,
not an intended edit. When creating or substantially editing a Bun-style
file that doesn't have it yet, add it. Always verify after editing with:

```
grep -n '<reference types=' scripts/update-data.ts
```

and confirm the line still appears, unchanged, at its original position.

## Each file references every type set it uses (2026-10-04)

IntelliJ without a tsconfig sees only the types a file references. A file that calls `Bun.*` needs `/// <reference types="bun" />`, one that uses `node:*` needs `node`. Add a second line, never replace or move the existing one. Verify with `../ETFs/.claude/tools/tc/check.sh .` (see `ts-ide-errors.md`)
