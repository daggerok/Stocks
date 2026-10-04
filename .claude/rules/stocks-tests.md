# Stocks tests: one small suite, the same shape as the ETF repos

Rules are the ETF ones in `../ETFs/.claude/rules/etf-tests.md`; this is the Stocks form

- `scripts/update-data.test.ts` is the only test file, five `describe` groups: `controls`, `parsing`, `metrics`, `pipeline`, `network`; small inline samples, no fixtures, no network, no UI or app tests (the app is covered by the browser tests in `../ETFs/.claude/tools/ui-std/`)
- `pipeline` covers: a one-ticker run keeps every catalog row, a second identical run writes nothing, a failed source keeps the company exactly as published, rotation cursor and soft deadline
- Portability: sort `readdirSync` results, no wall-clock thresholds below ~1 s (fake clock), pin time zones, build env explicitly per test and restore `globalThis.fetch` and `process.exitCode` in `afterEach`, per-test temp dir removed in `finally`
- `bun test` must exit 0, not only print `0 fail`; also run it once with the workflow's control variables exported
- A test never reads the published `api/stocks` files and never changes them
- And `../ETFs/.claude/tools/tc/check.sh .` prints nothing (no IDE type errors in the updater, its test or `app.tsx`; see `ts-ide-errors.md`)
