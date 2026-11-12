/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { createUniverse } from '../screener/engine';
import type { Condition, ScreenerRow } from '../screener/types';
import { computeScoring, type ScoringConfig, SCORE_IDS, validateScoringConfig, whyParts, withScoreMetrics, flagTexts } from '.';
import { loadScoringConfig } from './load-config';

type M = Record<string, unknown>;
const stock = (ticker: string, metrics: M, sector = 'Technology'): ScreenerRow => ({ ticker, type: 'stock', sector, industry: 'Software', isMine: false, size: 1e10, metrics });
const etf = (ticker: string, metrics: M): ScreenerRow => ({ ticker, type: 'etf', sector: null, industry: null, isMine: false, size: 1e9, metrics });
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

  test('ETFs get only Entry point (no EPS adjustment) and Dividend; the other scores stay empty', () => {
    const rows = [1, 2, 3, 4, 5].map((k) => etf(`E${k}`, { pctFrom52wHigh: -5 * k, pctFromAth: -10 * k, range52w: 100 - 20 * k, sigmaFromMean60d: 3 - k, dividendYield: k, epsRevision30d: -10, pe: 10 * k, roic: 10, debtToEquity: 1 }));
    const r = computeScoring(createUniverse(rows), config).rows;
    expect(r.map((x) => x.scores.entry)).toEqual([0, 25, 50, 75, 100]); // deeper drop and lower in the range = better entry, never lowered
    expect(r.map((x) => x.scores.dividend)).toEqual([0, 25, 50, 75, 100]); // the yield only
    expect(r.every((x) => x.scores.cheap === null && x.scores.quality === null && x.scores.safety === null && x.adjusted.length === 0)).toBe(true);
    expect(r.every((x) => x.status !== null && x.statusScore !== null)).toBe(true); // statuses from the scores that apply to ETFs
    expect(SCORE_IDS.length).toBe(5);
  });
});
