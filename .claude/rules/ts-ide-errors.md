# IDE type errors: IntelliJ is the owner's type gate

The owner opens each repo in IntelliJ without a tsconfig. Its TypeScript service then loads NO `@types` automatically: a file sees only what it references with `/// <reference types="..." />` (so a file that uses `Bun.*` needs the `bun` reference, a file that uses `node:*` the `node` one; iShares and Amplify carry both). Errors there do not break `bun test` or `bun run`, which is why 100+ of them lived unnoticed until the 2026-10-04 cleanup. Fix the real file, never silence it (no `@ts-ignore`, no `any` to hide an error, no tsconfig, no `typescript` in a repo)

## The sanctioned check
`../ETFs/.claude/tools/tc/check.sh <repo-dir> [files]` (the shared tool lives in the ETFs repo folder, sibling path) (default: `scripts/update-data.ts`, `scripts/update-data.test.ts`, `src/main.tsx`) runs a throwaway `tsc --strict` that mirrors IntelliJ (no automatic `@types`, only reference directives). It lives outside every repo (the `tc/` tools folder holds its own `typescript`; first use: `cd ../ETFs/.claude/tools/tc && bun add typescript`). It prints `error TS` lines, exit 0 means clean. This is the only allowed type check, an owner-approved exception to the no-tsc rule in `bun-only-tooling.md`
- Definition of done for any change to an updater, its test or `src/main.tsx`: the check prints nothing, plus the usual gates (`bun test` exit 0, both `bun build`, `git diff --check`)
- When the checker and an owner screenshot disagree, recalibrate the checker before fixing blind. A first version that passed `--types bun,node` hid iShares' missing Bun reference
- IntelliJ's "N problems" counts warnings too (unused functions, regex escapes, "caught locally"); only `error` severity is the gate
- A screenshot shows the owner's LOCAL working tree: if an error is already fixed on `origin/main`, ask for `git pull` instead of re-fixing

## Patterns fixed on 2026-10-04 (do not reintroduce)
- Never declare a local `declare const process: {...}` shim in a module: it shadows the global type and hides `execArgv`, `execPath`, `exit` (8 repos had it). The `reference types` line provides `process`
- Fetch mocks: Bun's `typeof fetch` has a static `preconnect`, so a plain mock is not assignable. Cast `as unknown as typeof fetch` once through a small helper, or type an option as a call signature `(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>`. Response bodies are `new Uint8Array(buf)` / `Uint8Array<ArrayBuffer>`, not a `Buffer`
- Generic constraints must not be all-optional "weak" types (`T extends { metrics?: any }` rejects `Record<string, unknown> & { ticker }`): use `T extends object` and read the key through a cast
- `numberOrNull(x) === null ? DASH : numberOrNull(x).toFixed()` does not narrow: call once and use `?.toFixed() ?? DASH`. `terms[t].field` does not narrow across the index: copy it to a local
- A `const` whose initializer references itself needs an explicit type (TS7022); test tables need typed arrays (`Array<Record<string, string>>`), mixed `expect` values `expect<unknown[]>(...)`
- `pathToFileURL(...)` returns `node:url`'s URL: wrap as `new URL(pathToFileURL(p).href)` where the global `URL` type is expected

## Errors that are REAL bugs, not typing noise (investigate before touching)
- "Cannot find name X": a missing definition. Global-X's `parseNportXml` called undefined `xmlTagText`, `xmlValue`, `NportPosition` since the first commit, so the EDGAR fallback threw `ReferenceError` (tests did not cover it)
- TS2393 / TS2323 duplicate declarations: find which one is live (the later wins), delete the dead one (Pacer had `configurePacing` twice)
- "Element implicitly has an any type" on a key map: SP-Funds read `metrics.yr1` while metrics carry `tr1y`, so every `TOTAL_RETURN_1Y/3Y/5Y/10Y` filter rejected every fund
- For each such finding add a tiny inline test that fails without the fix
