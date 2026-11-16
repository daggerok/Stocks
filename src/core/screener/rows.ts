/// <reference lib="esnext" />
/**
 * Row adapter: a company row of api/stocks/index.json and a fund row of an ETF brand index.json become one engine row.
 * size is marketCap for a stock and aumValue for an ETF (plan 1.6). The sector of an ETF is its fund category from the brand
 * feed (owner answer N4; the engine and the scores never mix it with stock sectors); ETFs have no industry (null, so industry
 * conditions treat them as missing). isMine comes from the row's own flag once the feed publishes it (plan 1.1), else from the
 * owner's ticker list passed in. Metrics are read as published: "1-year return" is the total return tr1y for stocks and ETFs
 * (owner answer N2), perf1y is the separate price return and stays empty for ETFs. A stock row also gets the flag isReit from its industry
 */
import type { ScreenerRow } from './types';

type Feed = Record<string, unknown>;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
const metricsOf = (row: Feed): Record<string, unknown> => (row.metrics && typeof row.metrics === 'object' ? (row.metrics as Record<string, unknown>) : {});
export const normalizeTicker = (t: unknown): string => String(t ?? '').trim().toUpperCase().replace(/\./g, '-');

/** A list is normalized on every call; a Set must already hold normalized tickers (one lookup per row, for thousands of rows) */
function mine(row: Feed, ticker: string, list?: ReadonlySet<string> | readonly string[]): boolean {
  if (typeof row.isMine === 'boolean') return row.isMine;
  if (!list) return false;
  if (Array.isArray(list)) return list.some((t) => normalizeTicker(t) === ticker);
  return (list as ReadonlySet<string>).has(ticker);
}

/** A REIT by its Yahoo industry, the same test as the updater's isReit (scripts/metrics/fundamentals.ts) */
export const isReitIndustry = (industry: string | null): boolean => /^REIT\b/.test(industry ?? '');

export function stockRow(company: Feed, mineList?: ReadonlySet<string> | readonly string[]): ScreenerRow {
  const ticker = normalizeTicker(company.ticker);
  const industry = text(company.industry);
  const metrics: Record<string, unknown> = { ...metricsOf(company), isReit: isReitIndustry(industry) }; // the archetype rules judge REITs by FFO growth (owner answer N22)
  return { ticker, type: 'stock', sector: text(company.sector), industry, isMine: mine(company, ticker, mineList), size: num(metrics.marketCap), metrics };
}

/** The metrics of an ETF fund row as the brand feed publishes them */
export const etfMetrics = (fund: Feed): Record<string, unknown> => metricsOf(fund);

export function etfRow(fund: Feed, mineList?: ReadonlySet<string> | readonly string[]): ScreenerRow {
  const ticker = normalizeTicker(fund.ticker);
  return { ticker, type: 'etf', sector: text(fund.category), industry: null, isMine: mine(fund, ticker, mineList), size: num(fund.aumValue), metrics: etfMetrics(fund) };
}

/** All rows of one stocks index and any number of ETF brand indexes; an ETF ticker already present (a fund in two feeds) keeps its first row */
export function universeRows(stocks: Feed | null, etfIndexes: Feed[], mineList?: readonly string[]): ScreenerRow[] {
  const set = mineList ? mineList.map(normalizeTicker) : undefined;
  const out: ScreenerRow[] = [];
  const seen: Record<string, boolean> = {};
  const push = (row: ScreenerRow) => { const key = `${row.type}:${row.ticker}`; if (!seen[key]) { seen[key] = true; out.push(row); } };
  const list = (doc: Feed | null, key: string): Feed[] => (doc && Array.isArray(doc[key]) ? (doc[key] as Feed[]) : []);
  list(stocks, 'companies').forEach((c) => push(stockRow(c, set)));
  etfIndexes.forEach((doc) => list(doc, 'funds').forEach((f) => push(etfRow(f, set))));
  return out;
}

/**
 * The owner's tickers as the page reads them from index.json: mineTickers once the updater publishes them; before that, when no
 * row has an isMine flag, the stock feed itself is the owner's list. The page and the scores snapshot use the same set
 */
export function feedMineSet(companies: readonly Feed[], mineTickers: readonly string[] | null): Set<string> {
  const flagged = companies.some((row) => typeof row.isMine === 'boolean');
  return new Set((mineTickers ? mineTickers : flagged ? [] : companies.map((row) => String(row.ticker))).map(normalizeTicker));
}

/**
 * The engine rows of the page's store, in feed order: every stock row with a ticker (first one of a ticker wins), then the ETF
 * funds of each brand in hub order whose ticker the stocks or an earlier brand do not have (main.tsx buildStore and ensureEtfs)
 */
export function storeRows(companies: readonly unknown[], mine: ReadonlySet<string>, brandFunds: ReadonlyArray<readonly unknown[]> = []): ScreenerRow[] {
  const seen = new Set<string>();
  const out: ScreenerRow[] = [];
  companies.forEach((c) => {
    const row = c as Feed;
    if (!row || typeof row.ticker !== 'string' || !row.ticker || seen.has(row.ticker)) return;
    seen.add(row.ticker);
    out.push(stockRow(row, mine));
  });
  brandFunds.forEach((funds) => funds.forEach((f) => {
    const fund = f as Feed;
    if (!fund || typeof fund.ticker !== 'string' || !fund.ticker.trim()) return;
    const ticker = normalizeTicker(fund.ticker);
    if (seen.has(ticker)) return;
    seen.add(ticker);
    out.push(etfRow(fund, mine));
  }));
  return out;
}
