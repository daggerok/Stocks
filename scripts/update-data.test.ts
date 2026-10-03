/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  annualSeries, buildAnnualRows, CONTROL_NAMES, dividendMetrics, fundamentalsMetrics, mergeAnnual, normalizeTicker, parseRange, parseSecTickers, priceReturns,
  installSystemCa, isCertError, parseRanges, readConfig, resolveControls, run, runtimeControls, sampleHistory, useApiRoot, valuationMetrics, type AnnualRow, type ChartDay, type Snapshot,
} from './update-data.ts';

const fact = (end: string, val: number, extra: Record<string, unknown> = {}) => ({ start: `${Number(end.slice(0, 4)) - 1}-${end.slice(5)}`, end, val, form: '10-K', filed: `${end.slice(0, 4)}-12-31`, ...extra });
const inst = (end: string, val: number) => ({ end, val, form: '10-K', filed: `${end.slice(0, 4)}-12-31` });
const units = (list: unknown[], unit = 'USD') => ({ units: { [unit]: list } });

function syntheticFacts(): Record<string, unknown> {
  const years = [2021, 2022, 2023, 2024, 2025, 2026];
  const series = (base: number, growth: number) => years.map((y, i) => fact(`${y}-12-31`, base * growth ** i));
  return {
    facts: {
      'us-gaap': {
        // an older tag and a newer one: the merge must take both eras
        SalesRevenueNet: units(series(100, 1.1).slice(0, 2)),
        RevenueFromContractWithCustomerExcludingAssessedTax: units(series(100, 1.1)),
        OperatingIncomeLoss: units(series(20, 1.1)),
        DepreciationDepletionAndAmortization: units(series(5, 1.1)),
        NetIncomeLoss: units(series(15, 1.1)),
        NetCashProvidedByUsedInOperatingActivities: units(series(25, 1.1)),
        PaymentsToAcquirePropertyPlantAndEquipment: units(series(5, 1.1)),
        PaymentsOfDividends: units(series(6, 1.1)),
        EarningsPerShareDiluted: units(years.map((y, i) => fact(`${y}-12-31`, 2 * 1.1 ** i)), 'USD/shares'),
        Assets: units(years.map((y, i) => inst(`${y}-12-31`, 200 * 1.1 ** i))),
        AssetsCurrent: units(years.map((y) => inst(`${y}-12-31`, 100))),
        LiabilitiesCurrent: units(years.map((y) => inst(`${y}-12-31`, 50))),
        CashAndCashEquivalentsAtCarryingValue: units(years.map((y) => inst(`${y}-12-31`, 30))),
        LongTermDebtNoncurrent: units(years.map((y) => inst(`${y}-12-31`, 60))),
        StockholdersEquity: units(years.map((y) => inst(`${y}-12-31`, 120))),
      },
    },
  };
}

describe('controls', () => {
  test('precedence is file < advanced < nonblank inputs < env, and an empty env wins', () => {
    const r = resolveControls({ CONCURRENCY: '3', TICKERS: 'AAPL' }, { CONCURRENCY: '4' }, { CONCURRENCY: '5', TICKERS: '' }, { CONCURRENCY: '6', VERBOSE: '' });
    expect(r.CONCURRENCY).toBe('6');
    expect(r.TICKERS).toBe('AAPL'); // a blank workflow input inherits the file value
    expect(r.VERBOSE).toBe('');
  });
  test('validation is strict', () => {
    expect(() => resolveControls({ NOPE: '1' })).toThrow('Unknown updater control');
    expect(() => readConfig({ MAX_RETRIES: '0' })).toThrow('MAX_RETRIES');
    expect(() => readConfig({ MARKET_CAP: '5:1' })).toThrow('min is greater than max');
    expect(() => readConfig({ HISTORY_RANGE: 'forever' })).toThrow('HISTORY_RANGE');
    expect(() => resolveControls({ TICKERS: 'A\nB' })).toThrow('multiline');
    expect(CONTROL_NAMES).toContain('MARKET_CAP');
  });
  test('ranges accept suffixes and open ends', () => {
    expect(parseRange('10B:')).toEqual({ min: 1e10, max: undefined });
    expect(parseRange(':500M')).toEqual({ min: undefined, max: 5e8 });
    expect(normalizeTicker('brk.b')).toBe('BRK-B');
  });
});

describe('fundamentals', () => {
  test('annual series merges tags across eras and ignores quarters', () => {
    const facts = syntheticFacts() as any;
    facts.facts['us-gaap'].SalesRevenueNet.units.USD.push({ start: '2026-01-01', end: '2026-03-31', val: 1, form: '10-Q', filed: '2026-04-30' });
    const s = annualSeries(facts, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'], 'flow');
    expect([...s.keys()]).toHaveLength(6);
    expect(s.has('2026-03-31')).toBe(false);
  });
  test('rows and metrics: growth, margins, ratios, ROIC', () => {
    const rows = buildAnnualRows(syntheticFacts());
    expect(rows[0].end).toBe('2026-12-31');
    expect(rows[0].ebitda).toBeCloseTo((20 + 5) * 1.1 ** 5, 6);
    expect(rows[0].fcf).toBeCloseTo((25 - 5) * 1.1 ** 5, 6);
    const m = fundamentalsMetrics(rows);
    expect(m.revenueGrowth).toBe(10);
    expect(m.revenueGrowth3y).toBe(10);
    expect(m.revenueGrowth5y).toBe(10);
    expect(m.netMargin).toBe(15);
    expect(m.netMarginDelta).toBe(0);
    expect(m.currentRatio).toBe(2);
    expect(m.quickRatio).toBe(0.6);
    expect(m.debtToEquity).toBe(0.5);
    expect(m.netDebtToEbitda).toBeCloseTo(30 / (25 * 1.1 ** 5), 2);
    expect(m.payoutRatio).toBe(40);
    expect(m.roic).not.toBeNull();
  });
  test('D&A falls back to depreciation plus intangible amortization when no combined tag exists', () => {
    const facts = syntheticFacts() as any;
    delete facts.facts['us-gaap'].DepreciationDepletionAndAmortization;
    expect(buildAnnualRows(facts)[0].ebitda).toBeNull();
    const years = [2021, 2022, 2023, 2024, 2025, 2026];
    facts.facts['us-gaap'].Depreciation = units(years.map((y) => fact(`${y}-12-31`, 3)));
    expect(buildAnnualRows(facts)[0].ebitda).toBeCloseTo(20 * 1.1 ** 5 + 3, 6);
    facts.facts['us-gaap'].AmortizationOfIntangibleAssets = units(years.map((y) => fact(`${y}-12-31`, 2)));
    expect(buildAnnualRows(facts)[0].ebitda).toBeCloseTo(20 * 1.1 ** 5 + 5, 6);
  });
  test('missing data is null, never zero (a bank has no EBITDA or FCF)', () => {
    const rows = [{ ...mergeAnnual([], new Map([['2025-12-31', { revenue: 100, netIncome: 30 }]])).rows[0] }];
    const m = fundamentalsMetrics(rows);
    expect(m.ebitdaMargin).toBeNull();
    expect(m.fcfPayout).toBeNull();
    expect(m.netMargin).toBe(30);
    expect(m.revenueGrowth).toBeNull();
  });
  test('growth is null when the previous row is not the prior fiscal year', () => {
    const rows = buildAnnualRows(syntheticFacts());
    rows.splice(1, 1); // drop a year
    expect(fundamentalsMetrics(rows).revenueGrowth).toBeNull();
  });
  test('yahoo only fills gaps and never overrides SEC', () => {
    const sec = buildAnnualRows(syntheticFacts()).map((r) => ({ ...r, ebitda: null }));
    const merged = mergeAnnual(sec, new Map([['2026-12-28', { ebitda: 999, revenue: 1 }]]));
    expect(merged.source).toBe('sec+yahoo');
    expect(merged.rows[0].ebitda).toBe(999);
    expect(merged.rows[0].revenue).toBeCloseTo(100 * 1.1 ** 5, 6);
    expect(mergeAnnual([], new Map()).source).toBe('sec');
  });
});

describe('market data', () => {
  const days: ChartDay[] = [];
  for (let i = 0; i <= 900; i += 1) {
    const date = new Date(Date.UTC(2023, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    days.push({ date, close: 100 + i * 0.1, adjClose: 90 + i * 0.12, volume: 1 });
  }
  test('performance uses closes, total return uses adjusted closes, unreachable periods are null', () => {
    const r = priceReturns(days);
    expect(r.perf1y).not.toBeNull();
    expect(r.tr1y).toBeGreaterThan(r.perf1y as number);
    expect(r.perf5y).toBeNull();
    expect(r.tr10y).toBeNull();
    expect(r.cagr3y).toBeNull(); // only about 2.5 years of history: no anchor day 3 years back
  });
  test('history is monthly with daily rows for the last 31 days, and volume is summed per month', () => {
    const long: ChartDay[] = [];
    for (let i = 0; i <= 9 * 365; i += 1) long.push({ date: new Date(Date.UTC(2017, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), close: i, adjClose: i, volume: 1 });
    const { rows, dailyFrom } = sampleHistory(long);
    const d = dailyFrom as string;
    const monthly = rows.filter((r) => r.date < d);
    const daily = rows.filter((r) => r.date >= d);
    expect(new Set(monthly.map((r) => r.date.slice(0, 7))).size).toBe(monthly.length);
    expect(monthly.length).toBeGreaterThan(100);
    expect(monthly.length).toBeLessThan(112);
    expect(daily).toHaveLength(long.filter((r) => r.date >= d).length);
    expect(daily.length).toBeLessThanOrEqual(31);
    expect(rows.reduce((s, r) => s + r.volume, 0)).toBe(long.length); // nothing is lost, only merged
    expect(monthly[1].close).toBe(long.filter((r) => r.date.startsWith(monthly[1].date.slice(0, 7))).at(-1)!.close); // month-end close
    expect(rows[rows.length - 1].date).toBe(long[long.length - 1].date);
    expect(sampleHistory([])).toEqual({ rows: [], dailyFrom: null });
  });
  test('dividend yield, growth and the honest zero of a non-payer', () => {
    const d = [2021, 2022, 2023, 2024].flatMap((y) => [1, 4, 7, 10].map((m) => ({ date: `${y}-${String(m).padStart(2, '0')}-15`, amount: 0.25 * (1 + (y - 2021) * 0.1) })));
    const r = dividendMetrics(d, 100, '2025-03-01');
    expect(r.metrics.dividendGrowth).toBeCloseTo(8.33, 1);
    expect(r.metrics.dividendGrowth3y).toBeCloseTo(9.14, 1);
    expect(r.metrics.dividendGrowth5y).toBeNull();
    expect(dividendMetrics([], 100, '2025-03-01').metrics.dividendYield).toBe(0);
  });
  test('valuation multiples are dropped when price and financials use different currencies (ADRs)', () => {
    const snap: Snapshot = { quoteType: 'EQUITY', name: 'X', sector: null, industry: null, currency: 'USD', financialCurrency: 'TWD', marketCap: 1e12, enterpriseValue: 1e12, sharesOutstanding: 1, beta: 1, pe: 20, forwardPe: 18, ps: 5, forwardRevenue: 2e11, evEbitda: 10, pb: 3, freeCashflow: 1e11, ebitda: 2e11, week52High: 1, week52Low: 1 };
    const adr = valuationMetrics(snap);
    expect(adr.pe).toBeNull();
    expect(adr.pFcf).toBeNull();
    expect(adr.marketCap).toBe(1e12);
    expect(adr.fcfToEbitda).toBe(50);
    const us = valuationMetrics({ ...snap, financialCurrency: 'USD' });
    expect(us.pFcf).toBe(10);
    expect(us.forwardPs).toBe(5);
  });
});

describe('updater run (mocked fetch)', () => {
  const realFetch = globalThis.fetch;
  let dir: string;
  let restore: URL;
  let inFlight = 0;
  let peak = 0;
  const calls: string[] = [];

  const chartPayload = () => {
    const start = Date.parse('2020-01-02T00:00:00Z') / 1000;
    const timestamp = Array.from({ length: 400 }, (_, i) => start + i * 86_400 * 3);
    const close = timestamp.map((_, i) => 50 + i * 0.05);
    return { chart: { result: [{ meta: { regularMarketPrice: 70, currency: 'USD', fullExchangeName: 'NasdaqGS' }, timestamp, indicators: { quote: [{ close, volume: close.map(() => 10) }], adjclose: [{ adjclose: close }] }, events: { dividends: { [String(timestamp[300])]: { amount: 0.5 } } } }] } };
  };
  const summary = (type: string) => ({ quoteSummary: { result: [{ price: { quoteType: type, longName: 'Mock Corp', currency: 'USD', marketCap: { raw: 2e9 } }, summaryDetail: { trailingPE: { raw: 15 } }, defaultKeyStatistics: { forwardPE: { raw: 12 } }, financialData: { financialCurrency: 'USD', freeCashflow: { raw: 1e8 }, ebitda: { raw: 4e8 } }, earningsTrend: { trend: [{ period: '+1y', revenueEstimate: { avg: { raw: 1e9 } } }] }, assetProfile: { sector: 'Tech', industry: 'Software' } }] } });

  const mockFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('company_tickers_exchange')) return json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[1, 'AAA INC', 'AAA', 'Nasdaq'], [2, 'BBB INC', 'BBB', 'NYSE'], [3, 'CCC FUND', 'CCC', 'NYSE'], [4, 'DDD OTC', 'DDD', 'OTC']] });
    if (url.startsWith('https://fc.yahoo.com')) return new Response('', { status: 404, headers: { 'set-cookie': 'A3=abc; Path=/' } });
    if (url.includes('getcrumb')) return new Response('crumb123', { status: 200 });
    if (url.includes('quoteSummary')) return json(summary(url.includes('/CCC') ? 'ETF' : 'EQUITY'));
    if (url.includes('/v8/finance/chart/')) return json(chartPayload());
    if (url.includes('fundamentals-timeseries')) return json({ timeseries: { result: [] } });
    if (url.includes('companyfacts')) return json(syntheticFacts());
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stocks-'));
    restore = useApiRoot(new URL(`${pathToFileURL(dir).href}/`));
    globalThis.fetch = mockFetch;
    inFlight = 0;
    peak = 0;
    calls.length = 0;
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    useApiRoot(restore);
    await rm(dir, { recursive: true, force: true });
  });

  const controls = (extra: Record<string, string> = {}) => ({ REQUEST_SLEEP: '0', MAX_RETRIES: '1', TICKERS: '', ...extra });
  const readIndex = async () => JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));

  test('publishes the contract, skips funds and non-listed exchanges', async () => {
    const out = await run(controls());
    expect(out).toMatchObject({ updated: 2, skipped: 1, failed: 0 });
    const index = await readIndex();
    expect(index.companies.map((c: any) => c.ticker)).toEqual(['AAA', 'BBB']);
    const metrics = index.companies[0].metrics;
    for (const key of ['marketCap', 'pe', 'forwardPe', 'ps', 'forwardPs', 'pFcf', 'evEbitda', 'fcfToEbitda', 'dividendYield', 'roic', 'revenueGrowth', 'tr1y', 'perf1y']) expect(metrics).toHaveProperty(key);
    expect(metrics.forwardPs).toBe(2);
    expect(metrics.returnsBasis.length).toBeGreaterThan(10);
    expect(metrics.performanceAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await readdir(join(dir, 'companies', 'AAA', 'history'))).toContain('001.json');
  });

  test('a filtered one-ticker run never shrinks the index', async () => {
    await run(controls());
    const out = await run(controls({ TICKERS: 'AAA' }));
    expect(out.rows).toBe(2);
    expect((await readIndex()).companies).toHaveLength(2);
  });

  test('a market cap filter keeps the previously published row', async () => {
    await run(controls());
    const out = await run(controls({ MARKET_CAP: '10B:' }));
    expect(out.updated).toBe(0);
    expect((await readIndex()).companies).toHaveLength(2);
  });

  test('a rerun on identical upstream data writes nothing new', async () => {
    await run(controls());
    const before = await readFile(join(dir, 'index.json'), 'utf8');
    await new Promise((r) => setTimeout(r, 1100)); // generatedAt would move by a second
    await run(controls());
    expect(await readFile(join(dir, 'index.json'), 'utf8')).toBe(before);
  });

  test('concurrency is real: peak 1 at c=1, more at c=3', async () => {
    await run(controls({ CONCURRENCY: '1' }));
    expect(peak).toBe(1);
    await rm(dir, { recursive: true, force: true });
    peak = 0;
    await run(controls({ CONCURRENCY: '3' }));
    expect(peak).toBeGreaterThan(1);
  });

  test('SEC ticker table parsing normalizes dotted tickers', () => {
    const table = parseSecTickers({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[1067983, 'BERKSHIRE', 'BRK.B', 'NYSE'], [5, 'NOEX', 'ZZZ', null]] });
    expect(table.get('BRK-B')?.exchange).toBe('NYSE');
    expect(table.has('ZZZ')).toBe(false);
  });
});

describe('configuration parity: config file, README, --help and workflow', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const file = () => JSON.parse(read('scripts/update-data.config.json'));

  test('scheduled path (empty inputs and advanced) equals the config defaults', () => {
    const defaults = file();
    expect(resolveControls(defaults, JSON.parse('{}'), {}, {})).toEqual(Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, String(v)])));
  });

  test('resolver rejects unknown keys, invalid values, non-scalars and newline injection', () => {
    for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { SKIP_YAHOO: 'maybe' }, { MARKET_CAP: '1:2:3' }, { DIVIDEND_YIELD: '5:1' }, { PERFORMANCE_1Y: 'a:b' }, { TOTAL_RETURN_5Y: '9:1' }, { HISTORY_RANGE: 'x' }, { TICKERS: ['AAPL'] }, { TICKERS: { a: 1 } }, null, []]) {
      expect(() => resolveControls(value)).toThrow();
    }
    expect(() => resolveControls({}, {}, { TICKERS: 'A\nB' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { SEC_UA: 'x\0bad' })).toThrow();
    expect(() => resolveControls({}, 'not an object')).toThrow();
  });

  test('defaults: the watchlist, no filters, the standard SEC contact', () => {
    const config = readConfig(resolveControls(file()));
    expect(config.maxFetches).toBe(0);
    expect(config.maxRetries).toBeGreaterThanOrEqual(1);
    expect(config.historyRange).toBe('max');
    expect(config.skipYahoo).toBe(false);
    expect(config.tickers?.has('AAPL')).toBe(true);
    expect(config.tickers?.has('BRK-B')).toBe(true);
    expect(config.marketCap).toEqual({});
    expect(config.performance).toEqual({});
    expect(config.totalReturn).toEqual({});
    expect(file().SEC_UA).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(config.secUa).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(parseRanges({ PERFORMANCE_1Y: '10:', PERFORMANCE_5Y: ':' }, 'PERFORMANCE')).toEqual({ '1Y': { min: 10, max: undefined } });
  });

  test('runtimeControls reads the config file and lets env override it', async () => {
    expect((await runtimeControls({})).REQUEST_SLEEP).toBe('1');
    expect((await runtimeControls({ REQUEST_SLEEP: '0', TICKERS: 'AAPL MSFT' })).TICKERS).toBe('AAPL MSFT');
    expect((await runtimeControls({ TICKERS: '' })).TICKERS).toBe('');
  });

  test('config keys, CONTROL_NAMES, README and --help stay in sync', () => {
    expect(Object.keys(file()).sort()).toEqual([...CONTROL_NAMES].sort());
    for (const value of Object.values(file())) expect(typeof value).toBe('string');
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

  test('workflow: inputs, schedule, fixed output dir and no direct interpolation', () => {
    const yml = read('.github/workflows/update-data.yml');
    const block = yml.slice(yml.indexOf('    inputs:'), yml.indexOf('\npermissions:'));
    const names = [...block.matchAll(/^      (\w+):$/gm)].map((m) => m[1]);
    expect(names.length).toBeLessThanOrEqual(25);
    expect(names).toContain('advanced');
    expect(block).toMatch(/advanced:[\s\S]*default: '\{\}'/);
    for (const name of names.filter((n) => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as any);
    expect(names).not.toContain('sec_ua');
    expect(names).not.toContain('output_dir');
    expect(yml).toContain("cron: '0 0 * * 0'");
    expect(yml).not.toMatch(/^  push:/m);
    expect(yml).toContain('toJSON(inputs)');
    expect(yml).not.toMatch(/\$\{\{\s*inputs\./);
    expect(yml).toContain('resolveControls');
    expect(yml).toContain('vars.SEC_UA');
    expect(yml).toContain('timeout-minutes: 30');
    expect(yml).toContain('persist-credentials: false');
    expect(yml).toContain('git add api/stocks\n');
    expect(yml.match(/git add /g)?.length).toBe(1);
  });

  test('README structure and verification section', () => {
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

  test('USE_SYSTEM_CA control: auto/true/false, case-insensitive, strict, default auto', () => {
    expect(resolveControls(file()).USE_SYSTEM_CA).toBe('auto');
    for (const mode of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) expect(resolveControls(file(), {}, {}, { USE_SYSTEM_CA: mode }).USE_SYSTEM_CA).toBe(mode.toLowerCase());
    expect(() => resolveControls(file(), {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow('USE_SYSTEM_CA');
  });

  test('isCertError recognizes untrusted-certificate errors only', () => {
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(Object.assign(new Error('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET', message: 'socket hang up' })).toBe(false);
    expect(isCertError(null)).toBe(false);
  });

  test('installSystemCa wraps fetch only in auto mode and restarts once on cert errors', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    const reexec = () => { calls += 1; return undefined as never; };
    try {
      installSystemCa('false', reexec, false);
      expect(globalThis.fetch).toBe(original);
      installSystemCa('auto', reexec, true);
      expect(globalThis.fetch).toBe(original);
      globalThis.fetch = (async () => { throw Object.assign(new Error('fetch failed'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }); }) as typeof fetch;
      const failing = globalThis.fetch;
      installSystemCa('auto', reexec, false);
      expect(globalThis.fetch).not.toBe(failing);
      await globalThis.fetch('https://example.invalid/');
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

export type { AnnualRow };
