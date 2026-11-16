/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { createUniverse, evaluatePreset, evaluatePresets } from '../screener/engine';
import { PRESET_SCHEMA_VERSION, type Condition, type Preset, type ScreenerRow } from '../screener/types';
import { applyScoresSnapshot, buildScoresSnapshot, canonicalJson, computeScoring, etfScoresKey, fnv1a, SCORES_SCHEMA_VERSION, SCORING_FORMULA_VERSION, parseScoresSnapshot, presetHash, type ScoringConfig, scoresText, snapshotPresetResult, stocksScoresKey, withScoreMetrics } from '.';

type M = Record<string, unknown>;
const T = (en: string) => ({ en, ru: en });
const c = (metric: string, op: Condition['op'], value: Condition['value'], scope: Condition['scope'] = 'absolute'): Condition => ({ metric, op, value, scope, missing: 'fail' });
const stock = (ticker: string, metrics: M, sector = 'Technology'): ScreenerRow => ({ ticker, type: 'stock', sector, industry: 'Software', isMine: false, size: 1e10, metrics });
const etf = (ticker: string, metrics: M, category = 'Large Blend'): ScreenerRow => ({ ticker, type: 'etf', sector: category, industry: null, isMine: false, size: 1e9, metrics });

const CONFIG: ScoringConfig = {
  schemaVersion: 1, minGroupSize: 3, minWeightShare: 0.5, colors: { good: 70, bad: 40 }, whyLimit: 4, defaultArchetype: 'stable',
  archetypes: {
    stable: { title: T('Stable'), scoreWeights: { cheap: 1, quality: 1, safety: 0, dividend: 1, entry: 1 }, buy: 55, reject: 40, stopFactors: ['negative-fcf'] },
    volatile: { title: T('Volatile'), scoreWeights: { cheap: 0, quality: 0, safety: 0, dividend: 0, entry: 1 }, buy: 70, reject: 40, stopFactors: [] },
  },
  archetypeRules: [{ id: 'volatile', archetype: 'volatile', title: T('volatile'), appliesTo: ['stock', 'etf'], match: 'all', conditions: [c('volatility1y', '>=', 45)] }],
  scores: {
    cheap: { title: T('Cheap'), appliesTo: ['stock'], items: [{ metric: 'pe', weight: 1 }] },
    quality: { title: T('Quality'), appliesTo: ['stock'], items: [{ metric: 'roic', weight: 1 }] },
    safety: { title: T('Safety'), appliesTo: ['stock'], items: [{ metric: 'debtToEquity', weight: 1 }] },
    dividend: { title: T('Dividend'), appliesTo: ['stock', 'etf'], payersOnly: true, items: [{ metric: 'dividendYield', weight: 1 }] },
    entry: { title: T('Entry'), appliesTo: ['stock', 'etf'], items: [{ metric: 'range52w', weight: 1, direction: 'lower-is-better' }], adjust: [{ when: c('epsRevision30d', '<', 0), factor: 0.5 }] },
  },
  stopFactors: [{ id: 'negative-fcf', title: T('Negative FCF'), appliesTo: ['stock'], match: 'all', conditions: [c('fcfNegativeYears', '>=', 3)] }],
  flags: [{ id: 'high-debt', title: T('High debt'), appliesTo: ['stock'], match: 'all', conditions: [c('debtToEquity', '>', 2)] }],
  notes: [{ condition: c('dividendYield', '>=', 4), text: T('yield {value}') }],
};

const preset = (id: string, appliesTo: Preset['appliesTo'], conditions: Condition[]): Preset => ({ schemaVersion: PRESET_SCHEMA_VERSION, id, title: T(id), appliesTo, match: 'all', conditions });
const PRESETS: Preset[] = [
  preset('payers', ['stock', 'etf'], [c('dividendYield', '>', 0)]),
  preset('buy', ['stock', 'etf'], [c('status', '=', 'buy')]),
  // market scope ranks stocks and ETFs together: a stock's result changes once the ETFs join
  preset('low-range', ['stock', 'etf'], [c('range52w', '<', 50, 'market')]),
];

const STOCKS: ScreenerRow[] = [
  stock('AAA', { pe: 10, roic: 30, debtToEquity: 0.5, dividendYield: 3, range52w: 20, volatility1y: 20 }),
  stock('BBB', { pe: 20, roic: 20, debtToEquity: 3, dividendYield: 5, range52w: 40, volatility1y: 20, fcfNegativeYears: 3 }),
  stock('CCC', { pe: 30, roic: 10, debtToEquity: 1, dividendYield: 0, range52w: 60, volatility1y: 60, epsRevision30d: -2 }),
  stock('DDD', { pe: 40, roic: 25, debtToEquity: 1.5, dividendYield: 1, range52w: 80, volatility1y: 25 }),
  stock('EEE', { pe: 15, roic: 5, debtToEquity: 0.2, dividendYield: 2, range52w: 55, volatility1y: 30 }, 'Energy'),
  stock('FFF', { pe: 25, roic: 15, debtToEquity: 2.5, range52w: 50, volatility1y: 35 }),
];
const ETFS: ScreenerRow[] = [
  etf('VVV', { dividendYield: 1.5, range52w: 90, volatility1y: 15 }),
  etf('WWW', { dividendYield: 2.5, range52w: 95, volatility1y: 18 }),
  etf('XXX', { dividendYield: 0, range52w: 85, volatility1y: 50 }),
  etf('YYY', { dividendYield: 4, range52w: 99, volatility1y: 20 }, 'Bonds'),
];
const PEERS = { Software: ['AAA', 'DDD'] };
const FEED = { generatedAt: '2026-11-15T10:00:00Z', companies: STOCKS.length };
const BRANDS: Array<[string, string]> = [['Schwab', '2026-11-15T09:00:00Z'], ['SPDR', '2026-11-14T09:00:00Z']];

/** What the page computes without the file */
function computed(rows: ScreenerRow[]) {
  const result = computeScoring(createUniverse(rows, { peers: PEERS }), CONFIG);
  const universe = createUniverse(withScoreMetrics(rows, result), { peers: PEERS });
  return { result, universe, presets: evaluatePresets(universe, PRESETS) };
}

describe('scores snapshot', () => {
  const snapshot = parseScoresSnapshot(JSON.parse(scoresText(buildScoresSnapshot({ config: CONFIG, presets: PRESETS, peers: PEERS, feed: FEED }, STOCKS, { brands: BRANDS, rows: ETFS }))));
  const stocksKey = stocksScoresKey(CONFIG, PEERS, FEED);
  const keys = { stocks: stocksKey, etfs: etfScoresKey(stocksKey, BRANDS) };

  test('the stock rows from the file equal computeScoring and the base presets of the stock universe, in any row order', () => {
    expect(snapshot).not.toBeNull();
    const rows = STOCKS.slice().reverse();
    const applied = snapshot ? applyScoresSnapshot(snapshot, rows, CONFIG, keys) : null;
    const fresh = computed(rows);
    expect(applied?.result.rows).toEqual(fresh.result.rows);
    PRESETS.forEach((p) => { expect(applied?.pass[p.id]).toEqual(fresh.presets[p.id].pass); expect(applied?.hashes[p.id]).toBe(presetHash(p)); });
    expect(fresh.result.rows.some((r) => r.status === 'buy') && fresh.result.rows.some((r) => r.flags.length > 0)).toBe(true); // the sample is not trivial
  });

  test('stocks with ETFs: the ETF part and the stock rows a market-scope preset changes give the result of the whole universe', () => {
    expect(snapshot?.etfs?.stocks.length).toBeGreaterThan(0);
    const rows = [ETFS[2], STOCKS[0], ETFS[0], ...STOCKS.slice(1), ETFS[1], ETFS[3]];
    const applied = snapshot ? applyScoresSnapshot(snapshot, rows, CONFIG, keys) : null;
    const fresh = computed(rows);
    expect(applied?.result.rows).toEqual(fresh.result.rows);
    PRESETS.forEach((p) => expect(applied?.pass[p.id]).toEqual(fresh.presets[p.id].pass));
  });

  test('the stock key carries the formula version of score.ts: a formula change in code alone never reuses an old file', () => {
    const body = { v: SCORES_SCHEMA_VERSION, config: CONFIG, peers: PEERS, generatedAt: FEED.generatedAt, companies: FEED.companies };
    expect(SCORING_FORMULA_VERSION).toBeGreaterThanOrEqual(2); // 2: an empty heavy score counts as 0 (owner 2026-11-15)
    expect(stocksKey).toBe(fnv1a(canonicalJson({ ...body, f: SCORING_FORMULA_VERSION })));
    expect(stocksKey).not.toBe(fnv1a(canonicalJson({ ...body, f: SCORING_FORMULA_VERSION - 1 })));
  });

  test('another key, an incomplete ETF view or other rows: not used (the page computes)', () => {
    if (!snapshot) throw new Error('no snapshot');
    expect(applyScoresSnapshot(snapshot, STOCKS, CONFIG, { ...keys, stocks: stocksScoresKey(CONFIG, PEERS, { ...FEED, generatedAt: '2026-11-16T10:00:00Z' }) })).toBeNull();
    expect(applyScoresSnapshot(snapshot, STOCKS, CONFIG, { ...keys, stocks: stocksScoresKey(CONFIG, { Software: ['AAA'] }, FEED) })).toBeNull();
    expect(applyScoresSnapshot(snapshot, STOCKS, CONFIG, { ...keys, stocks: stocksScoresKey({ ...CONFIG, minGroupSize: 4 }, PEERS, FEED) })).toBeNull();
    expect(applyScoresSnapshot(snapshot, STOCKS.concat(ETFS), CONFIG, { ...keys, etfs: null })).toBeNull();
    expect(applyScoresSnapshot(snapshot, STOCKS.concat(ETFS), CONFIG, { ...keys, etfs: etfScoresKey(stocksKey, BRANDS.slice(0, 1)) })).toBeNull();
    expect(applyScoresSnapshot(snapshot, STOCKS.slice(1), CONFIG, keys)).toBeNull();
    expect(applyScoresSnapshot(snapshot, STOCKS.concat([stock('ZZZ', {})]).slice(1), CONFIG, keys)).toBeNull();
    expect(parseScoresSnapshot({ ...snapshot, schemaVersion: 2 })).toBeNull();
  });

  test('a preset result from the bits: same count, funnel and start as evaluatePreset', () => {
    const fresh = computed(STOCKS);
    const p = PRESETS[0];
    const lazy = snapshotPresetResult(fresh.universe, p, fresh.presets[p.id].pass);
    const full = evaluatePreset(fresh.universe, p);
    expect([lazy.count, lazy.start, lazy.funnel, lazy.unavailable, lazy.invalid]).toEqual([full.count, full.start, full.funnel, full.unavailable, full.invalid]);
  });
});
