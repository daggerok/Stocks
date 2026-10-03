/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  annualSeries, buildAnnualRows, completeMetrics, CONTROL_NAMES, dividendMetrics, fundamentalsMetrics, installSystemCa, isCertError, mergeAnnual,
  isOperatingTicker, normalizeTicker, parseChart, parseRange, parseRanges, parseSecTickers, parseSummary, parseYahooAnnual, priceReturns, readConfig, resolveControls,
  run, runtimeControls, sampleHistory, useApiRoot, valuationMetrics, type ChartDay, type Snapshot,
} from './update-data.ts';

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

const SNAPSHOT: Snapshot = {
  quoteType: 'EQUITY', name: 'X', sector: 'Tech', industry: 'Software', currency: 'USD', financialCurrency: 'USD', marketCap: 1e12, enterpriseValue: 1e12, sharesOutstanding: 1, beta: 1,
  pe: 20, forwardPe: 18, ps: 5, forwardRevenue: 2e11, evEbitda: 10, pb: 3, freeCashflow: 1e11, ebitda: 2e11, week52High: 1, week52Low: 1,
};

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
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
    expect([...(readConfig({ TICKERS: 'aapl, brk.b;MSFT' }).tickers ?? [])].sort()).toEqual(['AAPL', 'BRK-B', 'MSFT']);
    expect(config.marketCap).toEqual({});
    expect(config.performance).toEqual({});
    expect(config.secUa).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(readConfig(resolveControls(file(), { SEC_UA: 'My Feed me@example.org' })).secUa).toBe('My Feed me@example.org');
    expect(parseRange('10B:')).toEqual({ min: 1e10, max: undefined });
    expect(parseRange(':500M')).toEqual({ min: undefined, max: 5e8 });
    expect(parseRanges({ PERFORMANCE_1Y: '10:', PERFORMANCE_5Y: ':' }, 'PERFORMANCE')).toEqual({ '1Y': { min: 10, max: undefined } });
    expect(normalizeTicker('brk.b')).toBe('BRK-B');
    expect(resolveControls(file()).USE_SYSTEM_CA).toBe('auto');
    expect(resolveControls(file(), {}, {}, { USE_SYSTEM_CA: 'TRUE' }).USE_SYSTEM_CA).toBe('true');
  });

  test('config keys, CONTROL_NAMES, README controls table and --help stay in sync', async () => {
    expect(Object.keys(file()).sort()).toEqual([...CONTROL_NAMES].sort());
    for (const value of Object.values(file())) expect(typeof value).toBe('string');
    expect((await runtimeControls({ REQUEST_SLEEP: '0', TICKERS: 'AAPL MSFT' })).TICKERS).toBe('AAPL MSFT');
    const doc = read('README.md');
    const section = doc.slice(doc.indexOf('### Update controls'), doc.indexOf('### Examples'));
    const documented = new Set<string>();
    for (const [, cell] of section.matchAll(/^\| ((?:`[A-Z0-9_]+`(?:, )?)+) \|/gm)) {
      const tokens = [...cell.matchAll(/`([A-Z0-9_]+)`/g)].map((m) => m[1]);
      const prefix = tokens[0].replace(/_YTD$/, '');
      for (const token of tokens) documented.add(token.startsWith('_') ? `${prefix}${token}` : token);
    }
    expect([...documented].sort()).toEqual([...CONTROL_NAMES].sort());
    expect(doc).toContain('scripts/update-data.config.json');
    const help = spawnSync('bun', [new URL('./update-data.ts', import.meta.url).pathname, '--help'], { encoding: 'utf8' }).stdout;
    for (const name of CONTROL_NAMES) {
      const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_/);
      expect(help).toContain(tenor ? `${tenor[1]}_YTD|1Y|3Y|5Y|10Y` : name);
    }
  });

  test('workflow and README structure follow the standard', () => {
    const yml = read('.github/workflows/update-data.yml');
    const block = yml.slice(yml.indexOf('    inputs:'), yml.indexOf('\npermissions:'));
    const names = [...block.matchAll(/^      (\w+):$/gm)].map((m) => m[1]);
    expect(names.length).toBeLessThanOrEqual(25);
    expect(block).toMatch(/advanced:[\s\S]*default: '\{\}'/);
    for (const name of names.filter((n) => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as any);
    expect(names).not.toContain('sec_ua');
    expect(names).not.toContain('output_dir');
    expect(yml).toContain("cron: '0 0 * * 0'");
    expect(yml).toContain('toJSON(inputs)');
    expect(yml).toContain('JSON.parse(process.env.DISPATCH_INPUTS || "{}") || {}'); // toJSON(inputs) is "null" on scheduled runs
    expect(yml).not.toMatch(/\$\{\{\s*inputs\./);
    for (const part of ['resolveControls', 'vars.SEC_UA', 'timeout-minutes: 30', 'persist-credentials: false', 'git add api/stocks\n']) expect(yml).toContain(part);
    expect(yml.match(/git add /g)?.length).toBe(1);
    const doc = read('README.md');
    const order = ['# Stocks', '## Using Bun', '## Updating the static Stocks data', '### Data sources', '### Metrics and caveats', '### Update controls', '### Examples', '## TypeScript and verification', '## Exchanges table', '## Sibling applications', '## License'];
    let at = -1;
    for (const heading of order) {
      const next = doc.indexOf(`\n${heading}\n`, at);
      expect(next > at || (heading === '# Stocks' && doc.startsWith(heading))).toBe(true);
      at = Math.max(at, next);
    }
    for (const command of ['bun install --frozen-lockfile', 'bun test', 'bun build --target=bun scripts/update-data.ts --outfile=/dev/null', 'git diff --check']) expect(doc).toContain(command);
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

  test('XBRL: annual 10-K facts only, tags merged across eras, D&A fallback, derived EBITDA and FCF', () => {
    const facts = syntheticFacts();
    facts.facts['us-gaap'].SalesRevenueNet.units.USD.push({ start: '2026-01-01', end: '2026-03-31', val: 1, form: '10-Q', filed: '2026-04-30' });
    const merged = annualSeries(facts, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'], 'flow');
    expect([...merged.keys()]).toHaveLength(6);
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
    expect(a.returnsBasis.length).toBeGreaterThan(10);
    expect(b.returnsBasis).toBe(a.returnsBasis);
    expect([a.performanceAsOf, b.performanceAsOf]).toEqual(['2026-10-02', null]);
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
    expect(monthly[1].close).toBe(long.filter((r) => r.date.startsWith(monthly[1].date.slice(0, 7))).at(-1)?.close as number);
    expect(rows[rows.length - 1].date).toBe(long[long.length - 1].date);
    expect(sampleHistory([])).toEqual({ rows: [], dailyFrom: null });
  });
});

// ---------------------------------------------------------------------------

describe('pipeline', () => {
  const realFetch = globalThis.fetch;
  let dir: string;
  let restore: URL;
  let failChartFor = '';

  const chartPayload = () => {
    const start = Date.parse('2020-01-02T00:00:00Z') / 1000;
    const timestamp = Array.from({ length: 400 }, (_, i) => start + i * 86_400 * 3);
    const close = timestamp.map((_, i) => 50 + i * 0.05);
    return { chart: { result: [{ meta: { regularMarketPrice: 70, currency: 'USD', fullExchangeName: 'NasdaqGS' }, timestamp, indicators: { quote: [{ close, volume: close.map(() => 10) }], adjclose: [{ adjclose: close }] }, events: { dividends: { [String(timestamp[300])]: { amount: 0.5 } } } }] } };
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
      const body = summary(url.includes('/CCC') ? 'ETF' : 'EQUITY');
      if (url.includes('/EEE')) delete (body.quoteSummary.result[0].price as any).marketCap; // a warrant has no market cap
      return json(body);
    }
    if (url.includes('/v8/finance/chart/')) return failChartFor && url.includes(`/${failChartFor}?`) ? new Response('boom', { status: 500 }) : json(chartPayload());
    if (url.includes('fundamentals-timeseries')) return json({ timeseries: { result: [] } });
    if (url.includes('companyfacts')) return url.includes('CIK0000000006') ? new Response('nope', { status: 404 }) : json(syntheticFacts()); // FFF has no XBRL facts
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stocks-'));
    restore = useApiRoot(new URL(`${pathToFileURL(dir).href}/`));
    globalThis.fetch = mockFetch;
    failChartFor = '';
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    useApiRoot(restore);
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
    expect(metrics.performanceAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([...(await readdir(join(dir, 'companies', 'AAA', 'history')))].sort()).toEqual(['001.json']);
  });

  test('a filtered one-ticker run and a market cap filter never shrink the index', async () => {
    await run(controls());
    expect((await run(controls({ TICKERS: 'AAA' }))).rows).toBe(2);
    const filtered = await run(controls({ MARKET_CAP: '10B:' }));
    expect(filtered.updated).toBe(0);
    expect((await readIndex()).companies).toHaveLength(2);
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

  test('a failed source keeps the stock exactly as published', async () => {
    await run(controls());
    const before = { meta: await readText('companies/AAA/meta.json'), row: (await readIndex()).companies[0] };
    failChartFor = 'AAA';
    expect(await run(controls())).toMatchObject({ updated: 1, failed: 1 });
    expect(await readText('companies/AAA/meta.json')).toBe(before.meta);
    expect((await readIndex()).companies[0]).toEqual(before.row);
  });
});

// ---------------------------------------------------------------------------

describe('network', () => {
  const realFetch = globalThis.fetch;
  let dir: string;
  let restore: URL;
  let inFlight = 0;
  let peak = 0;
  const seen: Array<{ url: string; signal: unknown }> = [];
  let companyFactsStatus = 200;

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, signal: init?.signal });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('company_tickers_exchange')) return json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[1, 'AAA', 'AAA', 'Nasdaq'], [2, 'BBB', 'BBB', 'NYSE'], [3, 'CCC', 'CCC', 'NYSE']] });
    if (url.startsWith('https://fc.yahoo.com')) return new Response('', { status: 404, headers: { 'set-cookie': 'A3=abc; Path=/' } });
    if (url.includes('getcrumb')) return new Response('crumb123', { status: 200 });
    if (url.includes('quoteSummary')) return json({ quoteSummary: { result: [{ price: { quoteType: 'EQUITY', currency: 'USD', marketCap: { raw: 1e9 } } }] } });
    if (url.includes('/v8/finance/chart/')) return json({ chart: { result: [{ meta: {}, timestamp: [1577923200], indicators: { quote: [{ close: [10], volume: [1] }], adjclose: [{ adjclose: [10] }] } }] } });
    if (url.includes('fundamentals-timeseries')) return json({ timeseries: { result: [] } });
    if (url.includes('companyfacts')) return companyFactsStatus === 200 ? json(syntheticFacts()) : new Response('nope', { status: companyFactsStatus });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stocks-net-'));
    restore = useApiRoot(new URL(`${pathToFileURL(dir).href}/`));
    globalThis.fetch = mockFetch;
    inFlight = 0;
    peak = 0;
    seen.length = 0;
    companyFactsStatus = 200;
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    useApiRoot(restore);
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
    globalThis.fetch = (async () => { throw Object.assign(new Error('fetch failed'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }); }) as typeof fetch;
    const failing = globalThis.fetch;
    installSystemCa('auto', reexec, false);
    expect(globalThis.fetch).not.toBe(failing);
    await globalThis.fetch('https://example.invalid/');
    expect(calls).toBe(1);
  });
});
