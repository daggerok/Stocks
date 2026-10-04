# Stocks repo: layout, contract, process

`daggerok/Stocks` is the stocks sibling of the 29 ETF repos and the ETFs hub (`../ETFs`). It is NOT in `../ETFs/.claude/tools/etf-std/registry.json` and the hub does not read it. The ETFs agentic setup (`../ETFs/.claude/`) is the source of truth for shared things; this folder keeps the copies that matter when a session starts here

## Layout
- `scripts/` holds exactly `update-data.config.json`, `update-data.test.ts`, `update-data.ts`; `.github/` holds only `workflows/update-data.yml` and `dependabot.yml`; no tsconfig, no typescript, no fixtures, no helper scripts, no worklog or evidence folders
- GitHub Pages deploys from `main` `/` (`build_type: legacy`), never an Actions workflow
- The workflow is generated from `../ETFs/.claude/tools/stocks-std/spec.json` with `../ETFs/.claude/tools/etf-std/gen-workflow.ts` and never hand-edited (24 `workflow_dispatch` inputs max incl. `advanced`; scheduled runs must guard `DISPATCH_INPUTS`)

## Updater contract
Same as the ETF contract in `../ETFs/.claude/rules/etf-updater-contract.md` (controls precedence, strict validation, `USE_SYSTEM_CA`, real per-worker concurrency, timeouts and retries, atomic ordered writes, zero-diff reruns, fund-level consistency, soft deadline 25 min, never-shrinking index, `NEW` list in the step summary, SEC contact `daggerok ETF feed daggerok@gmail.com`), with `companies` instead of `funds`, the stock metric set, `EXCHANGES` and `MARKET_CAP` controls and no AUM/TER/holdings controls. The stock standard is `../ETFs/.claude/tools/stocks-std/STANDARD.md`

## Process
- Work on a branch off the fresh `origin/main`, open a PR, merge with `gh pr merge --rebase --delete-branch` once the gates pass (owner's standing delegation), then `git switch main && git pull --ff-only` and delete the local branch. Never push to `main`
- Gates: `bun install --frozen-lockfile`, `bun test` (exit 0), `bun build --target=bun scripts/update-data.ts --outfile=/dev/null`, `bun build --target=bun app.tsx --outfile=/dev/null`, `git diff --check`, `bun ../ETFs/.claude/tools/stocks-std/check-readme.ts .` and the workflow and scripts checks of `etf-std`; after changing the controls regenerate the workflow and update the README controls table
- UI changes also need the browser tests of `../ETFs/.claude/tools/ui-std/` (`stocks-filters-uitest.ts`, `stocks-columns-uitest.ts`) ending `0 failed; console errors: none`
- Never commit data from a test or acceptance run (`git checkout -- api/` and delete created files); the published feed is the one the workflow produces
- Commit messages are Conventional Commits; prose uses plain hyphens and `->`, no trailing periods
- Branch hygiene: no stale branches. `../ETFs/.claude/tools/cleanup-branches.sh . Stocks dry|do` lists and removes local and remote branches whose work is already in `main`

## UI
Look and behavior follow `../ETFs/.claude/rules/ui-standard.md` (column types and filters, Columns menu with locked Use and Ticker, short `Filters: on` label, toolbar order). Stocks keeps its filter state in `state.filters`, `typeOverrides`, `hiddenCols` (not `columnFilterState`/CSS-position hiding) and its own `DAY_MS` engine constant; when the shared blocks change, port the change here by hand and run both Stocks browser tests
