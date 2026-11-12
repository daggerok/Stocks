#!/usr/bin/env bun
// Bun provides Node-compatible fs/promises; node types are intentionally not required at runtime.
/// <reference types="bun" />
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { epsCagr3y, ESTIMATE_METRIC_KEYS, estimateMetrics, parseEstimates, type Estimates } from './metrics/estimates';
import { capMultiples, FUNDAMENTAL_METRIC_KEYS, fundamentalMetrics, isFinancial, ownEbitdaMetrics, STALE_TTM_MULTIPLE_KEYS, staleAnnualTtm, withSectorExceptions } from './metrics/fundamentals';
import { HISTORY_METRIC_KEYS, historyMetrics } from './metrics/history';
import { DIVIDEND_HISTORY_KEYS, dividendHistory } from './metrics/dividends';
import { pctFrom52wHigh, swingMetrics } from './metrics/swing';
import { column, parseCompanyFacts, SEC_FORMS, type SecFundamentals, type Split } from './sec/companyfacts';
import { fxPairs, fxPoints, usdLayer, usdView, type FxSeries, type UsdLayer } from './sec/fx';
import { instanceFile, needsClassShares, parseInstanceShares, publishedShares, ttmAccession, withClassShares } from './sec/shares';
import { TAGS } from './sec/tags';
import { computeSignals, parseSignals, signalNames, signalsIssue, SIGNALS_FILE, type SignalsResult } from '../src/core/signals';
import { loadSignalSources } from '../src/core/signals/load';

// Stocks listed on Nasdaq, NYSE and Cboe: static ./api/stocks feed.
//   universe      SEC company_tickers_exchange.json (ticker, CIK, exchange)
//   fundamentals  SEC EDGAR XBRL companyfacts (annual 10-K series up to ~15 years; scripts/sec: 10-K and 10-Q quarters and TTM,
//                 20-F and 40-F of foreign issuers in us-gaap or ifrs-full, converted to USD at Yahoo FX rates by scripts/sec/fx.ts)
//   market data   Yahoo Finance chart API (history, dividends, returns)
//   snapshot      Yahoo Finance quoteSummary (market cap, TTM and forward valuation; needs cookie + crumb)

type JsonRecord = Record<string, any>;
type Range = { min?: number; max?: number };

const SEC_SITE = 'https://www.sec.gov';
const SEC_TICKERS_URL = `${SEC_SITE}/files/company_tickers_exchange.json`;
const SEC_FACTS_URL = 'https://data.sec.gov/api/xbrl/companyfacts';
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_SUMMARY_URL = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary';
const YAHOO_COOKIE_URL = 'https://fc.yahoo.com';
const YAHOO_CRUMB_URL = 'https://query1.finance.yahoo.com/v1/test/getcrumb';
const DEFAULT_SEC_UA = 'daggerok ETF feed daggerok@gmail.com';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 45_000;
const SOFT_DEADLINE_MS = 25 * 60_000;
const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;

// __dirname instead of import.meta: the owner's IDE checks this file with the TypeScript defaults (ES5, commonjs)
const SCRIPTS_DIR = new URL(`${pathToFileURL(__dirname).href}/`);
const CONFIG_FILE_URL = new URL('./update-data.config.json', SCRIPTS_DIR);
let API_ROOT = new URL('../api/stocks/', SCRIPTS_DIR);
export function useApiRoot(root: URL): URL { const previous = API_ROOT; API_ROOT = root; return previous; }
const indexFile = () => new URL('index.json', API_ROOT);
const stateFile = () => new URL('update-state.json', API_ROOT);
const signalsFile = () => new URL(SIGNALS_FILE, API_ROOT);
const companyDir = (ticker: string) => new URL(`companies/${ticker}/`, API_ROOT);
/**
 * Watchlist spellings of a ticker (scripts/All.txt, All.csv) -> the ticker in the SEC table. Grow it as new spellings show up.
 * Exchange prefixes (NYSE:TTE) and . or / separators (BRK.B, BRK/B) are handled without an entry.
 */
export const TICKER_ALIASES: Record<string, string[]> = {
  'BRK-A': ['BRKA'],
  'BRK-B': ['BRKB'],
};
let WATCHLIST_DIR = new URL('./', SCRIPTS_DIR);
export function useWatchlistDir(dir: URL): URL { const previous = WATCHLIST_DIR; WATCHLIST_DIR = dir; return previous; }

export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'MAX_RETRIES', 'EXCHANGES', 'TICKERS', 'MARKET_CAP', 'DIVIDEND_YIELD',
  'HISTORY_RANGE', 'HISTORY_PAGE_SIZE', 'SKIP_YAHOO', 'SEC_UA', 'VERBOSE', 'USE_SYSTEM_CA',
  ...['1D', '3D', '1W', 'WTD', '2W', '20D', '1M', 'MTD', '40D', '60D', '1Q', 'QTD', '4M', '6M', '52W', 'YTD', '1Y', '3Y', '5Y', '10Y'].map((period) => `PERFORMANCE_${period}`),
  ...['YTD', '1Y', '3Y', '5Y', '10Y'].map((period) => `TOTAL_RETURN_${period}`),
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
type RangeMap = Partial<Record<string, Range>>;
// metrics keys behind the PERFORMANCE_* (price change) and TOTAL_RETURN_* (dividend- and split-adjusted) filters
const PERFORMANCE_KEYS: Record<string, string> = { '1D': 'perf1d', '3D': 'perf3d', '1W': 'perf1w', WTD: 'perfWtd', '2W': 'perf2w', '20D': 'perf20d', '1M': 'perf1m', MTD: 'perfMtd', '40D': 'perf40d', '60D': 'perf60d', '1Q': 'perf1q', QTD: 'perfQtd', '4M': 'perf4m', '6M': 'perf6m', '52W': 'perf52w', YTD: 'perfYtd', '1Y': 'perf1y', '3Y': 'perf3y', '5Y': 'perf5y', '10Y': 'perf10y' };
const TOTAL_RETURN_KEYS: Record<string, string> = { YTD: 'ytd', '1Y': 'tr1y', '3Y': 'tr3y', '5Y': 'tr5y', '10Y': 'tr10y' };

export type UpdaterConfig = {
  maxFetches: number;
  requestSleep: number;
  concurrency: number;
  maxRetries: number;
  exchanges: Set<string>;
  tickers: Set<string> | null;
  marketCap: Range;
  dividendYield: Range;
  performance: RangeMap;
  totalReturn: RangeMap;
  historyRange: string;
  historyPageSize: number;
  skipYahoo: boolean;
  secUa: string;
  verbose: boolean;
};

// ---------------------------------------------------------------------------
// small helpers

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export function round(value: number, digits = 2): number { const f = 10 ** digits; return Math.round(value * f) / f; }
export function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value && typeof value === 'object' && 'raw' in (value as JsonRecord)) return numberOrNull((value as JsonRecord).raw);
  return null;
}
const rounded = (value: number | null, digits = 2): number | null => (value === null || !Number.isFinite(value) ? null : round(value, digits));
export function normalizeTicker(value: string): string { return value.trim().toUpperCase().replace(/\./g, '-'); }
const isoDate = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
const bool = (value: string | undefined) => /^(1|true|yes|y|on)$/i.test((value ?? '').trim());
const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------------------
// controls

function parseNumberWithSuffix(text: string, name: string): number | undefined {
  const raw = text.trim();
  if (!raw) return undefined;
  const m = /^(-?\d+(?:\.\d+)?)([kmbt])?$/i.exec(raw);
  if (!m) throw new Error(`${name}: invalid number "${raw}"`);
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(m[2] || '').toLowerCase() as 'k'] ?? 1;
  return Number(m[1]) * mult;
}

export function parseRange(value: string, name = 'range'): Range {
  const raw = (value ?? '').trim();
  if (!raw) return {};
  const parts = raw.split(':');
  if (parts.length !== 2) throw new Error(`${name}: expected min:max, got "${raw}"`);
  const min = parseNumberWithSuffix(parts[0], name);
  const max = parseNumberWithSuffix(parts[1], name);
  if (min !== undefined && max !== undefined && min > max) throw new Error(`${name}: min is greater than max`);
  return { min, max };
}

const inRange = (value: number | null | undefined, range: Range): boolean => {
  if (range.min === undefined && range.max === undefined) return true;
  if (value === null || value === undefined) return false;
  return (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
};

export function parseHistoryRange(value: string): string {
  const raw = (value || 'max').trim().toLowerCase();
  if (raw !== 'max' && !/^\d{1,2}y$/.test(raw)) throw new Error(`HISTORY_RANGE: expected max or Ny (for example 10y), got "${value}"`);
  return raw;
}

export function parseRanges(env: Record<string, string | undefined>, prefix: 'PERFORMANCE' | 'TOTAL_RETURN'): RangeMap {
  const out: RangeMap = {};
  for (const period of Object.keys(prefix === 'PERFORMANCE' ? PERFORMANCE_KEYS : TOTAL_RETURN_KEYS)) {
    const range = parseRange(env[`${prefix}_${period}`] ?? '', `${prefix}_${period}`);
    if (range.min !== undefined || range.max !== undefined) out[period] = range;
  }
  return out;
}

export function readConfig(env: Record<string, string | undefined> = process.env): UpdaterConfig {
  const int = (key: string, fallback: number, min: number) => {
    const v = env[key];
    if (v === undefined || v.trim() === '') return fallback;
    if (!/^\d+$/.test(v.trim()) || Number(v) < min) throw new Error(`${key}: expected integer >= ${min}`);
    return Number(v);
  };
  const sleepValue = env.REQUEST_SLEEP;
  if (sleepValue && sleepValue.trim() && (!Number.isFinite(Number(sleepValue)) || Number(sleepValue) < 0)) throw new Error('REQUEST_SLEEP: expected nonnegative seconds');
  const tickers = (env.TICKERS ?? '').split(/[\s,;]+/).map(normalizeTicker).filter(Boolean);
  const exchanges = (env.EXCHANGES ?? 'Nasdaq,NYSE,CBOE').split(/[\s,;]+/).map((e) => e.trim().toUpperCase()).filter(Boolean);
  if (!exchanges.length) throw new Error('EXCHANGES: at least one exchange is required');
  return {
    maxFetches: int('MAX_FETCHES', 0, 0),
    requestSleep: sleepValue && sleepValue.trim() ? Number(sleepValue) : 1,
    concurrency: int('CONCURRENCY', 3, 1),
    maxRetries: int('MAX_RETRIES', 2, 1),
    exchanges: new Set(exchanges),
    tickers: tickers.length ? new Set(tickers) : null,
    marketCap: parseRange(env.MARKET_CAP ?? '', 'MARKET_CAP'),
    dividendYield: parseRange(env.DIVIDEND_YIELD ?? '', 'DIVIDEND_YIELD'),
    performance: parseRanges(env, 'PERFORMANCE'),
    totalReturn: parseRanges(env, 'TOTAL_RETURN'),
    historyRange: parseHistoryRange(env.HISTORY_RANGE ?? 'max'),
    historyPageSize: int('HISTORY_PAGE_SIZE', 1000, 1),
    skipYahoo: bool(env.SKIP_YAHOO),
    secUa: (env.SEC_UA ?? '').trim() || DEFAULT_SEC_UA,
    verbose: bool(env.VERBOSE),
  };
}

/** file < advanced JSON < nonblank named inputs < environment (an explicitly set variable wins, even when empty) */
export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) if (env[key] !== undefined) apply({ [key]: env[key] });
  if (result.SKIP_YAHOO && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result.SKIP_YAHOO.trim())) throw new Error('SKIP_YAHOO: expected boolean');
  if (result.VERBOSE && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result.VERBOSE.trim())) throw new Error('VERBOSE: expected boolean');
  if (result.USE_SYSTEM_CA !== undefined) {
    const mode = result.USE_SYSTEM_CA.trim().toLowerCase();
    if (!['auto', 'true', 'false'].includes(mode)) throw new Error('USE_SYSTEM_CA: expected auto, true or false');
    result.USE_SYSTEM_CA = mode;
  }
  readConfig(result); // validate everything before any request or write
  return result;
}

// ---------------------------------------------------------------------------
// HTTP: per-worker request lanes, timeouts, retries

let secUa = DEFAULT_SEC_UA;
let requestSleepSeconds = 1;
let requestGates: number[] = [0];
let verboseOutput = false;
const note = (message: string) => { if (verboseOutput) console.warn(message); };

async function paceRequests(): Promise<void> {
  const now = Date.now();
  let lane = 0;
  for (let i = 1; i < requestGates.length; i++) if (requestGates[i] < requestGates[lane]) lane = i;
  const wait = Math.max(0, requestGates[lane] - now);
  requestGates[lane] = Math.max(now, requestGates[lane]) + requestSleepSeconds * 1000;
  if (wait) await sleep(wait);
}

class HttpError extends Error {
  constructor(public status: number, message: string, public retryAfterMs = 0) { super(message); this.name = 'HttpError'; }
}

/** Retry-After as milliseconds: delta-seconds or an HTTP-date, capped at 120 s; 0 when absent, in the past or malformed. */
export function parseRetryAfter(header: string | null, now = Date.now()): number {
  const text = (header || '').trim();
  const seconds = /^\d+$/.test(text) ? Number(text) : (Date.parse(text) - now) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(120, seconds) * 1000 : 0;
}
const retryable = (error: unknown) => (error instanceof HttpError ? [403, 408, 425, 429].includes(error.status) || error.status >= 500 : true);

async function fetchText(url: string, label: string, config: UpdaterConfig, headers: Record<string, string> = {}): Promise<string> {
  let lastError: unknown = new Error('no request attempted');
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      await paceRequests();
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS); // covers headers and body
      const response = await fetch(url, { headers: { 'User-Agent': secUa, Accept: '*/*', ...headers }, redirect: 'follow', signal });
      if (!response.ok) throw new HttpError(response.status, `${response.status} ${response.statusText}`, parseRetryAfter(response.headers.get('retry-after')));
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt >= config.maxRetries || !retryable(error)) break;
      const rateLimited = error instanceof HttpError && error.status === 429;
      const retryAfterMs = error instanceof HttpError && error.retryAfterMs ? error.retryAfterMs : 0;
      await sleep(Math.max(retryAfterMs, Math.min(60_000, (rateLimited ? 12_000 : 800) * 2 ** attempt)));
    }
  }
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function fetchJson(url: string, label: string, config: UpdaterConfig, headers: Record<string, string> = {}): Promise<JsonRecord> {
  const text = await fetchText(url, label, config, { Accept: 'application/json', ...headers });
  try { return JSON.parse(text) as JsonRecord; } catch { throw new Error(`${label}: response was not JSON`); }
}

// ---------------------------------------------------------------------------
// SEC universe

export type Listing = { ticker: string; cik: number; name: string; exchange: string };

export function parseSecTickers(payload: JsonRecord): Map<string, Listing> {
  const fields: string[] = payload?.fields ?? [];
  const col = (name: string) => fields.indexOf(name);
  const [iCik, iName, iTicker, iExchange] = [col('cik'), col('name'), col('ticker'), col('exchange')];
  if ([iCik, iName, iTicker, iExchange].some((i) => i < 0)) throw new Error('SEC ticker table has an unexpected shape');
  const result = new Map<string, Listing>();
  for (const row of payload.data ?? []) {
    const ticker = normalizeTicker(String(row[iTicker] ?? ''));
    if (!ticker || !row[iExchange]) continue;
    if (!result.has(ticker)) result.set(ticker, { ticker, cik: Number(row[iCik]), name: String(row[iName] ?? ticker), exchange: String(row[iExchange]) });
  }
  return result;
}

// ---------------------------------------------------------------------------
// SEC fundamentals (XBRL companyfacts)

type Fact = { start?: string; end: string; val: number; form?: string; filed?: string; fp?: string };
type Series = Map<string, number>; // period end (ISO date) -> value

const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '10-KT']);

function factList(facts: JsonRecord, tag: string, unit: string): Fact[] {
  const node = facts?.facts?.['us-gaap']?.[tag] ?? facts?.facts?.dei?.[tag];
  return Array.isArray(node?.units?.[unit]) ? node.units[unit] : [];
}

/** One value per fiscal period end: annual 10-K facts only, the latest filing wins, earlier tags in `tags` win over later ones. */
export function annualSeries(facts: JsonRecord, tags: string[], kind: 'flow' | 'instant', unit = 'USD'): Series {
  const out: Series = new Map();
  for (const tag of tags) {
    const best = new Map<string, Fact>();
    for (const fact of factList(facts, tag, unit)) {
      if (!ANNUAL_FORMS.has(String(fact.form)) || !Number.isFinite(fact.val) || !fact.end) continue;
      if (kind === 'flow') {
        if (!fact.start) continue;
        const days = dayDiff(fact.end, fact.start);
        if (days < 340 || days > 380) continue;
      } else if (fact.start) continue;
      const seen = best.get(fact.end);
      if (!seen || String(fact.filed) >= String(seen.filed)) best.set(fact.end, fact);
    }
    best.forEach((fact, end) => { if (!out.has(end)) out.set(end, fact.val); });
  }
  return out;
}

const sub = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? undefined : a - b);
const add = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? undefined : a + b);

export type AnnualRow = {
  end: string;
  revenue: number | null; grossProfit: number | null; operatingIncome: number | null; ebitda: number | null; netIncome: number | null; eps: number | null;
  operatingCashFlow: number | null; capex: number | null; fcf: number | null; dividendsPaid: number | null;
  assets: number | null; currentAssets: number | null; currentLiabilities: number | null; cash: number | null; longInvestments: number | null; receivables: number | null;
  debt: number | null; equity: number | null; taxRate: number | null;
};


/** Annual rows, newest first. `us-gaap` only: foreign private issuers report IFRS and get no rows. */
export function buildAnnualRows(facts: JsonRecord, limit = 15): AnnualRow[] {
  if (!facts?.facts?.['us-gaap']) return [];
  const flow = (tags: string[]) => annualSeries(facts, tags, 'flow');
  const inst = (tags: string[]) => annualSeries(facts, tags, 'instant');
  const revenue = flow(TAGS.revenue);
  const cost = flow(TAGS.costOfRevenue);
  const gross = flow(TAGS.grossProfit);
  const op = flow(TAGS.operatingIncome);
  const net = flow(TAGS.netIncome);
  const da = flow(TAGS.da);
  // many filers tag depreciation and intangible amortization separately instead of one combined D&A line
  const depreciation = flow(['Depreciation']);
  const amortization = flow(['AmortizationOfIntangibleAssets']);
  const ocf = flow(TAGS.ocf);
  const capex = flow(TAGS.capex);
  const divs = flow(TAGS.dividends);
  const pretax = flow(TAGS.pretax);
  const tax = flow(TAGS.tax);
  const eps = annualSeries(facts, ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'], 'flow', 'USD/shares');
  const assets = inst(TAGS.assets);
  const ca = inst(TAGS.currentAssets);
  const cl = inst(TAGS.currentLiabilities);
  const cash = inst(TAGS.cash);
  const sti = inst(TAGS.shortInvestments);
  const ar = inst(TAGS.receivables);
  const lti = inst(TAGS.longInvestments);
  const debtCombined = inst(TAGS.debtCombined);
  const debtNon = inst(TAGS.debtNoncurrent);
  const debtCur = inst(TAGS.debtCurrent);
  const debtFallback = inst(TAGS.debtTotalFallback);
  const cp = inst(TAGS.commercialPaper);
  const equity = inst(TAGS.equity);

  const ends = Array.from(revenue.size ? revenue.keys() : ocf.keys()).sort().reverse().slice(0, limit);
  return ends.map((end): AnnualRow => {
    const rev = revenue.get(end);
    const gp = gross.get(end) ?? (rev !== undefined && cost.has(end) ? rev - cost.get(end)! : undefined);
    const opInc = op.get(end);
    const dna = da.get(end) ?? (depreciation.has(end) ? depreciation.get(end)! + (amortization.get(end) ?? 0) : undefined);
    const ebitda = add(opInc, dna);
    const o = ocf.get(end);
    const cx = capex.get(end) === undefined ? undefined : Math.abs(capex.get(end)!);
    const debt = debtCombined.get(end)
      ?? (debtNon.has(end) ? debtNon.get(end)! + (debtCur.get(end) ?? 0) + (cp.get(end) ?? 0) : undefined)
      ?? (debtFallback.has(end) ? debtFallback.get(end)! + (cp.get(end) ?? 0) : undefined);
    const pt = pretax.get(end);
    const tx = tax.get(end);
    const rate = pt !== undefined && tx !== undefined && pt > 0 ? tx / pt : undefined;
    const cashTotal = cash.has(end) ? cash.get(end)! + (sti.get(end) ?? 0) : undefined;
    const n = (v: number | undefined) => (v === undefined ? null : v);
    return {
      end,
      revenue: n(rev), grossProfit: n(gp), operatingIncome: n(opInc), ebitda: n(ebitda), netIncome: n(net.get(end)), eps: n(eps.get(end)),
      operatingCashFlow: n(o), capex: n(cx), fcf: n(sub(o, cx)), dividendsPaid: divs.has(end) ? Math.abs(divs.get(end)!) : null,
      assets: n(assets.get(end)), currentAssets: n(ca.get(end)), currentLiabilities: n(cl.get(end)), cash: n(cashTotal), longInvestments: n(lti.get(end)), receivables: n(ar.get(end)),
      debt: n(debt), equity: n(equity.get(end)), taxRate: rate === undefined ? null : rate,
    };
  });
}

// ---------------------------------------------------------------------------
// Yahoo fundamentals-timeseries: gap filler (about 4-5 years, no crumb needed) for tags SEC does not carry
// and for issuers without usable SEC history (IFRS filers, holding-company reorganizations)

const YAHOO_TIMESERIES_URL = 'https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries';
const YAHOO_ANNUAL_TYPES: Record<string, keyof AnnualRow> = {
  annualTotalRevenue: 'revenue', annualGrossProfit: 'grossProfit', annualOperatingIncome: 'operatingIncome', annualEBITDA: 'ebitda', annualNetIncome: 'netIncome',
  annualDilutedEPS: 'eps', annualOperatingCashFlow: 'operatingCashFlow', annualCapitalExpenditure: 'capex', annualFreeCashFlow: 'fcf', annualCashDividendsPaid: 'dividendsPaid',
  annualTotalAssets: 'assets', annualCurrentAssets: 'currentAssets', annualCurrentLiabilities: 'currentLiabilities', annualCashCashEquivalentsAndShortTermInvestments: 'cash',
  annualAccountsReceivable: 'receivables', annualTotalDebt: 'debt', annualStockholdersEquity: 'equity', annualTaxRateForCalcs: 'taxRate',
};
const ABSOLUTE_FIELDS = new Set<keyof AnnualRow>(['capex', 'dividendsPaid']);
const YAHOO_FILLED_FIELDS = Object.values(YAHOO_ANNUAL_TYPES);

/** Annual points by period end; with `currency` only the points in that currency (a point without currencyCode is kept) */
export function parseYahooAnnual(payload: JsonRecord, currency?: string): Map<string, Partial<AnnualRow>> {
  const byDate = new Map<string, Partial<AnnualRow>>();
  for (const item of payload?.timeseries?.result ?? []) {
    const type: string = item?.meta?.type?.[0];
    const field = YAHOO_ANNUAL_TYPES[type];
    if (!field) continue;
    for (const point of item[type] ?? []) {
      const value = numberOrNull(point?.reportedValue);
      if (value === null || !point?.asOfDate) continue;
      if (currency && point.currencyCode && point.currencyCode !== currency) continue;
      const row = byDate.get(point.asOfDate) ?? {};
      (row as JsonRecord)[field] = ABSOLUTE_FIELDS.has(field) ? Math.abs(value) : value;
      byDate.set(point.asOfDate, row);
    }
  }
  return byDate;
}

async function fetchYahooAnnual(ticker: string, config: UpdaterConfig, currency?: string): Promise<Map<string, Partial<AnnualRow>>> {
  const query = new URLSearchParams({ type: Object.keys(YAHOO_ANNUAL_TYPES).join(','), period1: '1262304000', period2: String(Math.floor(Date.now() / 1000) + 86_400) });
  return parseYahooAnnual(await fetchJson(`${YAHOO_TIMESERIES_URL}/${encodeURIComponent(ticker)}?${query}`, `[ fundamen  ] ${ticker}`, config, { 'User-Agent': BROWSER_UA }), currency);
}

/**
 * Annual rows from the fiscal years of the SEC layer, in its reporting currency: the rows of a foreign issuer (20-F or 40-F,
 * us-gaap or ifrs-full), whose facts buildAnnualRows (10-K, us-gaap, USD) does not read
 */
export function annualRowsFromSec(sec: SecFundamentals | null): AnnualRow[] {
  if (!sec) return [];
  const ends = (sec.fy?.end ?? []) as Array<string | null>;
  const col = (k: string) => column(sec.fy, k);
  const c = {
    revenue: col('revenue'), grossProfit: col('grossProfit'), operatingIncome: col('operatingIncome'), da: col('da'), netIncome: col('netIncome'), eps: col('epsDiluted'),
    cfo: col('cfo'), capex: col('capex'), dividendsPaid: col('dividendsPaid'), assets: col('assets'), currentAssets: col('currentAssets'), currentLiabilities: col('currentLiabilities'),
    cash: col('cash'), sti: col('shortTermInvestments'), longInvestments: col('longTermInvestments'), receivables: col('receivables'), debt: col('debt'), equity: col('equity'),
    pretax: col('pretaxIncome'), tax: col('incomeTax'),
  };
  const rows: AnnualRow[] = [];
  ends.forEach((end, i) => {
    if (!end) return;
    const v = (k: keyof typeof c) => c[k][i] ?? null;
    const oi = v('operatingIncome'), da = v('da'), cfo = v('cfo'), capex = v('capex'), cash = v('cash'), pretax = v('pretax'), tax = v('tax');
    rows.push({
      end, revenue: v('revenue'), grossProfit: v('grossProfit'), operatingIncome: oi, ebitda: oi !== null && da !== null ? oi + da : null, netIncome: v('netIncome'), eps: v('eps'),
      operatingCashFlow: cfo, capex, fcf: cfo !== null && capex !== null ? cfo - capex : null, dividendsPaid: v('dividendsPaid'),
      assets: v('assets'), currentAssets: v('currentAssets'), currentLiabilities: v('currentLiabilities'), cash: cash === null ? null : cash + (v('sti') ?? 0), longInvestments: v('longInvestments'), receivables: v('receivables'),
      debt: v('debt'), equity: v('equity'), taxRate: pretax !== null && tax !== null && pretax > 0 ? tax / pretax : null,
    });
  });
  return rows;
}

const emptyRow = (end: string): AnnualRow => ({ end, revenue: null, grossProfit: null, operatingIncome: null, ebitda: null, netIncome: null, eps: null, operatingCashFlow: null, capex: null, fcf: null, dividendsPaid: null, assets: null, currentAssets: null, currentLiabilities: null, cash: null, longInvestments: null, receivables: null, debt: null, equity: null, taxRate: null });

/** SEC rows win; Yahoo only fills null fields of a row whose period end is within 10 days, and adds rows SEC has none for (newer than the SEC history or when SEC has fewer than 3 rows). */
export function mergeAnnual(sec: AnnualRow[], yahoo: Map<string, Partial<AnnualRow>>): { rows: AnnualRow[]; source: 'sec' | 'sec+yahoo' | 'yahoo' } {
  const rows = sec.map((r) => ({ ...r }));
  let filled = false;
  const usable = new Set<string>();
  for (const [date, values] of Array.from(yahoo)) {
    const near = rows.find((r) => Math.abs(dayDiff(r.end, date)) <= 10);
    if (near) {
      usable.add(near.end);
      for (const [key, value] of Object.entries(values) as [keyof AnnualRow, number][]) if (near[key] === null) { (near as JsonRecord)[key] = value; filled = true; }
    } else if (rows.length < 3 || date > (rows[0]?.end ?? '')) {
      const row = emptyRow(date);
      Object.assign(row, values);
      rows.push(row);
      filled = true;
    }
  }
  rows.sort((a, b) => b.end.localeCompare(a.end));
  for (const r of rows) if (r.fcf === null && r.operatingCashFlow !== null && r.capex !== null) r.fcf = r.operatingCashFlow - r.capex;
  return { rows: rows.slice(0, 15), source: !sec.length ? (rows.length ? 'yahoo' : 'sec') : filled ? 'sec+yahoo' : 'sec' };
}

// ---------------------------------------------------------------------------
// fundamentals metrics

type NumKey = 'revenue' | 'eps' | 'fcf' | 'ebitda' | 'capex' | 'assets' | 'debt';

/** Year-over-year change in percent relative to |previous|; null unless the previous row is the prior fiscal year. */
function growthPct(rows: AnnualRow[], key: NumKey, back: number): number | null {
  const cur = rows[0]?.[key];
  const prev = rows[back]?.[key];
  if (cur === null || cur === undefined || prev === null || prev === undefined || prev === 0) return null;
  const gap = dayDiff(rows[0].end, rows[back].end) / 365.25;
  if (Math.abs(gap - back) > 0.2) return null;
  if (back === 1) return rounded(((cur - prev) / Math.abs(prev)) * 100);
  if (cur <= 0 || prev <= 0) return null; // CAGR needs two positive endpoints
  return rounded(((cur / prev) ** (1 / back) - 1) * 100);
}

const margin = (value: number | null, revenue: number | null) => (value === null || !revenue ? null : (value / revenue) * 100);
type MarginKey = 'netIncome' | 'grossProfit' | 'ebitda' | 'fcf';
const marginDelta = (rows: AnnualRow[], key: MarginKey, back: number): number | null => {
  if (!rows[back]) return null;
  if (Math.abs(dayDiff(rows[0].end, rows[back].end) / 365.25 - back) > 0.2) return null;
  const a = margin(rows[0][key], rows[0].revenue);
  const b = margin(rows[back][key], rows[back].revenue);
  return a === null || b === null ? null : rounded(a - b);
};

export function fundamentalsMetrics(rows: AnnualRow[]): JsonRecord {
  const m: JsonRecord = {};
  const names: Record<NumKey, string> = { revenue: 'revenue', eps: 'eps', fcf: 'fcf', ebitda: 'ebitda', capex: 'capex', assets: 'assets', debt: 'debt' };
  for (const [key, name] of Object.entries(names) as [NumKey, string][]) {
    m[`${name}Growth`] = growthPct(rows, key, 1);
    m[`${name}Growth3y`] = growthPct(rows, key, 3);
    m[`${name}Growth5y`] = growthPct(rows, key, 5);
  }
  const r = rows[0];
  m.netMargin = rounded(margin(r?.netIncome ?? null, r?.revenue ?? null));
  m.grossMargin = rounded(margin(r?.grossProfit ?? null, r?.revenue ?? null));
  m.ebitdaMargin = rounded(margin(r?.ebitda ?? null, r?.revenue ?? null));
  m.fcfMargin = rounded(margin(r?.fcf ?? null, r?.revenue ?? null));
  for (const [key, name] of [['netIncome', 'netMargin'], ['grossProfit', 'grossMargin'], ['ebitda', 'ebitdaMargin'], ['fcf', 'fcfMargin']] as [MarginKey, string][]) {
    m[`${name}Delta`] = marginDelta(rows, key, 1);
    m[`${name}Delta3y`] = marginDelta(rows, key, 3);
  }
  // Balance sheet ratios from the latest fiscal year end
  m.currentRatio = r && r.currentAssets !== null && r.currentLiabilities ? rounded(r.currentAssets / r.currentLiabilities) : null;
  m.quickRatio = r && r.cash !== null && r.currentLiabilities ? rounded((r.cash + (r.receivables ?? 0)) / r.currentLiabilities) : null;
  m.debtToEquity = r && r.debt !== null && r.equity !== null && r.equity > 0 ? rounded(r.debt / r.equity) : null;
  m.netDebtToEbitda = r && r.debt !== null && r.cash !== null && r.ebitda !== null && r.ebitda > 0 ? rounded((r.debt - r.cash - (r.longInvestments ?? 0)) / r.ebitda) : null;
  // ROIC = NOPAT / average invested capital (debt + equity - cash)
  const capital = (row?: AnnualRow) => (row && row.debt !== null && row.equity !== null && row.cash !== null ? row.debt + row.equity - row.cash : null);
  const c0 = capital(r);
  const c1 = capital(rows[1]);
  const avgCapital = c0 !== null && c1 !== null ? (c0 + c1) / 2 : c0;
  const taxRate = r && r.taxRate !== null && r.taxRate >= 0 && r.taxRate <= 0.5 ? r.taxRate : 0.21;
  m.roic = r && r.operatingIncome !== null && avgCapital !== null && avgCapital > 0 ? rounded(((r.operatingIncome * (1 - taxRate)) / avgCapital) * 100) : null;
  // Dividend coverage from cash flow
  m.payoutRatio = r && r.dividendsPaid !== null && r.netIncome !== null && r.netIncome > 0 ? rounded((r.dividendsPaid / r.netIncome) * 100) : null;
  m.fcfPayout = r && r.dividendsPaid !== null && r.fcf !== null && r.fcf > 0 ? rounded((r.dividendsPaid / r.fcf) * 100) : null;
  return m;
}

// ---------------------------------------------------------------------------
// Yahoo chart: history, dividends, returns

export type ChartDay = { date: string; close: number; adjClose: number; volume: number };
export type ParsedChart = { days: ChartDay[]; dividends: Array<{ date: string; amount: number }>; splits: Split[]; price: number | null; exchangeName: string; currency: string };

export function parseChart(payload: JsonRecord): ParsedChart {
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error('Yahoo chart returned no result');
  const stamps: number[] = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const adjusted: unknown[] = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const days: ChartDay[] = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const close = numberOrNull(quote.close?.[i]);
    if (close === null) continue;
    days.push({ date: isoDate(stamps[i]), close, adjClose: numberOrNull(adjusted[i]) ?? close, volume: numberOrNull(quote.volume?.[i]) ?? 0 });
  }
  const dividends: ParsedChart['dividends'] = [];
  for (const [epoch, item] of Object.entries(result.events?.dividends ?? {})) {
    const amount = numberOrNull((item as JsonRecord)?.amount);
    if (amount !== null) dividends.push({ date: isoDate(Number(epoch)), amount });
  }
  dividends.sort((a, b) => a.date.localeCompare(b.date));
  const splits: Split[] = [];
  for (const [epoch, item] of Object.entries(result.events?.splits ?? {})) {
    const numerator = numberOrNull((item as JsonRecord)?.numerator);
    const denominator = numberOrNull((item as JsonRecord)?.denominator);
    if (numerator && denominator && numerator > 0 && denominator > 0) splits.push({ date: isoDate(Number(epoch)), ratio: numerator / denominator });
  }
  splits.sort((a, b) => a.date.localeCompare(b.date));
  return { days, dividends, splits, price: numberOrNull(result.meta?.regularMarketPrice), exchangeName: String(result.meta?.fullExchangeName ?? result.meta?.exchangeName ?? ''), currency: String(result.meta?.currency ?? '') };
}

function anchorDay(days: ChartDay[], target: string): ChartDay | null {
  let found: ChartDay | null = null;
  for (const day of days) { if (day.date <= target) found = day; else break; }
  return found;
}
// the candle closest to the target date (a Saturday target takes Friday, a Sunday one Monday, a tie the earlier one); null when the history starts after it
function nearestDay(days: ChartDay[], target: string): ChartDay | null {
  const before = anchorDay(days, target);
  if (!before) return null;
  const after = days[days.indexOf(before) + 1];
  return after && dayDiff(after.date, target) < dayDiff(target, before.date) ? after : before;
}
// N daily candles back from the last one (trading days, not calendar days)
const tradingBack = (days: ChartDay[], n: number): ChartDay | null => days[days.length - 1 - n] ?? null;
const minusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
// calendar months back, the day clipped to the end of a shorter month (2026-10-31 - 1M = 2026-09-30)
export function minusMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 - n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}
// the day before the current calendar week (Monday to Sunday), month or quarter (Q1 Jan-Mar ... Q4 Oct-Dec) of an ISO date
export function periodEve(iso: string, period: 'week' | 'month' | 'quarter'): string {
  if (period === 'week') return minusDays(iso, ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1);
  const month = period === 'month' ? Number(iso.slice(5, 7)) : Math.floor((Number(iso.slice(5, 7)) - 1) / 3) * 3 + 1;
  return minusDays(`${iso.slice(0, 4)}-${String(month).padStart(2, '0')}-01`, 1);
}
const pct = (start: number | null | undefined, end: number | null | undefined) => (start && end !== null && end !== undefined ? rounded((end / start - 1) * 100) : null);
const cagr = (start: number | null | undefined, end: number | null | undefined, years: number) => (start && start > 0 && end && end > 0 ? rounded(((end / start) ** (1 / years) - 1) * 100) : null);

export function priceReturns(days: ChartDay[]): JsonRecord {
  const last = days[days.length - 1];
  const empty = { perf1d: null, perf3d: null, perf1w: null, perfWtd: null, perf2w: null, perf20d: null, perf1m: null, perfMtd: null, perf40d: null, perf60d: null, perf1q: null, perfQtd: null, perf4m: null, perf6m: null, perf52w: null, perfYtd: null, perf1y: null, perf3y: null, perf5y: null, perf10y: null, ytd: null, tr1y: null, tr3y: null, tr5y: null, tr10y: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null };
  if (!last) return empty;
  const at = (years: number) => anchorDay(days, new Date(Date.parse(`${last.date}T00:00:00Z`) - years * YEAR_MS).toISOString().slice(0, 10));
  const yearStart = anchorDay(days, `${Number(last.date.slice(0, 4)) - 1}-12-31`);
  const [d1, d3, d5, d10] = [at(1), at(3), at(5), at(10)];
  const weeks = (n: number) => anchorDay(days, minusDays(last.date, n * 7));
  const months = (n: number) => anchorDay(days, minusMonths(last.date, n));
  const toDate = (period: 'week' | 'month' | 'quarter') => anchorDay(days, periodEve(last.date, period));
  const short = {
    perf1d: tradingBack(days, 1), perf3d: tradingBack(days, 3), perf1w: tradingBack(days, 5), perfWtd: toDate('week'), perf2w: tradingBack(days, 10), perf20d: tradingBack(days, 20), perf1m: nearestDay(days, minusMonths(last.date, 1)), perfMtd: toDate('month'),
    perf40d: tradingBack(days, 40), perf60d: tradingBack(days, 60), perf1q: nearestDay(days, minusMonths(last.date, 3)), perfQtd: toDate('quarter'), perf4m: months(4), perf6m: months(6), perf52w: weeks(52),
  };
  const first = days[0];
  const spanYears = dayDiff(last.date, first.date) / 365.25;
  return {
    ...Object.fromEntries(Object.entries(short).map(([key, anchor]) => [key, pct(anchor?.close, last.close)])),
    perfYtd: pct(yearStart?.close, last.close), perf1y: pct(d1?.close, last.close), perf3y: pct(d3?.close, last.close), perf5y: pct(d5?.close, last.close), perf10y: pct(d10?.close, last.close),
    ytd: pct(yearStart?.adjClose, last.adjClose), tr1y: pct(d1?.adjClose, last.adjClose), tr3y: pct(d3?.adjClose, last.adjClose), tr5y: pct(d5?.adjClose, last.adjClose), tr10y: pct(d10?.adjClose, last.adjClose),
    cagr3y: cagr(d3?.adjClose, last.adjClose, 3), cagr5y: cagr(d5?.adjClose, last.adjClose, 5), cagr10y: cagr(d10?.adjClose, last.adjClose, 10),
    siAnn: spanYears >= 1 ? cagr(first.adjClose, last.adjClose, spanYears) : null,
  };
}

export function dividendMetrics(dividends: ParsedChart['dividends'], price: number | null, lastDate: string): { metrics: JsonRecord; annual: Array<{ year: number; dps: number }> } {
  const byYear = new Map<number, number>();
  for (const d of dividends) byYear.set(Number(d.date.slice(0, 4)), (byYear.get(Number(d.date.slice(0, 4))) ?? 0) + d.amount);
  const lastYear = Number(lastDate.slice(0, 4));
  const complete = lastYear - 1; // the current calendar year is partial
  const dps = (y: number) => (byYear.has(y) ? byYear.get(y)! : null);
  const growth = (back: number): number | null => {
    const a = dps(complete);
    const b = dps(complete - back);
    if (a === null || b === null || b <= 0) return null;
    return rounded((back === 1 ? a / b - 1 : (a / b) ** (1 / back) - 1) * 100);
  };
  const cutoff = new Date(Date.parse(`${lastDate}T00:00:00Z`) - YEAR_MS).toISOString().slice(0, 10);
  const ttm = dividends.filter((d) => d.date > cutoff).reduce((sum, d) => sum + d.amount, 0);
  const annual = Array.from(byYear.entries()).sort((a, b) => b[0] - a[0]).slice(0, 15).map(([year, v]) => ({ year, dps: round(v, 4) }));
  return {
    metrics: {
      dividendYield: price ? (ttm > 0 ? rounded((ttm / price) * 100) : 0) : null, // no payments in the last year is an honest 0
      dividendRate: ttm > 0 ? rounded(ttm, 4) : null,
      dividendGrowth: growth(1), dividendGrowth3y: growth(3), dividendGrowth5y: growth(5),
      ...dividendHistory(annual, lastDate), // streak of yearly increases and the 10-year cut flag (scripts/metrics/dividends.ts)
    },
    annual,
  };
}

// ---------------------------------------------------------------------------
// Yahoo quoteSummary (cookie + crumb)

type YahooSession = { cookie: string; crumb: string } | null;
let yahooSession: Promise<YahooSession> | null = null;

async function openYahooSession(config: UpdaterConfig): Promise<YahooSession> {
  try {
    await paceRequests();
    const home = await fetch(YAHOO_COOKIE_URL, { headers: { 'User-Agent': BROWSER_UA }, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const cookie = (home.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    if (!cookie) throw new Error('no cookie');
    const crumb = (await fetchText(YAHOO_CRUMB_URL, '[ yahoo     ] crumb', config, { 'User-Agent': BROWSER_UA, Cookie: cookie })).trim();
    if (!crumb || /[<{\s]/.test(crumb)) throw new Error('invalid crumb');
    return { cookie, crumb };
  } catch (error) {
    note(`[ yahoo     ] session unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
let yahooSessionRetryAt = 0;
const YAHOO_SESSION_RETRY_MS = 5 * 60_000;
/** A failed session is retried after YAHOO_SESSION_RETRY_MS instead of being cached as null for the whole run. */
const getYahooSession = async (config: UpdaterConfig): Promise<YahooSession> => {
  if (!yahooSession && Date.now() < yahooSessionRetryAt) return null;
  if (!yahooSession) {
    yahooSession = openYahooSession(config).then((session) => {
      if (!session) { yahooSession = null; yahooSessionRetryAt = Date.now() + YAHOO_SESSION_RETRY_MS; }
      return session;
    });
  }
  return yahooSession;
};

export type Snapshot = {
  quoteType: string; name: string; sector: string | null; industry: string | null; currency: string; financialCurrency: string;
  country?: string | null; // assetProfile.country: the issuer's country (plan 1.1)
  marketCap: number | null; enterpriseValue: number | null; sharesOutstanding: number | null; beta: number | null;
  pe: number | null; forwardPe: number | null; ps: number | null; forwardRevenue: number | null; evEbitda: number | null; pb: number | null;
  freeCashflow: number | null; ebitda: number | null; week52High: number | null; week52Low: number | null;
  totalRevenue?: number | null; // TTM revenue (financialData.totalRevenue): the scale check of the SEC layer
  estimates?: Estimates | null; // earningsTrend: EPS consensus, expected growth and revisions (plan 1.4)
};

export function parseSummary(payload: JsonRecord): Snapshot {
  const r = payload?.quoteSummary?.result?.[0];
  if (!r) throw new Error('Yahoo quoteSummary returned no result');
  const price = r.price ?? {};
  const sd = r.summaryDetail ?? {};
  const ks = r.defaultKeyStatistics ?? {};
  const fd = r.financialData ?? {};
  const trend = (r.earningsTrend?.trend ?? []).find((t: JsonRecord) => t.period === '+1y');
  return {
    quoteType: String(price.quoteType ?? ''), name: String(price.longName ?? price.shortName ?? ''),
    sector: r.assetProfile?.sector ?? null, industry: r.assetProfile?.industry ?? null, country: r.assetProfile?.country ?? null,
    currency: String(price.currency ?? ''), financialCurrency: String(fd.financialCurrency ?? price.currency ?? ''),
    marketCap: numberOrNull(price.marketCap) ?? numberOrNull(sd.marketCap), enterpriseValue: numberOrNull(ks.enterpriseValue),
    sharesOutstanding: numberOrNull(ks.sharesOutstanding), beta: numberOrNull(sd.beta) ?? numberOrNull(ks.beta),
    pe: numberOrNull(sd.trailingPE), forwardPe: numberOrNull(ks.forwardPE) ?? numberOrNull(sd.forwardPE), ps: numberOrNull(sd.priceToSalesTrailing12Months),
    forwardRevenue: numberOrNull(trend?.revenueEstimate?.avg), evEbitda: numberOrNull(ks.enterpriseToEbitda), pb: numberOrNull(ks.priceToBook),
    freeCashflow: numberOrNull(fd.freeCashflow), ebitda: numberOrNull(fd.ebitda),
    week52High: numberOrNull(sd.fiftyTwoWeekHigh), week52Low: numberOrNull(sd.fiftyTwoWeekLow),
    totalRevenue: numberOrNull(fd.totalRevenue),
    estimates: parseEstimates(r),
  };
}

async function fetchSummary(ticker: string, config: UpdaterConfig): Promise<Snapshot | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await getYahooSession(config);
    if (!session) return null;
    const modules = 'price,summaryDetail,defaultKeyStatistics,financialData,earningsTrend,assetProfile';
    try {
      const payload = await fetchJson(`${YAHOO_SUMMARY_URL}/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}`, `[ summary   ] ${ticker}`, config, { 'User-Agent': BROWSER_UA, Cookie: session.cookie });
      return parseSummary(payload);
    } catch (error) {
      if (attempt === 0 && /401|Invalid Crumb/i.test(String(error))) { yahooSession = null; continue; } // refresh the session once
      throw error;
    }
  }
  return null;
}

/** Valuation multiples from the Yahoo snapshot; anything mixing a USD price with non-USD financials is dropped (ADRs). */
export function valuationMetrics(s: Snapshot): JsonRecord {
  const sameCurrency = !s.currency || !s.financialCurrency || s.currency === s.financialCurrency;
  const cap = s.marketCap;
  const positive = (v: number | null) => (v !== null && v > 0 ? v : null);
  return {
    marketCap: cap,
    enterpriseValue: sameCurrency ? s.enterpriseValue : null,
    pe: sameCurrency ? rounded(positive(s.pe)) : null,
    forwardPe: sameCurrency ? rounded(positive(s.forwardPe)) : null,
    ps: sameCurrency ? rounded(positive(s.ps)) : null,
    forwardPs: sameCurrency && cap && positive(s.forwardRevenue) ? rounded(cap / s.forwardRevenue!) : null,
    pFcf: sameCurrency && cap && positive(s.freeCashflow) ? rounded(cap / s.freeCashflow!) : null,
    evEbitda: sameCurrency ? rounded(positive(s.evEbitda)) : null,
    fcfToEbitda: s.freeCashflow !== null && positive(s.ebitda) ? rounded((s.freeCashflow / s.ebitda!) * 100) : null,
    pb: sameCurrency ? rounded(positive(s.pb)) : null,
    beta: rounded(s.beta),
    sharesOutstanding: s.sharesOutstanding,
  };
}

// ---------------------------------------------------------------------------
// files

export function samePublishedContent(previous: string, value: unknown): boolean {
  const strip = (item: unknown): unknown => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const { generatedAt, savedAt, ...rest } = item as Record<string, unknown>;
    return rest;
  };
  try { return JSON.stringify(strip(JSON.parse(previous))) === JSON.stringify(strip(value)); } catch { return false; }
}

/** One top-level entry per line: the index stays diff-friendly in git without the indentation that is 30% of its bytes. */
export function compactIndexText(value: unknown): string {
  const doc = value as Record<string, unknown>;
  const lines: string[] = [];
  for (const [key, item] of Object.entries(doc)) {
    if (key === 'companies' && Array.isArray(item)) lines.push(`${JSON.stringify(key)}: [\n${item.map((row) => JSON.stringify(row)).join(',\n')}\n]`);
    else lines.push(`${JSON.stringify(key)}: ${JSON.stringify(item)}`);
  }
  return `{\n${lines.join(',\n')}\n}\n`;
}

/** meta.json: indented like JSON.stringify(v, null, 2), but an array of plain values stays on one line (the SEC series are arrays by field) */
export function metaText(value: unknown): string {
  const plain = (v: unknown) => v === null || typeof v !== 'object';
  const render = (v: unknown, pad: string): string | undefined => {
    if (v === undefined || typeof v === 'function') return undefined;
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      if (v.every(plain)) return JSON.stringify(v);
      return `[\n${v.map((item) => `${pad}  ${render(item, `${pad}  `) ?? 'null'}`).join(',\n')}\n${pad}]`;
    }
    const lines: string[] = [];
    for (const [k, item] of Object.entries(v as JsonRecord)) {
      const text = render(item, `${pad}  `);
      if (text !== undefined) lines.push(`${pad}  ${JSON.stringify(k)}: ${text}`);
    }
    return lines.length ? `{\n${lines.join(',\n')}\n${pad}}` : '{}';
  };
  return `${render(value, '') ?? 'null'}\n`;
}

async function writeIfChanged(file: URL, value: unknown, format: (value: unknown) => string = (v) => `${JSON.stringify(v, null, 2)}\n`): Promise<boolean> {
  const text = format(value);
  try {
    const previous = await readFile(file, 'utf8');
    if (previous === text || samePublishedContent(previous, value)) return false;
  } catch { /* new file */ }
  await mkdir(new URL('.', file), { recursive: true });
  const tmp = new URL(`${file.pathname.split('/').pop()}.tmp`, file);
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
  return true;
}

async function readJson(file: URL): Promise<JsonRecord | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as JsonRecord; } catch { return null; }
}

/** Version of the feed layout in index.json and every meta.json; the feed only ever gains fields (plan 0, 1.8) */
export const FEED_SCHEMA_VERSION = 1;
// fundamentalsAsOf: end of the latest fiscal year of the annual rows; ttmAsOf: end of the latest quarter behind the TTM metrics
const ROW_KEYS = ['ticker', 'name', 'exchange', 'sector', 'industry', 'cik', 'currency', 'financialCurrency', 'dataFile', 'price', 'asOfDate', 'fundamentalsAsOf', 'ttmAsOf', 'fundamentalsBasis', 'metrics'];
export const rowFromMeta = (meta: JsonRecord): JsonRecord => Object.fromEntries(ROW_KEYS.map((k) => [k, meta[k] ?? null]));

const METRIC_KEYS = [
  'marketCap', 'enterpriseValue', 'price', 'week52High', 'week52Low', 'range52w', 'beta', 'sharesOutstanding',
  'pe', 'forwardPe', 'ps', 'forwardPs', 'pFcf', 'evEbitda', 'fcfToEbitda', 'pb',
  'dividendYield', 'dividendRate', 'dividendGrowth', 'dividendGrowth3y', 'dividendGrowth5y', ...DIVIDEND_HISTORY_KEYS, 'payoutRatio', 'fcfPayout',
  'currentRatio', 'quickRatio', 'debtToEquity', 'netDebtToEbitda', 'roic',
  ...['revenue', 'eps', 'fcf', 'ebitda', 'capex', 'assets', 'debt'].flatMap((n) => [`${n}Growth`, `${n}Growth3y`, `${n}Growth5y`]),
  'netMargin', 'grossMargin', 'ebitdaMargin', 'fcfMargin',
  ...['netMargin', 'grossMargin', 'ebitdaMargin', 'fcfMargin'].flatMap((n) => [`${n}Delta`, `${n}Delta3y`]),
  'perf1d', 'perf3d', 'perf1w', 'perfWtd', 'perf2w', 'perf20d', 'perf1m', 'perfMtd', 'perf40d', 'perf60d', 'perf1q', 'perfQtd', 'perf4m', 'perf6m', 'perf52w',
  'perfYtd', 'perf1y', 'perf3y', 'perf5y', 'perf10y', 'ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn',
  // price and swing metrics (scripts/metrics/swing.ts): split-adjusted, not dividend-adjusted daily closes of the Yahoo chart
  'pctFrom52wHigh', 'athPrice', 'athDate', 'athBasis', 'pctFromAth', 'volatility1y', 'sigmaFromMean60d', 'high60d', 'low60d',
  // SEC quarters and TTM (scripts/metrics/fundamentals.ts, plan 1.5 and 1.7)
  ...FUNDAMENTAL_METRIC_KEYS,
  // Yahoo earningsTrend and the two PEGs (scripts/metrics/estimates.ts), own 5-year history (scripts/metrics/history.ts)
  ...ESTIMATE_METRIC_KEYS, ...HISTORY_METRIC_KEYS,
  // foreign issuers (plan 1.1 and 1.3): Yahoo country, the ADR flag and an annual-only TTM
  'isAdr', 'country', 'ttmIsAnnual',
] as const;

/** Every key of a published `metrics` object, in order: the screener registry must describe each one (src/core/metrics). */
export const STOCK_METRIC_KEYS: readonly string[] = [...METRIC_KEYS, 'returnsBasis', 'performanceAsOf'];

export const RETURNS_BASIS = 'Yahoo chart API: performance from unadjusted closes (D windows, 1W (5 daily candles) and 2W (10) count daily candles; 1M and 1Q take the candle closest to the same day 1 and 3 months earlier; WTD, MTD, QTD and YTD start at the last close before the current calendar week, month, quarter or year; 4M, 6M and 52W are calendar windows anchored on the last close on or before the target date), total return and CAGR from dividend- and split-adjusted closes';
function foreignBasis(taxonomy: string, yahoo: boolean): string {
  return `SEC EDGAR XBRL ${taxonomy} facts of the annual 20-F or 40-F report${yahoo ? ' with gaps filled from Yahoo fundamentals-timeseries' : ''}, in the reporting currency; growth and margins in that currency, amounts and multiples over market cap in USD at Yahoo FX rates (balance sheet at the period-end rate, flows at the period average)`;
}
export const FUNDAMENTALS_BASIS = {
  sec: 'SEC EDGAR XBRL annual 10-K facts; valuation multiples from the Yahoo quoteSummary TTM snapshot',
  'sec+yahoo': 'SEC EDGAR XBRL annual 10-K facts with gaps filled from Yahoo fundamentals-timeseries; valuation multiples from the Yahoo quoteSummary TTM snapshot',
  yahoo: 'Yahoo fundamentals-timeseries annual statements (no usable SEC history); valuation multiples from the Yahoo quoteSummary TTM snapshot',
  'sec-ifrs': foreignBasis('ifrs-full', false),
  'sec-ifrs+yahoo': foreignBasis('ifrs-full', true),
  'sec-foreign': foreignBasis('us-gaap', false),
  'sec-foreign+yahoo': foreignBasis('us-gaap', true),
} as const;
export type FundamentalsSource = keyof typeof FUNDAMENTALS_BASIS;

/** A kept row published before a metric key existed gets that key as null, in METRIC_KEYS order: every row has the same key set */
export function withMetricKeys(row: JsonRecord): JsonRecord {
  const m = row.metrics;
  if (!m || typeof m !== 'object' || METRIC_KEYS.every((key) => key in m)) return row;
  const metrics: JsonRecord = {};
  for (const key of METRIC_KEYS) metrics[key] = m[key] === undefined ? null : m[key];
  for (const key of Object.keys(m)) if (!(key in metrics)) metrics[key] = m[key];
  return { ...row, metrics };
}

/** SEC TTM revenue against the Yahoo snapshot revenue (plan 1.8): more than 20% apart is a scale or tagging error */
export const SCALE_TOLERANCE_PCT = 20;
/**
 * An annual-only TTM (20-F filers) is the last fiscal year, Yahoo's revenue is a real TTM: growth alone moves them apart, so the
 * tolerance is wider; a scale error (×1000) still fails
 */
export const SCALE_TOLERANCE_ANNUAL_PCT = 50;
export function scaleCheck(secRevenue: unknown, yahooRevenue: unknown, tolerancePct = SCALE_TOLERANCE_PCT): { ok: boolean; diffPct: number } | null {
  if (typeof secRevenue !== 'number' || typeof yahooRevenue !== 'number' || !(secRevenue > 0) || !(yahooRevenue > 0)) return null;
  const diffPct = round((Math.abs(secRevenue - yahooRevenue) / yahooRevenue) * 100);
  return { ok: diffPct <= tolerancePct, diffPct };
}

export function completeMetrics(parts: JsonRecord, performanceAsOf: string | null): JsonRecord {
  const out: JsonRecord = {};
  for (const key of METRIC_KEYS) out[key] = parts[key] === undefined ? null : parts[key];
  out.returnsBasis = RETURNS_BASIS;
  out.performanceAsOf = performanceAsOf;
  return out;
}

// ---------------------------------------------------------------------------
// foreign issuers (plan 1.3): FX series per currency and run, the age limit of an annual-only SEC layer

const FX_CHART_FROM = 946_684_800; // 2000-01-01
let fxCache = new Map<string, Promise<FxSeries>>();

async function loadFx(currency: string, config: UpdaterConfig): Promise<FxSeries> {
  const { direct, inverse } = fxPairs(currency);
  const query = new URLSearchParams({ period1: String(FX_CHART_FROM), period2: String(Math.floor(Date.now() / 1000) + 86_400), interval: '1d' });
  const days = async (pair: string) => parseChart(await fetchJson(`${YAHOO_CHART_URL}/${encodeURIComponent(pair)}?${query}`, `[ fx        ] ${pair}`, config, { 'User-Agent': BROWSER_UA })).days;
  try {
    const direct1 = await days(direct);
    if (direct1.length) return { currency, pair: direct, inverted: false, points: fxPoints(direct1, false) };
  } catch (error) { note(`[ fx        ] ${direct}: ${error instanceof Error ? error.message : String(error)} - trying ${inverse}`); }
  const inverse1 = await days(inverse);
  if (!inverse1.length) throw new Error(`no Yahoo FX series for ${currency} (${direct}, ${inverse})`);
  return { currency, pair: inverse, inverted: true, points: fxPoints(inverse1, true) };
}

/** The USD-per-unit series of a currency, loaded once per run (every issuer of that currency shares it) */
export function fxSeries(currency: string, config: UpdaterConfig): Promise<FxSeries> {
  let cached = fxCache.get(currency);
  if (!cached) { cached = loadFx(currency, config); fxCache.set(currency, cached); }
  return cached;
}

/** A layer of a foreign issuer: a 20-F or 40-F annual report, or amounts in a currency other than USD */
export const isForeignLayer = (sec: SecFundamentals | null): sec is SecFundamentals =>
  !!sec && (sec.currency !== 'USD' || sec.annualForm === '20-F' || sec.annualForm === '40-F');

/** A foreign layer whose TTM ends more than this before the last close is stale (plan 1.2): the Yahoo fallback is fresher */
export const FOREIGN_STALE_DAYS = 456; // 15 months
export function staleForeignLayer(sec: SecFundamentals, asOf: string): boolean {
  const end = typeof sec.ttm?.end === 'string' ? sec.ttm.end : null;
  return !end || (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${end}T00:00:00Z`)) / DAY_MS > FOREIGN_STALE_DAYS;
}

const foreignSource = (sec: SecFundamentals, withYahoo: boolean): FundamentalsSource =>
  sec.taxonomy === 'ifrs-full' ? (withYahoo ? 'sec-ifrs+yahoo' : 'sec-ifrs') : (withYahoo ? 'sec-foreign+yahoo' : 'sec-foreign');

/** isAdr (plan 1.1): no source flags an ADR, so the flag is an issuer outside the US (Yahoo country) that files the annual 20-F */
export function adrFlag(country: string | null, annualForm: string | null): boolean | null {
  if (!country) return null;
  return country !== 'United States' && annualForm === '20-F';
}

// ---------------------------------------------------------------------------
// one company

const toCik = (cik: number) => String(cik).padStart(10, '0');

/**
 * Owner answer N36: an issuer whose TTM has no diluted EPS and no diluted shares in companyfacts (Visa reports both per share
 * class) gets the diluted shares of all classes from the XBRL instance of the filing behind its TTM (two EDGAR requests, only
 * for such issuers and only when the published layer does not carry them already). A failed download keeps the layer as is
 */
async function withAllClassShares(sec: SecFundamentals, facts: JsonRecord, cik: number, prev: SecFundamentals | null, ticker: string, config: UpdaterConfig): Promise<SecFundamentals> {
  let out = withClassShares(sec, publishedShares(prev));
  if (!needsClassShares(out)) return out;
  const accn = ttmAccession(facts, out, SEC_FORMS);
  if (!accn) return out;
  const folder = `${SEC_SITE}/Archives/edgar/data/${cik}/${accn.replace(/-/g, '')}`;
  try {
    const file = instanceFile(await fetchJson(`${folder}/index.json`, `[ sec       ] ${ticker} filing index`, config));
    if (!file) return out;
    out = withClassShares(out, parseInstanceShares(await fetchText(`${folder}/${file}`, `[ sec       ] ${ticker} instance`, config)));
  } catch (error) { note(`[ sec       ] ${ticker}: share classes: ${error instanceof Error ? error.message : String(error)}`); }
  return out;
}

function historyPeriods(range: string): { period1: number; period2: number } {
  const period2 = Math.floor(Date.now() / 1000) + DAY_MS / 1000;
  if (range === 'max') return { period1: 0, period2 };
  return { period1: Math.floor((Date.now() - Number(range.slice(0, -1)) * YEAR_MS) / 1000), period2 };
}

/** Published history in two tiers: monthly rows (last trading day of the month, summed volume) up to 31 days before the last day, daily rows for the last 31 days. Returns are computed from the full daily series before sampling. */
export function sampleHistory(days: ChartDay[]): { rows: ChartDay[]; dailyFrom: string | null } {
  const last = days[days.length - 1];
  if (!last) return { rows: [], dailyFrom: null };
  const cutoff = new Date(Date.parse(`${last.date}T00:00:00Z`) - 31 * DAY_MS).toISOString().slice(0, 10);
  const rows: ChartDay[] = [];
  let month = '';
  for (const day of days) {
    if (day.date > cutoff) { rows.push(day); continue; }
    const key = day.date.slice(0, 7);
    if (key === month) rows[rows.length - 1] = { ...day, volume: rows[rows.length - 1].volume + day.volume };
    else { rows.push({ ...day }); month = key; }
  }
  return { rows, dailyFrom: days.find((d) => d.date > cutoff)?.date ?? null };
}

/** Stale history pages are removed only after the new meta.json is written. */
async function pruneHistoryPages(dir: URL, keep: string[]): Promise<void> {
  try {
    for (const file of await readdir(new URL('history/', dir))) if (/^\d{3}\.json$/.test(file) && !keep.includes(`history/${file}`)) await rm(new URL(`history/${file}`, dir));
  } catch { /* no history dir yet */ }
}

/** The date of the first published history row (pages are oldest first), or null when nothing is published. */
async function publishedHistoryStart(dir: URL, prevMeta: JsonRecord | null): Promise<string | null> {
  const first = prevMeta?.history?.pages?.[0];
  if (typeof first !== 'string') return null;
  const page = await readJson(new URL(first, dir));
  const date = page?.rows?.[0]?.Date;
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/** Does a fresh chart start more than 31 days after the published history? (the published first row is a month-end) */
export function truncatedChart(firstFresh: string, publishedStart: string): boolean {
  return Date.parse(`${firstFresh}T00:00:00Z`) - Date.parse(`${publishedStart}T00:00:00Z`) > 31 * 86_400_000;
}

/** History pages built in memory; they are written only for a stock that is published, right before its meta.json. */
function buildHistory(ticker: string, fullDays: ChartDay[], pageSize: number): { files: Array<{ path: string; page: JsonRecord }>; history: JsonRecord } {
  const { rows: days, dailyFrom } = sampleHistory(fullDays);
  const files: Array<{ path: string; page: JsonRecord }> = [];
  const total = days.length;
  for (let i = 0; i * pageSize < total; i += 1) {
    const rows = days.slice(i * pageSize, (i + 1) * pageSize).map((d) => ({ Date: d.date, Close: String(round(d.close, 4)), 'Adj Close': String(round(d.adjClose, 4)), Volume: String(d.volume) }));
    files.push({ path: `history/${String(i + 1).padStart(3, '0')}.json`, page: { ticker, page: i + 1, pageSize, totalRows: total, headers: ['Date', 'Close', 'Adj Close', 'Volume'], rows } });
  }
  const history = { pages: files.map((f) => f.path), pageSize, totalRows: total, asOf: days[days.length - 1]?.date ?? null, granularity: { monthlyBefore: dailyFrom, dailyFrom }, source: 'Yahoo Finance public chart API (adjusted close); monthly rows (month-end close, summed volume) with daily rows for the last 31 days' };
  return { files, history };
}

/** The row with metrics.range52w set from metrics.price, week52Low and week52High (key order kept: METRIC_KEYS has it). */
export function withRange52w(row: JsonRecord): JsonRecord {
  const m = row.metrics;
  if (!m || typeof m !== 'object') return row;
  const metrics: JsonRecord = {};
  for (const key of Object.keys(m)) { metrics[key] = m[key]; if (key === 'week52Low') metrics.range52w = null; }
  metrics.range52w = range52wPosition(m.price, m.week52Low, m.week52High);
  return { ...row, metrics };
}

/**
 * Position of the price inside its 52-week range in percent: 0 = at the low, 100 = at the high, 2 decimals (owner, 2026-10-29,
 * sorted like Fidelity's 52-week range). The range is Yahoo's intraday one (or the closes when the snapshot failed) while the
 * price is the last close, so a price a little outside it is clamped to 0..100. Null when a value is missing or high <= low.
 */
export function range52wPosition(price: unknown, low: unknown, high: unknown): number | null {
  const p = typeof price === 'number' ? price : NaN, l = typeof low === 'number' ? low : NaN, h = typeof high === 'number' ? high : NaN;
  if (!Number.isFinite(p) || !Number.isFinite(l) || !Number.isFinite(h) || h <= l) return null;
  return Number(Math.min(100, Math.max(0, ((p - l) / (h - l)) * 100)).toFixed(2));
}

/** Lowest and highest close of the last 52 weeks: the 52-week range when the quoteSummary snapshot failed. */
function closeRange52w(days: ChartDay[]): { low: number | null; high: number | null } {
  const last = days[days.length - 1];
  if (!last) return { low: null, high: null };
  const from = minusDays(last.date, 52 * 7);
  const closes = days.filter((d) => d.date >= from).map((d) => d.close);
  return { low: round(Math.min(...closes), 4), high: round(Math.max(...closes), 4) };
}

/** degraded: the sources that failed for this stock in this run (it gives no signals, plan stage 8) */
export type Outcome = { row: JsonRecord; checks?: JsonRecord; degraded?: string[] } | { skipped: string };

/** Preferred shares, warrants, rights and units ("BAC-PB", "XYZ-WT", "ABC-R", "SPAC-UN") are not stocks of the catalog. */
export function isOperatingTicker(ticker: string): boolean {
  return !/-(P[A-Z]?|W[A-Z]*|R[A-Z]?|U[A-Z]?)$/.test(ticker);
}

const listNames = (names: string[], cap = 40): string => (names.length > cap ? `${names.slice(0, cap).join(', ')} and ${names.length - cap} more` : names.join(', '));

export async function processCompany(listing: Listing, config: UpdaterConfig, previous: JsonRecord | null): Promise<Outcome> {
  const ticker = listing.ticker;
  const dir = companyDir(ticker);
  const prevMeta = await readJson(new URL('meta.json', dir));

  // 1. Yahoo snapshot: skips ETFs and funds early, before the large SEC download
  let snapshot: Snapshot | null = null;
  let chart: ParsedChart | null = null;
  if (!config.skipYahoo) {
    try { snapshot = await fetchSummary(ticker, config); } catch (error) { note(`[ summary   ] ${ticker}: ${error instanceof Error ? error.message : String(error)}`); }
    if (snapshot && snapshot.quoteType && snapshot.quoteType !== 'EQUITY') return { skipped: `not a stock (${snapshot.quoteType})` };
    const { period1, period2 } = historyPeriods(config.historyRange);
    const query = new URLSearchParams({ period1: String(period1), period2: String(period2), interval: '1d', events: 'div,split', includeAdjustedClose: 'true' });
    chart = parseChart(await fetchJson(`${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?${query}`, `[ chart     ] ${ticker}`, config, { 'User-Agent': BROWSER_UA }));
    if (!chart.days.length) return { skipped: 'no price history' };
    // A truncated `max` answer never shrinks the published history: Yahoo served 2 bars for some funds on 2026-10-29, and a
    // stock's full answer starts at its listing. A chart that starts more than a month after the published history (whose
    // first row is a month-end) is a failed source: the stock keeps its published state.
    const publishedStart = period1 === 0 ? await publishedHistoryStart(dir, prevMeta) : null;
    if (publishedStart && truncatedChart(chart.days[0].date, publishedStart)) {
      throw new Error(`the Yahoo chart starts ${chart.days[0].date}, the published history ${publishedStart} (${chart.days.length} days): kept as published`);
    }
  }

  // 2. SEC fundamentals
  let rows: AnnualRow[] = [];
  let fundamentalsSource: FundamentalsSource = 'sec';
  let fundamentalsNote = '';
  let secFailed = false;
  let secMissing = false; // the CIK has no XBRL company facts at all (funds, trusts, non-filers)
  let sec: SecFundamentals | null = null;
  let annualForm: string | null | undefined; // undefined: unknown this run (a failed SEC download)
  try {
    const facts = await fetchJson(`${SEC_FACTS_URL}/CIK${toCik(listing.cik)}.json`, `[ sec       ] ${ticker}`, config);
    rows = buildAnnualRows(facts);
    sec = parseCompanyFacts(facts, { splits: chart?.splits ?? [] });
    if (sec && needsClassShares(sec)) sec = await withAllClassShares(sec, facts, listing.cik, prevMeta?.fundamentals?.sec ?? null, ticker, config);
    annualForm = sec?.annualForm ?? null;
    // a foreign issuer (plan 1.3): annual rows from its 20-F or 40-F layer; a layer older than 15 months keeps the Yahoo fallback
    if (isForeignLayer(sec)) {
      const asOf = chart?.days[chart.days.length - 1]?.date ?? prevMeta?.asOfDate ?? new Date().toISOString().slice(0, 10);
      if (staleForeignLayer(sec, asOf)) {
        note(`[ sec       ] ${ticker}: ${sec.taxonomy} facts end ${sec.ttm.end}, more than 15 months before ${asOf} - Yahoo fallback`);
        sec = null;
        rows = [];
      } else if (!rows.length) rows = annualRowsFromSec(sec);
    }
  } catch (error) {
    if (!prevMeta && /: 404 /.test(String(error))) { secMissing = true; annualForm = null; }
    else if (!prevMeta) throw error; // nothing to fall back to
    else secFailed = true;
    if (secFailed) {
      note(`[ sec       ] ${ticker}: ${error instanceof Error ? error.message : String(error)} - keeping previous fundamentals`);
      rows = prevMeta?.fundamentals?.annual ?? [];
      sec = prevMeta?.fundamentals?.sec ?? null;
    }
  }
  // scale check (plan 1.8): SEC TTM revenue vs the Yahoo snapshot; a miss withholds this run's SEC values and keeps the published
  // ones. Banks and insurers define revenue differently (net of interest expense or not), so for them it is only reported
  const industry: string | null = snapshot?.industry ?? prevMeta?.industry ?? null;
  // compared in one currency: Yahoo's revenue is in its financialCurrency, the SEC layer in its reporting currency
  const sameCurrency = !sec || !snapshot?.financialCurrency || snapshot.financialCurrency === sec.currency;
  const scale = secFailed || !sameCurrency ? null : scaleCheck(sec?.ttm?.revenue, snapshot?.totalRevenue, sec?.ttmIsAnnual ? SCALE_TOLERANCE_ANNUAL_PCT : SCALE_TOLERANCE_PCT);
  let withheld = false;
  if (scale && !scale.ok && !isFinancial(industry)) {
    withheld = true;
    console.warn(`[ check     ] ${ticker}: SEC TTM revenue is ${scale.diffPct}% away from Yahoo's - new SEC values withheld, published ones kept`);
    rows = prevMeta?.fundamentals?.annual ?? [];
    sec = prevMeta?.fundamentals?.sec ?? null;
  }
  const keepPublished = secFailed || (withheld && !!prevMeta);
  const { checks: secChecks, ...secStored } = sec ?? ({} as Partial<SecFundamentals>);
  const checks: JsonRecord = { ...((secChecks as JsonRecord | undefined) ?? (keepPublished ? prevMeta?.fundamentals?.checks ?? {} : {})), scale };
  // Yahoo only fills null fields: when the 4 latest SEC years carry every field it could fill, the request adds nothing to them
  const secComplete = rows.length >= 4 && rows.slice(0, 4).every((r) => YAHOO_FILLED_FIELDS.every((key) => r[key] !== null));
  const foreign = isForeignLayer(sec);
  if (!config.skipYahoo && !keepPublished && !secComplete) {
    try {
      // a foreign layer takes Yahoo's points only in its own reporting currency
      const merged = mergeAnnual(rows, await fetchYahooAnnual(ticker, config, foreign && sec ? sec.currency : undefined));
      rows = merged.rows;
      fundamentalsSource = merged.source;
    } catch (error) { note(`[ fundamen  ] ${ticker}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (foreign && sec && fundamentalsSource !== 'yahoo' && rows.length) fundamentalsSource = foreignSource(sec, fundamentalsSource === 'sec+yahoo');
  if (!rows.length) fundamentalsNote = 'no annual fundamentals available';
  // the layer in USD for amounts and multiples over market cap; a kept layer keeps its published conversion
  let usd: UsdLayer | null = null;
  if (sec && sec.currency !== 'USD') usd = keepPublished ? prevMeta?.fundamentals?.usd ?? null : usdLayer(sec, await fxSeries(sec.currency, config));

  // 3. assemble the company completely in memory
  const prevMarket = prevMeta?.market ?? null;
  let market: JsonRecord;
  let history: JsonRecord;
  let historyFiles: Array<{ path: string; page: JsonRecord }> = [];
  if (chart) {
    const last = chart.days[chart.days.length - 1];
    const price = chart.price ?? last.close;
    const div = dividendMetrics(chart.dividends, price, last.date);
    const valuation = snapshot ? valuationMetrics(snapshot) : (prevMarket?.valuation ?? {});
    const range = snapshot ? { low: snapshot.week52Low, high: snapshot.week52High } : closeRange52w(chart.days); // a failed snapshot: the closes still give the range
    market = {
      price, asOfDate: last.date, valuation, returns: priceReturns(chart.days), dividends: div.metrics, annualDps: div.annual,
      recentDividends: chart.dividends.slice(-12).reverse(), week52High: range.high, week52Low: range.low,
      swing: swingMetrics(chart.days, price), // the full daily series: the published history keeps daily rows for 31 days only
      estimates: snapshot ? snapshot.estimates ?? null : prevMarket?.estimates ?? null, // a failed snapshot keeps the published estimates
    };
    ({ files: historyFiles, history } = buildHistory(ticker, chart.days, config.historyPageSize));
  } else {
    if (!prevMarket) throw new Error(`${ticker}: SKIP_YAHOO is set and no previous market data exists`);
    market = prevMarket;
    history = prevMeta?.history ?? {};
  }

  const fundamentals = fundamentalsMetrics(rows);
  const secLayer = sec ? (secStored as SecFundamentals) : null;
  const marketCap = numberOrNull(market.valuation?.marketCap);
  // foreign issuer: formulas that mix market cap (USD) with amounts read the USD layer, multiples go over market cap (plan 1.3)
  const foreignLayer = isForeignLayer(secLayer);
  const marketLayer: SecFundamentals | null = !secLayer ? null : secLayer.currency === 'USD' ? secLayer : usd ? usdView(secLayer, usd) : null;
  const derived = fundamentalMetrics(secLayer, { marketCap, sector: snapshot?.sector ?? prevMeta?.sector ?? null, industry, ...(foreignLayer ? { usd: marketLayer } : {}) });
  const multiples: JsonRecord = foreignLayer ? capMultiples(marketLayer, marketCap) : {};
  // an annual-only TTM more than 12 months old: no multiples over it (owner answer N29), also none derived from P/E
  const staleTtm = staleAnnualTtm(secLayer, market.asOfDate ?? null);
  const pe = staleTtm ? null : foreignLayer ? numberOrNull(multiples.pe) : numberOrNull(market.valuation?.pe);
  const estimates = estimateMetrics(market.estimates ?? null, pe, numberOrNull(market.valuation?.forwardPe), epsCagr3y(secLayer?.fy) ?? numberOrNull(fundamentals.epsGrowth3y));
  // own 5-year history needs the full daily chart: without a fresh one (SKIP_YAHOO) the published values stay; a foreign issuer
  // has none of the P/E and P/FCF percentiles (price per ADR against shares and amounts of the ordinary shares)
  const history5y: JsonRecord = chart
    ? historyMetrics(chart.days, numberOrNull(market.price), foreignLayer ? null : secLayer, chart.dividends, numberOrNull(market.dividends?.dividendYield))
    : Object.fromEntries(HISTORY_METRIC_KEYS.map((k) => [k, prevMeta?.metrics?.[k] ?? null]));
  const country: string | null = snapshot ? snapshot.country ?? null : prevMeta?.metrics?.country ?? null;
  const issuer: JsonRecord = {
    isAdr: annualForm === undefined ? prevMeta?.metrics?.isAdr ?? null : adrFlag(country, annualForm),
    country,
    ttmIsAnnual: secLayer && typeof secLayer.ttmIsAnnual === 'boolean' ? secLayer.ttmIsAnnual : null,
  };
  const parts: JsonRecord = { ...fundamentals, ...(market.valuation ?? {}), ...(market.returns ?? {}), ...(market.dividends ?? {}), ...(market.swing ?? {}), ...derived, ...multiples, ...ownEbitdaMetrics(foreignLayer ? marketLayer : secLayer, marketCap), ...estimates, ...history5y, ...issuer, price: market.price, week52High: market.week52High, week52Low: market.week52Low, range52w: range52wPosition(market.price, market.week52Low, market.week52High), pctFrom52wHigh: pctFrom52wHigh(market.price, market.week52High) };
  if (staleTtm) STALE_TTM_MULTIPLE_KEYS.forEach((k) => { parts[k] = null; });
  if (parts.marketCap === undefined || parts.marketCap === null) parts.marketCap = null;
  const metrics = withSectorExceptions(completeMetrics(parts, market.asOfDate ?? null), industry) as JsonRecord;
  if (metrics.marketCap === null) return { skipped: 'no market cap (unit, warrant, preferred share or note)' };
  if (secMissing && !rows.length) return { skipped: 'no SEC company facts and no statements (fund, trust or non-filer)' };

  const row: JsonRecord = {
    ticker, name: snapshot?.name || prevMeta?.name || listing.name, exchange: listing.exchange, sector: snapshot?.sector ?? prevMeta?.sector ?? null, industry: snapshot?.industry ?? prevMeta?.industry ?? null,
    cik: listing.cik, currency: snapshot?.currency || chart?.currency || prevMeta?.currency || null, financialCurrency: snapshot?.financialCurrency || prevMeta?.financialCurrency || null,
    dataFile: `./companies/${ticker}/meta.json`, price: market.price, asOfDate: market.asOfDate,
    // a failed SEC download reuses the previous annual rows, so their basis travels with them (a Yahoo-only stock stays Yahoo)
    fundamentalsAsOf: rows[0]?.end ?? null, ttmAsOf: typeof secLayer?.ttm?.end === 'string' ? secLayer.ttm.end : null,
    fundamentalsBasis: (keepPublished ? prevMeta?.fundamentalsBasis : null) ?? (rows.length ? FUNDAMENTALS_BASIS[fundamentalsSource] : fundamentalsNote), metrics,
  };

  // 4. post-fetch filters keep the previously published state of unselected companies
  const reasons: string[] = [];
  if (!inRange(metrics.marketCap, config.marketCap)) reasons.push('MARKET_CAP');
  if (!inRange(metrics.dividendYield, config.dividendYield)) reasons.push('DIVIDEND_YIELD');
  for (const [period, range] of Object.entries(config.performance)) if (range && !inRange(metrics[PERFORMANCE_KEYS[period]], range)) reasons.push(`PERFORMANCE_${period}`);
  for (const [period, range] of Object.entries(config.totalReturn)) if (range && !inRange(metrics[TOTAL_RETURN_KEYS[period]], range)) reasons.push(`TOTAL_RETURN_${period}`);
  if (reasons.length) return { skipped: `filtered by ${reasons.join(', ')}` };

  // 5. ordered writes of a published stock only: history pages, then meta.json, then stale pages removed
  for (const file of historyFiles) await writeIfChanged(new URL(file.path, dir), file.page);
  const meta = {
    schemaVersion: FEED_SCHEMA_VERSION, ...row,
    sources: { universe: SEC_TICKERS_URL, fundamentals: `${SEC_FACTS_URL}/CIK${toCik(listing.cik)}.json`, market: 'Yahoo Finance chart API', snapshot: 'Yahoo Finance quoteSummary' },
    market, fundamentals: { asOf: rows[0]?.end ?? null, annual: rows, sec: secLayer, ...(usd ? { usd } : {}), checks }, history,
  };
  await writeIfChanged(new URL('meta.json', dir), meta, metaText);
  await pruneHistoryPages(dir, Array.isArray(history.pages) ? history.pages : []);
  void previous;
  // a source that failed or was withheld: the row partly keeps its published state, so its changes are not signals (plan stage 8)
  const degraded = [secFailed ? 'sec' : '', withheld ? 'scale' : '', !config.skipYahoo && !snapshot ? 'summary' : ''].filter(Boolean);
  return degraded.length ? { row, checks, degraded } : { row, checks };
}

// ---------------------------------------------------------------------------
// run

/** Delisted: gone from the SEC exchange table AND no price newer than this date (60 days back). */
const delistedBefore = () => new Date(Date.now() - 60 * DAY_MS).toISOString().slice(0, 10);

async function readPreviousRows(table: Map<string, Listing>): Promise<Map<string, JsonRecord>> {
  const out = new Map<string, JsonRecord>();
  for (const row of (await readJson(indexFile()))?.companies ?? []) out.set(String(row.ticker), row);
  // the index must list every company that has a meta.json, even when an earlier run shrank it, except a delisted one
  const staleBefore = delistedBefore();
  try {
    for (const entry of await readdir(new URL('companies/', API_ROOT))) {
      if (out.has(entry)) continue;
      const meta = await readJson(new URL(`companies/${entry}/meta.json`, API_ROOT));
      if (meta && !table.has(entry) && String(meta.asOfDate ?? '') < staleBefore) continue;
      if (meta) out.set(entry, rowFromMeta(meta));
    }
  } catch { /* first run */ }
  return out;
}

/** --prune: removes the folders of delisted companies the index no longer lists (run by hand, about once a quarter). */
export async function pruneCompanies(): Promise<string[]> {
  const index = await readJson(indexFile());
  if (!Array.isArray(index?.companies)) throw new Error('--prune: no index.json to compare with');
  const listed = new Set(index.companies.map((row: JsonRecord) => String(row.ticker)));
  const staleBefore = delistedBefore();
  const removed: string[] = [];
  for (const entry of (await readdir(new URL('companies/', API_ROOT))).sort()) {
    if (listed.has(entry)) continue;
    const meta = await readJson(new URL(`companies/${entry}/meta.json`, API_ROOT));
    if (!meta || String(meta.asOfDate ?? '') >= staleBefore) continue; // never a folder with a recent price
    await rm(companyDir(entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}

/** The published feed: the update workflow and a fresh local clone restore the previous state from here (api/stocks is not in git). */
export const PUBLISHED_SITE_URL = 'https://daggerok.github.io/Stocks/';
export const PUBLISHED_FEED_URL = `${PUBLISHED_SITE_URL}api/stocks/`;
const RESTORE_TICKER = /^[A-Z0-9][A-Z0-9.-]{0,15}$/;
const RESTORE_PAGE = /^history\/\d{3}\.json$/;

/** One feed file as text (byte-exact, so a rerun stays zero-diff), null on 404; 3 attempts with backoff on transient errors. */
async function fetchFeedFile(url: string): Promise<string | null> {
  let lastError: unknown = new Error('no request attempted');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.status === 404) return null;
      if (!response.ok) throw new HttpError(response.status, `${response.status} ${response.statusText}`);
      const text = await response.text();
      JSON.parse(text); // a feed file is always JSON: an HTML error page must not be restored
      return text;
    } catch (error) {
      lastError = error;
      if (error instanceof SyntaxError || !retryable(error)) break;
      await sleep(800 * 2 ** attempt);
    }
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function writeFeedFile(file: URL, text: string): Promise<void> {
  await mkdir(new URL('.', file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

/**
 * --restore-from [url]: downloads a published feed (index.json, update-state.json, every company meta.json and the
 * history pages its meta lists) into api/stocks, so the updater starts from the previous published state.
 * Refuses to overwrite a local index.json; index.json is written last, so an interrupted restore can simply be rerun.
 * Returns null when the site has no feed yet (404 on index.json): the next update then runs from an empty state.
 */
export async function restoreFeed(base: string = PUBLISHED_FEED_URL, concurrency = 8): Promise<{ companies: number; files: number } | null> {
  const root = base.endsWith('/') ? base : `${base}/`;
  if (await readJson(indexFile())) throw new Error(`--restore-from: ${fileURLToPath(indexFile())} exists; remove ${fileURLToPath(API_ROOT)} first to replace the local feed`);
  const indexText = await fetchFeedFile(`${root}index.json`);
  if (indexText === null) return null;
  const companies = JSON.parse(indexText).companies;
  if (!Array.isArray(companies) || !companies.length) throw new Error(`--restore-from: ${root}index.json lists no companies`);
  const tickers = companies.map((row: JsonRecord) => String(row?.ticker ?? ''));
  const bad = tickers.filter((t: string) => !RESTORE_TICKER.test(t));
  if (bad.length) throw new Error(`--restore-from: unexpected tickers in the index: ${listNames(bad)}`);
  let files = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tickers.length) {
      const ticker = tickers[next];
      next += 1;
      const metaText = await fetchFeedFile(`${root}companies/${ticker}/meta.json`);
      if (metaText === null) throw new Error(`--restore-from: companies/${ticker}/meta.json is listed in the index but missing`);
      const meta = JSON.parse(metaText);
      const pages: string[] = Array.isArray(meta?.history?.pages) ? meta.history.pages.map(String) : [];
      if (meta?.ticker !== ticker || pages.some((p) => !RESTORE_PAGE.test(p))) throw new Error(`--restore-from: companies/${ticker}/meta.json does not match its ticker or lists unexpected history pages`);
      // same order as the updater: history pages, then meta.json
      for (const page of pages) {
        const pageText = await fetchFeedFile(`${root}companies/${ticker}/${page}`);
        if (pageText === null) throw new Error(`--restore-from: companies/${ticker}/${page} is listed in meta.json but missing`);
        await writeFeedFile(new URL(page, companyDir(ticker)), pageText);
        files += 1;
      }
      await writeFeedFile(new URL('meta.json', companyDir(ticker)), metaText);
      files += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tickers.length)) }, worker));
  const stateText = await fetchFeedFile(`${root}update-state.json`);
  if (stateText !== null) { await writeFeedFile(stateFile(), stateText); files += 1; }
  // the signals of the last 12 weeks and the pending preset exits (plan stage 8); none yet before the first run with --signals
  const signalsText = await fetchFeedFile(`${root}${SIGNALS_FILE}`);
  if (signalsText !== null) { await writeFeedFile(signalsFile(), signalsText); files += 1; }
  await writeFeedFile(indexFile(), indexText);
  return { companies: tickers.length, files: files + 1 };
}

/** Watchlist tickers: All.txt splits on whitespace, commas and semicolons, All.csv takes the first cell of each row; "NYSE:TTE" and BRK.B work, a header cell is ignored. */
export function parseWatchlist(text: string, csv = false): string[] {
  const cells = csv ? text.split(/\r?\n/).map((line) => line.split(/[,;\t]/)[0] ?? '') : text.split(/[\s,;]+/);
  const out = new Set<string>();
  for (const cell of cells) {
    const ticker = watchTicker(cell);
    if (/^[A-Z0-9][A-Z0-9-]*$/.test(ticker) && ticker !== 'SYMBOL' && ticker !== 'TICKER') out.add(ticker);
  }
  return Array.from(out);
}

const watchTicker = (cell: string) => normalizeTicker(cell.replace(/["']/g, '').trim().replace(/^[A-Za-z]+:/, '').replace(/[/\s_]+/g, '-'));

/**
 * Maps watchlist spellings to known tickers: TICKER_ALIASES first, then an exact match, else the one known ticker
 * with the same letters (BRKB -> BRK-B); an ambiguous or unknown one stays as written.
 */
export function resolveWatchlist(list: Iterable<string>, known: Iterable<string>, aliases: Record<string, string[]> = TICKER_ALIASES): Set<string> {
  const alias = new Map<string, string>();
  for (const [ticker, spellings] of Object.entries(aliases)) for (const spelling of spellings) alias.set(watchTicker(spelling), watchTicker(ticker));
  const compact = (ticker: string) => ticker.replace(/[^A-Z0-9]/g, '');
  const exact = new Set(known);
  const byLetters = new Map<string, string[]>();
  exact.forEach((ticker) => byLetters.set(compact(ticker), [...(byLetters.get(compact(ticker)) ?? []), ticker]));
  const out = new Set<string>();
  for (const ticker of Array.from(list)) {
    const same = byLetters.get(compact(ticker)) ?? [];
    out.add(alias.get(ticker) ?? (exact.has(ticker) || same.length !== 1 ? ticker : same[0]));
  }
  return out;
}

/** scripts/All.txt, else scripts/All.csv: the first one that lists tickers limits the feed to them; no file or an empty one means the full universe. */
export async function readWatchlist(): Promise<{ file: string; tickers: Set<string> } | null> {
  for (const file of ['All.txt', 'All.csv']) {
    let text: string;
    try { text = await readFile(fileURLToPath(new URL(file, WATCHLIST_DIR)), 'utf8'); } catch { continue; }
    const tickers = parseWatchlist(text, file.endsWith('.csv'));
    if (tickers.length) return { file, tickers: new Set(tickers) };
  }
  return null;
}

/**
 * The owner's list (scripts/All.txt or All.csv) as the screener's "Mine" preset reads it (plan 1.1): every row gets isMine, and the
 * index lists every ticker of the file in mineTickers, also the ETFs and funds that are not in the stock feed. No list: isMine false
 */
export function withIsMine(row: JsonRecord, mine: ReadonlySet<string> | null): JsonRecord {
  return { ...row, isMine: mine ? mine.has(String(row.ticker)) : false };
}

export function indexDocument(companies: JsonRecord[], mineTickers?: string[]): JsonRecord {
  return {
    schemaVersion: FEED_SCHEMA_VERSION,
    generatedAt: stamp(),
    source: {
      provider: 'U.S. exchange-listed stocks (Nasdaq, NYSE, Cboe)', market: 'us', universe: SEC_TICKERS_URL, fundamentals: 'SEC EDGAR XBRL companyfacts (annual 10-K; 10-K and 10-Q quarters and TTM in companies/<T>/meta.json fundamentals.sec)',
      history: 'Yahoo Finance public chart API (adjusted close)', snapshot: 'Yahoo Finance quoteSummary (market cap, TTM and forward valuation)',
    },
    counts: { companies: companies.length },
    ...(mineTickers ? { mineTickers } : {}),
    companies,
  };
}

/**
 * --signals (plan stage 8): the previous index (as it was before this run) and the new one give api/stocks/signals.json. The base
 * presets, the committed own presets of user-data/presets, user-data/peers.json and the scoring config are read from the repo.
 * Quiet stocks (a failed source, or not refreshed by this run) give no signals; no previous index is the first run, no signals
 */
export async function updateSignals(previous: JsonRecord | null, current: JsonRecord, quiet: string[], now: Date = new Date()): Promise<SignalsResult> {
  const sources = loadSignalSources();
  for (const warning of sources.warnings) console.warn(`[ signals   ] ${warning}`);
  const state = parseSignals(await readJson(signalsFile()));
  const result = computeSignals({ previous, current, presets: sources.presets, peers: sources.peers, scoring: sources.scoring, quiet, state, now });
  await writeIfChanged(signalsFile(), result.doc);
  const line = result.firstRun
    ? 'signals: no previous index, first run: no signals'
    : `signals: ${result.added.length} new, ${result.doc.signals.length} kept, ${result.doc.pendingExits.length} preset exits wait for a second run, ${quiet.length} quiet stocks`;
  console.log(`[ signals   ] ${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n\n`, 'utf8');
  return result;
}

/**
 * --signals-issue <dir> [siteUrl]: title.txt and body.md of the weekly GitHub issue from api/stocks/signals.json (the signals of
 * the last 7 days with links to the site); prints the count and writes count=N to $GITHUB_OUTPUT, 0 means no issue
 */
export async function writeSignalsIssue(dir: string, siteUrl: string = PUBLISHED_SITE_URL, now: Date = new Date()): Promise<number> {
  const sources = loadSignalSources();
  const issue = signalsIssue(parseSignals(await readJson(signalsFile())), { now, siteUrl, names: signalNames(sources.presets, sources.scoring) });
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/title.txt`, `${issue.title}\n`, 'utf8');
  await writeFile(`${dir}/body.md`, issue.body, 'utf8');
  console.log(`[ signals   ] ${issue.title}: ${issue.count} signals -> ${dir}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `count=${issue.count}\n`, 'utf8');
  return issue.count;
}

export async function run(controls: Record<string, string | undefined>, options: { deadlineMs?: number; signals?: boolean; now?: Date } = {}): Promise<{ updated: number; skipped: number; failed: number; rows: number; signals: number | null }> {
  const config = readConfig(controls);
  secUa = config.secUa;
  requestSleepSeconds = config.requestSleep;
  requestGates = new Array(Math.max(1, config.concurrency)).fill(0);
  verboseOutput = config.verbose;
  yahooSession = null;
  yahooSessionRetryAt = 0;
  fxCache = new Map<string, Promise<FxSeries>>();

  const table = parseSecTickers(await fetchJson(SEC_TICKERS_URL, '[ universe  ] SEC ticker table', config));
  const previous = await readPreviousRows(table);
  const previousIndex = options.signals ? await readJson(indexFile()) : null; // the snapshot the signals compare with
  // scripts/All.txt or All.csv with tickers: the feed holds only those stocks, every other row and folder is removed
  const watchlist = await readWatchlist();
  const allowed = watchlist ? resolveWatchlist(watchlist.tickers, Array.from(table.keys()).concat(Array.from(previous.keys()))) : null;
  if (watchlist && allowed) console.log(`[ universe  ] watchlist scripts/${watchlist.file}: ${allowed.size} tickers`);
  let wanted = Array.from(config.tickers ?? allowed ?? table.keys());
  if (config.tickers && allowed && watchlist) {
    const outside = wanted.filter((t) => !allowed.has(t));
    if (outside.length) console.warn(`[ universe  ] not in scripts/${watchlist.file}, skipped: ${listNames(outside)}`);
    wanted = wanted.filter((t) => allowed.has(t));
  }
  const universe: Listing[] = [];
  const unlisted: string[] = [];
  let failed = 0;
  for (const ticker of wanted.sort()) {
    const listing = table.get(ticker);
    if (!listing) { if (config.tickers) { failed += 1; console.warn(`[ universe  ] ${ticker}: not found in the SEC exchange table`); } else if (allowed) unlisted.push(ticker); continue; }
    if (!config.exchanges.has(listing.exchange.toUpperCase())) { if (config.tickers || allowed) console.warn(`[ universe  ] ${ticker}: skipped, listed on ${listing.exchange}`); continue; }
    if (!config.tickers && !allowed && !isOperatingTicker(ticker)) continue; // an explicit list always wins
    universe.push(listing);
  }
  if (unlisted.length) console.log(`[ universe  ] ${unlisted.length} watchlist tickers are not in the SEC exchange table (ETFs, funds): ${listNames(unlisted)}`);
  console.log(`[ universe  ] ${universe.length} stocks on ${Array.from(config.exchanges).join(', ')}`);

  // Rotation: full-universe runs continue after the committed cursor (a run that stops at MAX_FETCHES or the soft deadline resumes there);
  // runs with an explicit TICKERS list never read or move it
  const rotate = !config.tickers;
  const state = (await readJson(stateFile())) ?? {};
  const cursor = rotate ? String(state.cursor ?? '') : '';
  const at = cursor ? universe.findIndex((l) => l.ticker > cursor) : -1;
  const queue = at > 0 ? universe.slice(at).concat(universe.slice(0, at)) : universe.slice();
  const total = config.maxFetches > 0 ? Math.min(config.maxFetches, queue.length) : queue.length;
  const results: JsonRecord[] = [];
  const clean = new Set<string>(); // refreshed in this run with every source answering
  const checkFails: Record<string, string[]> = { balance: [], grossProfit: [], quarterSum: [], scale: [] };
  const started = Date.now();
  let processed = 0;
  let skipped = 0;
  let lastTicker: string | null = cursor || null;
  const deadlineMs = options.deadlineMs ?? SOFT_DEADLINE_MS;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (config.maxFetches > 0 && processed >= config.maxFetches) return;
      if (Date.now() - started > deadlineMs) return;
      const listing = queue.shift();
      if (!listing) return;
      lastTicker = listing.ticker;
      const n = ++processed;
      try {
        const out = await processCompany(listing, config, previous.get(listing.ticker) ?? null);
        if ('skipped' in out) { skipped += 1; console.log(`[ ${`${String(n).padStart(String(total).length)}/${total}`.padEnd(9)} ] ${listing.ticker.padEnd(6)} skipped: ${out.skipped}`); continue; }
        results.push(out.row);
        if (!out.degraded) clean.add(listing.ticker);
        for (const name of Object.keys(checkFails)) if (out.checks?.[name] && out.checks[name].ok === false) checkFails[name].push(`${listing.ticker} ${out.checks[name].diffPct}%`);
        const m = out.row.metrics;
        console.log(`[ ${`${String(n).padStart(String(total).length)}/${total}`.padEnd(9)} ] ${listing.ticker.padEnd(6)} updated  cap ${m.marketCap === null ? '-' : `$${round(m.marketCap / 1e9, 1)}B`}  P/E ${m.pe ?? '-'}  FY ${out.row.fundamentalsAsOf ?? '-'}`);
      } catch (error) {
        failed += 1;
        console.warn(`[ ${`${String(n).padStart(String(total).length)}/${total}`.padEnd(9)} ] ${listing.ticker.padEnd(6)} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));

  // Filtered, bounded, skipped and failed companies keep their published row: the index never shrinks.
  const byTicker = new Map<string, JsonRecord>(previous);
  const added = results.filter((r) => !previous.has(String(r.ticker))).map((r) => String(r.ticker));
  for (const row of results) byTicker.set(String(row.ticker), row);
  // Delisted: no longer in the SEC exchange table AND no fresh price for 60 days (both, so a transient gap in the table never drops a live stock).
  const delisted: string[] = [];
  if (!config.tickers) {
    const staleBefore = delistedBefore();
    for (const [ticker, row] of Array.from(byTicker)) {
      if (!table.has(ticker) && String(row.asOfDate ?? '') < staleBefore) { byTicker.delete(ticker); delisted.push(ticker); }
    }
  }
  const outsideWatchlist: string[] = [];
  if (allowed) for (const ticker of Array.from(byTicker.keys())) if (!allowed.has(ticker)) { byTicker.delete(ticker); outsideWatchlist.push(ticker); }
  // every row gets range52w from its own price and 52-week low and high, also the rows this run did not refresh
  const companies = Array.from(byTicker.values()).sort((a, b) => String(a.ticker).localeCompare(String(b.ticker))).map(withMetricKeys).map(withRange52w).map((row) => withIsMine(row, allowed));
  const indexDoc = indexDocument(companies, allowed ? Array.from(allowed).sort() : undefined);
  await writeIfChanged(indexFile(), indexDoc, compactIndexText);
  if (allowed && watchlist) {
    // folders go only after the index stops listing them; a folder of a listed stock is never touched
    let folders: string[] = [];
    try { folders = (await readdir(new URL('companies/', API_ROOT))).sort(); } catch { /* first run */ }
    const removed = folders.filter((ticker) => !allowed.has(ticker));
    for (const ticker of removed) await rm(companyDir(ticker), { recursive: true, force: true });
    const gone = Array.from(new Set([...outsideWatchlist, ...removed])).sort();
    if (gone.length) console.log(`[ watchlist ] removed ${gone.length} stocks not in scripts/${watchlist.file}: ${listNames(gone)}`);
  }
  if (rotate) await writeIfChanged(stateFile(), { cursor: queue.length ? lastTicker : null, savedAt: stamp() });
  console.log(`[ done      ] ${results.length} updated, ${skipped} skipped, ${failed} failed; index lists ${companies.length} companies`);
  if (delisted.length) console.log(`DELISTED (${delisted.length}): ${listNames(delisted)}`);
  if (added.length) {
    console.log(`NEW STOCKS (${added.length}): ${listNames(added)}`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `NEW STOCKS (${added.length}): ${listNames(added)}\n`, 'utf8');
  }
  const checkLines = Object.keys(checkFails).filter((name) => checkFails[name].length).map((name) => `data check ${name}: ${checkFails[name].length} (${listNames(checkFails[name], 20)})`);
  for (const line of checkLines) console.log(`[ check     ] ${line}`);
  console.log(`[ check     ] ${adrCoverageLine(companies)}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Stocks data update\n\n- updated: ${results.length}\n- skipped: ${skipped}\n- failed: ${failed}\n- companies: ${companies.length}\n${checkLines.map((l) => `- ${l}\n`).join('')}\n`, 'utf8');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${adrCoverageLine(companies)}\n\n`, 'utf8');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, coverageMarkdown(companies), 'utf8');
  }
  let signals: number | null = null;
  if (options.signals) {
    const quiet = companies.map((row) => String(row.ticker)).filter((ticker) => !clean.has(ticker));
    signals = (await updateSignals(previousIndex, indexDoc, quiet, options.now)).added.length;
  }
  return { updated: results.length, skipped, failed, rows: companies.length, signals };
}

export type AdrCoverage = { adr: number; secIfrs: number; secUsGaap: number; yahoo: number; none: number };
/** Where the fundamentals of the ADR rows come from (plan 1.3): SEC ifrs-full, SEC us-gaap, the Yahoo fallback or nothing */
export function adrCoverage(companies: JsonRecord[]): AdrCoverage {
  const out: AdrCoverage = { adr: 0, secIfrs: 0, secUsGaap: 0, yahoo: 0, none: 0 };
  const ifrs = [FUNDAMENTALS_BASIS['sec-ifrs'], FUNDAMENTALS_BASIS['sec-ifrs+yahoo']];
  const usGaap = [FUNDAMENTALS_BASIS['sec-foreign'], FUNDAMENTALS_BASIS['sec-foreign+yahoo'], FUNDAMENTALS_BASIS.sec, FUNDAMENTALS_BASIS['sec+yahoo']];
  for (const c of companies) {
    if (c.metrics?.isAdr !== true) continue;
    out.adr += 1;
    const basis = String(c.fundamentalsBasis ?? '');
    if (ifrs.indexOf(basis) >= 0) out.secIfrs += 1;
    else if (usGaap.indexOf(basis) >= 0) out.secUsGaap += 1;
    else if (basis === FUNDAMENTALS_BASIS.yahoo) out.yahoo += 1;
    else out.none += 1;
  }
  return out;
}
export function adrCoverageLine(companies: JsonRecord[]): string {
  const c = adrCoverage(companies);
  return `ADR fundamentals: ${c.adr} ADRs, SEC ifrs-full ${c.secIfrs}, SEC us-gaap ${c.secUsGaap}, Yahoo fallback ${c.yahoo}, none ${c.none}`;
}

/** Coverage of every numeric metric (share of companies with a value), overall and per sector: the step summary table (plan 1.8) */
export function coverageMarkdown(companies: JsonRecord[]): string {
  if (!companies.length) return '';
  const sectors = Array.from(new Set(companies.map((c) => String(c.sector ?? 'Unknown')))).sort();
  const keys = METRIC_KEYS.filter((k) => !companies.some((c) => typeof c.metrics?.[k] === 'string' || typeof c.metrics?.[k] === 'boolean')); // numeric metrics only
  const share = (rows: JsonRecord[], k: string) => (rows.length ? `${Math.round((rows.filter((c) => typeof c.metrics?.[k] === 'number').length / rows.length) * 100)}` : '');
  const bySector = sectors.map((s) => companies.filter((c) => String(c.sector ?? 'Unknown') === s));
  const head = `| metric | all (${companies.length}) | ${sectors.map((s, i) => `${s} (${bySector[i].length})`).join(' | ')} |`;
  const rule = `|---|---|${sectors.map(() => '---').join('|')}|`;
  const lines = keys.map((k) => `| ${k} | ${share(companies, k)} | ${bySector.map((rows) => share(rows, k)).join(' | ')} |`);
  return `#### Metric coverage, % of companies with a value\n\n${head}\n${rule}\n${lines.join('\n')}\n\n`;
}

const USAGE = `
Stocks static data updater (Nasdaq, NYSE, Cboe)

Sources:
  universe      SEC company_tickers_exchange.json (ticker, CIK, exchange)
  fundamentals  SEC EDGAR XBRL companyfacts: 10-K and 10-Q facts, the 20-F and
                40-F of foreign issuers (us-gaap or ifrs-full, Yahoo FX rates
                convert amounts to USD); Yahoo fundamentals-timeseries fills
                gaps and covers issuers without usable SEC facts
  history       Yahoo Finance public chart API (daily, published as monthly rows
                with daily rows for the last 31 days)
  snapshot      Yahoo Finance quoteSummary (market cap, TTM and forward valuation)

Configuration: scripts/update-data.config.json defaults < advanced JSON (workflow
only) < nonblank workflow inputs < environment variables below (all filters use
AND logic):
  MAX_FETCHES=0       all selected stocks; positive value is a resumable batch
  REQUEST_SLEEP=1     seconds between request starts per worker lane
  CONCURRENCY=3       parallel workers, each with its own request lane
  MAX_RETRIES=2       retries after the initial request (integer >= 1)
  EXCHANGES=Nasdaq,NYSE,CBOE   listing exchanges to include
  TICKERS="AAPL MSFT"  ticker allowlist (BRK.B and BRK-B both work); blank = every stock on EXCHANGES
  MARKET_CAP=:        market cap range in USD, K/M/B/T suffixes allowed (10B:)
  DIVIDEND_YIELD=:    dividend yield percentage range
  PERFORMANCE_1D|3D|1W|WTD|2W|20D|1M|MTD|40D|60D|1Q|QTD|4M|6M|52W|YTD|1Y|3Y|5Y|10Y=min:max
                      price change ranges (%); D, 1W and 2W count daily candles, WTD, MTD, QTD are to date
                      (workflow: pass them in the advanced JSON, only YTD to 10Y are individual inputs)
  TOTAL_RETURN_YTD|1Y|3Y|5Y|10Y=min:max total return ranges (%)
  HISTORY_RANGE=max   Yahoo history range (max, 10y, 5y, ...)
  HISTORY_PAGE_SIZE=1000
  SKIP_YAHOO=false    keep the published market data, refresh SEC fundamentals only
  SEC_UA=             SEC User-Agent override (declare a contact); blank uses the built-in default (daggerok ETF feed daggerok@gmail.com)
  VERBOSE=false
  USE_SYSTEM_CA=auto  TLS trust store: auto restarts once with --use-system-ca on an untrusted-certificate error | true | false

Watchlist: when scripts/All.txt (else scripts/All.csv) lists tickers, only those
stocks are updated and published; rows and folders of every other stock are
removed. ETFs and funds in the list are not in the SEC table and are skipped.
No file or an empty one means a full update of every stock on EXCHANGES.

A full-universe run (no TICKERS) drops a delisted stock from the index: gone from
the SEC exchange table and no price for 60 days. Its folder stays until
  ./scripts/update-data.ts --prune
removes the folders of such stocks (run it by hand about once a quarter).

api/stocks is not in git: the update workflow publishes it as a GitHub Pages
artifact. Restore the published feed into an empty api/stocks (the workflow does
this when its Actions cache is empty; a local clone needs it once):
  ./scripts/update-data.ts --restore-from [url]
(default url ${PUBLISHED_FEED_URL}; refuses to overwrite a local index.json)

Signals (plan stage 8): --signals also writes api/stocks/signals.json after the
run: preset entries and exits, new and removed flags, status, archetype and large
score changes against the index as it was before the run (last 12 weeks kept).
  ./scripts/update-data.ts --signals
The weekly issue text (signals of the last 7 days, links to the site):
  ./scripts/update-data.ts --signals-issue <dir> [siteUrl]

Examples:
  TICKERS="AAPL MSFT JPM" ./scripts/update-data.ts
  TICKERS= MARKET_CAP="10B:" DIVIDEND_YIELD="2:" ./scripts/update-data.ts
  TOTAL_RETURN_1Y="20:" ./scripts/update-data.ts
`;

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice    ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  const file = JSON.parse(await readFile(fileURLToPath(CONFIG_FILE_URL), 'utf8'));
  return resolveControls(file, {}, {}, env);
}

// require.main === module instead of import.meta.main and a main() instead of top-level await: same IDE defaults as above
async function main(): Promise<void> {
  if (process.argv.some((arg) => ['-h', '--help', 'help'].includes(arg))) console.log(USAGE.trim());
  else if (process.argv.includes('--prune')) await pruneCompanies().then((removed) => console.log(`[ prune     ] removed ${removed.length} delisted folders${removed.length ? `: ${listNames(removed)}` : ''}`)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
  else if (process.argv.includes('--signals-issue')) {
    const [dir, site] = process.argv.slice(process.argv.indexOf('--signals-issue') + 1);
    if (!dir || dir.startsWith('-')) { console.error('usage: ./scripts/update-data.ts --signals-issue <dir> [siteUrl]'); process.exitCode = 2; }
    else await writeSignalsIssue(dir, site && !site.startsWith('-') ? site : PUBLISHED_SITE_URL).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
  }
  else if (process.argv.includes('--restore-from')) {
    const next = process.argv[process.argv.indexOf('--restore-from') + 1];
    await restoreFeed(next && !next.startsWith('-') ? next : PUBLISHED_FEED_URL).then((done) => console.log(done
      ? `[ restore   ] ${done.companies} companies, ${done.files} files -> ${fileURLToPath(API_ROOT)}`
      : '[ restore   ] no published feed yet (index.json 404): the update starts from an empty state')).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
  }
  else await runtimeControls().then((controls) => { installSystemCa(controls.USE_SYSTEM_CA ?? 'auto'); return run(controls, { signals: process.argv.includes('--signals') }); }).catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
}

if (require.main === module) main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
