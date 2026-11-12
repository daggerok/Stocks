/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  Condition, createUniverse, etfRow, evaluateCondition, evaluateExpression, evaluatePreset, evaluatePresets, FAIL, intersections, PASS, percentiles,
  Preset, ScreenerRow, SKIP, stockRow, tickersOf, universeRows, validatePreset,
} from '.';
import { loadPresets } from './load-presets';

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

  test('peers use the passed groups; a ticker without a group is missing', () => {
    const peers = { cards: ['T0', 'T1', 'T2', 'T3', 'T4'], other: ['U0'] };
    expect(pick(SECTOR_ROWS, { metric: 'forwardPe', op: '<=', value: 25, scope: 'peers' }, peers)).toEqual(['T0', 'T1', 'T2']);
    expect(pick(SECTOR_ROWS, { metric: 'forwardPe', op: '<=', value: 25, scope: 'peers', missing: 'skip' }, peers)).toEqual(['T0', 'T1', 'T2', 'T5', 'U0', 'U1', 'U2', 'N']);
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
  test('the 11 base presets validate against the registry; a broken preset does not', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['cashflow-machines', 'cheap-earnings', 'dividend-growth', 'gold', 'growth-no-profit', 'high-debt', 'mine', 'quality-growth', 'stable-dividend', 'undervalued', 'volatile-swings']);
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
    expect(stockRow({ ticker: 'brk.b', sector: 'Financial Services', industry: '', metrics: { marketCap: 1e12, pe: 20 } }, ['BRK-B'])).toEqual({ ticker: 'BRK-B', type: 'stock', sector: 'Financial Services', industry: null, isMine: true, size: 1e12, metrics: { marketCap: 1e12, pe: 20 } });
    expect(etfRow({ ticker: 'GLD', aumValue: 9e10, metrics: { tr1y: 30 } })).toEqual({ ticker: 'GLD', type: 'etf', sector: null, industry: null, isMine: false, size: 9e10, metrics: { tr1y: 30 } });
    expect(etfRow({ ticker: 'X', isMine: true, aumValue: null })).toEqual({ ticker: 'X', type: 'etf', sector: null, industry: null, isMine: true, size: null, metrics: {} });
    const all = universeRows({ companies: [{ ticker: 'AAPL', metrics: {} }] }, [{ funds: [{ ticker: 'SPY' }] }, { funds: [{ ticker: 'SPY' }, { ticker: 'GLD' }] }], ['gld']);
    expect(all.map((r) => `${r.type}:${r.ticker}:${r.isMine}`)).toEqual(['stock:AAPL:false', 'etf:SPY:false', 'etf:GLD:true']);
    expect(PASS).toBe(1);
  });
});
