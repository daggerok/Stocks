/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { Condition, Preset } from '../screener/types';
import type { ScoringConfig } from '../scoring/types';
import { computeSignals, isRestated, retained, type Signal, signalNames, signalPresets, signalsIssue, signalText, type SignalsDoc, SIGNALS_CONFIG, SIGNALS_SCHEMA_VERSION } from '.';
import { loadSignalSources } from './load';

type M = Record<string, unknown>;
const T = (en: string, ru = en) => ({ en, ru });
const c = (metric: string, op: Condition['op'], value: Condition['value']): Condition => ({ metric, op, value, scope: 'absolute', missing: 'fail' });
const NOW = new Date(Date.UTC(2026, 10, 12, 6));
const DAY = '2026-11-12';
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

/** One score (Cheap = P/E percentile in the sector, lower is better), one flag, one archetype rule: easy to follow by hand */
const SCORING: ScoringConfig = {
  schemaVersion: 1, minGroupSize: 3, minWeightShare: 0.5, colors: { good: 70, bad: 40 }, whyLimit: 3, defaultArchetype: 'stable',
  archetypes: {
    stable: { title: T('Stable', 'Стабильная'), scoreWeights: { cheap: 1, quality: 0, safety: 0, dividend: 0, entry: 0 }, buy: 60, reject: 40, stopFactors: [] },
    volatile: { title: T('Volatile', 'Волатильная'), scoreWeights: { cheap: 1, quality: 0, safety: 0, dividend: 0, entry: 0 }, buy: 60, reject: 40, stopFactors: [] },
  },
  archetypeRules: [{ id: 'volatile', archetype: 'volatile', title: T('volatile'), appliesTo: ['stock'], match: 'all', conditions: [c('volatility1y', '>=', 45)] }],
  scores: {
    cheap: { title: T('Cheap', 'Дёшево'), appliesTo: ['stock'], items: [{ metric: 'pe', weight: 1 }] },
    quality: { title: T('Quality'), appliesTo: ['stock'], items: [{ metric: 'roic', weight: 1 }] },
    safety: { title: T('Safety'), appliesTo: ['stock'], items: [{ metric: 'roic', weight: 1 }] },
    dividend: { title: T('Dividend'), appliesTo: ['stock'], payersOnly: true, items: [{ metric: 'dividendYield', weight: 1 }] },
    entry: { title: T('Entry'), appliesTo: ['stock'], items: [{ metric: 'roic', weight: 1 }] },
  },
  stopFactors: [],
  flags: [{ id: 'high-debt', title: T('Debt to equity above 2', 'Долг к капиталу выше 2'), appliesTo: ['stock'], match: 'all', conditions: [c('debtToEquity', '>', 2)] }],
  notes: [],
};
const preset = (id: string, conditions: Condition[], extra: Partial<Preset> = {}): Preset => ({ schemaVersion: 1, id, title: T(id), appliesTo: ['stock'], match: 'all', conditions, ...extra });
const CHEAP = preset('cheap', [c('pe', '<=', 15)]);
const PRESETS = [CHEAP];
const CONFIG = { ...SIGNALS_CONFIG, scoreDelta: 50 };

const row = (ticker: string, metrics: M, asOfDate = '2026-11-10', fy = '2025-12-31') => ({ ticker, sector: 'Technology', industry: 'Software', isMine: false, asOfDate, fundamentalsAsOf: fy, ttmAsOf: '2026-09-30', metrics: { marketCap: 1e10, ...metrics } });
const feed = (...companies: ReturnType<typeof row>[]) => ({ schemaVersion: 1, companies });
const BASE: Record<string, M> = {
  A: { pe: 20, debtToEquity: 1, volatility1y: 30 },
  B: { pe: 12, debtToEquity: 1, volatility1y: 30 },
  C: { pe: 14, debtToEquity: 1, volatility1y: 30 },
  D: { pe: 16, debtToEquity: 1, volatility1y: 30 },
};
const snap = (changes: Record<string, M> = {}, asOfDate = '2026-11-10', fy: Record<string, string> = {}) =>
  feed(...Object.keys(BASE).map((t) => row(t, { ...BASE[t], ...(changes[t] ?? {}) }, asOfDate, fy[t] ?? '2025-12-31')));
const tuple = (s: Signal) => [s.ticker, s.type, s.key, s.from, s.to, s.restated];
const run = (previous: ReturnType<typeof feed> | null, current: ReturnType<typeof feed>, state: SignalsDoc | null = null, now = NOW, quiet: string[] = [], presets = PRESETS) =>
  computeSignals({ previous, current, presets, scoring: SCORING, state, now, quiet, config: CONFIG });

describe('signals', () => {
  test('two snapshots give the expected list: preset entry, flag, status, archetype and a large score move', () => {
    // A: P/E 20 -> 10 enters Cheap, its Cheap score goes 0 -> 100 and the status Rejected -> Buy zone; C falls from 67 to 33
    // (Rejected) because A passed it; B's debt to equity crosses 2 in a new report; D's volatility makes it volatile
    const next = snap({ A: { pe: 10 }, B: { debtToEquity: 3 }, D: { volatility1y: 50 } }, '2026-11-11', { B: '2026-06-30' }); // B filed a new year
    const { added, doc, firstRun } = run(snap(), next);
    expect(firstRun).toBe(false);
    expect(added.map(tuple)).toEqual([
      ['A', 'preset-enter', 'cheap', null, null, false],
      ['A', 'status', null, 'rejected', 'buy', false],
      ['A', 'score', 'cheap', 0, 100, false],
      ['B', 'flag-new', 'high-debt', null, null, false],
      ['C', 'status', null, 'buy', 'rejected', false],
      ['D', 'archetype', null, 'stable', 'volatile', false],
    ]);
    expect(added.every((s) => s.date === DAY)).toBe(true);
    expect(doc.schemaVersion).toBe(SIGNALS_SCHEMA_VERSION);
    expect(doc.signals).toEqual(added);
    const names = signalNames(PRESETS, SCORING);
    expect(added.map((s) => signalText(s, names, 'en'))).toEqual(['entered cheap', 'status Rejected -> Buy zone', 'Cheap 0 -> 100', 'new flag: Debt to equity above 2', 'status Buy zone -> Rejected', 'archetype Stable -> Volatile']);
    expect(signalText(added[3], names, 'ru')).toBe('новый флаг: Долг к капиталу выше 2');
  });

  test('the first run (no previous index) gives no signals; an unchanged rerun gives none and keeps the state', () => {
    const first = run(null, snap());
    expect(first.firstRun).toBe(true);
    expect(first.added).toEqual([]);
    expect(first.doc.signals).toEqual([]);
    const again = run(snap(), snap(), first.doc);
    expect(again.added).toEqual([]);
    expect({ ...again.doc, generatedAt: '' }).toEqual({ ...first.doc, generatedAt: '' });
  });

  test('a quiet stock (failed source) gives no signals; a preset on a metric missing from a feed gives none', () => {
    const next = snap({ A: { pe: 10 }, B: { debtToEquity: 3 } });
    expect(run(snap(), next, null, NOW, ['a', 'B']).added.filter((s) => s.ticker === 'A' || s.ticker === 'B')).toEqual([]);
    const newMetric = preset('new-metric', [c('roic', '>', 10)]);
    const withRoic = snap({ A: { roic: 20 }, B: { roic: 20 }, C: { roic: 20 }, D: { roic: 20 } });
    expect(run(snap(), withRoic, null, NOW, [], [newMetric]).added.filter((s) => s.type === 'preset-enter')).toEqual([]);
    expect(signalPresets([CHEAP, preset('mine', [c('isMine', '=', true)]), preset('refine', [c('pe', '>', 0)], { refine: true }), preset('etf', [c('pe', '>', 0)], { appliesTo: ['etf'] })]).map((p) => p.id)).toEqual(['cheap']);
  });

  test('a preset exit needs two runs in a row with fresh data; coming back in between cancels it', () => {
    const out = (asOf: string) => snap({ C: { pe: 18 } }, asOf);
    const one = run(snap(), out('2026-11-11'));
    expect(one.added.filter((s) => s.type === 'preset-exit')).toEqual([]);
    expect(one.doc.pendingExits).toEqual([{ ticker: 'C', preset: 'cheap', since: DAY, runs: 1, asOf: '2026-11-11' }]);
    const same = run(out('2026-11-11'), out('2026-11-11'), one.doc, day(1));
    expect(same.added).toEqual([]); // the same data again is not a second run
    expect(same.doc.pendingExits.length).toBe(1);
    const two = run(out('2026-11-11'), out('2026-11-12'), same.doc, day(1));
    expect(two.added.map(tuple)).toEqual([['C', 'preset-exit', 'cheap', null, null, false]]);
    expect(two.doc.pendingExits).toEqual([]);
    const back = run(out('2026-11-11'), snap({}, '2026-11-12'), one.doc, day(1));
    expect(back.added.filter((s) => s.key === 'cheap')).toEqual([]); // no exit and no entry
    expect(back.doc.pendingExits).toEqual([]);
    expect(run(out('2026-11-11'), out('2026-11-12'), one.doc, day(1), ['C']).doc.pendingExits.length).toBe(1); // a quiet stock keeps its pending exit
  });

  test('restated past periods are marked; signals older than 12 weeks are dropped', () => {
    const next = snap({ B: { debtToEquity: 3 } });
    expect(run(snap(), next).added.map(tuple)).toEqual([['B', 'flag-new', 'high-debt', null, null, true]]); // same fiscal ends, SEC value moved
    const newYear = snap({ B: { debtToEquity: 3 } }, '2026-11-10', { B: '2026-06-30' });
    expect(run(snap(), newYear).added.map(tuple)).toEqual([['B', 'flag-new', 'high-debt', null, null, false]]);
    expect(isRestated(row('X', { pe: 10 }), row('X', { pe: 12 }))).toBe(false); // a price metric, not SEC
    const old = (date: string): Signal => ({ date, ticker: 'A', type: 'flag-new', key: 'high-debt', from: null, to: null, restated: false });
    const state: SignalsDoc = { schemaVersion: 1, generatedAt: '', retentionDays: 84, pendingExits: [], signals: [old('2026-08-20'), old('2026-08-19'), old('2026-11-01')] };
    expect(retained(state.signals, NOW, 84).map((s) => s.date)).toEqual(['2026-08-20', '2026-11-01']);
    expect(run(snap(), snap(), state).doc.signals.map((s) => s.date)).toEqual(['2026-11-01', '2026-08-20']);
  });
});

describe('signals 2', () => {
  test('weekly issue: title with the period, signals of the last 7 days grouped by type, ticker links; nothing to report gives 0', () => {
    const s = (date: string, ticker: string, type: Signal['type'], key: string | null, from: string | number | null = null, to: string | number | null = null): Signal => ({ date, ticker, type, key, from, to, restated: false });
    const doc: SignalsDoc = { schemaVersion: 1, generatedAt: '', retentionDays: 84, pendingExits: [], signals: [s('2026-11-12', 'BRK-B', 'preset-enter', 'cheap'), s('2026-11-06', 'A', 'status', null, 'watch', 'buy'), s('2026-11-05', 'OLD', 'preset-exit', 'cheap')] };
    const issue = signalsIssue(doc, { now: NOW, siteUrl: 'https://daggerok.github.io/Stocks', names: signalNames(PRESETS, SCORING) });
    expect(issue.title).toBe('Signals for 2026-11-06 - 2026-11-12');
    expect(issue.count).toBe(2);
    expect(issue.body).toContain('### Entered a preset (1)\n\n- 2026-11-12 [BRK-B](https://daggerok.github.io/Stocks/#ticker=BRK-B) entered cheap');
    expect(issue.body).toContain('### Status changed (1)\n\n- 2026-11-06 [A](https://daggerok.github.io/Stocks/#ticker=A) status Watch -> Buy zone');
    expect(issue.body).not.toContain('OLD');
    expect(signalsIssue(doc, { now: NOW, siteUrl: 'https://x/', names: signalNames([], null), limit: 1 }).body).toContain('1 more on the site: https://x/#signals');
    expect(signalsIssue(null, { now: NOW, siteUrl: 'https://x/', names: signalNames([], null) }).count).toBe(0);
  });

  test('the repo sources load: base presets, committed own presets, peers, scoring config; every base preset that may signal validates', () => {
    const sources = loadSignalSources();
    expect(sources.warnings).toEqual([]);
    expect(sources.presets.some((p) => p.id === 'cheap-earnings')).toBe(true);
    const ids = signalPresets(sources.presets).map((p) => p.id);
    expect(ids).not.toContain('mine');
    expect(ids).not.toContain('pays-dividend');
    expect(ids.length).toBeGreaterThan(5);
  });
});
