#!/usr/bin/env bun
// Bun provides Node-compatible fs/promises; node types are intentionally not required at runtime.
/// <reference types="bun" />
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Stocks listed on Nasdaq, NYSE and Cboe: static ./api/stocks feed.
//   universe      SEC company_tickers_exchange.json (ticker, CIK, exchange)
//   fundamentals  SEC EDGAR XBRL companyfacts (annual 10-K series, up to ~15 years)
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

const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);
let API_ROOT = new URL('../api/stocks/', import.meta.url);
export function useApiRoot(root: URL): URL { const previous = API_ROOT; API_ROOT = root; return previous; }
const indexFile = () => new URL('index.json', API_ROOT);
const stateFile = () => new URL('update-state.json', API_ROOT);
const companyDir = (ticker: string) => new URL(`companies/${ticker}/`, API_ROOT);

export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'MAX_RETRIES', 'EXCHANGES', 'TICKERS', 'MARKET_CAP', 'DIVIDEND_YIELD',
  'HISTORY_RANGE', 'HISTORY_PAGE_SIZE', 'SKIP_YAHOO', 'SEC_UA', 'VERBOSE',
] as const;

export type UpdaterConfig = {
  maxFetches: number;
  requestSleep: number;
  concurrency: number;
  maxRetries: number;
  exchanges: Set<string>;
  tickers: Set<string> | null;
  marketCap: Range;
  dividendYield: Range;
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
  constructor(public status: number, message: string) { super(message); this.name = 'HttpError'; }
}
const retryable = (error: unknown) => (error instanceof HttpError ? [403, 408, 425, 429].includes(error.status) || error.status >= 500 : true);

async function fetchText(url: string, label: string, config: UpdaterConfig, headers: Record<string, string> = {}): Promise<string> {
  let lastError: unknown = new Error('no request attempted');
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      await paceRequests();
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS); // covers headers and body
      const response = await fetch(url, { headers: { 'User-Agent': secUa, Accept: '*/*', ...headers }, redirect: 'follow', signal });
      if (!response.ok) throw new HttpError(response.status, `${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt >= config.maxRetries || !retryable(error)) break;
      const rateLimited = error instanceof HttpError && error.status === 429;
      await sleep(Math.min(60_000, (rateLimited ? 12_000 : 800) * 2 ** attempt));
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
    for (const [end, fact] of best) if (!out.has(end)) out.set(end, fact.val);
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

const TAGS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueGoodsNet', 'SalesRevenueServicesNet'],
  costOfRevenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  da: ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'DepreciationAmortizationAndOther'],
  ocf: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets', 'PaymentsForCapitalImprovements'],
  dividends: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
  pretax: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],
  tax: ['IncomeTaxExpenseBenefit'],
  assets: ['Assets'],
  currentAssets: ['AssetsCurrent'],
  currentLiabilities: ['LiabilitiesCurrent'],
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsAndShortTermInvestments', 'CashAndCashEquivalentsAtCarryingValueIncludingRestrictedCash'],
  shortInvestments: ['MarketableSecuritiesCurrent', 'ShortTermInvestments', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent'],
  longInvestments: ['MarketableSecuritiesNoncurrent', 'AvailableForSaleSecuritiesDebtSecuritiesNoncurrent', 'LongTermInvestments'],
  receivables: ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent'],
  debtCombined: ['DebtLongtermAndShorttermCombinedAmount'],
  debtNoncurrent: ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations'],
  debtCurrent: ['LongTermDebtCurrent', 'DebtCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent'],
  debtTotalFallback: ['LongTermDebt'],
  commercialPaper: ['CommercialPaper', 'ShortTermBorrowings'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
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

  const ends = [...(revenue.size ? revenue.keys() : ocf.keys())].sort().reverse().slice(0, limit);
  return ends.map((end): AnnualRow => {
    const rev = revenue.get(end);
    const gp = gross.get(end) ?? (rev !== undefined && cost.has(end) ? rev - cost.get(end)! : undefined);
    const opInc = op.get(end);
    const dna = da.get(end);
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

export function parseYahooAnnual(payload: JsonRecord): Map<string, Partial<AnnualRow>> {
  const byDate = new Map<string, Partial<AnnualRow>>();
  for (const item of payload?.timeseries?.result ?? []) {
    const type: string = item?.meta?.type?.[0];
    const field = YAHOO_ANNUAL_TYPES[type];
    if (!field) continue;
    for (const point of item[type] ?? []) {
      const value = numberOrNull(point?.reportedValue);
      if (value === null || !point?.asOfDate) continue;
      const row = byDate.get(point.asOfDate) ?? {};
      (row as JsonRecord)[field] = ABSOLUTE_FIELDS.has(field) ? Math.abs(value) : value;
      byDate.set(point.asOfDate, row);
    }
  }
  return byDate;
}

async function fetchYahooAnnual(ticker: string, config: UpdaterConfig): Promise<Map<string, Partial<AnnualRow>>> {
  const query = new URLSearchParams({ type: Object.keys(YAHOO_ANNUAL_TYPES).join(','), period1: '1262304000', period2: String(Math.floor(Date.now() / 1000) + 86_400) });
  return parseYahooAnnual(await fetchJson(`${YAHOO_TIMESERIES_URL}/${encodeURIComponent(ticker)}?${query}`, `[fundamen] ${ticker}`, config, { 'User-Agent': BROWSER_UA }));
}

const emptyRow = (end: string): AnnualRow => ({ end, revenue: null, grossProfit: null, operatingIncome: null, ebitda: null, netIncome: null, eps: null, operatingCashFlow: null, capex: null, fcf: null, dividendsPaid: null, assets: null, currentAssets: null, currentLiabilities: null, cash: null, longInvestments: null, receivables: null, debt: null, equity: null, taxRate: null });

/** SEC rows win; Yahoo only fills null fields of a row whose period end is within 10 days, and adds rows SEC has none for (newer than the SEC history or when SEC has fewer than 3 rows). */
export function mergeAnnual(sec: AnnualRow[], yahoo: Map<string, Partial<AnnualRow>>): { rows: AnnualRow[]; source: 'sec' | 'sec+yahoo' | 'yahoo' } {
  const rows = sec.map((r) => ({ ...r }));
  let filled = false;
  const usable = new Set<string>();
  for (const [date, values] of yahoo) {
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
export type ParsedChart = { days: ChartDay[]; dividends: Array<{ date: string; amount: number }>; price: number | null; exchangeName: string; currency: string };

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
  return { days, dividends, price: numberOrNull(result.meta?.regularMarketPrice), exchangeName: String(result.meta?.fullExchangeName ?? result.meta?.exchangeName ?? ''), currency: String(result.meta?.currency ?? '') };
}

function anchorDay(days: ChartDay[], target: string): ChartDay | null {
  let found: ChartDay | null = null;
  for (const day of days) { if (day.date <= target) found = day; else break; }
  return found;
}
const pct = (start: number | null | undefined, end: number | null | undefined) => (start && end !== null && end !== undefined ? rounded((end / start - 1) * 100) : null);
const cagr = (start: number | null | undefined, end: number | null | undefined, years: number) => (start && start > 0 && end && end > 0 ? rounded(((end / start) ** (1 / years) - 1) * 100) : null);

export function priceReturns(days: ChartDay[]): JsonRecord {
  const last = days[days.length - 1];
  const empty = { perfYtd: null, perf1y: null, perf3y: null, perf5y: null, perf10y: null, ytd: null, tr1y: null, tr3y: null, tr5y: null, tr10y: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null };
  if (!last) return empty;
  const at = (years: number) => anchorDay(days, new Date(Date.parse(`${last.date}T00:00:00Z`) - years * YEAR_MS).toISOString().slice(0, 10));
  const yearStart = anchorDay(days, `${Number(last.date.slice(0, 4)) - 1}-12-31`);
  const [d1, d3, d5, d10] = [at(1), at(3), at(5), at(10)];
  const first = days[0];
  const spanYears = dayDiff(last.date, first.date) / 365.25;
  return {
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
  const annual = [...byYear.entries()].sort((a, b) => b[0] - a[0]).slice(0, 15).map(([year, v]) => ({ year, dps: round(v, 4) }));
  return {
    metrics: {
      dividendYield: price ? (ttm > 0 ? rounded((ttm / price) * 100) : 0) : null, // no payments in the last year is an honest 0
      dividendRate: ttm > 0 ? rounded(ttm, 4) : null,
      dividendGrowth: growth(1), dividendGrowth3y: growth(3), dividendGrowth5y: growth(5),
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
    const crumb = (await fetchText(YAHOO_CRUMB_URL, '[yahoo   ] crumb', config, { 'User-Agent': BROWSER_UA, Cookie: cookie })).trim();
    if (!crumb || /[<{\s]/.test(crumb)) throw new Error('invalid crumb');
    return { cookie, crumb };
  } catch (error) {
    note(`[yahoo   ] session unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
const getYahooSession = (config: UpdaterConfig) => (yahooSession ??= openYahooSession(config));

export type Snapshot = {
  quoteType: string; name: string; sector: string | null; industry: string | null; currency: string; financialCurrency: string;
  marketCap: number | null; enterpriseValue: number | null; sharesOutstanding: number | null; beta: number | null;
  pe: number | null; forwardPe: number | null; ps: number | null; forwardRevenue: number | null; evEbitda: number | null; pb: number | null;
  freeCashflow: number | null; ebitda: number | null; week52High: number | null; week52Low: number | null;
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
    sector: r.assetProfile?.sector ?? null, industry: r.assetProfile?.industry ?? null,
    currency: String(price.currency ?? ''), financialCurrency: String(fd.financialCurrency ?? price.currency ?? ''),
    marketCap: numberOrNull(price.marketCap) ?? numberOrNull(sd.marketCap), enterpriseValue: numberOrNull(ks.enterpriseValue),
    sharesOutstanding: numberOrNull(ks.sharesOutstanding), beta: numberOrNull(sd.beta) ?? numberOrNull(ks.beta),
    pe: numberOrNull(sd.trailingPE), forwardPe: numberOrNull(ks.forwardPE) ?? numberOrNull(sd.forwardPE), ps: numberOrNull(sd.priceToSalesTrailing12Months),
    forwardRevenue: numberOrNull(trend?.revenueEstimate?.avg), evEbitda: numberOrNull(ks.enterpriseToEbitda), pb: numberOrNull(ks.priceToBook),
    freeCashflow: numberOrNull(fd.freeCashflow), ebitda: numberOrNull(fd.ebitda),
    week52High: numberOrNull(sd.fiftyTwoWeekHigh), week52Low: numberOrNull(sd.fiftyTwoWeekLow),
  };
}

async function fetchSummary(ticker: string, config: UpdaterConfig): Promise<Snapshot | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await getYahooSession(config);
    if (!session) return null;
    const modules = 'price,summaryDetail,defaultKeyStatistics,financialData,earningsTrend,assetProfile';
    try {
      const payload = await fetchJson(`${YAHOO_SUMMARY_URL}/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}`, `[summary ] ${ticker}`, config, { 'User-Agent': BROWSER_UA, Cookie: session.cookie });
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

async function writeIfChanged(file: URL, value: unknown): Promise<boolean> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
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

const ROW_KEYS = ['ticker', 'name', 'exchange', 'sector', 'industry', 'cik', 'currency', 'financialCurrency', 'dataFile', 'price', 'asOfDate', 'fundamentalsAsOf', 'fundamentalsBasis', 'metrics'];
export const rowFromMeta = (meta: JsonRecord): JsonRecord => Object.fromEntries(ROW_KEYS.map((k) => [k, meta[k] ?? null]));

const METRIC_KEYS = [
  'marketCap', 'enterpriseValue', 'price', 'week52High', 'week52Low', 'beta', 'sharesOutstanding',
  'pe', 'forwardPe', 'ps', 'forwardPs', 'pFcf', 'evEbitda', 'fcfToEbitda', 'pb',
  'dividendYield', 'dividendRate', 'dividendGrowth', 'dividendGrowth3y', 'dividendGrowth5y', 'payoutRatio', 'fcfPayout',
  'currentRatio', 'quickRatio', 'debtToEquity', 'netDebtToEbitda', 'roic',
  ...['revenue', 'eps', 'fcf', 'ebitda', 'capex', 'assets', 'debt'].flatMap((n) => [`${n}Growth`, `${n}Growth3y`, `${n}Growth5y`]),
  'netMargin', 'grossMargin', 'ebitdaMargin', 'fcfMargin',
  ...['netMargin', 'grossMargin', 'ebitdaMargin', 'fcfMargin'].flatMap((n) => [`${n}Delta`, `${n}Delta3y`]),
  'perfYtd', 'perf1y', 'perf3y', 'perf5y', 'perf10y', 'ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn',
] as const;

export const RETURNS_BASIS = 'Yahoo chart API: performance from unadjusted closes, total return and CAGR from dividend- and split-adjusted closes';
export const FUNDAMENTALS_BASIS = {
  sec: 'SEC EDGAR XBRL annual 10-K facts; valuation multiples from the Yahoo quoteSummary TTM snapshot',
  'sec+yahoo': 'SEC EDGAR XBRL annual 10-K facts with gaps filled from Yahoo fundamentals-timeseries; valuation multiples from the Yahoo quoteSummary TTM snapshot',
  yahoo: 'Yahoo fundamentals-timeseries annual statements (no usable SEC history); valuation multiples from the Yahoo quoteSummary TTM snapshot',
} as const;

export function completeMetrics(parts: JsonRecord, performanceAsOf: string | null): JsonRecord {
  const out: JsonRecord = {};
  for (const key of METRIC_KEYS) out[key] = parts[key] === undefined ? null : parts[key];
  out.returnsBasis = RETURNS_BASIS;
  out.performanceAsOf = performanceAsOf;
  return out;
}

// ---------------------------------------------------------------------------
// one company

const toCik = (cik: number) => String(cik).padStart(10, '0');

function historyPeriods(range: string): { period1: number; period2: number } {
  const period2 = Math.floor(Date.now() / 1000) + DAY_MS / 1000;
  if (range === 'max') return { period1: 0, period2 };
  return { period1: Math.floor((Date.now() - Number(range.slice(0, -1)) * YEAR_MS) / 1000), period2 };
}

const isoWeek = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of the same ISO week decides the year
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return `${d.getUTCFullYear()}-${Math.floor((d.getTime() - firstThursday.getTime()) / (7 * DAY_MS)) + 1}`;
};

/** Published history: weekly rows (last trading day of the week, summed volume) up to one year before the last day, daily rows after that. Returns are computed from the full daily series before sampling. */
export function sampleHistory(days: ChartDay[]): { rows: ChartDay[]; dailyFrom: string | null } {
  const last = days[days.length - 1];
  if (!last) return { rows: [], dailyFrom: null };
  const cutoff = new Date(Date.parse(`${last.date}T00:00:00Z`) - 365 * DAY_MS).toISOString().slice(0, 10);
  const rows: ChartDay[] = [];
  let week = '';
  for (const day of days) {
    if (day.date > cutoff) { rows.push(day); continue; }
    const key = isoWeek(day.date);
    if (key === week) rows[rows.length - 1] = { ...day, volume: rows[rows.length - 1].volume + day.volume };
    else { rows.push({ ...day }); week = key; }
  }
  return { rows, dailyFrom: days.find((d) => d.date > cutoff)?.date ?? null };
}

async function writeHistory(dir: URL, ticker: string, fullDays: ChartDay[], pageSize: number): Promise<JsonRecord> {
  const { rows: days, dailyFrom } = sampleHistory(fullDays);
  const pages: string[] = [];
  const total = days.length;
  for (let i = 0; i * pageSize < total; i += 1) {
    const rows = days.slice(i * pageSize, (i + 1) * pageSize).map((d) => ({ Date: d.date, Close: String(round(d.close, 4)), 'Adj Close': String(round(d.adjClose, 4)), Volume: String(d.volume) }));
    const name = `${String(i + 1).padStart(3, '0')}.json`;
    await writeIfChanged(new URL(`history/${name}`, dir), { ticker, page: i + 1, pageSize, totalRows: total, headers: ['Date', 'Close', 'Adj Close', 'Volume'], rows });
    pages.push(`history/${name}`);
  }
  try { // stale pages go only after the new ones are in place
    for (const file of await readdir(new URL('history/', dir))) if (/^\d{3}\.json$/.test(file) && !pages.includes(`history/${file}`)) await rm(new URL(`history/${file}`, dir));
  } catch { /* no history dir yet */ }
  return { pages, pageSize, totalRows: total, asOf: days[days.length - 1]?.date ?? null, granularity: { weeklyBefore: dailyFrom, dailyFrom }, source: 'Yahoo Finance public chart API (adjusted close); weekly rows before the last year, daily after' };
}

export type Outcome = { row: JsonRecord } | { skipped: string };

export async function processCompany(listing: Listing, config: UpdaterConfig, previous: JsonRecord | null): Promise<Outcome> {
  const ticker = listing.ticker;
  const dir = companyDir(ticker);
  const prevMeta = await readJson(new URL('meta.json', dir));

  // 1. Yahoo snapshot: skips ETFs and funds early, before the large SEC download
  let snapshot: Snapshot | null = null;
  let chart: ParsedChart | null = null;
  if (!config.skipYahoo) {
    try { snapshot = await fetchSummary(ticker, config); } catch (error) { note(`[summary ] ${ticker}: ${error instanceof Error ? error.message : String(error)}`); }
    if (snapshot && snapshot.quoteType && snapshot.quoteType !== 'EQUITY') return { skipped: `not a stock (${snapshot.quoteType})` };
    const { period1, period2 } = historyPeriods(config.historyRange);
    const query = new URLSearchParams({ period1: String(period1), period2: String(period2), interval: '1d', events: 'div,split', includeAdjustedClose: 'true' });
    chart = parseChart(await fetchJson(`${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?${query}`, `[chart   ] ${ticker}`, config, { 'User-Agent': BROWSER_UA }));
    if (!chart.days.length) throw new Error(`[chart   ] ${ticker}: no price history`);
  }

  // 2. SEC fundamentals
  let rows: AnnualRow[] = [];
  let fundamentalsSource: 'sec' | 'sec+yahoo' | 'yahoo' = 'sec';
  let fundamentalsNote = '';
  let secFailed = false;
  try {
    const facts = await fetchJson(`${SEC_FACTS_URL}/CIK${toCik(listing.cik)}.json`, `[sec     ] ${ticker}`, config);
    rows = buildAnnualRows(facts);
  } catch (error) {
    if (!prevMeta) throw error; // nothing to fall back to
    secFailed = true;
    note(`[sec     ] ${ticker}: ${error instanceof Error ? error.message : String(error)} - keeping previous fundamentals`);
    rows = prevMeta.fundamentals?.annual ?? [];
  }
  if (!config.skipYahoo && !secFailed) {
    try {
      const merged = mergeAnnual(rows, await fetchYahooAnnual(ticker, config));
      rows = merged.rows;
      fundamentalsSource = merged.source;
    } catch (error) { note(`[fundamen] ${ticker}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!rows.length) fundamentalsNote = 'no annual fundamentals available';

  // 3. assemble the company completely in memory
  const prevMarket = prevMeta?.market ?? null;
  let market: JsonRecord;
  let history: JsonRecord;
  if (chart) {
    const last = chart.days[chart.days.length - 1];
    const price = chart.price ?? last.close;
    const div = dividendMetrics(chart.dividends, price, last.date);
    const valuation = snapshot ? valuationMetrics(snapshot) : (prevMarket?.valuation ?? {});
    market = {
      price, asOfDate: last.date, valuation, returns: priceReturns(chart.days), dividends: div.metrics, annualDps: div.annual,
      recentDividends: chart.dividends.slice(-12).reverse(), week52High: snapshot?.week52High ?? null, week52Low: snapshot?.week52Low ?? null,
    };
    history = await writeHistory(dir, ticker, chart.days, config.historyPageSize);
  } else {
    if (!prevMarket) throw new Error(`${ticker}: SKIP_YAHOO is set and no previous market data exists`);
    market = prevMarket;
    history = prevMeta?.history ?? {};
  }

  const fundamentals = fundamentalsMetrics(rows);
  const parts: JsonRecord = { ...fundamentals, ...(market.valuation ?? {}), ...(market.returns ?? {}), ...(market.dividends ?? {}), price: market.price, week52High: market.week52High, week52Low: market.week52Low };
  if (parts.marketCap === undefined || parts.marketCap === null) parts.marketCap = null;
  const metrics = completeMetrics(parts, market.asOfDate ?? null);

  const row: JsonRecord = {
    ticker, name: snapshot?.name || prevMeta?.name || listing.name, exchange: listing.exchange, sector: snapshot?.sector ?? prevMeta?.sector ?? null, industry: snapshot?.industry ?? prevMeta?.industry ?? null,
    cik: listing.cik, currency: snapshot?.currency || chart?.currency || prevMeta?.currency || null, financialCurrency: snapshot?.financialCurrency || prevMeta?.financialCurrency || null,
    dataFile: `./companies/${ticker}/meta.json`, price: market.price, asOfDate: market.asOfDate,
    fundamentalsAsOf: rows[0]?.end ?? null, fundamentalsBasis: rows.length ? FUNDAMENTALS_BASIS[fundamentalsSource] : fundamentalsNote, metrics,
  };

  // 4. post-fetch filters keep the previously published state of unselected companies
  const reasons: string[] = [];
  if (!inRange(metrics.marketCap, config.marketCap)) reasons.push('MARKET_CAP');
  if (!inRange(metrics.dividendYield, config.dividendYield)) reasons.push('DIVIDEND_YIELD');
  if (reasons.length) return { skipped: `filtered by ${reasons.join(', ')}` };

  const meta = { ...row, sources: { universe: SEC_TICKERS_URL, fundamentals: `${SEC_FACTS_URL}/CIK${toCik(listing.cik)}.json`, market: 'Yahoo Finance chart API', snapshot: 'Yahoo Finance quoteSummary' }, market, fundamentals: { asOf: rows[0]?.end ?? null, annual: rows }, history };
  await writeIfChanged(new URL('meta.json', dir), meta);
  void previous;
  return { row };
}

// ---------------------------------------------------------------------------
// run

async function readPreviousRows(): Promise<Map<string, JsonRecord>> {
  const out = new Map<string, JsonRecord>();
  for (const row of (await readJson(indexFile()))?.companies ?? []) out.set(String(row.ticker), row);
  // the index must list every company that has a meta.json, even when an earlier run shrank it
  try {
    for (const entry of await readdir(new URL('companies/', API_ROOT))) {
      if (out.has(entry)) continue;
      const meta = await readJson(new URL(`companies/${entry}/meta.json`, API_ROOT));
      if (meta) out.set(entry, rowFromMeta(meta));
    }
  } catch { /* first run */ }
  return out;
}

export function indexDocument(companies: JsonRecord[]): JsonRecord {
  return {
    generatedAt: stamp(),
    source: {
      provider: 'U.S. exchange-listed stocks (Nasdaq, NYSE, Cboe)', market: 'us', universe: SEC_TICKERS_URL, fundamentals: 'SEC EDGAR XBRL companyfacts (annual 10-K)',
      history: 'Yahoo Finance public chart API (adjusted close)', snapshot: 'Yahoo Finance quoteSummary (market cap, TTM and forward valuation)',
    },
    counts: { companies: companies.length },
    companies,
  };
}

export async function run(controls: Record<string, string | undefined>): Promise<{ updated: number; skipped: number; failed: number; rows: number }> {
  const config = readConfig(controls);
  secUa = config.secUa;
  requestSleepSeconds = config.requestSleep;
  requestGates = new Array(Math.max(1, config.concurrency)).fill(0);
  verboseOutput = config.verbose;
  yahooSession = null;

  const previous = await readPreviousRows();
  const table = parseSecTickers(await fetchJson(SEC_TICKERS_URL, '[universe] SEC ticker table', config));
  const wanted = config.tickers ? [...config.tickers] : [...table.keys()];
  const universe: Listing[] = [];
  let failed = 0;
  for (const ticker of wanted.sort()) {
    const listing = table.get(ticker);
    if (!listing) { if (config.tickers) { failed += 1; console.warn(`[universe] ${ticker}: not found in the SEC exchange table`); } continue; }
    if (!config.exchanges.has(listing.exchange.toUpperCase())) { if (config.tickers) console.warn(`[universe] ${ticker}: skipped, listed on ${listing.exchange}`); continue; }
    universe.push(listing);
  }
  console.log(`[universe] ${universe.length} stocks on ${[...config.exchanges].join(', ')}`);

  const state = (await readJson(stateFile())) ?? {};
  const cursor = config.maxFetches > 0 ? String(state.cursor ?? '') : '';
  const at = cursor ? universe.findIndex((l) => l.ticker === cursor) : -1;
  const queue = at >= 0 ? universe.slice(at + 1).concat(universe.slice(0, at + 1)) : universe.slice();
  const total = config.maxFetches > 0 ? Math.min(config.maxFetches, queue.length) : queue.length;
  const results: JsonRecord[] = [];
  const started = Date.now();
  let processed = 0;
  let skipped = 0;
  let lastTicker: string | null = cursor || null;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (config.maxFetches > 0 && processed >= config.maxFetches) return;
      if (Date.now() - started > SOFT_DEADLINE_MS) return;
      const listing = queue.shift();
      if (!listing) return;
      const n = ++processed;
      try {
        const out = await processCompany(listing, config, previous.get(listing.ticker) ?? null);
        lastTicker = listing.ticker;
        if ('skipped' in out) { skipped += 1; console.log(`[${String(n).padStart(3)}/${total}] ${listing.ticker.padEnd(6)} skipped: ${out.skipped}`); continue; }
        results.push(out.row);
        const m = out.row.metrics;
        console.log(`[${String(n).padStart(3)}/${total}] ${listing.ticker.padEnd(6)} updated  cap ${m.marketCap === null ? '-' : `$${round(m.marketCap / 1e9, 1)}B`}  P/E ${m.pe ?? '-'}  FY ${out.row.fundamentalsAsOf ?? '-'}`);
      } catch (error) {
        failed += 1;
        console.warn(`[${String(n).padStart(3)}/${total}] ${listing.ticker.padEnd(6)} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));

  // Filtered, bounded, skipped and failed companies keep their published row: the index never shrinks.
  const byTicker = new Map<string, JsonRecord>(previous);
  const added = results.filter((r) => !previous.has(String(r.ticker))).map((r) => String(r.ticker));
  for (const row of results) byTicker.set(String(row.ticker), row);
  const companies = [...byTicker.values()].sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));
  await writeIfChanged(indexFile(), indexDocument(companies));
  await writeIfChanged(stateFile(), { cursor: config.maxFetches > 0 ? lastTicker : null, savedAt: stamp() });
  console.log(`[done    ] ${results.length} updated, ${skipped} skipped, ${failed} failed; index lists ${companies.length} companies`);
  if (added.length) {
    console.log(`NEW STOCKS: ${added.join(', ')}`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `NEW STOCKS: ${added.join(', ')}\n`, 'utf8');
  }
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Stocks data update\n\n- updated: ${results.length}\n- skipped: ${skipped}\n- failed: ${failed}\n- companies: ${companies.length}\n`, 'utf8');
  return { updated: results.length, skipped, failed, rows: companies.length };
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  const file = JSON.parse(await readFile(fileURLToPath(CONFIG_FILE_URL), 'utf8'));
  return resolveControls(file, {}, {}, env);
}

if ((import.meta as { main?: boolean }).main) {
  await runtimeControls().then(run).catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
}
