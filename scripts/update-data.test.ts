/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  annualSeries, buildAnnualRows, CONTROL_NAMES, dividendMetrics, fundamentalsMetrics, mergeAnnual, normalizeTicker, parseRange, parseSecTickers, priceReturns,
  readConfig, resolveControls, run, useApiRoot, valuationMetrics, type AnnualRow, type ChartDay, type Snapshot,
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

export type { AnnualRow };
