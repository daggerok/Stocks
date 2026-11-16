/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { createUniverse } from '../screener/engine';
import type { Condition, ScreenerRow } from '../screener/types';
import { computeScoring, type ScoringConfig, SCORE_IDS, totalScoreText, validateScoringConfig, whyParts, withScoreMetrics, flagTexts } from '.';
import { loadScoringConfig } from './load-config';

type M = Record<string, unknown>;
const stock = (ticker: string, metrics: M, sector = 'Technology'): ScreenerRow => ({ ticker, type: 'stock', sector, industry: 'Software', isMine: false, size: 1e10, metrics });
const etf = (ticker: string, metrics: M, category: string | null = null): ScreenerRow => ({ ticker, type: 'etf', sector: category, industry: null, isMine: false, size: 1e9, metrics });
const T = (en: string, ru = en) => ({ en, ru });
const c = (metric: string, op: Condition['op'], value: Condition['value']): Condition => ({ metric, op, value, scope: 'absolute', missing: 'fail' });

/** A small config whose numbers are easy to follow by hand: two metrics per status at most */
const HAND: ScoringConfig = {
  schemaVersion: 1, minGroupSize: 3, minWeightShare: 0.5, colors: { good: 70, bad: 40 }, whyLimit: 4, defaultArchetype: 'stable',
  archetypes: {
    stable: { title: T('Stable', 'Стабильная'), scoreWeights: { cheap: 1, quality: 0, safety: 1, dividend: 0, entry: 0 }, buy: 60, reject: 40, stopFactors: ['fcf-negative-3y'] },
    growth: { title: T('Growth', 'Растущая'), scoreWeights: { cheap: 0, quality: 1, safety: 0, dividend: 0, entry: 1 }, buy: 60, reject: 40, stopFactors: ['cash-runway-short'] },
    volatile: { title: T('Volatile', 'Волатильная'), scoreWeights: { cheap: 0, quality: 0, safety: 0, dividend: 0, entry: 1 }, buy: 70, reject: 40, stopFactors: ['weak-piotroski'] },
  },
  archetypeRules: [
    { id: 'volatile', archetype: 'volatile', title: T('volatile'), appliesTo: ['stock', 'etf'], match: 'all', conditions: [c('volatility1y', '>=', 45)] },
    { id: 'growth', archetype: 'growth', title: T('growth'), appliesTo: ['stock'], match: 'all', conditions: [c('revenueGrowth3y', '>=', 15)] },
  ],
  scores: {
    cheap: { title: T('Cheap'), appliesTo: ['stock'], items: [{ metric: 'pe', weight: 1 }] },
    quality: { title: T('Quality'), appliesTo: ['stock'], items: [{ metric: 'roic', weight: 1 }] },
    safety: { title: T('Safety'), appliesTo: ['stock'], items: [{ metric: 'debtToEquity', weight: 1 }, { metric: 'altmanZ', weight: { stable: 1 } }] },
    dividend: { title: T('Dividend'), appliesTo: ['stock', 'etf'], payersOnly: true, items: [{ metric: 'dividendYield', weight: 1 }] },
    entry: { title: T('Entry'), appliesTo: ['stock', 'etf'], items: [{ metric: 'range52w', weight: 1, direction: 'lower-is-better' }], adjust: [{ when: c('epsRevision30d', '<', 0), factor: 0.5 }] },
  },
  stopFactors: [
    { id: 'fcf-negative-3y', title: T('Negative FCF 3 years', 'Отрицательный FCF 3 года'), appliesTo: ['stock'], match: 'all', conditions: [c('fcfNegativeYears', '>=', 3)] },
    { id: 'cash-runway-short', title: T('Cash under 12 months', 'Кэша меньше 12 месяцев'), appliesTo: ['stock'], match: 'all', conditions: [c('cashRunwayMonths', '<', 12)] },
    { id: 'weak-piotroski', title: T('Weak Piotroski'), appliesTo: ['stock'], match: 'all', conditions: [c('piotroskiF', '<=', 2)] },
  ],
  flags: [{ id: 'high-debt', title: T('Debt to equity above 2', 'Долг к капиталу выше 2'), appliesTo: ['stock'], match: 'all', conditions: [c('debtToEquity', '>', 2)] }],
  notes: [{ condition: c('dividendYield', '>=', 4), text: T('yield {value} >= {threshold}', 'доходность {value} >= {threshold}') }],
};

// 5 stable (volatility 20), 5 growth (revenue +20% a year), 5 volatile (volatility 60); one sector of 15 stocks
const HAND_ROWS: ScreenerRow[] = [
  stock('S1', { volatility1y: 20, pe: 10, debtToEquity: 3, altmanZ: 1, dividendYield: 0 }),
  stock('S2', { volatility1y: 20, pe: 20, debtToEquity: 0.5, altmanZ: 4, dividendYield: 2 }),
  stock('S3', { volatility1y: 20, pe: 30, debtToEquity: 1, altmanZ: 3, dividendYield: 3, fcfNegativeYears: 3 }),
  stock('S4', { volatility1y: 20, pe: 40, debtToEquity: 1.5, altmanZ: 2.5, dividendYield: 4 }),
  stock('S5', { volatility1y: 20, pe: 50, debtToEquity: 2, altmanZ: 5, dividendYield: 5, fcfNegativeYears: 2 }),
  stock('G1', { volatility1y: 30, revenueGrowth3y: 20, roic: 30, range52w: 10 }),
  stock('G2', { volatility1y: 30, revenueGrowth3y: 20, roic: 25, range52w: 20, epsRevision30d: -5 }),
  stock('G3', { volatility1y: 30, revenueGrowth3y: 20, roic: 20, range52w: 30, cashRunwayMonths: 6 }),
  stock('G4', { volatility1y: 30, revenueGrowth3y: 20, roic: 15, range52w: 40, cashRunwayMonths: 18 }),
  stock('G5', { volatility1y: 30, revenueGrowth3y: 20, roic: 10, range52w: 50 }),
  stock('V1', { volatility1y: 60, revenueGrowth3y: 30, range52w: 5 }),
  stock('V2', { volatility1y: 60, range52w: 15 }),
  stock('V3', { volatility1y: 60, range52w: 35, piotroskiF: 5 }),
  stock('V4', { volatility1y: 60, range52w: 70, piotroskiF: 1 }),
  stock('V5', { volatility1y: 60, range52w: 80 }),
];

describe('scores and status on a hand example', () => {
  const result = computeScoring(createUniverse(HAND_ROWS), HAND);
  const by = (t: string) => result.rows[HAND_ROWS.findIndex((r) => r.ticker === t)];

  test('stable: sector percentiles (100 = best), weighted mean, stop factor and thresholds', () => {
    // P/E 10..50 lower is better: 100, 75, 50, 25, 0. D/E: S2 100, S3 75, S4 50, S5 25, S1 0; Altman Z: S5 100, S2 75, S3 50, S4 25, S1 0
    expect(['S1', 'S2', 'S3', 'S4', 'S5'].map((t) => [by(t).archetype, by(t).scores.cheap, by(t).scores.safety])).toEqual([
      ['stable', 100, 0], ['stable', 75, 88], ['stable', 50, 63], ['stable', 25, 38], ['stable', 0, 63],
    ]);
    // status score = (cheap + safety) / 2 from unrounded scores: 50, 81.25, 56.25, 31.25, 31.25
    expect(['S1', 'S2', 'S3', 'S4', 'S5'].map((t) => [by(t).statusScore, by(t).status, by(t).stops.join()])).toEqual([
      [50, 'watch', ''], [81, 'buy', ''], [56, 'rejected', 'fcf-negative-3y'], [31, 'rejected', ''], [31, 'rejected', ''],
    ]);
    // dividend: payers only (S1 pays nothing and is not in the group), the 4 yields 2..5: 0, 33, 67, 100
    expect(['S1', 'S2', 'S3', 'S4', 'S5'].map((t) => by(t).scores.dividend)).toEqual([null, 0, 33, 67, 100]);
  });

  test('a buy cap turns a buy zone score into Watch and says why; a row outside the cap and a watch row stay as they are', () => {
    // owner answer N19: no buy zone below a $2B market cap. S2 (score 81, buy) is small, G1 (buy) is large, S1 (watch) is small
    const capped: ScoringConfig = { ...HAND, buyCaps: [{ id: 'small-cap', title: T('Market cap below $2B', 'Капитализация меньше $2 млрд'), appliesTo: ['stock'], match: 'all', conditions: [c('marketCap', '<', 2e9)] }] };
    expect(validateScoringConfig(capped)).toEqual([]);
    const rows = HAND_ROWS.map((r) => (r.ticker === 'S2' || r.ticker === 'S1' ? { ...r, metrics: { ...r.metrics, marketCap: 1e9 } } : r.ticker === 'G1' ? { ...r, metrics: { ...r.metrics, marketCap: 5e9 } } : r));
    const res = computeScoring(createUniverse(rows), capped);
    const at = (t: string) => res.rows[rows.findIndex((r) => r.ticker === t)];
    expect(['S2', 'G1', 'S1'].map((t) => [at(t).statusScore, at(t).status, at(t).caps])).toEqual([[81, 'watch', ['small-cap']], [by('G1').statusScore, 'buy', []], [50, 'watch', []]]);
    const s2 = rows[rows.findIndex((r) => r.ticker === 'S2')];
    expect(whyParts(capped, at('S2'), s2, 'en').slice(1, 3)).toEqual(['score 81 >= 60', 'at most Watch: Market cap below $2B: Market cap $1B < $2B']);
  });

  test('a buy zone needs every heavy score: an empty one gives Watch and Why names it; a light or not applicable one does not (owner 2026-11-15)', () => {
    // stable weights cheap 1, safety 1 (50% each). S2 (buy, 81) loses its P/E: cheap empty counts as 0, total = 88 × 50% = 44,
    // still a buy at the lowered threshold 40 of this test, so the guard makes it Watch
    const guarded: ScoringConfig = { ...HAND, buyRequiresScores: { minWeight: 0.15 }, archetypes: { ...HAND.archetypes, stable: { ...HAND.archetypes.stable, buy: 40, reject: 20 } }, scores: { ...HAND.scores, cheap: { ...HAND.scores.cheap, noData: T('no data for the Cheap score', 'нет данных для оценки дешевизны') } } };
    expect(validateScoringConfig(guarded)).toEqual([]);
    expect(validateScoringConfig({ ...guarded, buyRequiresScores: { minWeight: 0 } })).toContain('buyRequiresScores.minWeight must be above 0 and at most 1');
    const rows = HAND_ROWS.map((r) => (r.ticker === 'S2' ? stock('S2', { volatility1y: 20, debtToEquity: 0.5, altmanZ: 4, dividendYield: 2 }) : r));
    const i = rows.findIndex((r) => r.ticker === 'S2');
    const res = computeScoring(createUniverse(rows), guarded);
    expect([res.rows[i].scores.cheap, res.rows[i].statusScore, res.rows[i].status, res.rows[i].missing]).toEqual([null, 44, 'watch', ['cheap']]);
    const plain = computeScoring(createUniverse(rows), HAND).rows[i]; // without buyRequiresScores the empty score is left out and safety scaled up
    expect([plain.statusScore, plain.status]).toEqual([88, 'buy']);
    expect(whyParts(guarded, res.rows[i], rows[i], 'en').slice(1)).toEqual(['score 44 >= 40', 'at most Watch: no data for the Cheap score']);
    expect(whyParts(guarded, res.rows[i], rows[i], 'ru').slice(1)).toEqual(['оценка 44 >= 40', 'не выше «Наблюдать»: нет данных для оценки дешевизны']);
    // a score without noData in the config gets the generic text; G1 (growth, buy) keeps its buy: all its weighted scores have values
    const growthGuard: ScoringConfig = { ...guarded, archetypes: { ...guarded.archetypes, growth: { ...guarded.archetypes.growth, scoreWeights: { cheap: 0, quality: 1, safety: 0, dividend: 0.1, entry: 1 } } } };
    const g = computeScoring(createUniverse(HAND_ROWS), growthGuard).rows[HAND_ROWS.findIndex((r) => r.ticker === 'G1')];
    expect([g.status, g.missing]).toEqual(['buy', []]); // dividend weighs 0.1 / 2.1 < 15% and G1 pays nothing anyway
    const heavyDiv: ScoringConfig = { ...guarded, archetypes: { ...guarded.archetypes, stable: { ...guarded.archetypes.stable, buy: 10, reject: 5, scoreWeights: { cheap: 1, quality: 0, safety: 1, dividend: 1, entry: 0 } } } };
    const payer = [stock('P1', { volatility1y: 20, pe: 10, debtToEquity: 0.1, altmanZ: 9, dividendYield: 1 }), stock('N1', { volatility1y: 20, pe: 10, debtToEquity: 0.1, altmanZ: 9, dividendYield: 0 })];
    const p = computeScoring(createUniverse(payer), heavyDiv).rows;
    expect(p.map((x) => [x.scores.dividend, x.status, x.missing])).toEqual([[50, 'buy', []], [null, 'buy', []]]); // a non-payer's empty Dividend is not missing data
  });

  test('the Total score tooltip lists each score times its weight, heaviest first, and spells out the scaling', () => {
    const shipped: ScoringConfig = { ...HAND, archetypes: { ...HAND.archetypes, growth: { ...HAND.archetypes.growth, scoreWeights: { cheap: 0.2, quality: 0.35, safety: 0.15, dividend: 0, entry: 0.3 } } } };
    const rows = [stock('G', { revenueGrowth3y: 20 })];
    const r = computeScoring(createUniverse(rows), shipped).rows[0];
    const full = { ...r, scores: { cheap: 86, quality: 66, safety: 62, dividend: null, entry: 53 }, statusScore: 65 };
    expect(totalScoreText(shipped, full, rows[0], 'en')).toBe('Growth: quality 66 × 35% + entry 53 × 30% + cheap 86 × 20% + safety 62 × 15% = 65');
    expect(totalScoreText(shipped, full, rows[0], 'ru')).toBe('Растущая: quality 66 × 35% + entry 53 × 30% + cheap 86 × 20% + safety 62 × 15% = 65');
    const holed = { ...full, scores: { ...full.scores, cheap: null }, statusScore: 61 };
    expect(totalScoreText(shipped, holed, rows[0], 'en').split('\n')).toEqual([
      'Growth: quality 66 × 35% + entry 53 × 30% + cheap no data × 20% + safety 62 × 15%', '= 49 / 80% = 61', 'no data: cheap; the weights with data (80%) are scaled up to 100%',
    ]);
    expect(totalScoreText(shipped, { ...holed, statusScore: null }, rows[0], 'ru').split('\n')[1]).toBe('итога нет: данные есть у 80% веса, нужно от 50%');
    const stable = computeScoring(createUniverse(HAND_ROWS), { ...HAND, archetypes: { ...HAND.archetypes, stable: { ...HAND.archetypes.stable, scoreWeights: { cheap: 1, quality: 0, safety: 1, dividend: 1, entry: 0 } } } });
    expect(totalScoreText({ ...HAND, archetypes: { ...HAND.archetypes, stable: { ...HAND.archetypes.stable, scoreWeights: { cheap: 1, quality: 0, safety: 1, dividend: 1, entry: 0 } } } }, stable.rows[0], HAND_ROWS[0], 'en').split('\n')[0])
      .toBe('Stable: cheap 100 × 33% + safety 0 × 33% + dividend no dividend × 33%'); // S1 pays nothing
  });

  test('growth: quality and entry, the EPS revision lowers the entry score, cash runway stops', () => {
    // range52w of the 10 growth and volatile rows, lower is better: V5 0, V4 11.1, G5 22.2, G4 33.3, V3 44.4, G3 55.6, G2 66.7, V2 77.8, G1 88.9, V1 100
    expect(['G1', 'G2', 'G3', 'G4', 'G5'].map((t) => [by(t).archetype, by(t).scores.quality, by(t).scores.entry, by(t).adjusted.join()])).toEqual([
      ['growth', 100, 89, ''], ['growth', 75, 33, 'entry'], ['growth', 50, 56, ''], ['growth', 25, 33, ''], ['growth', 0, 22, ''],
    ]);
    expect(['G1', 'G2', 'G3', 'G4', 'G5'].map((t) => [by(t).statusScore, by(t).status])).toEqual([[94, 'buy'], [54, 'watch'], [53, 'rejected'], [29, 'rejected'], [11, 'rejected']]);
    expect(by('G3').stops).toEqual(['cash-runway-short']);
    expect(by('G4').stops).toEqual([]); // 18 months is enough
  });

  test('volatile: the first matching rule wins, entry only, own buy threshold and stop factor', () => {
    expect(by('V1').archetype).toBe('volatile'); // also matches the growth rule, volatile comes first
    expect(['V1', 'V2', 'V3', 'V4', 'V5'].map((t) => [by(t).statusScore, by(t).status])).toEqual([[100, 'buy'], [78, 'buy'], [44, 'watch'], [11, 'rejected'], [0, 'rejected']]);
    expect(by('V4').stops).toEqual(['weak-piotroski']);
    expect(['V1', 'V2', 'V3', 'V4', 'V5'].map((t) => by(t).scores.cheap)).toEqual([null, null, null, null, null]); // no P/E: empty, never 0
  });

  test('Why in both languages, flags with their numbers, outputs as metrics', () => {
    const row = (t: string) => HAND_ROWS.find((r) => r.ticker === t) as ScreenerRow;
    expect(whyParts(HAND, by('S2'), row('S2'), 'en')).toEqual(['Stable', 'score 81 >= 60']);
    expect(whyParts(HAND, by('S2'), row('S2'), 'ru')).toEqual(['Стабильная', 'оценка 81 >= 60']);
    expect(whyParts(HAND, by('S3'), row('S3'), 'en')).toEqual(['Stable', 'stop: Negative FCF 3 years: Negative FCF years in a row 3 >= 3']);
    expect(whyParts(HAND, by('S5'), row('S5'), 'ru')).toEqual(['Стабильная', 'оценка 31 < 40', 'доходность 5% >= 4']);
    expect(whyParts(HAND, by('V5'), row('V5'), 'en')[0]).toBe('Volatile');
    expect(flagTexts(HAND, by('S1'), row('S1'), 'en')).toEqual([{ id: 'high-debt', title: 'Debt to equity above 2', detail: 'Debt to equity above 2: Debt to equity 3 > 2' }]);
    expect(by('S5').flags).toEqual([]); // D/E 2 is not above 2
    const titled = { ...HAND, flags: [{ ...HAND.flags[0], title: T('Debt {debtToEquity} of equity', 'Долг {debtToEquity} капитала') }] };
    expect(flagTexts(titled, by('S1'), row('S1'), 'ru')[0].title).toBe('Долг 3 капитала'); // {metric} placeholders of a title take the row's value
    const enriched = withScoreMetrics(HAND_ROWS, result);
    expect([enriched[1].metrics.scoreCheap, enriched[1].metrics.status, enriched[0].metrics.flags, enriched[0].metrics.flagCount, enriched[1].metrics.flags]).toEqual([75, 'buy', 'high-debt', 1, null]);
    expect(HAND_ROWS[1].metrics.status).toBeUndefined(); // the input rows stay as they were
  });

  test('less than half of the weight gives an empty score; a small sector compares with the market, ETFs with ETFs', () => {
    // safety of a stable row with D/E only: 1 of 2 weight is exactly half, so it counts; with neither it is empty
    const half = computeScoring(createUniverse(HAND_ROWS.map((r) => (r.ticker === 'S2' ? stock('S2', { volatility1y: 20, debtToEquity: 0.5 }) : r))), HAND);
    expect(half.rows[1].scores.safety).toBe(100);
    const none = computeScoring(createUniverse(HAND_ROWS.map((r) => (r.ticker === 'S2' ? stock('S2', { volatility1y: 20 }) : r))), HAND);
    expect([none.rows[1].scores.safety, none.rows[1].statusScore, none.rows[1].status]).toEqual([null, null, null]);
    // sector A has 2 P/E values (< minGroupSize 3): its rows rank in the market of A and B; sector B has 3 and ranks alone
    const rows = [stock('A1', { pe: 10 }, 'A'), stock('A2', { pe: 50 }, 'A'), stock('B1', { pe: 20 }, 'B'), stock('B2', { pe: 30 }, 'B'), stock('B3', { pe: 40 }, 'B'), etf('E1', { pe: 1, range52w: 90 }), etf('E2', { range52w: 10 })];
    const r = computeScoring(createUniverse(rows), HAND).rows;
    expect(r.map((x) => x.scores.cheap)).toEqual([100, 0, 100, 50, 0, null, null]);
    expect([r[5].scores.entry, r[6].scores.entry]).toEqual([0, 100]); // the two ETFs among themselves
  });

  test('a stock of a small sector ranks against the whole stock market, every sector included, not only the other small sectors', () => {
    // minGroupSize 3: sector A has 2 P/E values, so A1, A2 and the row without a sector rank among all 6 stocks; B (3 values) ranks alone.
    // Ranked only with the other small-sector rows (15, 25, 35) A1 would get 100 and N1 50
    const rows = [stock('A1', { pe: 15 }, 'A'), stock('A2', { pe: 35 }, 'A'), stock('B1', { pe: 10 }, 'B'), stock('B2', { pe: 20 }, 'B'), stock('B3', { pe: 30 }, 'B'), stock('N1', { pe: 25 }, '')];
    const r = computeScoring(createUniverse(rows), HAND).rows;
    expect(r.map((x) => x.scores.cheap)).toEqual([80, 0, 100, 50, 0, 40]); // market of 6: 10 100, 15 80, 20 60, 25 40, 30 20, 35 0; a row without a sector ranks there too
  });

  test('ETFs rank inside their fund category; a category under minGroupSize compares with all ETFs (owner answer N4)', () => {
    // Equity has 3 entry values (= minGroupSize 3) and ranks alone; Bond has 1 and ranks among all 4 ETFs; the stock sector Equity never mixes in
    const rows = [etf('Q1', { range52w: 10 }, 'Equity'), etf('Q2', { range52w: 50 }, 'Equity'), etf('Q3', { range52w: 90 }, 'Equity'), etf('B1', { range52w: 70 }, 'Bond'), stock('S1', { range52w: 0, volatility1y: 20 }, 'Equity')];
    const r = computeScoring(createUniverse(rows), HAND).rows;
    expect(r.slice(0, 4).map((x) => x.scores.entry)).toEqual([100, 50, 0, 33]); // B1: 70 of 10, 50, 70, 90 with lower is better
  });
});

describe('the shipped config', () => {
  const config = loadScoringConfig();

  test('is valid, and the validator finds broken entries', () => {
    expect(validateScoringConfig(config)).toEqual([]);
    const broken = JSON.parse(JSON.stringify(config)) as ScoringConfig;
    broken.defaultArchetype = 'boring';
    broken.archetypes.growth.buy = 10; // below reject
    broken.scores.entry.items.push({ metric: 'pctFromAth', weight: 1 }); // neutral in the registry, no direction
    broken.scores.cheap.items.push({ metric: 'notAMetric', weight: 1 });
    broken.flags[0].conditions[0].op = '>>' as Condition['op'];
    broken.archetypes.stable.stopFactors.push('nope');
    const errors = validateScoringConfig(broken).join('\n');
    ['defaultArchetype boring', 'archetype growth: needs 0 <= reject <= buy <= 100', 'pctFromAth needs a direction', 'unknown metric notAMetric', 'unknown op >>', 'unknown stop factor nope']
      .forEach((e) => expect(errors).toContain(e));
  });

  test('archetype rules in order, first match wins, ETFs only by the price rules', () => {
    const rows = [
      stock('VOL', { volatility1y: 50, revenueGrowth3y: 30 }), stock('GRO', { volatility1y: 35, revenueGrowth3y: 20 }),
      stock('BURN', { volatility1y: 35, revenueGrowth: 30, fcfMargin: -5 }), stock('PAY', { volatility1y: 35, dividendYield: 2 }),
      stock('CALM', { volatility1y: 20 }), stock('NONE', { volatility1y: 35 }), etf('EVOL', { volatility1y: 50 }), etf('EGRO', { volatility1y: 35, revenueGrowth3y: 30, dividendYield: 3 }),
    ];
    expect(computeScoring(createUniverse(rows), config).rows.map((r) => r.archetype)).toEqual(['volatile', 'growth', 'growth', 'stable', 'stable', config.defaultArchetype, 'volatile', config.defaultArchetype]);
  });

  /** A value that makes the condition pass or fail, from the threshold of the config (so the test follows tuned thresholds) */
  const valueFor = (cond: Condition, pass: boolean): unknown => {
    const v = cond.value;
    if (cond.op === '=') return pass ? v : typeof v === 'boolean' ? !v : `not-${String(v)}`;
    const n = Number(v);
    const up = cond.op === '>' || cond.op === '>=';
    return pass ? (up ? n + 1 : n - 1) : (up ? n - 1 : n + 1);
  };
  const metricsFor = (conditions: Condition[], pass: boolean, firstOnly: boolean): M => {
    const out: M = {};
    conditions.forEach((cond, i) => { if (!(cond.metric in out)) out[cond.metric] = valueFor(cond, pass && (!firstOnly || i === 0)); }); // a metric in two conditions (match 1 of 2): the first decides
    return out;
  };

  test('each flag fires on its numbers and stays silent without them; a switched-off flag never fires', () => {
    config.flags.forEach((flag) => {
      const soft = flag.match !== 'all';
      const rows = [stock('FIRE', metricsFor(flag.conditions, true, soft)), stock('QUIET', metricsFor(flag.conditions, false, false)), stock('EMPTY', {})];
      const r = computeScoring(createUniverse(rows), config).rows.map((x) => x.flags.indexOf(flag.id) >= 0);
      expect({ flag: flag.id, fired: r }).toEqual({ flag: flag.id, fired: [flag.enabled !== false, false, false] });
    });
  });

  test('each stop factor rejects its archetypes and stays silent without its numbers', () => {
    Object.keys(config.archetypes).forEach((archetype) => {
      const rule = config.archetypeRules.filter((r) => r.archetype === archetype)[0];
      const base: M = rule ? metricsFor(rule.conditions, true, rule.match !== 'all') : {};
      config.archetypes[archetype].stopFactors.forEach((id) => {
        const stop = config.stopFactors.filter((s) => s.id === id)[0];
        const rows = [stock('STOP', { ...base, ...metricsFor(stop.conditions, true, stop.match !== 'all') }), stock('OK', { ...base, ...metricsFor(stop.conditions, false, false) })];
        const r = computeScoring(createUniverse(rows), config).rows;
        expect({ archetype, id, a: r.map((x) => x.archetype), stops: r.map((x) => x.stops), status: r[0].status }).toEqual({ archetype, id, a: [archetype, archetype], stops: [[id], []], status: 'rejected' });
      });
    });
  });

  test('the main red flag has a second rule: cash conversion below 0.5 while net income grows (owner answer N21)', () => {
    const flag = config.flags.filter((f) => f.id === 'ni-up-cfo-not')[0];
    const alt = (flag.or ?? [])[0];
    const limit = Number(alt.conditions.filter((x) => x.metric === 'cfoToNi')[0].value); // the threshold lives in the config
    const rows = [
      stock('CASHLESS', { niGrowth3y: 5, cfoToNi: limit - 0.2 }), // CFO turned negative: no cfoGrowth3y, the first rule is silent
      stock('BACKED', { niGrowth3y: 5, cfoToNi: limit + 0.4 }),
      stock('SHRINKING', { niGrowth3y: -5, cfoToNi: limit - 0.2 }),
      stock('FIRST', { niGrowth3y: 12, cfoGrowth3y: 1, cfoToNi: 1 }),
    ];
    const result = computeScoring(createUniverse(rows), config);
    expect(result.rows.map((x) => x.flags.indexOf('ni-up-cfo-not') >= 0)).toEqual([true, false, false, true]);
    expect(flagTexts(config, result.rows[0], rows[0], 'en')[0].detail).toBe(`Profit grows, cash flow does not: Net income growth 3Y 5% > 0, Cash conversion (CFO / NI) ${(limit - 0.2).toFixed(1)} < ${limit}`);
    expect(flagTexts(config, result.rows[3], rows[3], 'en')[0].detail).toContain('Operating cash flow growth 3Y'); // the first rule explains itself
    const broken = JSON.parse(JSON.stringify(config)) as ScoringConfig;
    (broken.flags[0].or ?? [])[0].conditions[0].metric = 'notAMetric';
    expect(validateScoringConfig(broken).join('\n')).toContain('flags 1 (ni-up-cfo-not) or 1: ');
  });

  test('REITs are growth only by approximate FFO growth, else stable; revenue growth from acquisitions does not count (owner answer N22)', () => {
    const reit = (t: string, m: M) => stock(t, { isReit: true, ...m }, 'Real Estate');
    const rows = [
      reit('O', { volatility1y: 18, revenueGrowth3y: 22, ffoGrowth3y: 4 }), // acquisitions lift revenue, FFO grows slowly
      reit('FAST', { volatility1y: 35, revenueGrowth3y: 30, ffoGrowth3y: 20 }),
      reit('NOFFO', { volatility1y: 35, revenueGrowth3y: 30 }), // no FFO growth yet -> stable
      reit('SWING', { volatility1y: 60, ffoGrowth3y: 20 }), // the price rule still comes first
      stock('SAAS', { isReit: false, volatility1y: 35, revenueGrowth3y: 22 }),
    ];
    expect(computeScoring(createUniverse(rows), config).rows.map((x) => x.archetype)).toEqual(['stable', 'growth', 'stable', 'volatile', 'growth']);
  });

  test('ETFs get only Entry point (no EPS adjustment) and Dividend (from the brand dividend keys); the other scores stay empty', () => {
    const rows = [1, 2, 3, 4, 5].map((k) => etf(`E${k}`, { pctFrom52wHigh: -5 * k, pctFromAth: -10 * k, range52w: 100 - 20 * k, sigmaFromMean60d: 3 - k, dividendYield: k, epsRevision30d: -10, pe: 10 * k, roic: 10, debtToEquity: 1 }));
    const r = computeScoring(createUniverse(rows), config).rows;
    expect(r.map((x) => x.scores.entry)).toEqual([0, 25, 50, 75, 100]); // deeper drop and lower in the range = better entry, never lowered
    expect(r.map((x) => x.scores.dividend)).toEqual([null, null, null, null, null]); // the yield alone is under half of the weight
    // the brand feeds publish streak, cut and 5-year growth (etf-dividend-growth-plan 1.2): the Dividend score moves; the yield-only fund stays empty
    const paid = [1, 2, 3, 4, 5].map((k) => etf(`D${k}`, { dividendYield: k, dividendStreak: k, dividendCut10y: k === 1, dividendGrowth5y: k })).concat([etf('Y', { dividendYield: 9 })]);
    expect(computeScoring(createUniverse(paid), config).rows.map((x) => x.scores.dividend)).toEqual([0, 47, 64, 80, 97, null]);
    expect(r.every((x) => x.scores.cheap === null && x.scores.quality === null && x.scores.safety === null && x.adjusted.length === 0)).toBe(true);
    expect(r.every((x) => x.status !== null && x.statusScore !== null)).toBe(true); // statuses from the scores that apply to ETFs
    expect(SCORE_IDS.length).toBe(5);
  });

  test('buyRequiresScores: a volatile stock without a Cheap score is at most Watch (FUTU on 2026-11-13: total 80, Buy zone before)', () => {
    const min = (config.buyRequiresScores ?? { minWeight: 2 }).minWeight;
    expect(config.archetypes.volatile.scoreWeights.cheap).toBeGreaterThanOrEqual(min);
    SCORE_IDS.forEach((id) => expect(config.scores[id].noData).toBeDefined());
    // 25 volatile stocks with falling entry metrics: the best ones are a buy; V0 has everything but the cheap metrics
    const rows = Array.from({ length: 25 }, (_, k) => stock(`V${k}`, { volatility1y: 60, pctFrom52wHigh: -k, pctFromAth: -k, range52w: 100 - 4 * k, sigmaFromMean60d: 2 - k / 5, debtToEquity: 3 - k / 10, netDebtToEbitda: 3 - k / 10, interestCoverage: k, altmanZ: 3 + k, piotroskiF: k % 10, niVolatility5y: 50 - k, fcfVolatility5y: 50 - k, roic: k, grossMarginSlope3y: k, operatingMarginSlope3y: k, cfoToNi: k, fcfToNi: k, ...(k === 24 ? {} : { peg: 3 - k / 10, pegHist: 3 - k / 10, forwardToTtmPe: 1, pePct5y: 50, pFcfPct5y: 50, forwardPe: 30 - k }) }));
    const r = computeScoring(createUniverse(rows), config).rows;
    expect([r[24].scores.cheap, r[24].status, r[24].missing]).toEqual([null, 'watch', ['cheap']]);
    expect(r[23].status).toBe('buy');
    expect(whyParts(config, r[24], rows[24], 'en')).toContain('at most Watch: no data for the Cheap score');
  });

  test('the irregular dividend flag reads dividendIrregular; the refinement Pays a dividend keeps such stocks', () => {
    const rows = [stock('FUTU', { dividendIrregular: true, dividendYield: 2.76 }), stock('KO', { dividendIrregular: false, dividendYield: 3 }), stock('NONE', {})];
    const r = computeScoring(createUniverse(rows), config).rows;
    expect(r.map((x) => x.flags.indexOf('irregular-dividend') >= 0)).toEqual([true, false, false]);
    expect(flagTexts(config, r[0], rows[0], 'ru')[0].title).toBe('Нерегулярный дивиденд');
  });
});

describe('buyRequiresScores.exempt: financials skip the Safety score (owner N46, 2026-11-15)', () => {
  const config = loadScoringConfig();
  const cheapKeys = { peg: 1, pegHist: 1, forwardToTtmPe: 1, pePct5y: 50, pFcfPct5y: 50 };
  const safetyKeys = ['debtToEquity', 'netDebtToEbitda', 'interestCoverage', 'altmanZ', 'piotroskiF', 'niVolatility5y', 'fcfVolatility5y'];
  // 25 volatile stocks with falling entry metrics; the last one (k = 24) is the best and may lose its cheap or safety metrics, in any sector
  const build = (lastSector: string, drop: 'safety' | 'cheap' | 'none') => Array.from({ length: 25 }, (_, k) => {
    const m: M = { volatility1y: 60, pctFrom52wHigh: -k, pctFromAth: -k, range52w: 100 - 4 * k, sigmaFromMean60d: 2 - k / 5, debtToEquity: 3 - k / 10, netDebtToEbitda: 3 - k / 10, interestCoverage: k, altmanZ: 3 + k, piotroskiF: k % 10, niVolatility5y: 50 - k, fcfVolatility5y: 50 - k, roic: k, grossMarginSlope3y: k, operatingMarginSlope3y: k, cfoToNi: k, fcfToNi: k, ...cheapKeys, forwardPe: 30 - k };
    if (k === 24 && drop === 'safety') safetyKeys.forEach((key) => delete m[key]);
    if (k === 24 && drop === 'cheap') [...Object.keys(cheapKeys), 'forwardPe'].forEach((key) => delete m[key]);
    return stock(`V${k}`, m, k === 24 ? lastSector : 'Technology');
  });
  const last = (rows: ScreenerRow[], cfg = config) => computeScoring(createUniverse(rows), cfg).rows[24];

  test('the shipped config lists Safety of Financial Services and validates', () => {
    expect(config.buyRequiresScores?.exempt).toEqual([{ score: 'safety', sector: ['Financial Services'] }]);
    expect(validateScoringConfig(config)).toEqual([]);
    expect(validateScoringConfig({ ...config, buyRequiresScores: { minWeight: 0.15, exempt: [{ score: 'nope' as never, sector: ['X'] }] } })).toContain('buyRequiresScores.exempt needs entries of a known score and a non-empty list of sector names');
    expect(validateScoringConfig({ ...config, buyRequiresScores: { minWeight: 0.15, exempt: [{ score: 'safety', sector: [] }] } })).toContain('buyRequiresScores.exempt needs entries of a known score and a non-empty list of sector names');
  });

  test('a Financial Services stock with an empty Safety score can be Buy zone; a non-financial one cannot', () => {
    const fin = last(build('Financial Services', 'safety'));
    expect([fin.scores.safety, fin.status, fin.missing]).toEqual([null, 'buy', []]);
    const tech = last(build('Technology', 'safety')); // the empty Safety counts as 0: 25% of the weight gone, below the buy zone
    expect([tech.scores.safety, tech.status, tech.missing]).toEqual([null, 'watch', []]);
    expect(tech.statusScore).toBe(Math.round((fin.statusScore ?? 0) * 0.75));
    expect(last(build('Financial Services', 'none')).status).toBe('buy');
  });

  test('the exemption is only for Safety: a financial volatile stock with an empty Cheap score is still Watch (FUTU-like)', () => {
    const r = last(build('Financial Services', 'cheap'));
    expect([r.scores.cheap, r.status, r.missing]).toEqual([null, 'watch', ['cheap']]);
  });

  test('without the exempt list a Financial Services stock with empty Safety is Watch again', () => {
    const r = last(build('Financial Services', 'safety'), { ...config, buyRequiresScores: { minWeight: 0.15 } });
    expect([r.status, r.missing, r.statusScore]).toEqual(['watch', [], last(build('Technology', 'safety')).statusScore]);
  });
});

describe('FUTU 2026-11-15: an empty heavy score counts as 0, P/E in the Cheap score (owner options A and D)', () => {
  const config = loadScoringConfig();
  const futu = stock('FUTU', { volatility1y: 60, dividendYield: 2.76 }, 'Financial Services');
  const base = { archetype: 'volatile', stops: [], caps: [], missing: [], flags: [], notes: [], adjusted: [] };

  test('the Total tooltip shows the heavy empty score as no data × weight = 0 and says it counts as 0, EN and RU', () => {
    const r = { ...base, scores: { cheap: null, quality: 87, safety: 72, dividend: null, entry: 83 }, statusScore: 68, status: 'watch' as const };
    // 83 × 50% + 72 × 25% + 87 × 10% + 0 × 15% = 68.2: the Total of FUTU on the feed of 2026-11-13 was 80 with the 15% dropped
    expect(totalScoreText(config, r, futu, 'en').split('\n')).toEqual([
      'Volatile: entry point 83 × 50% + safety 72 × 25% + cheap (no data × 15% = 0) + quality 87 × 10% = 68', 'no data: cheap counts as 0 (a score with 15% of the weight or more)',
    ]);
    expect(totalScoreText(config, r, futu, 'ru').split('\n')).toEqual([
      'Волатильная: точка входа 83 × 50% + безопасно 72 × 25% + дёшево (нет данных × 15% = 0) + качественно 87 × 10% = 68', 'нет данных: дёшево считается как 0 (оценка с весом от 15%)',
    ]);
    // a light empty score (Quality, 10%) is still left out and the rest scaled: (41.5 + 18 + 0) / 90% = 66
    const both = { ...r, scores: { ...r.scores, quality: null }, statusScore: 66 };
    expect(totalScoreText(config, both, futu, 'en').split('\n')).toEqual([
      'Volatile: entry point 83 × 50% + safety 72 × 25% + cheap (no data × 15% = 0) + quality no data × 10%', '= 59 / 90% = 66',
      'no data: quality; the weights with data (90%) are scaled up to 100%', 'no data: cheap counts as 0 (a score with 15% of the weight or more)',
    ]);
  });

  test('computeScoring: the heavy empty score adds its weight with 0, a light one or an exempt one is scaled out', () => {
    // 25 volatile stocks; V24 has no cheap metrics at all
    const rows = Array.from({ length: 25 }, (_, k) => stock(`V${k}`, { volatility1y: 60, pctFrom52wHigh: -k, pctFromAth: -k, range52w: 100 - 4 * k, sigmaFromMean60d: 2 - k / 5, debtToEquity: 3 - k / 10, netDebtToEbitda: 3 - k / 10, interestCoverage: k, altmanZ: 3 + k, piotroskiF: k % 10, niVolatility5y: 50 - k, fcfVolatility5y: 50 - k, roic: k, grossMarginSlope3y: k, operatingMarginSlope3y: k, cfoToNi: k, fcfToNi: k, ...(k === 24 ? {} : { peg: 3 - k / 10, pegHist: 3 - k / 10, pe: 30 - k, forwardPe: 30 - k }) }));
    const r = computeScoring(createUniverse(rows), config).rows[24];
    const s = r.scores;
    expect(s.cheap).toBeNull();
    const zeroed = 0.5 * (s.entry ?? 0) + 0.25 * (s.safety ?? 0) + 0.1 * (s.quality ?? 0);
    expect(Math.abs((r.statusScore ?? 0) - zeroed)).toBeLessThanOrEqual(1);
    const plain = computeScoring(createUniverse(rows), { ...config, buyRequiresScores: undefined }).rows[24]; // the old rule: dropped and scaled
    expect(Math.abs((plain.statusScore ?? 0) - zeroed / 0.85)).toBeLessThanOrEqual(1);
    // the same row in Financial Services without Safety metrics: Safety is exempt there (N46 b), so it is scaled out, not 0
    const fin = rows.map((x, k) => (k === 24 ? stock('V24', { ...x.metrics, pe: 5, pegHist: 0.1, debtToEquity: null, netDebtToEbitda: null, interestCoverage: null, altmanZ: null, piotroskiF: null, niVolatility5y: null, fcfVolatility5y: null }, 'Financial Services') : x));
    const f = computeScoring(createUniverse(fin), config).rows[24];
    expect(f.scores.safety).toBeNull();
    const fs = f.scores;
    expect(Math.abs((f.statusScore ?? 0) - (0.5 * (fs.entry ?? 0) + 0.15 * (fs.cheap ?? 0) + 0.1 * (fs.quality ?? 0)) / 0.75)).toBeLessThanOrEqual(1);
  });

  test('Cheap has a TTM P/E item in the sector and its own minWeightShare 0.25: P/E with one more valuation metric is a score', () => {
    expect(config.scores.cheap.items).toContainEqual({ metric: 'pe', weight: 1, scope: 'sector' });
    expect(config.scores.cheap.minWeightShare).toBe(0.25);
    expect(validateScoringConfig({ ...config, scores: { ...config.scores, cheap: { ...config.scores.cheap, minWeightShare: 1.5 } } })).toContain('score cheap: minWeightShare must be above 0 and at most 1');
    // a foreign filer like FUTU: only pegHist and the TTM P/E (no forward P/E, no own 5-year percentiles): 2 of 7.5 weight
    const rows = Array.from({ length: 21 }, (_, k) => stock(`F${k}`, k === 20 ? { pe: 9 } : { pe: 10 + k, pegHist: 0.5 + k / 10 }, 'Financial Services'));
    const r = computeScoring(createUniverse(rows), config).rows;
    expect(r[0].scores.cheap).toBe(98); // the lowest pegHist (100) and the second lowest P/E of 21 (95, F20 has 9)
    expect(r[19].scores.cheap).toBe(0); // the highest P/E and pegHist of the sector
    expect(r[20].scores.cheap).toBeNull(); // P/E alone is 1 of 7.5: still no data
  });
});

describe('buyRequiresScores.always: no buy zone without a Quality score, whatever its weight (owner N47 b, 2026-11-16)', () => {
  const config = loadScoringConfig();
  const qualityKeys = ['roic', 'grossMarginSlope3y', 'operatingMarginSlope3y', 'cfoToNi', 'fcfToNi'];
  // 25 volatile Financial Services stocks (FUTU's sector), the best one (k = 24) may lose its quality metrics like FUTU after the revenue sanity
  const build = (dropQuality: boolean, sector = 'Financial Services') => Array.from({ length: 25 }, (_, k) => {
    const m: M = { volatility1y: 60, pctFrom52wHigh: -k, pctFromAth: -k, range52w: 100 - 4 * k, sigmaFromMean60d: 2 - k / 5, debtToEquity: 3 - k / 10, netDebtToEbitda: 3 - k / 10, interestCoverage: k, altmanZ: 3 + k, piotroskiF: k % 10, niVolatility5y: 50 - k, fcfVolatility5y: 50 - k, roic: k, grossMarginSlope3y: k, operatingMarginSlope3y: k, cfoToNi: k, fcfToNi: k, peg: 3 - k / 10, pegHist: 3 - k / 10, pe: 30 - k, forwardPe: 30 - k };
    if (k === 24 && dropQuality) qualityKeys.forEach((key) => delete m[key]);
    return stock(`V${k}`, m, sector);
  });
  const last = (rows: ScreenerRow[], cfg = config) => computeScoring(createUniverse(rows), cfg).rows[24];
  const without = { ...config, buyRequiresScores: { ...(config.buyRequiresScores ?? { minWeight: 0.15 }), always: undefined } };

  test('the shipped config requires Quality, below minWeight for volatile, and validates; always takes known score ids only', () => {
    expect(config.buyRequiresScores?.always).toEqual(['quality']);
    expect(config.archetypes.volatile.scoreWeights.quality).toBeLessThan(config.buyRequiresScores?.minWeight ?? 0);
    expect(validateScoringConfig(config)).toEqual([]);
    const msg = 'buyRequiresScores.always needs a list of known score ids (cheap, quality, safety, dividend, entry)';
    expect(validateScoringConfig({ ...config, buyRequiresScores: { minWeight: 0.15, always: ['nope' as never] } })).toContain(msg);
    expect(validateScoringConfig({ ...config, buyRequiresScores: { minWeight: 0.15, always: 'quality' as never } })).toContain(msg);
  });

  test('a FUTU-like row (Buy zone total, empty Quality) is at most Watch with the reason, EN and RU; the Total does not count Quality as 0', () => {
    const rows = build(true);
    const r = last(rows);
    const before = last(rows, without);
    expect([before.scores.quality, before.status, before.missing]).toEqual([null, 'buy', []]);
    expect([r.scores.quality, r.status, r.missing, r.statusScore]).toEqual([null, 'watch', ['quality'], before.statusScore]);
    expect(whyParts(config, r, rows[24], 'en')).toContain('at most Watch: no data for the Quality score');
    expect(whyParts(config, r, rows[24], 'ru')).toContain('не выше «Наблюдать»: нет данных для оценки качества');
  });

  test('a row with a Quality score is unchanged by the rule', () => {
    const rows = build(false);
    const r = last(rows);
    expect(r.scores.quality).not.toBeNull();
    expect([r.status, r.missing, r.statusScore]).toEqual(['buy', [], last(rows, without).statusScore]);
  });

  test('exempt applies to the always scores too; the shipped config does not exempt Quality, so Financial Services need it', () => {
    expect((config.buyRequiresScores?.exempt ?? []).some((e) => e.score === 'quality')).toBe(false);
    const req = config.buyRequiresScores ?? { minWeight: 0.15 };
    const exempt = { ...config, buyRequiresScores: { ...req, exempt: [{ score: 'quality' as const, sector: ['Financial Services'] }] } };
    expect([last(build(true), exempt).status, last(build(true), exempt).missing]).toEqual(['buy', []]);
    expect([last(build(true, 'Technology'), exempt).status, last(build(true, 'Technology'), exempt).missing]).toEqual(['watch', ['quality']]);
  });
});
