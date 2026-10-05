# Stocks

One of the app's features lets you rank every stock of Nasdaq, NYSE and Cboe on the numbers that matter to a long-term holder: dividend yield, dividend growth, payout and FCF payout, quick and current ratios, debt to equity and net debt to EBITDA, revenue, EPS, FCF, EBITDA, CapEx, asset and debt growth, net, gross, EBITDA and FCF margins with their year-over-year change, ROIC, valuation multiples (P/E, forward P/E, P/S, forward P/S, P/FCF, EV/EBITDA, FCF/EBITDA) and performance and total returns over 1, 3, 5 and 10 years with CAGRs. Another feature lets you tick stocks into a Watchlist, open per-stock Fundamentals, Dividends and History tabs, and copy or export the tickers. A client-side tool (Parcel + Tailwind CSS v4, built into `dist`) that reads the generated `./api/stocks` static feed (SEC EDGAR XBRL annual filings, SEC company ticker table, Yahoo Finance prices, dividends and valuation snapshot) into a searchable stock catalog - the same look, feel and interaction model as the ETFs applications, with no runtime dependencies

## Using Bun

```bash
bunx degit daggerok/Stocks#main ./12345 && cd $_
bun install
bun run serve
open http://0:1234
```

`bun run serve` is the Parcel dev server (it copies `api/` into `dist/api` first); `bun run build` writes the production site to `dist` and `bun run build-github-pages` does the same for the `/Stocks/` public URL

The published application is available at <https://daggerok.github.io/Stocks/>

### Column types and filters

Every column of the catalog and of the Fundamentals, Dividends and History tabs has a type: text (`ABC`), number (`123`), percentage (`%`), money (`$`), date (`D`), date and time (`DT`) or time of day (`T`). The type is detected from the texts the column shows (80% of the filled cells must agree, otherwise text) and is written in the badge next to the column title: click it to cycle the type, Shift+click to return to auto-detection. Dates are read as `2024-06-15`, `6/15/2024`, `15.06.2024`, `Jun 15, 2024` or `15-Jun-2024`, date and time as `2024-06-15T09:30:00Z` or `2024-06-15 09:30`, time as `09:30`, `16:00:00` or `9:30 PM`

A row of filter inputs sits under the column headers (the `Filters` button hides it, `Clear filters` empties it). Filters of different columns are combined with AND, the Search box and the Exchanges, Sectors and Hide stale controls apply on top, and Copy Tickers and the exports use the filtered rows. Filters and type overrides are remembered in the browser; filters keep working on columns that are hidden in the Columns menu (hiding a column only hides it from the table). The `Columns` menu lists every column one by one (Use and Ticker are listed but locked, everything else is shown by default, with search, All, Clear, Toggle and Reset) and the choice is remembered in the browser. `Sticky #` (next to `Filters`, off by default, remembered in the browser) numbers the rows by their rank in the table sorted by the current column before the column filters, so a filtered stock keeps its rank and the numbers keep gaps; the sort, the search, the Watchlist and the Exchanges, Sectors, blacklist and Hide stale choices rank again. Every export starts with the `#` column. The red `Clear` button asks once, listing what it resets and what it keeps, then forgets everything saved in the browser except the blacklist and the theme, so the page looks like a first visit (also after a reload)

Inside one filter: a space means AND, a comma means OR, a leading `!` means NOT, `?` matches an empty or unavailable value and `!?` a value that is there; a value that is unavailable matches only `?` and negated conditions. An unquoted space ends the value, so quote values that contain one (`>="2024-06-15 09:30"`)

| Type | Examples |
| --- | --- |
| Text | `bank` contains, `"two words"`, `!bank`, `=exact`, `^starts`, `ends$`, `/regex/`, `tech, health` |
| Number, percentage, money | `>10`, `>=10 <50`, `=22` (matches what rounds to 22), `!=22`, `10..50`, `..50`, `10..`, `>1B` and `K` `M` `B` `T` suffixes, an optional `$` or `%` |
| Date, date and time | `>2024-06-01`, `2024` (the whole year), `2024-06` (the whole month), `2024-01..2024-06`, `today`, `yesterday`, `-7d..` (the last 7 days), `+2w`, `-3m`, `-1y` |
| Time | `>09:30`, `09:30..16:00`, `=12:00` (the whole minute) |

## Updating the static Stocks data

Run the updater with Bun:

```bash
bun test
./scripts/update-data.ts
```

Run `./scripts/update-data.ts -h` (or `--help`) to print every configuration variable with its default and usage examples

Defaults live in `scripts/update-data.config.json` (every control as a string). An explicitly set environment variable overrides the file, even when it is empty. The **Update Stocks data** GitHub Actions workflow uses the same resolver (`resolveControls` in `scripts/update-data.ts`): individual `workflow_dispatch` inputs are blank by default and inherit the file, and the `advanced` input accepts a JSON object with any control (for example `{"VERBOSE":"true"}`). Precedence: file defaults < advanced JSON < nonblank inputs < protected Actions variable or environment. `SEC_UA` and `USE_SYSTEM_CA` are set through `advanced`, and `SEC_UA` is also taken from the protected `SEC_UA` repository Actions variable when it is nonblank. The workflow always writes to `api/stocks` only. All supplied filters use **AND** logic

### Data sources

| Block | Source |
| --- | --- |
| Universe, exchange, CIK | SEC `https://www.sec.gov/files/company_tickers_exchange.json` (Nasdaq, NYSE and Cboe rows; OTC and unlisted rows are ignored) |
| Annual fundamentals | SEC EDGAR XBRL `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`, 10-K facts only, up to 15 fiscal years |
| Fundamentals gap filler | Yahoo Finance `fundamentals-timeseries` (about 4 years): fills tags SEC does not carry and covers IFRS filers and holding-company reorganizations |
| Price history, dividends, returns | Yahoo Finance public chart API (`/v8/finance/chart/{TICKER}?interval=1d&events=div,split`) |
| Market cap, TTM and forward valuation, sector | Yahoo Finance `quoteSummary` (needs a cookie and a crumb, opened once per run; a failed session leaves the forward multiples unavailable) |

### Metrics and caveats

Each stock carries a `metrics` object that powers the catalog columns. Percent values are plain numbers (`12.5` means 12.5%), ratios are plain numbers, money is USD

| Group | Keys | Meaning |
| --- | --- | --- |
| Valuation | `marketCap`, `pe`, `forwardPe`, `ps`, `forwardPs`, `pFcf`, `evEbitda`, `fcfToEbitda`, `pb`, `enterpriseValue` | Yahoo TTM snapshot; forward values use the next fiscal year consensus; `pFcf` is market cap over TTM free cash flow, `fcfToEbitda` is cash conversion in % |
| Dividends | `dividendYield`, `dividendRate`, `dividendGrowth`, `dividendGrowth3y`, `dividendGrowth5y`, `payoutRatio`, `fcfPayout` | Yield from the last 12 months of ex-dates over the last close; growth from calendar-year sums of split-adjusted dividends (last complete year, 1-year growth and 3 and 5-year CAGR); payout and FCF payout are dividends paid over net income and over free cash flow of the latest fiscal year |
| Balance sheet | `quickRatio`, `currentRatio`, `debtToEquity`, `netDebtToEbitda`, `roic` | Latest fiscal year end; quick = (cash and short-term investments + receivables) / current liabilities; net debt subtracts cash plus short and long-term investments; ROIC = operating income after tax / average (debt + equity - cash) |
| Growth | `revenueGrowth`, `epsGrowth`, `fcfGrowth`, `ebitdaGrowth`, `capexGrowth`, `assetsGrowth`, `debtGrowth` and the same with `3y` and `5y` | 1-year change relative to the absolute previous value; 3 and 5-year CAGR need two positive endpoints and consecutive fiscal years |
| Margins | `netMargin`, `grossMargin`, `ebitdaMargin`, `fcfMargin`, and `...Delta`, `...Delta3y` | Latest fiscal year over revenue; deltas are percentage-point changes versus 1 and 3 fiscal years earlier |
| Performance | `perfYtd`, `perf1y`, `perf3y`, `perf5y`, `perf10y` | Cumulative price change from unadjusted closes |
| Total return | `ytd`, `tr1y`, `tr3y`, `tr5y`, `tr10y`, `cagr3y`, `cagr5y`, `cagr10y`, `siAnn` | Cumulative and annualized return from dividend and split-adjusted closes; `siAnn` is since listing |
| Market | `price`, `week52High`, `week52Low`, `beta`, `sharesOutstanding` | Yahoo Finance |
| Provenance | `returnsBasis`, `performanceAsOf` | Mandatory: how the returns were computed and the ISO date of the last price they are as of |

Caveats:

- Unavailable values stay empty and are never written as `0`; the one exception is a dividend yield of `0`, which honestly means no payment in the last 12 months
- Fundamentals describe the latest fiscal year of the 10-K, not the trailing twelve months; the row carries `fundamentalsAsOf` and `fundamentalsBasis` (SEC, SEC with Yahoo gap fill, or Yahoo only)
- EBITDA is operating income plus depreciation and amortization (the combined D&A line, or depreciation plus intangible amortization when a filer tags them separately); it excludes non-operating income, so it can differ from Yahoo's EBITDA, which the `evEbitda` and `fcfToEbitda` multiples use
- Banks, insurers and other issuers without an operating income, capital expenditures or a classified balance sheet have those metrics unavailable
- ADRs and other issuers whose reporting currency differs from the price currency keep growth and margins but lose every multiple that mixes the two currencies
- Share classes (GOOG and GOOGL, BRK-B) share one set of fundamentals and differ only in market data
- Price history is published as month-end rows with daily rows for the last 31 days; returns are computed from the full daily series before that sampling
- NYSE Arca has no stock rows in the SEC company table; Arca-listed stocks are not covered
- A stock whose Yahoo quote type is not `EQUITY` (ETFs, funds) is skipped; so is a security without a market cap (SPAC units and warrants, baby bonds, preferred shares) and a CIK that has no SEC company facts and no Yahoo statements (closed-end funds, trusts)
- SPAC shells and other new listings without a full fiscal year stay in the catalog with unavailable fundamentals; filter them by sector or industry
- The feed holds about 6,000 stocks, roughly 35 KB each plus a 17 MB `index.json`; it stays under the 1 GB GitHub Pages size limit, and a weekly run rewrites most files, so the Git history grows by tens of MB per run

### Update controls

Keep this table, `scripts/update-data.config.json`, `CONTROL_NAMES` and `--help` in sync

| Control | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | `0` (all) | Batch size: with a positive value the updater stops after that many stocks and the next full-universe run continues after the committed cursor in `api/stocks/update-state.json`; empty or `0` is a full pass (a run that hits the 25-minute soft deadline also saves the cursor) |
| `REQUEST_SLEEP` | `1` | Minimum delay in seconds between request starts of one worker lane, including retries |
| `CONCURRENCY` | `24` | Number of parallel workers; each worker owns a request lane paced by `REQUEST_SLEEP`; 24 lanes refresh about 6 stocks per second, so the whole universe fits one 25-minute run |
| `MAX_RETRIES` | `2` | Integer >= 1; retries after the initial request; only network errors and HTTP 403/408/425/429/5xx are retried with exponential backoff |
| `EXCHANGES` | `Nasdaq,NYSE,CBOE` | Listing exchanges to include, as named in the SEC company table |
| `TICKERS` | empty (all) | Space-, comma- or semicolon-separated ticker allowlist (`BRK.B` and `BRK-B` both work); blank means every stock listed on `EXCHANGES`; a run with `TICKERS` never reads or moves the rotation cursor |
| `MARKET_CAP` | `:` | Market cap range in USD (strict `min:max`); each bound may use `K`, `M`, `B` or `T`, for example `10B:` |
| `DIVIDEND_YIELD` | `:` | Dividend-yield percentage range |
| `HISTORY_RANGE` | `max` | Yahoo chart range for the price history (`max`, `10y`, `5y`, ...); a limited range is requested with explicit `period1` and `period2` |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated history JSON page |
| `SKIP_YAHOO` | `false` | Keep the published market data and history while refreshing SEC fundamentals |
| `SEC_UA` | `daggerok ETF feed daggerok@gmail.com` | SEC User-Agent override; SEC policy requires automated tools to declare a contact; the protected `SEC_UA` Actions variable wins when nonblank |
| `VERBOSE` | `false` | Print per-stock retry and fallback notices |
| `USE_SYSTEM_CA` | `auto` | TLS trust store: `auto` restarts the updater once with Bun's `--use-system-ca` when a request fails with an untrusted-certificate error; `true` always uses the system CA store; `false` never restarts. Not an individual workflow input: use `advanced`, the config file or the CLI environment |
| `PERFORMANCE_YTD`, `_1Y`, `_3Y`, `_5Y`, `_10Y` | `:` | Cumulative price change ranges in % (`min:max`) |
| `TOTAL_RETURN_YTD`, `_1Y`, `_3Y`, `_5Y`, `_10Y` | `:` | Cumulative total return ranges in % (`min:max`) |

`TICKERS` combines with the market cap, yield and return filters using AND logic; it does not override them. A stock without a value for an active range does not match it. Filtered or bounded runs (`TICKERS`, `MAX_FETCHES`, any range filter, `SKIP_YAHOO`) never shrink the feed: stocks that are not selected, are skipped by a filter or fail keep their published row and data files, and `api/stocks/index.json` always lists every stock that has a `companies/*/meta.json`. The default run covers the whole universe: every Nasdaq, NYSE and Cboe listing of the SEC table except preferred shares, warrants, rights and units (tickers ending in `-P*`, `-W*`, `-R*`, `-U*`) and except securities Yahoo reports without a market cap or as funds. Narrow it with `TICKERS` or a `MARKET_CAP` floor

### Examples

```bash
TICKERS="AAPL MSFT JPM XOM" ./scripts/update-data.ts
MAX_FETCHES=500 ./scripts/update-data.ts
MARKET_CAP="10B:" ./scripts/update-data.ts
DIVIDEND_YIELD="2:" TOTAL_RETURN_5Y="50:" ./scripts/update-data.ts
SKIP_YAHOO=true ./scripts/update-data.ts
```

## TypeScript and verification

The browser app lives in `src/`: `index.html` (markup), `main.tsx` (TypeScript), `index.css` (Tailwind CSS v4 plus the app styles) and `favicon.ico`, built by Parcel into `dist` (`bun run build`, same setup as daggerok/csv and daggerok/options-desk) - no `tsconfig.json` needed. Bun runs the updater TypeScript out of the box. The migration notes are in `.claude/parcel-migration.md`

Verification before every publish:

```bash
bun install --frozen-lockfile
bun test
bun build --target=bun scripts/update-data.ts --outfile=/dev/null
git diff --check
```

`bun test` also covers the README controls table, the config file, `--help` and the workflow

## Exchanges table

| Exchange | Where to get the data |
| --- | --- |
| **Nasdaq** | [sec.gov company tickers](https://www.sec.gov/files/company_tickers_exchange.json) \| [Stocks](https://daggerok.github.io/Stocks/) |
| **NYSE** | [sec.gov company tickers](https://www.sec.gov/files/company_tickers_exchange.json) \| [Stocks](https://daggerok.github.io/Stocks/) |
| **Cboe** | [sec.gov company tickers](https://www.sec.gov/files/company_tickers_exchange.json) \| [Stocks](https://daggerok.github.io/Stocks/) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| ETFs | The generated `./api/<slug>` static feeds of the 29 ETF brand repositories (issuer pages, SEC EDGAR N-PORT-P and Yahoo Finance) | [ETFs](https://github.com/daggerok/ETFs) |

## License

[MIT - same as all sibling repositories.](./LICENSE)

This is an independent, unofficial tool; it is not affiliated with, endorsed by, or sponsored by Nasdaq, NYSE, Cboe, the U.S. Securities and Exchange Commission, Yahoo or any listed company. All trademarks, company names and tickers referenced here are the property of their respective owners. All data is reproduced from public SEC EDGAR filings and Yahoo Finance for research purposes; nothing here is investment advice
