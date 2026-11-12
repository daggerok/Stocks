/// <reference lib="esnext" />
/**
 * Scoring (plan stage 5): five scores 0-100, archetype, status score, status, stop factors, flags and Why notes for every row of
 * a screener universe. No DOM: the page, tests and the signals job (plan stage 8) call the same functions.
 *
 * - a score metric becomes its percentile in the row's group with 100 = best: the sector of a stock (the whole stock market, every
 *   sector included, when the sector has fewer than minGroupSize values), the fund category of an ETF (owner answer N4; all ETFs
 *   when the category has fewer than minGroupSize values); ties share the mean rank
 * - a score is the weighted mean of the items with a value, empty below minWeightShare of the weight of the items that apply to
 *   the row type; the weights may differ per archetype
 * - the status score combines the scores with the archetype's score weights in the same way; a stop factor of the archetype
 *   rejects the row, otherwise the archetype's buy and reject thresholds decide
 */
import type { AssetType, Direction } from '../metrics/types';
import { evaluateCondition, evaluatePreset, fieldValue, numeric, PASS, percentiles, type Universe } from '../screener/engine';
import { type Preset, PRESET_SCHEMA_VERSION, type ScreenerRow } from '../screener/types';
import { type Rule, type RowScoring, SCORE_IDS, SCORE_METRICS, type ScoreDef, type ScoreId, type ScoreItem, type ScoringConfig, type Status, type Weight } from './types';

export type ScoringResult = { config: ScoringConfig; rows: RowScoring[] };

export const ruleAsPreset = (rule: Rule): Preset => ({ schemaVersion: PRESET_SCHEMA_VERSION, id: rule.id, title: rule.title, appliesTo: rule.appliesTo, match: rule.match, conditions: rule.conditions });

/** The rule's own conditions and each of its `or` groups as presets, in order */
export const ruleGroups = (rule: Rule): Preset[] => [ruleAsPreset(rule)].concat((rule.or ?? []).map((g, k) => ruleAsPreset({ ...rule, id: `${rule.id}#${k + 1}`, match: g.match, conditions: g.conditions, or: undefined })));

/** 1 for a row that passes the rule's own conditions or any of its `or` groups */
export function rulePass(universe: Universe, rule: Rule): Uint8Array {
  const groups = ruleGroups(rule).map((p) => evaluatePreset(universe, p).pass);
  if (groups.length === 1) return groups[0];
  const out = new Uint8Array(universe.rows.length);
  for (let i = 0; i < out.length; i += 1) for (let k = 0; k < groups.length && !out[i]; k += 1) out[i] = groups[k][i];
  return out;
}

export const weightOf = (weight: Weight, archetype: string): number => (typeof weight === 'number' ? weight : weight[archetype] ?? 0);

/** The direction an item is scored in: its own, else the registry's */
export function itemDirection(universe: Universe, item: ScoreItem): Direction {
  if (item.direction) return item.direction;
  const def = universe.registry.byId[item.metric];
  return def ? def.direction : 'neutral';
}

const appliesToType = (universe: Universe, metric: string, type: AssetType): boolean => {
  const def = universe.registry.byId[metric];
  return !!def && def.appliesTo.indexOf(type) >= 0;
};

/**
 * Percentile (0-100, 100 = best) of every row's value of `metric` in its group: sector of a stock or category of an ETF (the
 * stock market or all ETFs below minGroupSize values). NaN without a value or rejected by include; a group with one value gives 50
 */
export function groupPercentiles(universe: Universe, metric: string, direction: Direction, minGroupSize: number, include?: (row: ScreenerRow) => boolean): Float64Array {
  const rows = universe.rows;
  const n = rows.length;
  const out = new Float64Array(n);
  out.fill(NaN);
  const values = new Float64Array(n);
  const has = new Uint8Array(n);
  const sectorCount: Record<string, number> = {};
  for (let i = 0; i < n; i += 1) {
    const v = include && !include(rows[i]) ? null : numeric(fieldValue(rows[i], metric));
    if (v === null) continue;
    values[i] = v;
    has[i] = 1;
    if (rows[i].sector) { const g = `${rows[i].type}:${rows[i].sector}`; sectorCount[g] = (sectorCount[g] ?? 0) + 1; }
  }
  const groups: Record<string, number[]> = {};
  const rankedIn: string[] = new Array(n).fill(''); // the group whose ranking a row takes
  const push = (key: string, i: number) => (groups[key] || (groups[key] = [])).push(i);
  for (let i = 0; i < n; i += 1) {
    if (!has[i]) continue;
    const row = rows[i];
    const group = row.sector ? `${row.type}:${row.sector}` : '';
    const key = group && sectorCount[group] >= minGroupSize ? group : `${row.type}:`;
    rankedIn[i] = key;
    push(key, i);
    if (key !== `${row.type}:`) push(`${row.type}:`, i); // every row also counts in the market of its type a small sector or category falls back to
  }
  const sign = direction === 'lower-is-better' ? -1 : 1;
  Object.keys(groups).forEach((key) => {
    const members = groups[key].sort((a, b) => sign * (values[a] - values[b]));
    const m = members.length;
    let j = 0;
    while (j < m) {
      let k = j;
      while (k + 1 < m && values[members[k + 1]] === values[members[j]]) k += 1;
      const pct = m === 1 ? 50 : (((j + k) / 2) / (m - 1)) * 100; // mean rank of the tie, worst 0, best 100
      for (let x = j; x <= k; x += 1) if (rankedIn[members[x]] === key) out[members[x]] = pct;
      j = k + 1;
    }
  });
  return out;
}

const passes = (states: Uint8Array, i: number) => states[i] === PASS;

/** Every row's scores, archetype, status, stop factors, flags and notes */
export function computeScoring(universe: Universe, config: ScoringConfig): ScoringResult {
  const rows = universe.rows;
  const n = rows.length;
  const archetypeIds = Object.keys(config.archetypes);

  // 1. archetype: the first enabled rule that passes, else the default
  const archetype: string[] = new Array(n).fill(config.defaultArchetype);
  const decided = new Uint8Array(n);
  config.archetypeRules.filter((r) => r.enabled !== false).forEach((rule) => {
    const pass = rulePass(universe, rule);
    for (let i = 0; i < n; i += 1) if (!decided[i] && pass[i]) { archetype[i] = rule.archetype; decided[i] = 1; }
  });

  // 2. scores
  const tableCache: Record<string, Float64Array> = {};
  const isPayer = (row: ScreenerRow) => (numeric(row.metrics.dividendYield) ?? 0) > 0;
  const table = (metric: string, item: ScoreItem, payersOnly: boolean): Float64Array => {
    const scope = item.scope ?? 'sector';
    const direction = itemDirection(universe, { ...item, metric }); // a fallback metric (or) brings its own registry direction
    const key = `${metric}|${scope}|${direction}|${payersOnly}`;
    if (tableCache[key]) return tableCache[key];
    let out: Float64Array;
    if (scope === 'peers') {
      const raw = percentiles(universe, metric, 'peers'); // share strictly lower, 0-100
      out = new Float64Array(n);
      for (let i = 0; i < n; i += 1) out[i] = raw[i] !== raw[i] ? NaN : direction === 'lower-is-better' ? 100 - raw[i] : raw[i];
    } else out = groupPercentiles(universe, metric, direction, config.minGroupSize, payersOnly ? isPayer : undefined); // payers rank among payers
    tableCache[key] = out;
    return out;
  };
  const scores: Record<ScoreId, Float64Array> = {} as Record<ScoreId, Float64Array>;
  const adjusted: ScoreId[][] = rows.map(() => []);
  SCORE_IDS.forEach((id) => {
    const def: ScoreDef = config.scores[id];
    const out = new Float64Array(n);
    out.fill(NaN);
    scores[id] = out;
    for (let i = 0; i < n; i += 1) {
      const row = rows[i];
      if (def.appliesTo.indexOf(row.type) < 0) continue;
      if (def.payersOnly && !isPayer(row)) continue;
      let total = 0, avail = 0, sum = 0;
      def.items.forEach((item) => {
        const w = weightOf(item.weight, archetype[i]);
        const candidates = [item.metric].concat(item.or ?? []).filter((m) => appliesToType(universe, m, row.type));
        if (!(w > 0) || !candidates.length) return;
        total += w;
        let pct = NaN;
        for (let c = 0; c < candidates.length && pct !== pct; c += 1) {
          const metric = candidates[c];
          if (typeof item.good === 'boolean') {
            const v = fieldValue(row, metric);
            if (typeof v === 'boolean') pct = v === item.good ? 100 : 0;
          } else pct = table(metric, item, !!def.payersOnly)[i];
        }
        if (pct !== pct) return;
        avail += w;
        sum += w * pct;
      });
      if (!(total > 0) || avail < config.minWeightShare * total) continue;
      out[i] = sum / avail;
    }
    (def.adjust ?? []).forEach((a) => {
      const states = evaluateCondition(universe, a.when).states;
      for (let i = 0; i < n; i += 1) if (out[i] === out[i] && passes(states, i)) { out[i] *= a.factor; if (adjusted[i].indexOf(id) < 0) adjusted[i].push(id); }
    });
  });

  // 3. stop factors, flags and notes
  const stopPass: Record<string, Uint8Array> = {};
  config.stopFactors.filter((r) => r.enabled !== false).forEach((r) => { stopPass[r.id] = rulePass(universe, r); });
  const flagPass = config.flags.filter((r) => r.enabled !== false).map((r) => ({ id: r.id, pass: rulePass(universe, r) }));
  const noteStates = config.notes.map((note) => evaluateCondition(universe, note.condition).states);

  // 4. status per row
  const out: RowScoring[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const row = rows[i];
    const a = config.archetypes[archetype[i]] ?? config.archetypes[config.defaultArchetype] ?? config.archetypes[archetypeIds[0]];
    const rowScores = {} as Record<ScoreId, number | null>;
    let total = 0, avail = 0, sum = 0;
    SCORE_IDS.forEach((id) => {
      const v = scores[id][i];
      rowScores[id] = v === v ? Math.round(v) : null;
      const w = a.scoreWeights[id] ?? 0;
      if (!(w > 0) || config.scores[id].appliesTo.indexOf(row.type) < 0) return;
      total += w;
      if (v === v) { avail += w; sum += w * v; }
    });
    const statusScore = total > 0 && avail >= config.minWeightShare * total ? Math.round(sum / avail) : null;
    const stops = a.stopFactors.filter((id) => stopPass[id] && stopPass[id][i] === 1);
    let status: Status | null = null;
    if (stops.length) status = 'rejected';
    else if (statusScore !== null) status = statusScore >= a.buy ? 'buy' : statusScore < a.reject ? 'rejected' : 'watch';
    const notes: number[] = [];
    config.notes.forEach((note, k) => {
      if (note.archetypes && note.archetypes.indexOf(archetype[i]) < 0) return;
      if (passes(noteStates[k], i)) notes.push(k);
    });
    out[i] = {
      archetype: archetype[i], scores: rowScores, statusScore, status, stops,
      flags: flagPass.filter((f) => f.pass[i] === 1).map((f) => f.id), notes, adjusted: adjusted[i],
    };
  }
  return { config, rows: out };
}

/**
 * The rows with the scoring outputs added to `metrics` (scoreCheap ... scoreEntry, statusScore, archetype, status, flags,
 * flagCount), so presets and the signals job can read them like feed metrics. The input rows are not changed
 */
export function withScoreMetrics(rows: ScreenerRow[], result: ScoringResult): ScreenerRow[] {
  return rows.map((row, i) => {
    const r = result.rows[i];
    if (!r) return row;
    const extra: Record<string, unknown> = { statusScore: r.statusScore, archetype: r.archetype, status: r.status };
    SCORE_IDS.forEach((id) => { extra[SCORE_METRICS[id]] = r.scores[id]; });
    if (row.type === 'stock') { extra.flags = r.flags.length ? r.flags.join(' ') : null; extra.flagCount = r.flags.length; }
    return { ...row, metrics: { ...row.metrics, ...extra } };
  });
}
