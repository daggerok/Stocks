/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  annualSeries, buildAnnualRows, compactIndexText, completeMetrics, CONTROL_NAMES, dividendMetrics, fundamentalsMetrics, installSystemCa, isCertError, mergeAnnual,
  isOperatingTicker, minusMonths, normalizeTicker, parseChart, periodEve, parseRange, parseRanges, parseRetryAfter, parseSecTickers, parseSummary, parseYahooAnnual, priceReturns, readConfig, resolveControls,
  indexDocument, parseWatchlist, range52wPosition, pruneCompanies, resolveWatchlist, run, runtimeControls, sampleHistory, useApiRoot, useWatchlistDir, valuationMetrics, withMetricKeys, type ChartDay, type Snapshot,
  coverageMarkdown, metaText, scaleCheck, FEED_SCHEMA_VERSION, adrCoverage, adrFlag, annualRowsFromSec, FUNDAMENTALS_BASIS, SCALE_TOLERANCE_ANNUAL_PCT, staleForeignLayer,
} from './update-data.ts';
import { parseCompanyFacts } from './sec/companyfacts';

// ---------------------------------------------------------------------------
// tiny inline samples (no network, no fixtures)
// ---------------------------------------------------------------------------

const YEARS = [2021, 2022, 2023, 2024, 2025, 2026];
const fact = (end: string, val: number, extra: Record<string, unknown> = {}) => ({ start: `${Number(end.slice(0, 4)) - 1}-${end.slice(5)}`, end, val, form: '10-K', filed: `${end.slice(0, 4)}-12-31`, ...extra });
const inst = (end: string, val: number) => ({ end, val, form: '10-K', filed: `${end.slice(0, 4)}-12-31` });
const units = (list: unknown[], unit = 'USD') => ({ units: { [unit]: list } });
const flowSeries = (base: number, growth = 1.1) => YEARS.map((y, i) => fact(`${y}-12-31`, base * growth ** i));
const instantSeries = (value: number) => YEARS.map((y) => inst(`${y}-12-31`, value));

function syntheticFacts(): any {
  return {
    facts: {
      'us-gaap': {
        // an older tag and a newer one: the merge must take both eras
        SalesRevenueNet: units(flowSeries(100).slice(0, 2)),
        RevenueFromContractWithCustomerExcludingAssessedTax: units(flowSeries(100)),
        OperatingIncomeLoss: units(flowSeries(20)),
        DepreciationDepletionAndAmortization: units(flowSeries(5)),
        NetIncomeLoss: units(flowSeries(15)),
        NetCashProvidedByUsedInOperatingActivities: units(flowSeries(25)),
        PaymentsToAcquirePropertyPlantAndEquipment: units(flowSeries(5)),
        PaymentsOfDividends: units(flowSeries(6)),
        EarningsPerShareDiluted: units(flowSeries(2), 'USD/shares'),
        Assets: units(YEARS.map((y, i) => inst(`${y}-12-31`, 200 * 1.1 ** i))),
        AssetsCurrent: units(instantSeries(100)),
        LiabilitiesCurrent: units(instantSeries(50)),
        CashAndCashEquivalentsAtCarryingValue: units(instantSeries(30)),
        LongTermDebtNoncurrent: units(instantSeries(60)),
        StockholdersEquity: units(instantSeries(120)),
      },
    },
  };
}

/** The synthetic company as a foreign issuer: ifrs-full synonyms, EUR, the annual 20-F, values in millions */
const IFRS_NAMES: Record<string, string> = {
  RevenueFromContractWithCustomerExcludingAssessedTax: 'Revenue', OperatingIncomeLoss: 'ProfitLossFromOperatingActivities', DepreciationDepletionAndAmortization: 'DepreciationAndAmortisationExpense',
  NetIncomeLoss: 'ProfitLossAttributableToOwnersOfParent', NetCashProvidedByUsedInOperatingActivities: 'CashFlowsFromUsedInOperatingActivities',
  PaymentsToAcquirePropertyPlantAndEquipment: 'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities', PaymentsOfDividends: 'DividendsPaidClassifiedAsFinancingActivities',
  EarningsPerShareDiluted: 'DilutedEarningsLossPerShare', Assets: 'Assets', AssetsCurrent: 'CurrentAssets', LiabilitiesCurrent: 'CurrentLiabilities',
  CashAndCashEquivalentsAtCarryingValue: 'CashAndCashEquivalents', LongTermDebtNoncurrent: 'LongtermBorrowings', StockholdersEquity: 'EquityAttributableToOwnersOfParent',
};
function ifrsFacts(): any {
  const ifrs: Record<string, unknown> = {};
  const usGaap = syntheticFacts().facts['us-gaap'];
  Object.keys(IFRS_NAMES).forEach((tag) => {
    const [unit, rows] = Object.entries<any[]>(usGaap[tag].units)[0];
    const perShare = unit === 'USD/shares';
    ifrs[IFRS_NAMES[tag]] = { units: { [perShare ? 'EUR/shares' : 'EUR']: rows.map((r) => ({ ...r, form: '20-F', val: perShare ? r.val : r.val * 1e6 })) } };
  });
  return { facts: { 'ifrs-full': ifrs } };
}

/** Every USD value multiplied (a filing tagged in thousands by mistake) */
function scaled(facts: any, factor: number): any {
  if (factor === 1) return facts;
  for (const node of Object.values<any>(facts.facts['us-gaap'])) for (const row of node.units.USD ?? []) row.val *= factor;
  return facts;
}

/** Every field Yahoo fundamentals-timeseries could fill is present in every SEC year. */
function completeFacts(): any {
  const facts = syntheticFacts();
  Object.assign(facts.facts['us-gaap'], {
    GrossProfit: units(flowSeries(40)),
    AccountsReceivableNetCurrent: units(instantSeries(10)),
    IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: units(flowSeries(18)),
    IncomeTaxExpenseBenefit: units(flowSeries(3)),
  });
  return facts;
}

const SNAPSHOT: Snapshot = {
  quoteType: 'EQUITY', name: 'X', sector: 'Tech', industry: 'Software', currency: 'USD', financialCurrency: 'USD', marketCap: 1e12, enterpriseValue: 1e12, sharesOutstanding: 1, beta: 1,
  pe: 20, forwardPe: 18, ps: 5, forwardRevenue: 2e11, evEbitda: 10, pb: 3, freeCashflow: 1e11, ebitda: 2e11, week52High: 1, week52Low: 1,
};

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');
const file = () => JSON.parse(read('scripts/update-data.config.json'));

// ---------------------------------------------------------------------------

describe('controls', () => {
  test('precedence is file < advanced < nonblank inputs < env; blank input inherits, empty env wins', () => {
    const r = resolveControls({ CONCURRENCY: '2', TICKERS: 'AAPL' }, { CONCURRENCY: '3' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '5', VERBOSE: '' });
    expect(r.CONCURRENCY).toBe('5');
    expect(r.TICKERS).toBe('AAPL');
    expect(r.VERBOSE).toBe('');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ TICKERS: 'AAPL' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ TICKERS: 'AAPL' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
    expect(resolveControls({ MARKET_CAP: '1B:' }, {}, {}, { UNRELATED: 'x', PATH: '/bin' }).MARKET_CAP).toBe('1B:');
    // the scheduled path (no inputs, empty advanced, no env) equals the config defaults
    expect(resolveControls(file(), JSON.parse('{}'), {}, {})).toEqual(Object.fromEntries(Object.entries(file()).map(([k, v]) => [k, String(v)])));
  });

  test('validation is strict: ranges, integers, booleans, HISTORY_RANGE, scalars and CR/LF/NUL', () => {
    for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { SKIP_YAHOO: 'maybe' }, { MARKET_CAP: '1:2:3' }, { DIVIDEND_YIELD: '5:1' }, { PERFORMANCE_1Y: 'a:b' }, { TOTAL_RETURN_5Y: '9:1' }, { HISTORY_RANGE: 'forever' }, { USE_SYSTEM_CA: 'maybe' }, { TICKERS: ['AAPL'] }, { TICKERS: { a: 1 } }, null, []]) {
      expect(() => resolveControls(value)).toThrow();
    }
    expect(() => resolveControls({}, {}, { TICKERS: 'A\nB' })).toThrow('multiline');
    expect(() => resolveControls({}, {}, {}, { SEC_UA: 'x\0bad' })).toThrow();
    expect(() => resolveControls({}, 'not an object')).toThrow();
    expect(() => readConfig({ EXCHANGES: ' ' })).toThrow('EXCHANGES');
  });

  test('defaults, ranges with suffixes, ticker normalization and the standard SEC contact', () => {
    const config = readConfig(resolveControls(file()));
    expect(config.maxFetches).toBe(0);
    expect(config.historyRange).toBe('max');
    expect(config.skipYahoo).toBe(false);
    expect(config.tickers).toBeNull(); // blank = the whole universe
    expect(config.concurrency).toBe(24);
    expect(Array.from(readConfig({ TICKERS: 'aapl, brk.b;MSFT' }).tickers ?? []).sort()).toEqual(['AAPL', 'BRK-B', 'MSFT']);
    expect(config.marketCap).toEqual({});
    expect(config.performance).toEqual({});
    expect(config.secUa).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(readConfig(resolveControls(file(), { SEC_UA: 'My Feed me@example.org' })).secUa).toBe('My Feed me@example.org');
    expect(parseRange('10B:')).toEqual({ min: 1e10, max: undefined });
    expect(parseRange(':500M')).toEqual({ min: undefined, max: 5e8 });
    expect(parseRanges({ PERFORMANCE_1Y: '10:', PERFORMANCE_5Y: ':' }, 'PERFORMANCE')).toEqual({ '1Y': { min: 10, max: undefined } });
    expect(resolveControls(file(), { PERFORMANCE_20D: '10:' }).PERFORMANCE_20D).toBe('10:');
    expect(parseRanges({ PERFORMANCE_WTD: '2:', PERFORMANCE_20D: ':-5', TOTAL_RETURN_20D: '1:' }, 'PERFORMANCE')).toEqual({ WTD: { min: 2, max: undefined }, '20D': { min: undefined, max: -5 } });
    expect(normalizeTicker('brk.b')).toBe('BRK-B');
    expect(resolveControls(file()).USE_SYSTEM_CA).toBe('auto');
    expect(resolveControls(file(), {}, {}, { USE_SYSTEM_CA: 'TRUE' }).USE_SYSTEM_CA).toBe('true');
  });

  test('config keys, CONTROL_NAMES and --help stay in sync', async () => {
    expect(Object.keys(file()).sort()).toEqual([...CONTROL_NAMES].sort());
    for (const value of Object.values(file())) expect(typeof value).toBe('string');
    expect((await runtimeControls({ REQUEST_SLEEP: '0', TICKERS: 'AAPL MSFT' })).TICKERS).toBe('AAPL MSFT');
    const help = spawnSync('bun', [join(__dirname, 'update-data.ts'), '--help'], { encoding: 'utf8' }).stdout;
    for (const name of CONTROL_NAMES) {
      const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_/);
      expect(help).toMatch(tenor ? new RegExp(`${tenor[1]}_([0-9A-Z]+\\|)*${name.slice(tenor[0].length)}[|=]`) : new RegExp(name));
    }
  });
});

// ---------------------------------------------------------------------------

describe('parsing', () => {
  test('SEC ticker table: normalized dotted tickers, rows without an exchange are dropped', () => {
    const table = parseSecTickers({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[1067983, 'BERKSHIRE', 'BRK.B', 'NYSE'], [5, 'NOEX', 'ZZZ', null]] });
    expect(table.get('BRK-B')?.exchange).toBe('NYSE');
    expect(table.has('ZZZ')).toBe(false);
    expect(() => parseSecTickers({ fields: ['cik'], data: [] })).toThrow('unexpected shape');
    for (const ticker of ['BAC-PB', 'XYZ-WT', 'ABC-WS', 'ABC-R', 'SPAC-UN', 'SPAC-U']) expect(isOperatingTicker(ticker)).toBe(false);
    for (const ticker of ['AAPL', 'BRK-B', 'BF-B', 'LEN-A']) expect(isOperatingTicker(ticker)).toBe(true);
  });

  test('watchlist: txt tokens, csv first cells, exchange prefixes and dots normalized, header and blanks ignored', () => {
    expect(parseWatchlist('NVDA\nBRK.B\n\nNYSE:TTE TTE, aapl\n')).toEqual(['NVDA', 'BRK-B', 'TTE', 'AAPL']);
    expect(parseWatchlist('Symbol,Name\r\n"BRK.B",Berkshire\r\nNYSE:OR,Osisko\r\n', true)).toEqual(['BRK-B', 'OR']);
    expect(parseWatchlist(' \n\n')).toEqual([]);
    expect(parseWatchlist('BRK/A brk.b BRK-B')).toEqual(['BRK-A', 'BRK-B']);
    const known = ['BRK-A', 'BRK-B', 'AMP', 'AB', 'A-B', 'X-YZ', 'XY-Z'];
    expect(Array.from(resolveWatchlist(['BRKA', 'BRK-B', 'AMP', 'AB', 'XYZ', 'VOO'], known, {}))).toEqual(['BRK-A', 'BRK-B', 'AMP', 'AB', 'XYZ', 'VOO']); // exact wins, ambiguous and unknown stay
    expect(Array.from(resolveWatchlist(['XYZ', 'AB', 'FB'], known, { 'XY-Z': ['XYZ'], 'A-B': ['AB'], META: ['FB'] }))).toEqual(['XY-Z', 'A-B', 'META']); // the alias table wins over everything
    expect(resolveWatchlist(['BRKB'], [])).toEqual(new Set(['BRK-B'])); // TICKER_ALIASES is the default
  });

  test('XBRL: annual 10-K facts only, tags merged across eras, D&A fallback, derived EBITDA and FCF', () => {
    const facts = syntheticFacts();
    facts.facts['us-gaap'].SalesRevenueNet.units.USD.push({ start: '2026-01-01', end: '2026-03-31', val: 1, form: '10-Q', filed: '2026-04-30' });
    const merged = annualSeries(facts, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'], 'flow');
    expect(Array.from(merged.keys())).toHaveLength(6);
    expect(merged.has('2026-03-31')).toBe(false);
    const rows = buildAnnualRows(facts);
    expect(rows[0].end).toBe('2026-12-31');
    expect(rows[0].ebitda).toBeCloseTo(25 * 1.1 ** 5, 6);
    expect(rows[0].fcf).toBeCloseTo(20 * 1.1 ** 5, 6);
    delete facts.facts['us-gaap'].DepreciationDepletionAndAmortization;
    expect(buildAnnualRows(facts)[0].ebitda).toBeNull();
    facts.facts['us-gaap'].Depreciation = units(flowSeries(3, 1));
    facts.facts['us-gaap'].AmortizationOfIntangibleAssets = units(flowSeries(2, 1));
    expect(buildAnnualRows(facts)[0].ebitda).toBeCloseTo(20 * 1.1 ** 5 + 5, 6);
    expect(buildAnnualRows({ facts: { ifrs: {} } })).toEqual([]);
  });

  test('Yahoo payloads: chart days and dividends, quoteSummary snapshot, annual statements', () => {
    const chart = parseChart({ chart: { result: [{ meta: { regularMarketPrice: 70, currency: 'USD', fullExchangeName: 'NasdaqGS' }, timestamp: [1577923200, 1578009600], indicators: { quote: [{ close: [10, null], volume: [5, 6] }], adjclose: [{ adjclose: [9, null] }] }, events: { dividends: { 1577923200: { amount: 0.5 } } } }] } });
    expect(chart.days).toEqual([{ date: '2020-01-02', close: 10, adjClose: 9, volume: 5 }]);
    expect(chart.dividends).toEqual([{ date: '2020-01-02', amount: 0.5 }]);
    const snap = parseSummary({ quoteSummary: { result: [{ price: { quoteType: 'EQUITY', longName: 'Mock', currency: 'USD', marketCap: { raw: 2e9 } }, summaryDetail: { trailingPE: { raw: 15 } }, defaultKeyStatistics: { forwardPE: { raw: 12 } }, financialData: { financialCurrency: 'USD', freeCashflow: { raw: 1e8 } }, earningsTrend: { trend: [{ period: '+1y', revenueEstimate: { avg: { raw: 1e9 } } }] }, assetProfile: { sector: 'Tech' } }] } });
    expect(snap).toMatchObject({ quoteType: 'EQUITY', marketCap: 2e9, pe: 15, forwardPe: 12, forwardRevenue: 1e9, sector: 'Tech', ebitda: null });
    const annual = parseYahooAnnual({ timeseries: { result: [{ meta: { type: ['annualCapitalExpenditure'] }, annualCapitalExpenditure: [{ asOfDate: '2025-09-30', reportedValue: { raw: -12 } }] }] } });
    expect(annual.get('2025-09-30')).toEqual({ capex: 12 });
    expect(() => parseChart({})).toThrow('no result');
  });

  test('SEC layer inputs: split events, Yahoo TTM revenue for the scale check, meta.json with one-line value arrays', () => {
    const chart = parseChart({ chart: { result: [{ meta: {}, timestamp: [1598880600], indicators: { quote: [{ close: [129] }] }, events: { splits: { 1598880600: { numerator: 4, denominator: 1 }, 1: { numerator: 0, denominator: 1 } } } }] } });
    expect(chart.splits).toEqual([{ date: '2020-08-31', ratio: 4 }]);
    expect(parseSummary({ quoteSummary: { result: [{ financialData: { totalRevenue: { raw: 4.2e11 } } }] } }).totalRevenue).toBe(4.2e11);
    const trend = { earningsTrend: { trend: [{ period: '+1y', growth: { raw: 0.1 }, earningsEstimate: { avg: { raw: 10.5 } }, epsTrend: { current: { raw: 10.5 }, '30daysAgo': { raw: 10 } } }] } };
    expect(parseSummary({ quoteSummary: { result: [trend] } }).estimates).toMatchObject({ epsNextYear: 10.5, growthNextYear: 10, growth5y: null, trendNextYear: { current: 10.5, d30: 10 } });
    expect(scaleCheck(416e9, 400e9)).toEqual({ ok: true, diffPct: 4 });
    expect(scaleCheck(416e12, 400e9)?.ok).toBe(false); // a ×1000 tagging error
    expect([scaleCheck(null, 1), scaleCheck(-1, 1), scaleCheck(1, 0)]).toEqual([null, null, null]);
    const text = metaText({ a: 1, list: [1, null, 'x'], rows: [{ b: [] }], skip: undefined, empty: {} });
    expect(text).toBe('{\n  "a": 1,\n  "list": [1,null,"x"],\n  "rows": [\n    {\n      "b": []\n    }\n  ],\n  "empty": {}\n}\n');
    expect(JSON.parse(text)).toEqual({ a: 1, list: [1, null, 'x'], rows: [{ b: [] }], empty: {} });
    const coverage = coverageMarkdown([{ sector: 'Tech', metrics: { pe: 10, athBasis: 'daily closes' } }, { sector: 'Tech', metrics: { pe: null } }, { sector: null, metrics: { pe: 5 } }]);
    expect(coverage).toContain('| metric | all (3) | Tech (2) | Unknown (1) |');
    expect(coverage).toContain('| pe | 67 | 50 | 100 |');
    expect(coverage).not.toContain('| athBasis |'); // text metrics have no coverage row
  });

  test('Yahoo only fills gaps and adds missing years, it never overrides SEC', () => {
    const sec = buildAnnualRows(syntheticFacts()).map((r) => ({ ...r, ebitda: null }));
    const merged = mergeAnnual(sec, new Map([['2026-12-28', { ebitda: 999, revenue: 1 }], ['2027-12-31', { revenue: 7 }]]));
    expect(merged.source).toBe('sec+yahoo');
    expect(merged.rows[1].ebitda).toBe(999);
    expect(merged.rows[1].revenue).toBeCloseTo(100 * 1.1 ** 5, 6);
    expect(merged.rows[0]).toMatchObject({ end: '2027-12-31', revenue: 7 });
    expect(mergeAnnual([], new Map()).source).toBe('sec');
    expect(mergeAnnual([], new Map([['2025-12-31', { revenue: 1 }]])).source).toBe('yahoo');
  });
});

describe('parsing 2', () => {
  test('foreign issuer (plan 1.3): annual rows from the 20-F layer in its currency, Yahoo points of another currency dropped', () => {
    const sec = parseCompanyFacts(ifrsFacts());
    if (!sec) throw new Error('no SEC layer');
    expect([sec.currency, sec.taxonomy, sec.annualForm, sec.ttmIsAnnual]).toEqual(['EUR', 'ifrs-full', '20-F', true]);
    expect(buildAnnualRows(ifrsFacts())).toEqual([]); // the 10-K reader sees nothing
    const rows = annualRowsFromSec(sec);
    expect(rows.map((r) => r.end)).toEqual(['2026-12-31', '2025-12-31', '2024-12-31', '2023-12-31', '2022-12-31', '2021-12-31']);
    expect(rows[0]).toMatchObject({ revenue: 161051000, netIncome: 24157650, ebitda: 32210200 + 8052550, operatingCashFlow: 40262750, capex: 8052550, fcf: 40262750 - 8052550, cash: 30000000, debt: 60000000 });
    expect(fundamentalsMetrics(rows).revenueGrowth).toBe(10); // growth in EUR
    const yahoo = { timeseries: { result: [{ meta: { type: ['annualTotalRevenue'] }, annualTotalRevenue: [
      { asOfDate: '2025-12-31', currencyCode: 'EUR', reportedValue: { raw: 5 } }, { asOfDate: '2024-12-31', currencyCode: 'USD', reportedValue: { raw: 6 } }, { asOfDate: '2023-12-31', reportedValue: { raw: 7 } },
    ] }] } };
    expect(Array.from(parseYahooAnnual(yahoo, 'EUR').keys())).toEqual(['2025-12-31', '2023-12-31']);
    expect(parseYahooAnnual(yahoo).size).toBe(3);
  });

  test('ADR flag, a stale foreign layer, the wider scale tolerance of an annual TTM and the ADR coverage count', () => {
    expect([adrFlag('Taiwan', '20-F'), adrFlag('Canada', '40-F'), adrFlag('United States', '20-F'), adrFlag('Germany', '10-K'), adrFlag(null, '20-F')]).toEqual([true, false, false, false, null]);
    const sec = parseCompanyFacts(ifrsFacts());
    if (!sec) throw new Error('no SEC layer');
    expect([staleForeignLayer(sec, '2028-03-31'), staleForeignLayer(sec, '2028-04-01')]).toEqual([false, true]); // 15 months = 456 days after 2026-12-31
    expect(scaleCheck(130, 100)).toEqual({ ok: false, diffPct: 30 });
    expect(scaleCheck(130, 100, SCALE_TOLERANCE_ANNUAL_PCT)).toEqual({ ok: true, diffPct: 30 });
    expect(scaleCheck(130000, 100, SCALE_TOLERANCE_ANNUAL_PCT)?.ok).toBe(false); // a ×1000 error still fails
    const row = (isAdr: boolean | null, basis: string) => ({ metrics: { isAdr }, fundamentalsBasis: basis });
    expect(adrCoverage([row(true, FUNDAMENTALS_BASIS['sec-ifrs']), row(true, FUNDAMENTALS_BASIS['sec-foreign+yahoo']), row(true, FUNDAMENTALS_BASIS.yahoo), row(true, 'no annual fundamentals available'), row(false, FUNDAMENTALS_BASIS.yahoo), row(null, FUNDAMENTALS_BASIS.sec)]))
      .toEqual({ adr: 4, secIfrs: 1, secUsGaap: 1, yahoo: 1, none: 1 });
  });
});

// ---------------------------------------------------------------------------

describe('metrics', () => {
  test('growth, margins, ratios, ROIC and payout from annual rows; null for what is not there', () => {
    const m = fundamentalsMetrics(buildAnnualRows(syntheticFacts()));
    expect(m).toMatchObject({ revenueGrowth: 10, revenueGrowth3y: 10, revenueGrowth5y: 10, netMargin: 15, netMarginDelta: 0, currentRatio: 2, quickRatio: 0.6, debtToEquity: 0.5, payoutRatio: 40 });
    expect(m.netDebtToEbitda).toBeCloseTo(30 / (25 * 1.1 ** 5), 2);
    expect(m.roic).not.toBeNull();
    const bank = fundamentalsMetrics(mergeAnnual([], new Map([['2025-12-31', { revenue: 100, netIncome: 30 }]])).rows);
    expect(bank.ebitdaMargin).toBeNull();
    expect(bank.fcfPayout).toBeNull();
    expect(bank.netMargin).toBe(30);
    expect(bank.revenueGrowth).toBeNull();
    const gap = buildAnnualRows(syntheticFacts());
    gap.splice(1, 1); // the previous row is not the prior fiscal year
    expect(fundamentalsMetrics(gap).revenueGrowth).toBeNull();
  });

  test('returns: performance from closes, total return from adjusted closes, horizons the history cannot reach are null', () => {
    const days: ChartDay[] = [];
    for (let i = 0; i <= 900; i += 1) days.push({ date: new Date(Date.UTC(2023, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), close: 100 + i * 0.1, adjClose: 90 + i * 0.12, volume: 1 });
    const r = priceReturns(days);
    expect(r.perf1y).not.toBeNull();
    expect(r.tr1y).toBeGreaterThan(r.perf1y as number);
    expect(r.perf5y).toBeNull();
    expect(r.tr10y).toBeNull();
    expect(r.cagr3y).toBeNull();
    expect(priceReturns([]).tr1y).toBeNull();
  });

  test('short horizons: D counts daily candles, 1W and 2W are 5 and 10 candles, 1M and 1Q are the closest candle 1 and 3 months back, WTD, MTD and QTD start before the current calendar period, 4M to 52W are calendar windows', () => {
    // weekdays only, 2026-07-03 is a holiday, the last candle is Thursday 2026-08-27; close = position + 1, so a return points back to its anchor candle
    const all: ChartDay[] = [];
    for (let t = Date.UTC(2025, 5, 2); t <= Date.UTC(2026, 7, 27); t += 86_400_000) {
      const date = new Date(t).toISOString().slice(0, 10);
      if ([0, 6].includes(new Date(t).getUTCDay()) || date === '2026-07-03') continue;
      all.push({ date, close: all.length + 1, adjClose: all.length + 1, volume: 1 });
    }
    const anchors = (days: ChartDay[]) => {
      const r = priceReturns(days);
      const last = days[days.length - 1].close;
      const keys = ['perf1d', 'perf3d', 'perf1w', 'perfWtd', 'perf2w', 'perf20d', 'perf1m', 'perfMtd', 'perf40d', 'perf60d', 'perf1q', 'perfQtd', 'perf4m', 'perf6m', 'perf52w'];
      return Object.fromEntries(keys.map((k) => [k, r[k] === null ? null : days.find((d) => d.close === Math.round(last / (1 + r[k] / 100)))?.date]));
    };
    expect(anchors(all)).toEqual({
      perf1d: '2026-08-26', perf3d: '2026-08-24', perf1w: '2026-08-20', perfWtd: '2026-08-21', perf2w: '2026-08-13', perf20d: '2026-07-30', perf1m: '2026-07-27', perfMtd: '2026-07-31',
      perf40d: '2026-07-01', perf60d: '2026-06-03', perf1q: '2026-05-27', perfQtd: '2026-06-30', perf4m: '2026-04-27', perf6m: '2026-02-27', perf52w: '2025-08-28',
    });
    // the holiday is skipped by D windows and falls back to the day before for calendar anchors
    const july = all.slice(0, all.findIndex((d) => d.date === '2026-07-10') + 1);
    expect(anchors(july)).toMatchObject({ perf3d: '2026-07-07', perf1w: '2026-07-02', perfWtd: '2026-07-02', perf2w: '2026-06-25', perf20d: '2026-06-11' });
    // 1M and 1Q on a weekend: a Saturday target takes Friday, a Sunday one Monday
    const upTo = (date: string) => all.slice(0, all.findIndex((d) => d.date === date) + 1);
    expect([anchors(upTo('2026-06-16')).perf1m, anchors(upTo('2026-06-17')).perf1m]).toEqual(['2026-05-15', '2026-05-18']);
    expect([anchors(upTo('2026-05-28')).perf1q, anchors(upTo('2026-08-17')).perf1q]).toEqual(['2026-02-27', '2026-05-18']);
    // a 10-day listing: what it cannot reach is null, never 0
    expect(anchors(all.slice(-10))).toMatchObject({ perf1d: '2026-08-26', perf1w: '2026-08-20', perfWtd: '2026-08-21', perf20d: null, perf1m: null, perfMtd: null, perf1q: null, perfQtd: null, perf52w: null });
    expect(Object.values(priceReturns([])).every((v) => v === null)).toBe(true);
    expect([minusMonths('2026-10-31', 1), minusMonths('2026-05-31', 3), minusMonths('2028-03-31', 1), minusMonths('2026-01-15', 2)]).toEqual(['2026-09-30', '2026-02-28', '2028-02-29', '2025-11-15']);
    expect([periodEve('2026-10-12', 'week'), periodEve('2026-10-18', 'week'), periodEve('2026-01-20', 'month'), periodEve('2026-10-15', 'quarter'), periodEve('2026-03-05', 'quarter')])
      .toEqual(['2026-10-11', '2026-10-11', '2025-12-31', '2026-09-30', '2025-12-31']);
  });

  test('dividends: yield, growth, the honest zero of a non-payer; multiples drop when currencies differ', () => {
    const d = [2021, 2022, 2023, 2024].flatMap((y) => [1, 4, 7, 10].map((m) => ({ date: `${y}-${String(m).padStart(2, '0')}-15`, amount: 0.25 * (1 + (y - 2021) * 0.1) })));
    const r = dividendMetrics(d, 100, '2025-03-01');
    expect(r.metrics.dividendGrowth).toBeCloseTo(8.33, 1);
    expect(r.metrics.dividendGrowth3y).toBeCloseTo(9.14, 1);
    expect(r.metrics.dividendGrowth5y).toBeNull();
    expect(dividendMetrics([], 100, '2025-03-01').metrics.dividendYield).toBe(0);
    const adr = valuationMetrics({ ...SNAPSHOT, financialCurrency: 'TWD' });
    expect(adr.pe).toBeNull();
    expect(adr.pFcf).toBeNull();
    expect(adr.marketCap).toBe(1e12);
    expect(adr.fcfToEbitda).toBe(50);
    const us = valuationMetrics(SNAPSHOT);
    expect(us.pFcf).toBe(10);
    expect(us.forwardPs).toBe(5);
  });

  test('every row has the same key set; returnsBasis and performanceAsOf travel together', () => {
    const a = completeMetrics({ marketCap: 1, pe: 2 }, '2026-10-02');
    const b = completeMetrics({}, null);
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(b.marketCap).toBeNull();
    expect(Object.keys(b)).toEqual(expect.arrayContaining(['perf1d', 'perf1w', 'perfWtd', 'perf1m', 'perfMtd', 'perf40d', 'perf1q', 'perfQtd', 'perf52w']));
    expect(a.returnsBasis.length).toBeGreaterThan(10);
    expect(b.returnsBasis).toBe(a.returnsBasis);
    expect([a.performanceAsOf, b.performanceAsOf]).toEqual(['2026-10-02', null]);
    // 52-week range position: 0 at the low, 100 at the high, clamped, null without a usable range
    expect(Object.keys(b)).toContain('range52w');
    expect([range52wPosition(150, 100, 200), range52wPosition(100, 100, 200), range52wPosition(201, 100, 200), range52wPosition(99, 100, 200)]).toEqual([50, 0, 100, 0]);
    expect([range52wPosition(150, null, 200), range52wPosition(150, 200, 200), range52wPosition(null, 100, 200)]).toEqual([null, null, null]);
    // a kept row published before the swing metrics existed gets them as null, in the same key order as a fresh row
    const old: Record<string, unknown> = { ...a };
    delete old.athPrice;
    delete old.volatility1y;
    const kept = withMetricKeys({ ticker: 'OLD', metrics: old });
    expect(Object.keys(kept.metrics)).toEqual(Object.keys(a));
    expect([kept.metrics.athPrice, kept.metrics.volatility1y, kept.metrics.pe]).toEqual([null, null, 2]);
  });

  test('published history: monthly rows with daily rows for the last 31 days, volume summed, nothing lost', () => {
    const long: ChartDay[] = [];
    for (let i = 0; i <= 9 * 365; i += 1) long.push({ date: new Date(Date.UTC(2017, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), close: i, adjClose: i, volume: 1 });
    const { rows, dailyFrom } = sampleHistory(long);
    const monthly = rows.filter((r) => r.date < (dailyFrom as string));
    expect(new Set(monthly.map((r) => r.date.slice(0, 7))).size).toBe(monthly.length);
    expect(monthly.length).toBeGreaterThan(100);
    expect(monthly.length).toBeLessThan(112);
    expect(rows.length - monthly.length).toBeLessThanOrEqual(31);
    expect(rows.reduce((s, r) => s + r.volume, 0)).toBe(long.length);
    expect(monthly[1].close).toBe(long.filter((r) => r.date.startsWith(monthly[1].date.slice(0, 7))).pop()?.close as number);
    expect(rows[rows.length - 1].date).toBe(long[long.length - 1].date);
    expect(sampleHistory([])).toEqual({ rows: [], dailyFrom: null });
  });
});

// ---------------------------------------------------------------------------

describe('pipeline', () => {
  const realFetch = globalThis.fetch;
  let dir: string;
  let restore: URL;
  let restoreWatchlist: URL;
  let failChartFor = '';
  let failSummaryFor = '';
  let failSecFor = '';
  let chartLength = 400;
  let chartSkip = 0; // candles missing at the start: a truncated Yahoo answer
  let yahooRevenue = 0; // financialData.totalRevenue of the snapshot (0: not reported)
  let secScale = 1; // a tagging error that multiplies every SEC value
  let foreignBbb = false; // BBB as a German 20-F filer in EUR (plan 1.3)

  const chartPayload = () => {
    const start = Date.parse('2020-01-02T00:00:00Z') / 1000;
    const timestamp = Array.from({ length: chartLength - chartSkip }, (_, i) => start + (i + chartSkip) * 86_400 * 3);
    const close = timestamp.map((_, i) => 50 + i * 0.05);
    return { chart: { result: [{ meta: { regularMarketPrice: 70, currency: 'USD', fullExchangeName: 'NasdaqGS' }, timestamp, indicators: { quote: [{ close, volume: close.map(() => 10) }], adjclose: [{ adjclose: close }] }, events: { dividends: { [String(timestamp[300 - chartSkip])]: { amount: 0.5 } } } }] } };
  };
  const summary = (type: string) => ({ quoteSummary: { result: [{ price: { quoteType: type, longName: 'Mock Corp', currency: 'USD', marketCap: { raw: 2e9 } }, summaryDetail: { trailingPE: { raw: 15 } }, defaultKeyStatistics: { forwardPE: { raw: 12 } }, financialData: { financialCurrency: 'USD', freeCashflow: { raw: 1e8 }, ebitda: { raw: 4e8 } }, earningsTrend: { trend: [{ period: '+1y', revenueEstimate: { avg: { raw: 1e9 } } }] }, assetProfile: { sector: 'Tech', industry: 'Software' } }] } });

  const mockFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    await new Promise((r) => setTimeout(r, 2)); // every response takes longer than the 1 ms deadline of the rotation test
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('company_tickers_exchange')) return json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[1, 'AAA INC', 'AAA', 'Nasdaq'], [2, 'BBB INC', 'BBB', 'NYSE'], [3, 'CCC FUND', 'CCC', 'NYSE'], [4, 'DDD OTC', 'DDD', 'OTC'], [5, 'EEE WARRANT', 'EEE', 'Nasdaq'], [6, 'FFF TRUST', 'FFF', 'NYSE'], [7, 'GGG PREFERRED', 'GGG-PA', 'NYSE']] });
    if (url.startsWith('https://fc.yahoo.com')) return new Response('', { status: 404, headers: { 'set-cookie': 'A3=abc; Path=/' } });
    if (url.includes('getcrumb')) return new Response('crumb123', { status: 200 });
    if (url.includes('quoteSummary')) {
      if (failSummaryFor && url.includes(`/${failSummaryFor}?`)) return new Response('boom', { status: 500 });
      const body = summary(url.includes('/CCC') ? 'ETF' : 'EQUITY');
      if (url.includes('/EEE')) delete (body.quoteSummary.result[0].price as any).marketCap; // a warrant has no market cap
      if (yahooRevenue) (body.quoteSummary.result[0].financialData as any).totalRevenue = { raw: yahooRevenue };
      if (foreignBbb && url.includes('/BBB?')) {
        (body.quoteSummary.result[0].financialData as any).financialCurrency = 'EUR';
        (body.quoteSummary.result[0].assetProfile as any).country = 'Germany';
      }
      return json(body);
    }
    if (url.includes('/v8/finance/chart/EURUSD%3DX')) { // EURUSD 1.1 every day from 2019 on
      const from = Date.parse('2019-01-01T00:00:00Z') / 1000;
      const timestamp = Array.from({ length: 3300 }, (_, i) => from + i * 86_400);
      return json({ chart: { result: [{ meta: { currency: 'USD' }, timestamp, indicators: { quote: [{ close: timestamp.map(() => 1.1) }] } }] } });
    }
    if (url.includes('/v8/finance/chart/')) return failChartFor && url.includes(`/${failChartFor}?`) ? new Response('boom', { status: 500 }) : json(chartPayload());
    if (url.includes('fundamentals-timeseries')) return json({ timeseries: { result: [] } });
    if (url.includes('companyfacts') && failSecFor && url.includes(failSecFor)) return new Response('boom', { status: 500 });
    if (url.includes('companyfacts') && foreignBbb && url.includes('CIK0000000002')) return json(ifrsFacts());
    if (url.includes('companyfacts')) return url.includes('CIK0000000006') ? new Response('nope', { status: 404 }) : json(scaled(syntheticFacts(), secScale)); // FFF has no XBRL facts
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stocks-'));
    restore = useApiRoot(new URL(`${pathToFileURL(dir).href}/`));
    restoreWatchlist = useWatchlistDir(new URL(`${pathToFileURL(dir).href}/`)); // never the repo's scripts/All.txt
    globalThis.fetch = mockFetch;
    failChartFor = '';
    failSummaryFor = '';
    failSecFor = '';
    chartLength = 400;
    chartSkip = 0;
    yahooRevenue = 0;
    secScale = 1;
    foreignBbb = false;
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    useApiRoot(restore);
    useWatchlistDir(restoreWatchlist);
    await rm(dir, { recursive: true, force: true });
  });

  const controls = (extra: Record<string, string> = {}) => ({ REQUEST_SLEEP: '0', MAX_RETRIES: '1', TICKERS: '', ...extra });
  const readIndex = async () => JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
  const readText = (path: string) => readFile(join(dir, path), 'utf8');

  test('publishes the contract; funds, warrants, preferreds, fund-like filers and other exchanges are left out', async () => {
    expect(await run(controls())).toMatchObject({ updated: 2, skipped: 3, failed: 0 });
    const index = await readIndex();
    expect(index.companies.map((c: any) => c.ticker)).toEqual(['AAA', 'BBB']);
    const metrics = index.companies[0].metrics;
    for (const key of ['marketCap', 'pe', 'forwardPe', 'ps', 'forwardPs', 'pFcf', 'evEbitda', 'fcfToEbitda', 'dividendYield', 'roic', 'revenueGrowth', 'tr1y', 'perf1y']) expect(metrics).toHaveProperty(key);
    expect(metrics.forwardPs).toBe(2);
    // swing metrics from the full daily series: closes 50 + 0.05 i (i = 0..399), price 70; the last 60 closes are 67..69.95
    expect([metrics.athPrice, metrics.athDate, metrics.athBasis, metrics.pctFromAth]).toEqual([69.95, '2023-04-13', 'daily closes since 2020-01-02', 0.07]);
    expect([metrics.high60d, metrics.low60d, metrics.sigmaFromMean60d]).toEqual([69.95, 67, 1.75]);
    expect(metrics.volatility1y).toBeGreaterThan(0);
    expect(metrics.performanceAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([...(await readdir(join(dir, 'companies', 'AAA', 'history')))].sort()).toEqual(['001.json']);
    expect((await readdir(join(dir, 'companies'))).sort()).toEqual(['AAA', 'BBB']); // skipped stocks (EEE no market cap, FFF no SEC facts) leave no history behind
  });

  test('a filtered one-ticker run and a market cap filter never shrink the index', async () => {
    await run(controls());
    expect((await run(controls({ TICKERS: 'AAA' }))).rows).toBe(2);
    const history = await readText('companies/AAA/history/001.json');
    chartLength = 401; // a new candle: a filtered-out stock keeps its history with its meta
    const filtered = await run(controls({ MARKET_CAP: '10B:' }));
    expect(filtered.updated).toBe(0);
    expect((await readIndex()).companies).toHaveLength(2);
    expect(await readText('companies/AAA/history/001.json')).toBe(history);
  });

  test('a delisted stock (not in the SEC table, no price for 60 days) leaves the index on a full run only; --prune removes its folder', async () => {
    const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
    await run(controls());
    const index = await readIndex();
    // ZZB: gone from the SEC table yesterday (a transient gap); ZZC: delisted, still in the index; ZZD: delisted, already out of the index
    index.companies.push({ ticker: 'ZZB', asOfDate: day(1) }, { ticker: 'ZZC', asOfDate: day(90) });
    await writeFile(join(dir, 'index.json'), JSON.stringify(index));
    for (const ticker of ['ZZC', 'ZZD']) {
      await mkdir(join(dir, 'companies', ticker), { recursive: true });
      await writeFile(join(dir, 'companies', ticker, 'meta.json'), JSON.stringify({ ticker, asOfDate: day(90) }));
    }
    const tickers = async () => (await readIndex()).companies.map((c: any) => c.ticker);
    await run(controls({ TICKERS: 'AAA' })); // a TICKERS run never shrinks the index and never brings ZZD back
    expect(await tickers()).toEqual(['AAA', 'BBB', 'ZZB', 'ZZC']);
    expect(await run(controls())).toMatchObject({ rows: 3 });
    expect(await tickers()).toEqual(['AAA', 'BBB', 'ZZB']);
    expect(await pruneCompanies()).toEqual(['ZZC', 'ZZD']);
    const left = (await readdir(join(dir, 'companies'))).sort();
    expect(left.filter((t) => t.startsWith('ZZ'))).toEqual([]);
    expect(left).toContain('AAA');
    expect(await pruneCompanies()).toEqual([]); // listed stocks and folders without meta.json are never removed
  });

  test('a second identical run writes nothing (zero diff, stamps move only with content)', async () => {
    await run(controls());
    const stamped = { ...(await readIndex()), generatedAt: '2000-01-01T00:00:00Z' };
    await writeFile(join(dir, 'index.json'), `${JSON.stringify(stamped, null, 2)}\n`);
    const meta = await readText('companies/AAA/meta.json');
    await run(controls());
    expect((await readIndex()).generatedAt).toBe('2000-01-01T00:00:00Z');
    expect(await readText('companies/AAA/meta.json')).toBe(meta);
  });

  test('--signals: compares with the index before the run, a rerun writes the same file, a stock with a failed source is quiet', async () => {
    const now = new Date(Date.UTC(2026, 10, 12));
    expect(await run(controls())).toMatchObject({ signals: null });
    await expect(readText('signals.json')).rejects.toThrow(); // only with --signals
    // the published AAA had debt to equity 3 (flag high-debt); the fresh SEC facts give 0.5 with the same fiscal year ends
    const index = await readIndex();
    index.companies[0].metrics.debtToEquity = 3;
    await writeFile(join(dir, 'index.json'), compactIndexText(index));
    expect(await run(controls(), { signals: true, now })).toMatchObject({ signals: 1 });
    const doc = JSON.parse(await readText('signals.json'));
    expect(doc.signals).toEqual([{ date: '2026-11-12', ticker: 'AAA', type: 'flag-removed', key: 'high-debt', from: null, to: null, restated: true }]);
    const text = await readText('signals.json');
    expect(await run(controls(), { signals: true, now })).toMatchObject({ signals: 0 });
    expect(await readText('signals.json')).toBe(text);
    const again = await readIndex();
    again.companies[0].metrics.debtToEquity = 3;
    await writeFile(join(dir, 'index.json'), compactIndexText(again));
    failSummaryFor = 'AAA';
    expect(await run(controls(), { signals: true, now })).toMatchObject({ updated: 2, signals: 0 });
  });

  test('rotation: a bounded run resumes after its cursor, a deadline run saves it, TICKERS runs never move it', async () => {
    const cursor = async () => JSON.parse(await readText('update-state.json')).cursor;
    await run(controls({ MAX_FETCHES: '1' }));
    expect((await readIndex()).companies.map((c: any) => c.ticker)).toEqual(['AAA']);
    expect(await cursor()).toBe('AAA');
    await run(controls({ TICKERS: 'AAA' }));
    expect(await cursor()).toBe('AAA');
    await run(controls({ MAX_FETCHES: '1' }));
    expect((await readIndex()).companies.map((c: any) => c.ticker)).toEqual(['AAA', 'BBB']);
    await run(controls({ MAX_FETCHES: '1' })); // the rest of the universe is skipped stocks, the cursor wraps around
    await rm(join(dir, 'update-state.json'), { force: true });
    await run(controls({ CONCURRENCY: '1' }), { deadlineMs: 1 }); // stops after the first stock, cursor kept for the next run
    expect(await cursor()).not.toBeNull();
    await run(controls());
    expect(await cursor()).toBeNull();
  });

  test('compactIndexText writes one company per line and parses back', () => {
    const doc = indexDocument([{ ticker: 'A', metrics: { pe: 1 } }, { ticker: 'B', metrics: { pe: null } }]);
    const text = compactIndexText(doc);
    expect(JSON.parse(text)).toEqual(doc);
    expect(text.split('\n').filter((line) => line.startsWith('{"ticker"')).length).toBe(2);
  });

  test('the published index is one company per line; meta.json stays pretty-printed', async () => {
    await run(controls());
    const text = await readText('index.json');
    expect(text.split('\n').filter((line) => line.startsWith('{"ticker"')).map((line) => JSON.parse(line.replace(/,$/, '')).ticker)).toEqual(['AAA', 'BBB']);
    expect(text).not.toContain('\n  ');
    expect(await readText('companies/AAA/meta.json')).toContain('\n  "ticker": "AAA"');
    await run(controls());
    expect(await readText('index.json')).toBe(text); // the compact file is still a zero-diff rerun
  });

  test('watchlist: All.txt keeps only its stocks, marks them isMine and removes the rest, a blank file means a full update', async () => {
    await run(controls());
    const tickers = async () => (await readIndex()).companies.map((c: any) => c.ticker);
    expect(await tickers()).toEqual(['AAA', 'BBB']);
    expect((await readIndex()).companies.map((c: any) => c.isMine)).toEqual([false, false]); // no list: nothing is the owner's
    expect((await readIndex()).mineTickers).toBeUndefined();
    await writeFile(join(dir, 'All.txt'), 'NASDAQ:aaa\nVOO\n'); // VOO is an ETF, absent from the SEC table
    expect(await run(controls())).toMatchObject({ updated: 1, failed: 0, rows: 1 });
    expect(await tickers()).toEqual(['AAA']);
    expect((await readIndex()).companies[0].isMine).toBe(true); // the "Mine" preset reads isMine; ETFs of the list come in mineTickers
    expect((await readIndex()).mineTickers).toEqual(['AAA', 'VOO']);
    expect((await readdir(join(dir, 'companies'))).sort()).toEqual(['AAA']);
    expect(await run(controls({ TICKERS: 'BBB' }))).toMatchObject({ updated: 0, rows: 1 }); // TICKERS outside the list are skipped
    await writeFile(join(dir, 'All.txt'), ' \n\n');
    await writeFile(join(dir, 'All.csv'), 'Symbol\nBBB\n'); // an empty All.txt falls through to All.csv
    await run(controls());
    expect(await tickers()).toEqual(['BBB']);
    await writeFile(join(dir, 'All.csv'), '');
    await run(controls());
    expect(await tickers()).toEqual(['AAA', 'BBB']);
  });

  test('the SEC layer: arrays by field and schemaVersion in meta.json; a revenue far from Yahoo\'s withholds the new SEC values', async () => {
    await run(controls());
    const index = await readIndex();
    expect([index.schemaVersion, index.companies[0].ttmAsOf, index.companies[0].fundamentalsAsOf]).toEqual([FEED_SCHEMA_VERSION, '2026-12-31', '2026-12-31']);
    const meta = JSON.parse(await readText('companies/AAA/meta.json'));
    expect(meta.schemaVersion).toBe(FEED_SCHEMA_VERSION);
    expect(meta.fundamentals.sec.fy.end).toEqual(['2026-12-31', '2025-12-31', '2024-12-31', '2023-12-31', '2022-12-31', '2021-12-31']);
    expect(meta.fundamentals.sec.fy.revenue[0]).toBe(161); // 100 × 1.1^5, whole dollars
    expect(meta.fundamentals.sec.ttm).toMatchObject({ end: '2026-12-31', period: 'TTM', basis: 'fy', revenue: 161 });
    expect(meta.fundamentals.checks.scale).toBeNull(); // the mock snapshot reports no revenue
    expect(index.companies[0].metrics.operatingMargin).toBe(19.88); // operating income 20 × 1.1^5 over revenue 100 × 1.1^5, whole dollars: 32 / 161
    expect(await readText('companies/AAA/meta.json')).toContain('"end": ["2026-12-31","2025-12-31"');
    // the next filing comes in thousands by mistake: SEC is 1000× Yahoo's revenue, the published SEC values stay
    secScale = 1000;
    yahooRevenue = 161.051; // 100 × 1.1^5
    expect(await run(controls({ TICKERS: 'AAA' }))).toMatchObject({ updated: 1, failed: 0 });
    const after = JSON.parse(await readText('companies/AAA/meta.json'));
    expect(after.fundamentals.sec).toEqual(meta.fundamentals.sec);
    expect(after.fundamentals.annual).toEqual(meta.fundamentals.annual);
    expect(after.fundamentals.checks.scale).toEqual({ ok: false, diffPct: 99900 });
    secScale = 1;
    expect(await run(controls({ TICKERS: 'AAA' }))).toMatchObject({ updated: 1 });
    expect(JSON.parse(await readText('companies/AAA/meta.json')).fundamentals.checks.scale).toEqual({ ok: true, diffPct: 0.03 }); // SEC stores whole dollars: 161
  });

  test('a foreign issuer: ifrs-full 20-F in EUR, growth in EUR, P/E over market cap in USD, isAdr and country', async () => {
    foreignBbb = true;
    expect(await run(controls())).toMatchObject({ updated: 2, failed: 0 });
    const row = (await readIndex()).companies.find((c: any) => c.ticker === 'BBB');
    const meta = JSON.parse(await readText('companies/BBB/meta.json'));
    expect([meta.fundamentals.sec.currency, meta.fundamentals.sec.taxonomy, meta.fundamentals.usd.pair, meta.fundamentals.usd.rates.ttm]).toEqual(['EUR', 'ifrs-full', 'EURUSD=X', { flow: 1.1, balance: 1.1 }]);
    expect(row.fundamentalsBasis).toBe(FUNDAMENTALS_BASIS['sec-ifrs']);
    expect([row.metrics.isAdr, row.metrics.country, row.metrics.ttmIsAnnual]).toEqual([true, 'Germany', true]);
    expect(row.metrics.pe).toBe(Math.round((2e9 / (24157650 * 1.1)) * 100) / 100); // market cap / NI in USD (75.26), not Yahoo's 15
    expect(row.metrics.pb).toBe(Math.round((2e9 / (120e6 * 1.1)) * 100) / 100);
    expect([row.metrics.revenueGrowth, row.metrics.niGrowth3y, row.metrics.pePct5y]).toEqual([10, 10, null]); // EUR growth; no own-history P/E for an ADR
    const aaa = (await readIndex()).companies.find((c: any) => c.ticker === 'AAA');
    expect([aaa.metrics.pe, aaa.metrics.isAdr, aaa.metrics.ttmIsAnnual, aaa.fundamentalsBasis]).toEqual([15, null, true, FUNDAMENTALS_BASIS.sec]); // a US filer keeps Yahoo's P/E; the mock has no country
  });

  test('a failed source keeps the stock exactly as published', async () => {
    await run(controls());
    const before = { meta: await readText('companies/AAA/meta.json'), row: (await readIndex()).companies[0] };
    failChartFor = 'AAA';
    expect(await run(controls())).toMatchObject({ updated: 1, failed: 1 });
    expect(await readText('companies/AAA/meta.json')).toBe(before.meta);
    expect((await readIndex()).companies[0]).toEqual(before.row);
    // a truncated `max` answer (the first 300 days missing) counts as a failed source too: the history is never shrunk
    failChartFor = '';
    chartSkip = 100;
    expect(await run(controls())).toMatchObject({ updated: 0 }); // every published stock gets the short answer and fails
    expect(await readText('companies/AAA/meta.json')).toBe(before.meta);
    expect((await readIndex()).companies[0]).toEqual(before.row);
  });

  test('a failed quoteSummary keeps the 52-week range from the closes; a failed SEC download keeps the fundamentals basis', async () => {
    await run(controls());
    const meta = JSON.parse(await readText('companies/AAA/meta.json'));
    meta.fundamentalsBasis = 'Yahoo fundamentals-timeseries annual statements (no usable SEC history); valuation multiples from the Yahoo quoteSummary TTM snapshot';
    await writeFile(join(dir, 'companies', 'AAA', 'meta.json'), JSON.stringify(meta));
    failSummaryFor = 'AAA';
    failSecFor = 'CIK0000000001';
    expect(await run(controls())).toMatchObject({ updated: 2, failed: 0 });
    const after = JSON.parse(await readText('companies/AAA/meta.json'));
    // closes are 50 + 0.05 i every 3 days: the last 52 weeks start at candle 278 and end at candle 399
    expect([after.metrics.week52Low, after.metrics.week52High]).toEqual([63.9, 69.95]);
    expect(after.fundamentalsBasis).toBe(meta.fundamentalsBasis);
    expect(after.fundamentals.annual).toEqual(meta.fundamentals.annual);
    const bbb = JSON.parse(await readText('companies/BBB/meta.json'));
    expect(bbb.fundamentalsBasis).toMatch(/^SEC EDGAR/); // the stock whose sources answered is not touched
    expect([bbb.metrics.week52Low, bbb.metrics.week52High]).toEqual([null, null]); // an honest null from a working quoteSummary stays null
    expect([bbb.metrics.pctFrom52wHigh, after.metrics.pctFrom52wHigh]).toEqual([null, 0.07]); // 70 / 69.95 (the closes) - 1
    // SKIP_YAHOO: the swing metrics travel with the published market data, nothing is recomputed or lost
    const swingKeys = ['athPrice', 'athDate', 'athBasis', 'pctFromAth', 'volatility1y', 'sigmaFromMean60d', 'high60d', 'low60d', 'pctFrom52wHigh'];
    const pick = (m: any) => swingKeys.map((k) => m[k]);
    expect(await run(controls({ SKIP_YAHOO: 'true' }))).toMatchObject({ updated: 2 }); // the unpublished candidates have no market data to keep and fail
    expect(pick(JSON.parse(await readText('companies/AAA/meta.json')).metrics)).toEqual(pick(after.metrics));
  });
});

// ---------------------------------------------------------------------------

describe('network', () => {
  const realFetch = globalThis.fetch;
  let dir: string;
  let restore: URL;
  let restoreWatchlist: URL;
  let inFlight = 0;
  let peak = 0;
  const seen: Array<{ url: string; signal: unknown }> = [];
  let companyFactsStatus = 200;
  let companyFactsRetryAfter = '';
  let completeSec = false;
  let cookieFailures = 0; // the first N fc.yahoo.com answers carry no cookie (a failed Yahoo session)
  let clockJumpOnChart = ''; // a ticker whose chart request moves the clock 6 minutes ahead

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, signal: init?.signal });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('company_tickers_exchange')) return json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[1, 'AAA', 'AAA', 'Nasdaq'], [2, 'BBB', 'BBB', 'NYSE'], [3, 'CCC', 'CCC', 'NYSE']] });
    if (url.startsWith('https://fc.yahoo.com')) return cookieFailures-- > 0 ? new Response('', { status: 404 }) : new Response('', { status: 404, headers: { 'set-cookie': 'A3=abc; Path=/' } });
    if (url.includes('getcrumb')) return new Response('crumb123', { status: 200 });
    if (url.includes('quoteSummary')) return json({ quoteSummary: { result: [{ price: { quoteType: 'EQUITY', currency: 'USD', marketCap: { raw: 1e9 } } }] } });
    if (clockJumpOnChart && url.includes(`/v8/finance/chart/${clockJumpOnChart}?`)) setSystemTime(new Date(Date.now() + 6 * 60_000));
    if (url.includes('/v8/finance/chart/')) return json({ chart: { result: [{ meta: {}, timestamp: [1577923200], indicators: { quote: [{ close: [10], volume: [1] }], adjclose: [{ adjclose: [10] }] } }] } });
    if (url.includes('fundamentals-timeseries')) return json({ timeseries: { result: [] } });
    if (url.includes('companyfacts')) return companyFactsStatus === 200 ? json(completeSec ? completeFacts() : syntheticFacts()) : new Response('nope', { status: companyFactsStatus, headers: companyFactsRetryAfter ? { 'retry-after': companyFactsRetryAfter } : {} });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stocks-net-'));
    restore = useApiRoot(new URL(`${pathToFileURL(dir).href}/`));
    restoreWatchlist = useWatchlistDir(new URL(`${pathToFileURL(dir).href}/`));
    globalThis.fetch = mockFetch;
    inFlight = 0;
    peak = 0;
    seen.length = 0;
    companyFactsStatus = 200;
    companyFactsRetryAfter = '';
    completeSec = false;
    cookieFailures = 0;
    clockJumpOnChart = '';
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    setSystemTime();
    useApiRoot(restore);
    useWatchlistDir(restoreWatchlist);
    await rm(dir, { recursive: true, force: true });
  });

  const controls = (extra: Record<string, string> = {}) => ({ REQUEST_SLEEP: '0', MAX_RETRIES: '1', TICKERS: '', ...extra });

  test('every request carries an abort signal (timeout covers headers and body)', async () => {
    await run(controls({ TICKERS: 'AAA' }));
    expect(seen.length).toBeGreaterThan(4);
    for (const call of seen) expect(call.signal instanceof AbortSignal).toBe(true);
  });

  test('retries are bounded by MAX_RETRIES and only transient statuses are retried', async () => {
    companyFactsStatus = 503;
    expect(await run(controls({ TICKERS: 'AAA', MAX_RETRIES: '1' }))).toMatchObject({ failed: 1 });
    expect(seen.filter((c) => c.url.includes('companyfacts')).length).toBe(2);
    seen.length = 0;
    companyFactsStatus = 404;
    await run(controls({ TICKERS: 'AAA', MAX_RETRIES: '3' }));
    expect(seen.filter((c) => c.url.includes('companyfacts')).length).toBe(1);
  });

  test('Retry-After: delta-seconds and HTTP-date are parsed and capped, junk and past dates are ignored', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfter('7', now)).toBe(7_000);
    expect(parseRetryAfter(' 600 ', now)).toBe(120_000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:27:00 GMT', now)).toBe(0);
    for (const junk of [null, '', '0', 'soon']) expect(parseRetryAfter(junk, now)).toBe(0);
  });

  test('a retry waits for Retry-After when it is longer than the backoff', async () => {
    companyFactsStatus = 503;
    companyFactsRetryAfter = '2'; // the backoff alone would wait 0.8 s
    const started = Date.now();
    expect(await run(controls({ TICKERS: 'AAA', MAX_RETRIES: '1' }))).toMatchObject({ failed: 1 });
    expect(seen.filter((c) => c.url.includes('companyfacts')).length).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
  });

  test('Yahoo fundamentals-timeseries is requested only when the 4 latest SEC years have a gap it could fill', async () => {
    const timeseries = () => seen.filter((c) => c.url.includes('fundamentals-timeseries')).length;
    await run(controls({ TICKERS: 'AAA' })); // the synthetic SEC facts have no gross profit, receivables or tax rate
    expect(timeseries()).toBe(1);
    seen.length = 0;
    completeSec = true;
    await run(controls({ TICKERS: 'AAA' }));
    expect(timeseries()).toBe(0);
    expect(seen.filter((c) => c.url.includes('companyfacts')).length).toBe(1);
  });

  test('a failed Yahoo session is not cached for the whole run: retried after 5 minutes, not before', async () => {
    const sessionOpens = () => seen.filter((c) => c.url.startsWith('https://fc.yahoo.com')).length;
    cookieFailures = 1; // inside the retry window nobody reopens the session: no snapshot, no market cap, every stock skipped
    expect(await run(controls({ CONCURRENCY: '1' }))).toMatchObject({ updated: 0, skipped: 3 });
    expect(sessionOpens()).toBe(1);
    seen.length = 0;
    await rm(dir, { recursive: true, force: true });
    cookieFailures = 1;
    clockJumpOnChart = 'AAA'; // the clock passes the retry window while AAA is processed: BBB reopens the session
    expect(await run(controls({ CONCURRENCY: '1' }))).toMatchObject({ updated: 2, skipped: 1 });
    expect(sessionOpens()).toBe(2);
  });

  test('concurrency is real: peak 1 at CONCURRENCY=1, more at 3', async () => {
    await run(controls({ CONCURRENCY: '1' }));
    expect(peak).toBe(1);
    await rm(dir, { recursive: true, force: true });
    peak = 0;
    await run(controls({ CONCURRENCY: '3' }));
    expect(peak).toBeGreaterThan(1);
  });

  test('HISTORY_RANGE shrinks the Yahoo request with explicit period1 and period2', async () => {
    const periods = async (range: string) => {
      seen.length = 0;
      await run(controls({ TICKERS: 'AAA', HISTORY_RANGE: range }));
      const url = new URL(seen.find((c) => c.url.includes('/v8/finance/chart/'))?.url as string);
      return { p1: Number(url.searchParams.get('period1')), p2: Number(url.searchParams.get('period2')) };
    };
    const max = await periods('max');
    expect(max.p1).toBe(0);
    const five = await periods('5y');
    expect(five.p1).toBeGreaterThan(0);
    expect(five.p2 - five.p1).toBeGreaterThan(4.9 * 365 * 86400);
    expect(five.p2 - five.p1).toBeLessThan(5.1 * 365 * 86400);
  });

  test('TLS: only untrusted-certificate errors restart with the system CA, once, in auto mode', async () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(Object.assign(new Error('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET', message: 'socket hang up' })).toBe(false);
    expect(isCertError(null)).toBe(false);
    let calls = 0;
    const reexec = () => { calls += 1; return undefined as never; };
    installSystemCa('false', reexec, false);
    expect(globalThis.fetch).toBe(mockFetch);
    installSystemCa('auto', reexec, true);
    expect(globalThis.fetch).toBe(mockFetch);
    globalThis.fetch = (async () => { throw Object.assign(new Error('fetch failed'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }); }) as unknown as typeof fetch;
    const failing = globalThis.fetch;
    installSystemCa('auto', reexec, false);
    expect(globalThis.fetch).not.toBe(failing);
    await globalThis.fetch('https://example.invalid/');
    expect(calls).toBe(1);
  });
});
