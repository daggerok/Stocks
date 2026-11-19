/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  Condition, createUniverse, etfRow, evaluateCondition, evaluateExpression, evaluatePreset, evaluatePresets, FAIL, intersections, PASS, percentiles,
  Preset, ScreenerRow, SKIP, stockRow, storeRows, tickersOf, validatePreset,
} from '.';
import { loadPresets, loadRawPresets } from './load-presets';
import { pickVariant, withVariant } from './variants';

type Extra = { sector?: string; industry?: string; isMine?: boolean; size?: number };
const row = (ticker: string, metrics: Record<string, unknown>, extra: Extra = {}, type: 'stock' | 'etf' = 'stock'): ScreenerRow =>
  ({ ticker, type, sector: extra.sector ?? null, industry: extra.industry ?? null, isMine: !!extra.isMine, size: extra.size ?? null, metrics });
const preset = (conditions: Condition[], match: Preset['match'] = 'all', appliesTo: Preset['appliesTo'] = ['stock', 'etf']): Preset =>
  ({ schemaVersion: 1, id: 'p', title: { en: 'P', ru: 'П' }, appliesTo, match, conditions });
const pick = (rows: ScreenerRow[], c: Condition, peers?: Record<string, string[]>) => {
  const u = createUniverse(rows, { peers });
  return tickersOf(u, evaluatePreset(u, preset([c])).pass);
};

const PE = [row('A', { pe: 5 }), row('B', { pe: 10 }), row('C', { pe: 15 }), row('D', { pe: null }), row('E', { pe: -3 }), row('F', {})];

describe('operators', () => {
  test('>, >=, <, <= and = on numbers, null never read as 0, negatives compared as numbers', () => {
    expect(pick(PE, { metric: 'pe', op: '>', value: 10 })).toEqual(['C']);
    expect(pick(PE, { metric: 'pe', op: '>=', value: 10 })).toEqual(['B', 'C']);
    expect(pick(PE, { metric: 'pe', op: '<', value: 10 })).toEqual(['A', 'E']);
    expect(pick(PE, { metric: 'pe', op: '<=', value: 5 })).toEqual(['A', 'E']);
    expect(pick(PE, { metric: 'pe', op: '=', value: 10 })).toEqual(['B']);
  });

  test('range with closed and open bounds, in and = on categories and flags', () => {
    expect(pick(PE, { metric: 'pe', op: 'range', value: [5, 10] })).toEqual(['A', 'B']);
    expect(pick(PE, { metric: 'pe', op: 'range', value: [null, 0] })).toEqual(['E']);
    expect(pick(PE, { metric: 'pe', op: 'range', value: [12, null] })).toEqual(['C']);
    const rows = [row('GOLD', {}, { industry: 'Gold', isMine: true }), row('NEM', {}, { industry: 'gold' }), row('AAPL', {}, { industry: 'Consumer Electronics', sector: 'Technology' })];
    expect(pick(rows, { metric: 'industry', op: 'in', value: ['Gold', 'Silver'] })).toEqual(['GOLD', 'NEM']);
    expect(pick(rows, { metric: 'sector', op: '=', value: 'technology' })).toEqual(['AAPL']);
    expect(pick(rows, { metric: 'isMine', op: '=', value: true })).toEqual(['GOLD']);
    expect(pick(rows, { metric: 'ticker', op: 'in', value: ['nem', 'XYZ'] })).toEqual(['NEM']);
  });
});

const SECTOR_ROWS = [
  ...[1, 2, 2, 3, 4, 5].map((v, i) => row(`T${i}`, { forwardPe: v }, { sector: 'Tech', industry: 'Software' })),
  ...[10, 20, 30].map((v, i) => row(`U${i}`, { forwardPe: v }, { sector: 'Utilities', industry: 'Utilities' })),
  row('N', { forwardPe: null }, { sector: 'Tech', industry: 'Software' }),
];

describe('scopes', () => {
  test('market percentile is the share of rows with a value that is strictly lower; ties share it', () => {
    const u = createUniverse(SECTOR_ROWS);
    const pct = Array.from(percentiles(u, 'forwardPe', 'market')).map((v) => (isNaN(v) ? null : Math.round(v * 100) / 100));
    expect(pct).toEqual([0, 11.11, 11.11, 33.33, 44.44, 55.56, 66.67, 77.78, 88.89, null]);
    expect(pick(SECTOR_ROWS, { metric: 'forwardPe', op: '<=', value: 40, scope: 'market' })).toEqual(['T0', 'T1', 'T2', 'T3']);
  });

  test('sector and industry percentiles; a group under 5 values behaves as missing (fail or skip)', () => {
    expect(pick(SECTOR_ROWS, { metric: 'forwardPe', op: '<', value: 50, scope: 'sector' })).toEqual(['T0', 'T1', 'T2']);
    expect(pick(SECTOR_ROWS, { metric: 'forwardPe', op: '>=', value: 80, scope: 'industry' })).toEqual(['T5']);
    expect(pick(SECTOR_ROWS, { metric: 'forwardPe', op: '<', value: 50, scope: 'sector', missing: 'skip' })).toEqual(['T0', 'T1', 'T2', 'U0', 'U1', 'U2', 'N']);
  });

  test('an ETF sector is its category, ranked only among ETFs of that category (owner answer N4)', () => {
    // five Equity ETFs rank among themselves; the stock sector named Equity does not join them; a category under 5 values is missing
    const rows = [
      ...[1, 2, 3, 4, 5].map((v, i) => row(`E${i}`, { tr1y: v }, { sector: 'Equity' }, 'etf')),
      ...[100, 200, 300, 400, 500].map((v, i) => row(`S${i}`, { tr1y: v }, { sector: 'Equity' })),
      row('B0', { tr1y: 50 }, { sector: 'Fixed Income' }, 'etf'),
    ];
    expect(pick(rows, { metric: 'tr1y', op: '>=', value: 60, scope: 'sector' })).toEqual(['E3', 'E4', 'S3', 'S4']);
    expect(pick(rows, { metric: 'tr1y', op: '>=', value: 0, scope: 'sector', missing: 'fail' })).not.toContain('B0');
  });

  test('peers use the passed groups; a ticker without a group falls back to its industry', () => {
    const peers = { cards: ['T0', 'T1', 'T2', 'T3', 'T4'], other: ['U0'] };
    // T5 has no group: its industry Software (6 values) puts it at P83, so it fails <= 25 even with skip; U1 and U2 fall back to
    // Utilities, a group of 3, and behave as missing like U0 in its group of 1
    expect(pick(SECTOR_ROWS, { metric: 'forwardPe', op: '<=', value: 25, scope: 'peers' }, peers)).toEqual(['T0', 'T1', 'T2']);
    expect(pick(SECTOR_ROWS, { metric: 'forwardPe', op: '<=', value: 25, scope: 'peers', missing: 'skip' }, peers)).toEqual(['T0', 'T1', 'T2', 'U0', 'U1', 'U2', 'N']);
    expect(pick(SECTOR_ROWS, { metric: 'forwardPe', op: '<=', value: 90, scope: 'peers' }, peers)).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5']);
    // without any peer groups every ticker is compared with its industry
    expect(pick(SECTOR_ROWS, { metric: 'forwardPe', op: '>=', value: 80, scope: 'peers' })).toEqual(['T5']);
  });

  test('history reads only the own-history metrics; another metric is invalid, an absent one unavailable', () => {
    const rows = [row('A', { pePct5y: 20, pe: 5 }), row('B', { pePct5y: 80, pe: 9 }), row('C', { pePct5y: null })];
    expect(pick(rows, { metric: 'pePct5y', op: '<=', value: 50, scope: 'history' })).toEqual(['A']);
    const u = createUniverse(rows);
    expect(evaluateCondition(u, { metric: 'pe', op: '<', value: 50, scope: 'history' }).status).toBe('invalid');
    const absent = evaluateCondition(u, { metric: 'pFcfPct5y', op: '<', value: 50, scope: 'history', missing: 'skip' });
    expect(absent.status).toBe('unavailable');
    expect(Array.from(absent.states)).toEqual([SKIP, SKIP, SKIP]);
  });
});

describe('missing and soft mode', () => {
  test('missing fail and skip; a metric that does not apply to the row type is skipped; a row of another type fails', () => {
    const rows = [row('S', { quickRatio: 0.5, range52w: 10 }), row('E', { range52w: 10 }, {}, 'etf'), row('X', { quickRatio: null, range52w: 10 })];
    const u = createUniverse(rows);
    expect(Array.from(evaluateCondition(u, { metric: 'quickRatio', op: '>=', value: 1 }).states)).toEqual([FAIL, SKIP, FAIL]);
    expect(Array.from(evaluateCondition(u, { metric: 'quickRatio', op: '>=', value: 1, missing: 'skip' }).states)).toEqual([FAIL, SKIP, SKIP]);
    expect(tickersOf(u, evaluatePreset(u, preset([{ metric: 'range52w', op: '<=', value: 25 }, { metric: 'quickRatio', op: '<', value: 1 }])).pass)).toEqual(['S', 'E']);
    expect(tickersOf(u, evaluatePreset(u, preset([{ metric: 'range52w', op: '<=', value: 25 }], 'all', ['stock'])).pass)).toEqual(['S', 'X']);
  });

  test('soft mode N of M and the funnel', () => {
    const u = createUniverse([row('A', { roic: 1, beta: 1, pe: 1 }), row('B', { roic: 1, beta: 0, pe: 0 }), row('C', { roic: 0, beta: 1, pe: null }), row('D', { roic: 0, beta: 0, pe: 0 })]);
    const three: Condition[] = [{ metric: 'roic', op: '>', value: 0 }, { metric: 'beta', op: '>', value: 0 }, { metric: 'pe', op: '>', value: 0 }];
    const all = evaluatePreset(u, preset(three));
    expect(tickersOf(u, all.pass)).toEqual(['A']);
    expect(all.funnel.map((s) => s.left)).toEqual([2, 1, 1]);
    const two = evaluatePreset(u, preset(three, 2));
    expect(tickersOf(u, two.pass)).toEqual(['A']);
    expect(two.funnel.map((s) => s.left)).toEqual([4, 3, 1]);
    const one = evaluatePreset(u, preset(three, 1));
    expect(tickersOf(u, one.pass)).toEqual(['A', 'B', 'C']);
    expect(one.funnel[one.funnel.length - 1].left).toBe(one.count);
  });

  test('a disabled condition is ignored and an unavailable metric follows missing', () => {
    const u = createUniverse([row('A', { roic: 20 }), row('B', { roic: 5 })]);
    const p = preset([{ metric: 'roic', op: '>', value: 10 }, { metric: 'peg', op: '<=', value: 1, missing: 'skip' }, { metric: 'roic', op: '>', value: 100, enabled: false }]);
    const r = evaluatePreset(u, p);
    expect(tickersOf(u, r.pass)).toEqual(['A']);
    expect(r.unavailable).toEqual(['peg']);
    expect(r.funnel.length).toBe(2);
    expect(evaluatePreset(u, preset([{ metric: 'peg', op: '<=', value: 1 }])).count).toBe(0);
  });
});

const PRESETS = loadPresets();
const BY_ID: Record<string, Preset> = {};
PRESETS.forEach((p) => { BY_ID[p.id] = p; });

describe('presets', () => {
  test('the 32 base presets (eleven of them refinements) validate against the registry; a broken preset does not', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['aum-floor', 'beats-benchmark', 'best-in-sector', 'cashflow-machines', 'cheap-earnings', 'dividend-growth', 'etf-on-sale', 'gold', 'growth-no-profit', 'high-debt', 'high-income', 'index-family', 'low-cost', 'mine', 'monthly-grower', 'monthly-pay', 'no-dilution', 'pays-dividend', 'positive-1y', 'price-growth', 'pullback', 'qualified-dividends', 'quality-growth', 'quality-on-sale', 'rising-dividend', 'rotation-dip', 'stable-dividend', 'stable-growth', 'steady-income', 'undervalued', 'volatile-swings', 'yield-above-benchmark']);
    expect(PRESETS.filter((p) => p.refine).map((p) => p.id)).toEqual(['aum-floor', 'index-family', 'low-cost', 'monthly-pay', 'no-dilution', 'pays-dividend', 'positive-1y', 'pullback', 'qualified-dividends', 'rising-dividend', 'yield-above-benchmark']);
    expect(validatePreset({ ...BY_ID['pays-dividend'], refine: 'yes' } as unknown as Preset)).toEqual(['pays-dividend: refine must be true or false']);
    expect(PRESETS.flatMap((p) => validatePreset(p))).toEqual([]);
    const broken = preset([
      { metric: 'nope', op: '>', value: 1 }, { metric: 'pe', op: 'range', value: [10, 5] }, { metric: 'pe', op: '<', value: 120, scope: 'market' },
      { metric: 'pe', op: '<', value: 1, scope: 'history' }, { metric: 'industry', op: '>', value: 1 }, { metric: 'isMine', op: '=', value: 'yes' },
    ], 7);
    expect(validatePreset(broken)).toEqual([
      'p: match must be "all" or a whole number from 1 to the number of conditions',
      'p condition 1 (nope): unknown metric nope',
      'p condition 2 (pe): range min is above max',
      'p condition 3 (pe): a percentile is 0-100',
      'p condition 4 (pe): scope history only reads pePct5y, pFcfPct5y, yieldVsAvg5y',
      'p condition 5 (industry): > needs a numeric metric',
      'p condition 6 (isMine): a flag compares with true or false',
    ]);
  });

  test('quality on sale: strong scores after a 15% drop, large caps only, no rejected status (owner answer N19)', () => {
    const ok = { scoreQuality: 66, scoreSafety: 62, pctFrom52wHigh: -34, marketCap: 3.9e12, status: 'buy' };
    const u = createUniverse([
      row('NVDA', ok),
      row('META', { ...ok, pctFrom52wHigh: -19, status: 'watch' }),
      row('FLAT', { ...ok, pctFrom52wHigh: -10 }),
      row('WEAK', { ...ok, scoreQuality: 40 }),
      row('RISKY', { ...ok, scoreSafety: 50 }),
      row('SMALL', { ...ok, marketCap: 5e9 }),
      row('STOP', { ...ok, status: 'rejected' }),
      row('NONE', { ...ok, scoreQuality: null }),
      row('QQQ', ok, {}, 'etf'),
    ]);
    expect(tickersOf(u, evaluatePreset(u, BY_ID['quality-on-sale']).pass)).toEqual(['NVDA', 'META']);
  });

  test('stable growth: a horizon variant adds its conditions; growing on every horizon up to it, 5% a year, calm price (owner 2026-11-14)', () => {
    const raw = loadRawPresets().filter((p) => p.id === 'stable-growth')[0];
    expect(validatePreset(raw)).toEqual([]);
    expect(raw.variants!.map((v) => v.id)).toEqual(['1y', '3y', '5y', '10y']);
    expect(BY_ID['stable-growth'].variant).toBe('5y'); // loadPresets resolves the default
    expect(BY_ID['stable-growth'].variants).toBeUndefined();
    expect(pickVariant(raw, 'nope')!.id).toBe('5y');
    const good = { volatility1y: 20, tr1y: 8, tr3y: 30, tr5y: 50, tr10y: 120, cagr3y: 9, cagr5y: 8.4, cagr10y: 8.2 };
    const u = createUniverse([
      row('KO', good),
      row('YOUNG', { ...good, tr10y: null, cagr10y: null }, {}, 'etf'),
      row('DIP3', { ...good, tr3y: -2 }),
      row('SLOW', { ...good, cagr5y: 3, cagr3y: 3 }),
      row('WILD', { ...good, volatility1y: 60 }),
      row('HOT1', { volatility1y: 30, tr1y: 12 }),
    ]);
    const pass = (h: string) => tickersOf(u, evaluatePreset(u, withVariant(raw, h)).pass);
    expect([pass('1y'), pass('3y'), pass('5y'), pass('10y')]).toEqual([
      ['KO', 'YOUNG', 'DIP3', 'SLOW', 'HOT1'], ['KO', 'YOUNG'], ['KO', 'YOUNG'], ['KO', 'SLOW'],
    ]); // the pace reads the CAGR of the chosen horizon only: SLOW grew 3% a year over 3 and 5 years but 8.2% over 10
    expect(withVariant(raw, '10y').conditions.map((c) => c.metric)).toEqual(['volatility1y', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr10y']);
    const broken = { ...raw, defaultVariant: '20y', match: 1, variants: [raw.variants![0], { ...raw.variants![0], conditions: [] }] } as Preset;
    expect(validatePreset(broken)).toEqual([
      'stable-growth variant 2 (1y): duplicate variant id', 'stable-growth variant 2 (1y): no conditions',
      'stable-growth: defaultVariant 20y is not a variant', 'stable-growth: a preset with variants needs match "all"',
    ]);
  });

  test('rising dividend: grown over 5 years and never cut in 10, for stocks and ETFs alike', () => {
    const u = createUniverse([row('KO', { dividendGrowth5y: 4, dividendCut10y: false }), row('CUT', { dividendGrowth5y: 4, dividendCut10y: true }), row('FLAT', { dividendGrowth5y: 0, dividendCut10y: false }), row('VIG', { dividendYield: 2, dividendGrowth5y: 9, dividendCut10y: false }, {}, 'etf'), row('TLT', { dividendYield: 4, dividendGrowth5y: 10, dividendCut10y: true }, {}, 'etf'), row('JEPI', { dividendYield: 8, dividendGrowth5y: null, dividendCut10y: false }, {}, 'etf')]);
    expect(tickersOf(u, evaluatePreset(u, BY_ID['rising-dividend']).pass)).toEqual(['KO', 'VIG']);
  });

  test('gold: a miner by industry or an ETF by ticker; mine: the isMine flag', () => {
    const rows = [row('NEM', {}, { industry: 'Gold' }), row('AAPL', {}, { industry: 'Consumer Electronics', isMine: true }), row('GLD', {}, {}, 'etf'), row('SPY', {}, { isMine: true }, 'etf')];
    const u = createUniverse(rows);
    expect(tickersOf(u, evaluatePreset(u, BY_ID.gold).pass)).toEqual(['NEM', 'GLD']);
    expect(tickersOf(u, evaluatePreset(u, BY_ID.mine).pass)).toEqual(['AAPL', 'SPY']);
  });

  test('stock presets skip ETFs; metrics not in the feed are reported as unavailable', () => {
    const rows = [row('KO', { dividendYield: 3, dividendGrowth5y: 5, fcfPayout: 70, netDebtToEbitda: 2.5, roic: 10, beta: 0.6 }), row('VIG', { dividendYield: 3 }, {}, 'etf'), row('T', { dividendYield: 6, dividendGrowth5y: 0, fcfPayout: null, netDebtToEbitda: 3, roic: 5, beta: 0.5 })];
    const u = createUniverse(rows);
    const all = evaluatePresets(u, PRESETS);
    expect(tickersOf(u, all['stable-dividend'].pass)).toEqual(['KO']);
    expect(all['stable-dividend'].start).toBe(2);
    expect(all['volatile-swings'].unavailable).toEqual(['volatility1y', 'quickRatio', 'pctFromAth', 'range52w']);
    expect(all.undervalued.unavailable).toContain('peg');
    expect(all['cheap-earnings'].count).toBe(0);
  });

  test('Up over 1 year reads the total return tr1y of stocks and ETFs; Undervalued needs 5-year NI and FCF growth above 0', () => {
    // owner answer N2: a stock with a price loss but a positive total return passes, an ETF without tr1y fails
    const u = createUniverse([row('KO', { tr1y: 2, perf1y: -1 }), row('T', { tr1y: -3, perf1y: 1 }), row('SPY', { tr1y: 14 }, {}, 'etf'), row('GLD', { perf1y: 5 }, {}, 'etf')]);
    expect(tickersOf(u, evaluatePreset(u, BY_ID['positive-1y']).pass)).toEqual(['KO', 'SPY']);
    // owner answer N3: the shipped thresholds plus niGrowth5y > 0 and fcfGrowth5y > 0
    const good = { peg: 0.8, forwardToTtmPe: 0.9, pePct5y: 30, roic: 15, operatingMarginSlope3y: 1, niGrowth5y: 8, fcfGrowth5y: 6, niVolatility5y: 25, fcfVolatility5y: 30, cfoToNi: 1.1, debtToEquity: 0.5 };
    const v = createUniverse([row('A', good), row('B', { ...good, niGrowth5y: 0 }), row('C', { ...good, fcfGrowth5y: -2 }), row('D', { ...good, fcfGrowth5y: null }), row('E', { ...good, niVolatility5y: 26 })]);
    expect(tickersOf(v, evaluatePreset(v, BY_ID.undervalued).pass)).toEqual(['A']);
    expect(BY_ID.undervalued.conditions.filter((c) => /Volatility5y$/.test(c.metric)).map((c) => [c.metric, c.value])).toEqual([['niVolatility5y', 25], ['fcfVolatility5y', 30]]);
  });
});

describe('expressions and intersections', () => {
  const rows = [row('A', { debtToEquity: 3, fcfMargin: 25 }, { isMine: true }), row('B', { debtToEquity: 0.5, fcfMargin: 25 }), row('C', { debtToEquity: 0.2 }, { isMine: true })];
  const presets: Record<string, Preset> = { mine: BY_ID.mine, debt: BY_ID['high-debt'], fcf: { ...preset([{ metric: 'fcfMargin', op: '>=', value: 20 }]), id: 'fcf' } };

  test('and, or, not over preset ids; an unknown id throws', () => {
    const u = createUniverse(rows);
    expect(tickersOf(u, evaluateExpression(u, { and: ['fcf', { not: 'debt' }] }, presets))).toEqual(['B']);
    expect(tickersOf(u, evaluateExpression(u, { or: ['debt', 'mine'] }, presets))).toEqual(['A', 'C']);
    expect(tickersOf(u, evaluateExpression(u, { not: { or: ['fcf', 'mine'] } }, presets))).toEqual([]);
    expect(() => evaluateExpression(u, { and: ['fcf', 'nope'] }, presets)).toThrow('unknown preset in expression: nope');
  });

  test('intersections count rows matching both presets', () => {
    const u = createUniverse(rows);
    const r = evaluatePresets(u, [presets.mine, presets.debt, presets.fcf]);
    expect(intersections([r.mine, r['high-debt'], r.fcf])).toEqual({ ids: ['mine', 'high-debt', 'fcf'], counts: [[2, 1, 1], [1, 1, 1], [1, 1, 2]] });
  });
});

describe('rows', () => {
  test('stock and ETF rows: size from marketCap or aumValue, isMine from the row flag or the owner list, no metrics -> empty', () => {
    expect(stockRow({ ticker: 'brk.b', sector: 'Financial Services', industry: '', metrics: { marketCap: 1e12, pe: 20 } }, ['BRK-B'])).toEqual({ ticker: 'BRK-B', type: 'stock', sector: 'Financial Services', industry: null, isMine: true, size: 1e12, metrics: { marketCap: 1e12, pe: 20, isReit: false, businessType: 'regular', dilutionOkStrict: null, dilutionOkPerShare: null, dilutionOkSector: null } });
    expect(stockRow({ ticker: 'O', industry: 'REIT - Retail', metrics: {} }).metrics.isReit).toBe(true); // owner answer N22
    expect(stockRow({ ticker: 'X', industry: 'Real Estate Services', metrics: {} }).metrics.isReit).toBe(false);
    // metrics as published: no tr1y stands in for perf1y (owner answer N2); the fund category is the ETF sector (owner answer N4)
    // expenseRatio and expenseRatioGross come from the row fields terValue and terGrossValue (benchmark plan 5.2)
    expect(etfRow({ ticker: 'GLD', aumValue: 9e10, category: 'Commodity', terValue: 0.4, metrics: { tr1y: 30 } })).toEqual({ ticker: 'GLD', type: 'etf', sector: 'Commodity', industry: null, isMine: false, size: 9e10, metrics: { tr1y: 30, expenseRatio: 0.4, expenseRatioGross: null } });
    expect(etfRow({ ticker: 'IAU', category: ' ', metrics: { tr1y: 30, perf1y: 28 } })).toMatchObject({ sector: null, metrics: { tr1y: 30, perf1y: 28 } });
    expect(etfRow({ ticker: 'IAU', metrics: { tr1y: null } }).metrics).toEqual({ tr1y: null, expenseRatio: null, expenseRatioGross: null });
    expect(etfRow({ ticker: 'brk.b' }, new Set(['BRK-B'])).isMine).toBe(true);
    expect(etfRow({ ticker: 'X', isMine: true, aumValue: null })).toEqual({ ticker: 'X', type: 'etf', sector: null, industry: null, isMine: true, size: null, metrics: { expenseRatio: null, expenseRatioGross: null } });
    // the Stocks store: stock rows only, the first row of a ticker wins
    const rows = storeRows([{ ticker: 'AAPL', metrics: {} }, { ticker: 'MSFT' }, { ticker: 'AAPL', name: 'again' }, { ticker: '' }], new Set(['MSFT']));
    expect(rows.map((r) => `${r.type}:${r.ticker}:${r.isMine}`)).toEqual(['stock:AAPL:false', 'stock:MSFT:true']);
    expect(PASS).toBe(1);
  });
});
