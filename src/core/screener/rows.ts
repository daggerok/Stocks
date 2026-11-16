/// <reference lib="esnext" />
/**
 * Row adapter: a company row of api/stocks/index.json (the Stocks page) or a fund row of an ETF brand index.json (the ETFs hub,
 * which reads the brand feeds itself) becomes an engine row.
 * size is marketCap for a stock and aumValue for an ETF (plan 1.6). The sector of an ETF is its fund category from the brand
 * feed (owner answer N4; the engine and the scores never mix it with stock sectors); ETFs have no industry (null, so industry
 * conditions treat them as missing). isMine comes from the row's own flag once the feed publishes it (plan 1.1), else from the
 * owner's ticker list passed in. Metrics are read as published: "1-year return" is the total return tr1y for stocks and ETFs
 * (owner answer N2), perf1y is the separate price return (ETFs publish it from the benchmark block). A stock row also gets the flag
 * isReit from its industry. An ETF row also gets expenseRatio and expenseRatioGross from terValue and terGrossValue, and with the
 * compiled classes (etfClasses() over etf-classes.json and qdi.json, benchmark plan sections 5 and 6) isGeared, indexFamily,
 * indexVariant, the normalized sector or theme as industry and the qualified dividend keys
 */
import type { Text } from '../metrics/types';
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

export function etfRow(fund: Feed, mineList?: ReadonlySet<string> | readonly string[] | null, classes?: EtfClasses | null): ScreenerRow {
  const ticker = normalizeTicker(fund.ticker);
  const metrics: Record<string, unknown> = { ...etfMetrics(fund), expenseRatio: num(fund.terValue), expenseRatioGross: num(fund.terGrossValue) };
  let industry: string | null = null;
  if (classes) {
    const c = classifyEtf(classes, ticker, text(fund.name) ?? '', text(fund.category) ?? '');
    metrics.isGeared = c.isGeared;
    metrics.indexFamily = c.indexFamily;
    metrics.indexVariant = c.indexVariant;
    metrics.qualifiedDividendPct = c.qualifiedDividendPct;
    metrics.qualifiedDividendYear = c.qualifiedDividendYear;
    metrics.qualifiedDividendBasis = c.qualifiedDividendBasis;
    industry = c.industry;
  }
  return { ticker, type: 'etf', sector: text(fund.category), industry, isMine: mine(fund, ticker, mineList ?? undefined), size: num(fund.aumValue), metrics };
}

// ---- ETF classes (benchmark plan 5 and 6.3): etf-classes.json and qdi.json compiled once, then one classify call per fund row ----

type NameRule = { name?: string; category?: string; tickers?: string[] };
/** etf-classes.json as written */
export type EtfClassesFile = {
  schemaVersion: number;
  geared: { name: string[]; tickers?: string[]; notTickers?: string[] };
  family: Record<string, { name: string; tickers: string[] }>;
  variants: Array<[string, string]>;
  sectorExclude: NameRule;
  sectors: Array<{ id: string; title: Text; name: string; tickers?: string[] }>;
  qdiEstimate: Array<NameRule & { class: string; pct: number | null; geared?: boolean }>;
};
/** qdi.json of the workspace tool etf-std/qdi/build.ts: the official share per ticker of one tax year */
export type QdiFile = { year: number; source?: Record<string, string>; values: Record<string, number> };

type Matcher = { name: RegExp | null; category: RegExp | null; tickers: Record<string, boolean> };
export type EtfClasses = {
  geared: RegExp[]; gearedYes: Record<string, boolean>; gearedNo: Record<string, boolean>;
  family: Array<{ id: string; m: Matcher }>; variants: Array<{ id: string; re: RegExp }>;
  sectorExclude: Matcher; sectors: Array<{ id: string; title: Text; m: Matcher }>;
  qdi: Array<{ id: string; pct: number | null; geared: boolean; m: Matcher }>;
  qdiYear: number | null; qdiValues: Record<string, number>;
  /** classifyEtf results by ticker, name and category: the hub rebuilds its rows on every feed that streams in */
  cache: Record<string, EtfClass>;
};
export type EtfClass = {
  isGeared: boolean; indexFamily: string | null; indexVariant: string | null; industry: string | null;
  qualifiedDividendPct: number | null; qualifiedDividendYear: number | null; qualifiedDividendBasis: 'official' | 'estimated' | null;
  /** the estimate class of 6.3 that set an estimated value (or would have), for the review list */
  qdiClass: string | null;
};

const re = (source: string | undefined): RegExp | null => (source ? new RegExp(source, 'i') : null);
const tickerSet = (list: readonly string[] | undefined): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  (list || []).forEach((t) => { out[normalizeTicker(t)] = true; });
  return out;
};
const matcher = (rule: NameRule): Matcher => ({ name: re(rule.name), category: re(rule.category), tickers: tickerSet(rule.tickers) });
const hit = (m: Matcher, ticker: string, name: string, category: string): boolean => !!m.tickers[ticker] || (!!m.name && m.name.test(name)) || (!!m.category && !!category && m.category.test(category));

/** Compiles the two files once (the regexes are built here, not per row); qdi may be null (no official values: estimates only) */
export function etfClasses(file: EtfClassesFile, qdi?: QdiFile | null): EtfClasses {
  const values: Record<string, number> = {};
  if (qdi && qdi.values) Object.keys(qdi.values).forEach((t) => { if (typeof qdi.values[t] === 'number' && isFinite(qdi.values[t])) values[normalizeTicker(t)] = qdi.values[t]; });
  return {
    geared: file.geared.name.map((s) => new RegExp(s, 'i')), gearedYes: tickerSet(file.geared.tickers), gearedNo: tickerSet(file.geared.notTickers),
    family: Object.keys(file.family).map((id) => ({ id, m: matcher(file.family[id]) })),
    variants: file.variants.map(([id, source]) => ({ id, re: new RegExp(source, 'i') })),
    sectorExclude: matcher(file.sectorExclude),
    sectors: file.sectors.map((s) => ({ id: s.id, title: s.title, m: matcher(s) })),
    qdi: file.qdiEstimate.map((r) => ({ id: r.class, pct: r.pct, geared: r.geared === true, m: matcher(r) })),
    qdiYear: qdi && typeof qdi.year === 'number' ? qdi.year : null, qdiValues: values, cache: {},
  };
}

/** The classes of one fund from its ticker, name and brand category; a ticker list of a class wins over its name rule */
export function classifyEtf(c: EtfClasses, ticker: string, name: string, category: string): EtfClass {
  const key = `${ticker}|${name}|${category}`;
  const cached = c.cache[key];
  if (cached) return cached;
  const out = classifyOnce(c, ticker, name, category);
  c.cache[key] = out;
  return out;
}

function classifyOnce(c: EtfClasses, ticker: string, name: string, category: string): EtfClass {
  const isGeared = !c.gearedNo[ticker] && (!!c.gearedYes[ticker] || c.geared.some((r) => r.test(name)));
  const family = c.family.filter((f) => !!f.m.tickers[ticker])[0] || c.family.filter((f) => hit(f.m, ticker, name, ''))[0];
  const indexFamily = family ? family.id : null;
  const variant = isGeared ? 'geared' : (c.variants.filter((v) => v.re.test(name))[0] || { id: 'core' }).id;
  const forced = c.sectors.filter((s) => !!s.m.tickers[ticker])[0];
  const excluded = !forced && (isGeared || hit(c.sectorExclude, ticker, name, category));
  const sector = forced || (excluded ? undefined : c.sectors.filter((s) => !!s.m.name && s.m.name.test(name))[0]);
  const estimate = c.qdi.filter((r) => (r.geared ? isGeared : hit(r.m, ticker, name, category) || (!r.m.name && !r.m.category && !Object.keys(r.m.tickers).length)))[0];
  const official = c.qdiValues[ticker];
  const hasOfficial = typeof official === 'number';
  const pct = hasOfficial ? official : estimate ? estimate.pct : null;
  return {
    isGeared, indexFamily, indexVariant: indexFamily ? variant : null, industry: sector ? sector.id : null,
    qualifiedDividendPct: pct, qualifiedDividendYear: pct === null ? null : hasOfficial ? c.qdiYear : null,
    qualifiedDividendBasis: pct === null ? null : hasOfficial ? 'official' : 'estimated', qdiClass: estimate ? estimate.id : null,
  };
}

/** The title of a normalized ETF sector or theme id (the Industry column), the id itself when unknown */
export const etfIndustryTitle = (c: EtfClasses, id: string): Text => (c.sectors.filter((s) => s.id === id)[0] || { title: { en: id, ru: id } }).title;

/**
 * The owner's tickers as the page reads them from index.json: mineTickers once the updater publishes them; before that, when no
 * row has an isMine flag, the stock feed itself is the owner's list. The page and the scores snapshot use the same set
 */
export function feedMineSet(companies: readonly Feed[], mineTickers: readonly string[] | null): Set<string> {
  const flagged = companies.some((row) => typeof row.isMine === 'boolean');
  return new Set((mineTickers ? mineTickers : flagged ? [] : companies.map((row) => String(row.ticker))).map(normalizeTicker));
}

/**
 * The engine rows of the Stocks page's store, in feed order: every stock row with a ticker (first one of a ticker wins), as
 * main.tsx buildStore. Stocks lists stocks only; the ETFs hub builds its fund rows with etfRow
 */
export function storeRows(companies: readonly unknown[], mine: ReadonlySet<string>): ScreenerRow[] {
  const seen = new Set<string>();
  const out: ScreenerRow[] = [];
  companies.forEach((c) => {
    const row = c as Feed;
    if (!row || typeof row.ticker !== 'string' || !row.ticker || seen.has(row.ticker)) return;
    seen.add(row.ticker);
    out.push(stockRow(row, mine));
  });
  return out;
}
