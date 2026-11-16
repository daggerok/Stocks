/// <reference types="bun" />
/// <reference types="node" />
/** Benchmark plan stage 2: the benchmark scope, the chip pickers, the ETF classes of the row adapter and the new ETF presets */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyEtf, Condition, createUniverse, etfClasses, EtfClassesFile, etfRow, evaluateCondition, evaluatePreset, FAIL, PASS, Preset, QdiFile, ScreenerRow, SKIP,
  stockRow, tickersOf, validatePreset, withPickers,
} from '.';
import { loadRawPresets } from './load-presets';

type Extra = { size?: number; industry?: string };
const row = (ticker: string, metrics: Record<string, unknown>, type: 'stock' | 'etf' = 'etf', extra: Extra = {}): ScreenerRow =>
  ({ ticker, type, sector: null, industry: extra.industry ?? null, isMine: false, size: extra.size ?? null, metrics });
const plain = (conditions: Condition[]): Preset => ({ schemaVersion: 1, id: 'p', title: { en: 'P', ru: 'П' }, appliesTo: ['stock', 'etf'], match: 'all', conditions });
const pick = (rows: ScreenerRow[], conditions: Condition[]) => { const u = createUniverse(rows); return tickersOf(u, evaluatePreset(u, plain(conditions)).pass); };
const yieldVs = (value: number, benchmark = 'SPY', extra: Partial<Condition> = {}): Condition => ({ metric: 'dividendYield', op: '>', value, scope: 'benchmark', benchmark, ...extra });

const RAW: Record<string, Preset> = {};
loadRawPresets().forEach((p) => { RAW[p.id] = p; });
const CLASSES = etfClasses(JSON.parse(readFileSync(join(__dirname, 'etf-classes.json'), 'utf8')) as EtfClassesFile, JSON.parse(readFileSync(join(__dirname, 'qdi.json'), 'utf8')) as QdiFile);
const cls = (ticker: string, name: string, category = '') => classifyEtf(CLASSES, ticker, name, category);

describe('benchmark scope', () => {
  const rows = [row('SPY', { dividendYield: 1.2 }), row('HDV', { dividendYield: 3.1 }), row('VUG', { dividendYield: 0.4 }), row('NEW', { dividendYield: null }), row('SPYM', { dividendYield: 1.25 })];

  test('the row value minus the benchmark value of the same metric, in the metric unit: a margin is the value', () => {
    expect(pick(rows, [yieldVs(0)])).toEqual(['HDV', 'SPYM']);
    expect(pick(rows, [yieldVs(1, 'SPY', { op: '>=' })])).toEqual(['HDV']);
    expect(pick(rows, [yieldVs(0, 'spym')])).toEqual(['HDV']); // the ticker is normalized
    expect(pick(rows, [{ metric: 'dividendYield', op: 'range', value: [-1, 0.1], scope: 'benchmark', benchmark: 'SPY' }])).toEqual(['SPY', 'VUG', 'SPYM']);
  });

  test('a benchmark that is not in the universe or has no value is unavailable: every row gets the missing outcome', () => {
    const u = createUniverse(rows);
    const absent = evaluateCondition(u, yieldVs(0, 'QQQ', { missing: 'skip' }));
    expect(absent.status).toBe('unavailable');
    expect(Array.from(absent.states)).toEqual([SKIP, SKIP, SKIP, SKIP, SKIP]);
    expect(evaluatePreset(u, plain([yieldVs(0, 'QQQ')])).unavailable).toEqual(['QQQ.dividendYield']);
    expect(evaluateCondition(u, yieldVs(0, 'NEW')).status).toBe('unavailable');
    expect(evaluateCondition(u, { metric: 'dividendYield', op: '>', value: 0, scope: 'benchmark' }).status).toBe('invalid'); // no ticker
  });

  test('a row without the value fails, or is skipped with missing skip', () => {
    const u = createUniverse(rows);
    expect(Array.from(evaluateCondition(u, yieldVs(0)).states)).toEqual([FAIL, PASS, FAIL, FAIL, PASS]);
    expect(Array.from(evaluateCondition(u, yieldVs(0, 'SPY', { missing: 'skip' })).states)).toEqual([FAIL, PASS, FAIL, SKIP, PASS]);
  });

  test('the benchmark compared with itself is 0, so SPY does not beat SPY', () => {
    expect(pick([row('SPY', { perf5y: 61.44 }), row('XLG', { perf5y: 68.74 }), row('HDV', { perf5y: 56.31 })], [{ metric: 'perf5y', op: '>', value: 0, scope: 'benchmark', benchmark: 'SPY' }])).toEqual(['XLG']);
  });

  test('an ETF row wins over a stock with the same ticker; validation of the scope', () => {
    const mixed = [row('GLD', { perf1y: 5 }, 'stock'), row('GLD', { perf1y: 40 }), row('A', { perf1y: 30 }, 'stock')];
    expect(pick(mixed, [{ metric: 'perf1y', op: '>', value: -20, scope: 'benchmark', benchmark: 'GLD' }])).toEqual(['GLD', 'A']);
    expect(validatePreset(plain([
      { metric: 'dividendYield', op: '>', value: 0, scope: 'benchmark', benchmark: 'spy' }, { metric: 'payFrequency', op: '=', value: 'monthly', scope: 'benchmark', benchmark: 'SPY' },
      { metric: 'pe', op: '>', value: 0, benchmark: 'SPY' }, { metric: 'pe', op: 'in', value: [1], scope: 'benchmark', benchmark: 'SPY' },
    ]))).toEqual([
      'p condition 1 (dividendYield): scope benchmark needs a ticker in benchmark',
      'p condition 2 (payFrequency): scope benchmark needs a numeric metric', 'p condition 2 (payFrequency): scope benchmark compares with >, >=, <, <= or range',
      'p condition 3 (pe): benchmark only goes with scope benchmark',
      'p condition 4 (pe): scope benchmark compares with >, >=, <, <= or range',
    ]);
  });
});

describe('pickers', () => {
  test('defaults: every picker takes its default option, the result is a plain preset with picked set', () => {
    const p = withPickers(RAW['beats-benchmark']);
    expect(p.pickers).toBeUndefined();
    expect(p.picked).toEqual({ benchmark: 'spy', horizon: '5y', return: 'total' });
    expect(p.conditions.map((c) => c.metric)).toEqual(['size', 'isGeared', 'vsSpy5y']);
    expect(validatePreset(p)).toEqual([]);
  });

  test('a chosen option per picker adds its vars and its conditions after the shared ones, in picker order', () => {
    const p = withPickers(RAW['beats-benchmark'], { benchmark: 'qqq', horizon: '10y', return: 'price' });
    expect(p.conditions.slice(2)).toEqual([
      { metric: 'vsQqq10y', op: '>', value: 0.25, scope: 'absolute', missing: 'fail' },
      { metric: 'perf10y', op: '>', value: 0, scope: 'benchmark', benchmark: 'QQQ', missing: 'fail' },
    ]);
    expect(withPickers(RAW['steady-income'], { horizon: '3y' }).conditions.map((c) => c.metric).slice(-2)).toEqual(['tr1y', 'tr3y']); // up on every horizon
  });

  test('tokens are replaced in metric, benchmark, a whole value and list items; a value keeps the type of its var', () => {
    expect(withPickers(RAW.pullback, { depth: 'deep' }).conditions[0].value).toEqual([-40, -20]);
    expect(withPickers(RAW['yield-above-benchmark'], { benchmark: 'qqq' }).conditions.map((c) => c.benchmark)).toEqual(['QQQ', 'QQQM']);
    const income = withPickers(RAW['high-income'], { yield: '10', horizon: 'si', risk: 'calm' });
    expect(income.conditions.filter((c) => ['dividendYield', 'perfSi', 'maxDrawdown1y'].indexOf(c.metric) >= 0).map((c) => [c.metric, c.value])).toEqual([['dividendYield', 10], ['perfSi', 0], ['maxDrawdown1y', -25]]);
  });

  test('an unknown or missing choice falls back to the default; a preset without pickers is returned as is', () => {
    expect(withPickers(RAW['etf-on-sale'], { horizon: '20y', benchmark: 'nope' }).picked).toEqual({ benchmark: 'spy', horizon: '10y' });
    expect(withPickers(RAW.gold)).toBe(RAW.gold);
  });

  test('validation: ids, default, var clashes, unknown tokens, variants and pickers together; every combination is checked', () => {
    const base = RAW['aum-floor'];
    const broken = { ...base, variants: [], match: 1, pickers: [{ ...base.pickers![0], default: '5b', options: base.pickers![0].options.concat([{ id: 'X', title: { en: 'X', ru: 'X' } }]) }] } as unknown as Preset;
    expect(validatePreset(broken)).toEqual([
      'aum-floor picker 1 (level) option 4 (X): id must be lowercase letters, digits and hyphens', 'aum-floor picker 1 (level): default 5b is not an option',
      'aum-floor: a preset has variants or pickers, never both', 'aum-floor: a preset with pickers needs match "all"',
    ]);
    const clash = { ...base, pickers: [base.pickers![0], { ...base.pickers![0], id: 'again' }] } as Preset;
    expect(validatePreset(clash)[0]).toBe('aum-floor picker 2 (again) option 1 (100m): var A is also set by picker level');
    expect(validatePreset({ ...base, conditions: [{ metric: 'size', op: '>=', value: '{Z}' }] } as Preset)).toEqual(['aum-floor [100m] condition 1 (size): unknown token {Z}']);
  });
});

describe('etf classes', () => {
  test('geared: leveraged and inverse names; ultra-short bond funds and the overrides are not', () => {
    const geared = [['SSO', 'ProShares Ultra S&P500'], ['SDS', 'ProShares UltraShort S&P500'], ['SH', 'ProShares Short S&P500'], ['SPXU', 'ProShares UltraPro Short S&P500'], ['UPRO', 'ProShares UltraPro S&P500'], ['TQQQ', 'ProShares UltraPro QQQ'], ['SQQQ', 'ProShares UltraPro Short QQQ'], ['PSQ', 'Short QQQ'], ['QLD', 'Ultra QQQ'], ['QID', 'UltraShort QQQ'], ['XSPI', 'Boosted S&P 500 High Income ETF'], ['XQQI', 'Boosted Nasdaq-100 High Income ETF'], ['SOXL', 'Direxion Daily Semiconductor Bull 3x Shares']];
    const not = [['JPST', 'JPMorgan Ultra-Short Income ETF'], ['ICSH', 'iShares Ultra Short Duration Bond Active ETF'], ['VUSB', 'Vanguard Ultra-Short Bond ETF'], ['VGSH', 'Vanguard Short-Term Treasury ETF'], ['SHM', 'SPDR Nuveen ICE Short Term Municipal Bond ETF'], ['RDIV', 'Invesco S&P Ultra Dividend Revenue ETF'], ['LVLN', 'SPDR S&P Leveraged Loan ETF']];
    expect(geared.filter(([t, n]) => !cls(t, n).isGeared)).toEqual([]);
    expect(not.filter(([t, n]) => cls(t, n).isGeared)).toEqual([]);
  });

  test('index family and variant (plan 5.1): by name or the ticker list, first matching variant, core otherwise', () => {
    const fam = (t: string, n: string) => { const c = cls(t, n); return `${c.indexFamily} ${c.indexVariant}`; };
    expect([fam('SPY', 'SPDR S&P 500 ETF Trust'), fam('IVV', 'iShares Core S&P 500 ETF'), fam('VOO', 'Vanguard 500 Index Fund'), fam('RSP', 'Invesco S&P 500 Equal Weight ETF'), fam('XLK', 'Technology Select Sector SPDR'),
      fam('SPMO', 'Invesco S&P 500 Momentum ETF'), fam('NOBL', 'ProShares S&P 500 Dividend Aristocrats ETF'), fam('XYLD', 'Global X S&P 500 Covered Call ETF'), fam('JEPI', 'JPMorgan Equity Premium Income ETF'),
      fam('PHDG', 'Invesco S&P 500 Downside Hedged ETF'), fam('SSO', 'ProShares Ultra S&P500'), fam('QQQ', 'Invesco QQQ Trust'), fam('QQEW', 'First Trust NASDAQ-100 Equal Weighted Index Fund'),
      fam('QYLD', 'Global X Nasdaq 100 Covered Call ETF'), fam('TQQQ', 'ProShares UltraPro QQQ'), fam('CATH', 'Global X S&P 500 Catholic Values ETF'), fam('SCHD', 'Schwab U.S. Dividend Equity ETF')])
      .toEqual(['sp500 core', 'sp500 core', 'sp500 core', 'sp500 equal-weight', 'sp500 sector', 'sp500 factor', 'sp500 dividend', 'sp500 income', 'sp500 income',
        'sp500 hedged', 'sp500 geared', 'nasdaq100 core', 'nasdaq100 equal-weight', 'nasdaq100 income', 'nasdaq100 geared', 'sp500 screened', 'null null']);
  });

  test('sector or theme as industry (plan 5.3): themes before sectors, bond, option-income and geared funds excluded, tickers override', () => {
    const ind = (t: string, n: string, c = 'Equity') => cls(t, n, c).industry;
    expect([ind('SOXX', 'iShares Semiconductor ETF'), ind('XLK', 'Technology Select Sector SPDR'), ind('FBCV', 'Fidelity Blue Chip Value ETF'), ind('GDX', 'VanEck Gold Miners ETF'), ind('XLU', 'Utilities Select Sector SPDR'),
      ind('ITM', 'VanEck Intermediate Muni ETF'), ind('DIA', 'SPDR Dow Jones Industrial Average ETF Trust'), ind('XLKI', 'Technology Covered Call ETF'), ind('ROM', 'ProShares Ultra Technology'),
      ind('DBE', 'Invesco DB Energy Fund', 'Commodity'), ind('PGF', 'Invesco Financial Preferred ETF'), ind('SPY', 'SPDR S&P 500 ETF Trust')])
      .toEqual(['semiconductors', 'technology', null, 'miners', 'utilities', null, null, null, null, null, null, null]);
    // the Sector picker of Best in sector offers exactly the classes of etf-classes.json
    expect(RAW['best-in-sector'].pickers![1].options.map((o) => o.id)).toEqual(['all'].concat(CLASSES.sectors.map((s) => s.id)));
  });

  test('qualified dividends (plan 6): the official table first, else the class estimate; option income is never estimated', () => {
    const q = (t: string, n: string, c = '') => { const r = cls(t, n, c); return [r.qualifiedDividendPct, r.qualifiedDividendBasis]; };
    expect([q('VYM', 'Vanguard High Dividend Yield ETF'), q('JEPI', 'JPMorgan Equity Premium Income ETF'), q('BND', 'Vanguard Total Bond Market ETF'), q('VXUS', 'Vanguard Total International Stock ETF'),
      q('SCHD', 'Schwab U.S. Dividend Equity ETF', 'U.S. Equities'), q('QYLD', 'Global X Nasdaq 100 Covered Call ETF', 'Equity / Income'), q('SCHO', 'Schwab Short-Term U.S. Treasury ETF', 'Fixed Income'),
      q('SCHH', 'Schwab U.S. REIT ETF', 'Real Estate'), q('SCHF', 'Schwab International Equity ETF', 'International Equities'), q('PFFD', 'Global X U.S. Preferred ETF'), q('DIV', 'Global X SuperDividend U.S. ETF', 'Equity / Income')])
      .toEqual([[100, 'official'], [15.86, 'official'], [0, 'official'], [58.5, 'official'], [95, 'estimated'], [null, null], [0, 'estimated'], [5, 'estimated'], [60, 'estimated'], [60, 'estimated'], [95, 'estimated']]);
    expect(cls('VYM', 'Vanguard High Dividend Yield ETF').qualifiedDividendYear).toBe(2025);
  });

  test('etfRow with the classes fills the metrics and the industry; without them it adds only the expense ratios', () => {
    const fund = { ticker: 'XLE', name: 'Energy Select Sector SPDR Fund', category: 'Equity', aumValue: 4e10, terValue: 0.08, metrics: { tr1y: 5 } };
    expect(etfRow(fund, null, CLASSES)).toEqual({ ticker: 'XLE', type: 'etf', sector: 'Equity', industry: 'energy', isMine: false, size: 4e10, metrics: {
      tr1y: 5, expenseRatio: 0.08, expenseRatioGross: null, isGeared: false, indexFamily: 'sp500', indexVariant: 'sector', qualifiedDividendPct: 100, qualifiedDividendYear: 2025, qualifiedDividendBasis: 'official',
    } });
    expect(etfRow(fund).industry).toBeNull();
  });
});

describe('benchmark presets', () => {
  const run = (rows: ScreenerRow[], p: Preset) => { const u = createUniverse(rows); return tickersOf(u, evaluatePreset(u, p).pass); };
  const big = { size: 5e10 };
  const floor = { isGeared: false };

  test('Beats the benchmark (section 8 values): trackers fail on the margin, Total and price drops funds that beat only with dividends', () => {
    const rows = [row('SPY', { ...floor, vsSpy5y: 0, perf5y: 61.44 }, 'etf', big), row('IVV', { ...floor, vsSpy5y: 0.07, perf5y: 61.49 }, 'etf', big), row('XLG', { ...floor, vsSpy5y: 0.51, perf5y: 68.74 }, 'etf', big),
      row('HDV', { ...floor, vsSpy5y: 1.81, perf5y: 56.31 }, 'etf', big), row('TINY', { ...floor, vsSpy5y: 9 }, 'etf', { size: 5e7 }), row('SSO', { isGeared: true, vsSpy5y: 9 }, 'etf', big)];
    expect(run(rows, withPickers(RAW['beats-benchmark']))).toEqual(['XLG', 'HDV']);
    expect(run(rows, withPickers(RAW['beats-benchmark'], { return: 'price' }))).toEqual(['XLG']);
  });

  test('ETF on sale: 10% under the 52-week high, CAGR 10 or more, not behind the benchmark, drawdown above -35, $1B; 10Y falls back to 5Y for younger funds', () => {
    const good = { ...floor, pctFrom52wHigh: -15, cagr5y: 14, cagr10y: 13, vsSpy5y: 1, vsSpy10y: 0.5, maxDrawdown5y: -30, maxDrawdown10y: -33 };
    const rows = [row('SMH', good, 'etf', big), row('YOUNG', { ...good, cagr10y: null, vsSpy10y: null, maxDrawdown10y: null }, 'etf', big), row('HIGH', { ...good, pctFrom52wHigh: -3 }, 'etf', big),
      row('SLOW10', { ...good, cagr10y: 8 }, 'etf', big), row('DEEP', { ...good, maxDrawdown10y: -50 }, 'etf', big), row('SMALL', good, 'etf', { size: 5e8 }), row('BABY', { ...good, cagr5y: null }, 'etf', big)];
    expect(run(rows, withPickers(RAW['etf-on-sale']))).toEqual(['SMH', 'YOUNG']);
    expect(run(rows, withPickers(RAW['etf-on-sale'], { horizon: '5y' }))).toEqual(['SMH', 'YOUNG', 'SLOW10', 'DEEP']);
  });

  test('Rotation: lagging now reads the stress return against the benchmark row (GLD passes, a fund moving with SPY does not)', () => {
    const rows = [row('SPY', { ...floor, stressReturnSpy: -18.76 }, 'etf', big), row('GLD', { ...floor, relStrength3mSpy: -9.97, pctFrom52wHigh: -8, corr1ySpy: 0.36, stressReturnSpy: 1.61, downCapture3ySpy: 33.05, tr5y: 103 }, 'etf', big),
      row('SPMO', { ...floor, relStrength3mSpy: -12.36, pctFrom52wHigh: -9, corr1ySpy: 0.8, stressReturnSpy: -19.66, tr5y: 101 }, 'etf', big)];
    expect(run(rows, withPickers(RAW['rotation-dip']))).toEqual(['GLD']);
  });

  test('High income, no erosion: the price over the horizon, risk Calm adds volatility and drawdown', () => {
    const rows = [row('JEPQ', { ...floor, dividendYield: 12.4, perf3y: 15.81, tr1y: 10, tr3y: 40, volatility1y: 16, maxDrawdown3y: -20 }, 'etf', big), row('QYLD', { ...floor, dividendYield: 12, perf3y: 3.99, tr1y: 9, tr3y: 30, volatility1y: 22, maxDrawdown3y: -24 }, 'etf', big),
      row('BIZD', { ...floor, dividendYield: 12.5, perf3y: -19.92, tr1y: 2, tr3y: 10 }, 'etf', big)];
    expect(run(rows, withPickers(RAW['high-income']))).toEqual(['JEPQ', 'QYLD']);
    expect(run(rows, withPickers(RAW['high-income'], { risk: 'calm' }))).toEqual(['JEPQ']);
  });

  test('Monthly payments applies to stocks and ETFs: payFrequency monthly', () => {
    const rows = [stockRow({ ticker: 'O', metrics: { payFrequency: 'monthly' } }), stockRow({ ticker: 'KO', metrics: { payFrequency: 'quarterly' } }), row('JEPI', { payFrequency: 'monthly' }), row('GLD', { payFrequency: null })];
    expect(run(rows, RAW['monthly-pay'])).toEqual(['O', 'JEPI']);
  });
});
