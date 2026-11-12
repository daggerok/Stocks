/// <reference lib="esnext" />
/**
 * Row adapter: a company row of api/stocks/index.json and a fund row of an ETF brand index.json become one engine row.
 * size is marketCap for a stock and aumValue for an ETF (plan 1.6); ETFs carry no sector or industry yet (null, so sector
 * and industry conditions treat them as missing). isMine comes from the row's own flag once the feed publishes it (plan 1.1),
 * else from the owner's ticker list passed in. ETF feeds publish no price perf1y yet: an ETF row reads its total return tr1y as
 * perf1y (open question N2 of the plan), so "1-year return > 0" also selects ETFs
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

export function stockRow(company: Feed, mineList?: ReadonlySet<string> | readonly string[]): ScreenerRow {
  const ticker = normalizeTicker(company.ticker);
  const metrics = metricsOf(company);
  return { ticker, type: 'stock', sector: text(company.sector), industry: text(company.industry), isMine: mine(company, ticker, mineList), size: num(metrics.marketCap), metrics };
}

/** perf1y of an ETF row: its own when published, else tr1y */
export function etfMetrics(fund: Feed): Record<string, unknown> {
  const metrics = metricsOf(fund);
  if (num(metrics.perf1y) !== null || num(metrics.tr1y) === null) return metrics;
  return { ...metrics, perf1y: metrics.tr1y };
}

export function etfRow(fund: Feed, mineList?: ReadonlySet<string> | readonly string[]): ScreenerRow {
  const ticker = normalizeTicker(fund.ticker);
  return { ticker, type: 'etf', sector: null, industry: null, isMine: mine(fund, ticker, mineList), size: num(fund.aumValue), metrics: etfMetrics(fund) };
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
