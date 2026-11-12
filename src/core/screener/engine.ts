/// <reference lib="esnext" />
/**
 * Screener engine (plan stage 3). A universe holds the rows, the peer groups and lazily built percentile tables; a condition
 * gives every row PASS, FAIL or SKIP; a preset combines its conditions ("all" or the soft "N of M"), reports the funnel and
 * the metrics that are not in the feed yet. Rules: null is never 0; a relative scope reads the share of the group (rows with
 * a value) that is strictly lower, 0-100; a group with fewer than MIN_GROUP values behaves as missing; a condition on a metric
 * that does not apply to the row type (quickRatio for an ETF) is skipped; a row of a type the preset does not apply to fails;
 * the peers scope of a ticker without a peer group compares it with its industry (plan stage 6)
 */
import { createRegistry, isNumericMetric, Registry } from '../metrics';
import { Condition, Expression, HISTORY_METRICS, PeerGroups, Preset, RELATIVE_SCOPES, ScreenerRow, Scope } from './types';

export const MIN_GROUP = 5;
export const FAIL = 0;
export const PASS = 1;
export const SKIP = 2;

/** Row fields a condition can name besides the keys of `metrics` */
export const ROW_FIELDS: readonly string[] = ['ticker', 'type', 'sector', 'industry', 'isMine', 'size'];

export type ConditionStatus = 'ok' | 'unavailable' | 'invalid';
export type ConditionResult = { states: Uint8Array; status: ConditionStatus; passed: number };

export type Universe = {
  rows: ScreenerRow[];
  registry: Registry;
  /** peer group name of each row (first group in name order that lists the ticker), null without one */
  peerGroupOf: Array<string | null>;
  /** keys present in at least one row (a key with only nulls is present: the feed has it, the values are empty) */
  available: Record<string, boolean>;
  tables: Record<string, Float64Array>;
  conditionCache: Record<string, ConditionResult>;
};

export function createUniverse(rows: ScreenerRow[], options: { peers?: PeerGroups; registry?: Registry } = {}): Universe {
  const available: Record<string, boolean> = {};
  ROW_FIELDS.forEach((f) => { available[f] = true; });
  rows.forEach((row) => { for (const key in row.metrics) if (row.metrics[key] !== undefined) available[key] = true; });
  const groupOfTicker: Record<string, string> = {};
  const peers = options.peers ?? {};
  Object.keys(peers).sort().forEach((name) => {
    (peers[name] || []).forEach((t) => { const key = String(t).trim().toUpperCase().replace(/\./g, '-'); if (!groupOfTicker[key]) groupOfTicker[key] = name; });
  });
  return {
    rows,
    registry: options.registry ?? createRegistry(),
    peerGroupOf: rows.map((r) => groupOfTicker[r.ticker.toUpperCase()] ?? null),
    available,
    tables: {},
    conditionCache: {},
  };
}

export function fieldValue(row: ScreenerRow, field: string): unknown {
  switch (field) {
    case 'ticker': return row.ticker;
    case 'type': return row.type;
    case 'sector': return row.sector;
    case 'industry': return row.industry;
    case 'isMine': return row.isMine;
    case 'size': return row.size;
    default: return row.metrics[field];
  }
}

export const numeric = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);

function groupKey(universe: Universe, index: number, scope: Scope): string | null {
  const row = universe.rows[index];
  if (scope === 'market') return '';
  if (scope === 'sector') return row.sector || null;
  if (scope === 'industry') return row.industry || null;
  if (scope === 'peers') return universe.peerGroupOf[index];
  return null;
}

/**
 * Percentile (0-100) of each row's metric inside its scope group, NaN when the row has no value, no group or the group is under MIN_GROUP.
 * peers: a row without a peer group takes its percentile in the whole industry (every row of the industry, grouped or not)
 */
export function percentiles(universe: Universe, metric: string, scope: Scope): Float64Array {
  const cacheKey = `${metric}|${scope}`;
  const cached = universe.tables[cacheKey];
  if (cached) return cached;
  const n = universe.rows.length;
  const out = new Float64Array(n);
  out.fill(NaN);
  const groups: Record<string, number[]> = {};
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = numeric(fieldValue(universe.rows[i], metric));
    if (v === null) continue;
    const key = groupKey(universe, i, scope);
    if (key === null) continue;
    values[i] = v;
    (groups[key] || (groups[key] = [])).push(i);
  }
  for (const key in groups) {
    const members = groups[key];
    if (members.length < MIN_GROUP) continue;
    members.sort((a, b) => values[a] - values[b]);
    let below = 0;
    for (let j = 0; j < members.length; j += 1) {
      if (j > 0 && values[members[j]] !== values[members[j - 1]]) below = j; // ties share the count of strictly lower values
      out[members[j]] = (below / members.length) * 100;
    }
  }
  if (scope === 'peers') {
    const industry = percentiles(universe, metric, 'industry');
    for (let i = 0; i < n; i += 1) if (universe.peerGroupOf[i] === null) out[i] = industry[i];
  }
  universe.tables[cacheKey] = out;
  return out;
}

/** Builds the tables of every numeric registry metric present in the universe for the given scopes (the "once per universe" step) */
export function buildPercentileTables(universe: Universe, scopes: readonly Scope[] = RELATIVE_SCOPES): number {
  let built = 0;
  universe.registry.metrics.forEach((m) => {
    if (!isNumericMetric(m) || !universe.available[m.id]) return;
    scopes.forEach((scope) => { percentiles(universe, m.id, scope); built += 1; });
  });
  return built;
}

const lower = (v: unknown): unknown => (typeof v === 'string' ? v.toLowerCase() : v);
const isMissing = (v: unknown): boolean => v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v));

/** true or false for a present value; the caller handles missing values */
export function compare(v: unknown, op: Condition['op'], target: Condition['value']): boolean {
  if (op === 'in') return Array.isArray(target) && target.some((t) => lower(t) === lower(v));
  if (op === 'range') {
    const x = numeric(v);
    if (x === null || !Array.isArray(target)) return false;
    const lo = numeric(target[0]), hi = numeric(target[1]);
    return (lo === null || x >= lo) && (hi === null || x <= hi);
  }
  if (op === '=') return lower(v) === lower(target);
  const x = numeric(v), t = numeric(target);
  if (x === null || t === null) return false;
  if (op === '>') return x > t;
  if (op === '>=') return x >= t;
  if (op === '<') return x < t;
  return x <= t;
}

export const conditionKey = (c: Condition): string => JSON.stringify([c.metric, c.op, c.value, c.scope ?? 'absolute', c.missing ?? 'fail']);

export function evaluateCondition(universe: Universe, condition: Condition): ConditionResult {
  const key = conditionKey(condition);
  const cached = universe.conditionCache[key];
  if (cached) return cached;
  const { rows } = universe;
  const states = new Uint8Array(rows.length);
  const def = universe.registry.byId[condition.metric];
  const scope: Scope = condition.scope ?? 'absolute';
  const onMissing = condition.missing === 'skip' ? SKIP : FAIL;
  const relative = RELATIVE_SCOPES.indexOf(scope) >= 0;
  let status: ConditionStatus = 'ok';
  if (!def || (scope === 'history' && HISTORY_METRICS.indexOf(condition.metric) < 0) || (relative && !isNumericMetric(def))) status = 'invalid';
  else if (!universe.available[condition.metric]) status = 'unavailable';
  const table = status === 'ok' && relative ? percentiles(universe, condition.metric, scope) : null;
  let passed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (def && def.appliesTo.indexOf(rows[i].type) < 0) { states[i] = SKIP; continue; }
    if (status !== 'ok') { states[i] = onMissing; continue; }
    const v = table ? table[i] : fieldValue(rows[i], condition.metric);
    if (isMissing(v)) { states[i] = onMissing; continue; }
    const ok = compare(v, condition.op, condition.value);
    states[i] = ok ? PASS : FAIL;
    if (ok) passed += 1;
  }
  const result = { states, status, passed };
  universe.conditionCache[key] = result;
  return result;
}

export type FunnelStep = { index: number; metric: string; op: Condition['op']; scope: Scope; status: ConditionStatus; left: number };
export type PresetResult = {
  id: string;
  /** 1 for a row that matches */
  pass: Uint8Array;
  count: number;
  /** rows of the preset's types, before any condition */
  start: number;
  /** rows still able to match after each enabled condition in order; the last step equals count */
  funnel: FunnelStep[];
  unavailable: string[];
  invalid: string[];
};

export function evaluatePreset(universe: Universe, preset: Preset): PresetResult {
  const { rows } = universe;
  const n = rows.length;
  const conditions = preset.conditions.filter((c) => c.enabled !== false);
  const results = conditions.map((c) => evaluateCondition(universe, c));
  const m = conditions.length;
  const typeOk = new Uint8Array(n);
  const needed = new Int32Array(n);
  const applicableAfter: Int32Array[] = []; // applicableAfter[k][i]: non-skipped conditions with index >= k
  for (let k = 0; k <= m; k += 1) applicableAfter.push(new Int32Array(n));
  let start = 0;
  for (let i = 0; i < n; i += 1) {
    typeOk[i] = preset.appliesTo.indexOf(rows[i].type) >= 0 ? 1 : 0;
    start += typeOk[i];
    for (let k = m - 1; k >= 0; k -= 1) applicableAfter[k][i] = applicableAfter[k + 1][i] + (results[k].states[i] === SKIP ? 0 : 1);
    const applicable = applicableAfter[0][i];
    needed[i] = preset.match === 'all' ? applicable : Math.min(preset.match, applicable);
  }
  const passedSoFar = new Int32Array(n);
  const funnel: FunnelStep[] = [];
  for (let k = 0; k < m; k += 1) {
    const states = results[k].states;
    let left = 0;
    for (let i = 0; i < n; i += 1) {
      if (states[i] === PASS) passedSoFar[i] += 1;
      if (typeOk[i] && passedSoFar[i] + applicableAfter[k + 1][i] >= needed[i]) left += 1;
    }
    const c = conditions[k];
    funnel.push({ index: preset.conditions.indexOf(c), metric: c.metric, op: c.op, scope: c.scope ?? 'absolute', status: results[k].status, left });
  }
  const pass = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i += 1) if (typeOk[i] && passedSoFar[i] >= needed[i]) { pass[i] = 1; count += 1; }
  const names = (status: ConditionStatus) => conditions.filter((_, k) => results[k].status === status).map((c) => c.metric).filter((v, k, all) => all.indexOf(v) === k);
  return { id: preset.id, pass, count, start, funnel, unavailable: names('unavailable'), invalid: names('invalid') };
}

export function evaluatePresets(universe: Universe, presets: Preset[]): Record<string, PresetResult> {
  const out: Record<string, PresetResult> = {};
  presets.forEach((p) => { out[p.id] = evaluatePreset(universe, p); });
  return out;
}

/** and/or/not over preset ids; an unknown id throws (an expression must not silently match nothing) */
export function evaluateExpression(universe: Universe, expression: Expression, presets: Record<string, Preset>, results: Record<string, PresetResult> = {}): Uint8Array {
  const n = universe.rows.length;
  if (typeof expression === 'string') {
    if (!results[expression]) {
      const preset = presets[expression];
      if (!preset) throw new Error(`unknown preset in expression: ${expression}`);
      results[expression] = evaluatePreset(universe, preset);
    }
    return results[expression].pass;
  }
  const out = new Uint8Array(n);
  if ('not' in expression) {
    const inner = evaluateExpression(universe, expression.not, presets, results);
    for (let i = 0; i < n; i += 1) out[i] = inner[i] ? 0 : 1;
    return out;
  }
  const isAnd = 'and' in expression;
  const parts = (isAnd ? (expression as { and: Expression[] }).and : (expression as { or: Expression[] }).or).map((e) => evaluateExpression(universe, e, presets, results));
  for (let i = 0; i < n; i += 1) {
    let v = isAnd ? 1 : 0;
    for (let k = 0; k < parts.length; k += 1) v = isAnd ? v & parts[k][i] : v | parts[k][i];
    out[i] = v;
  }
  return out;
}

/** counts[i][j] = rows matching both presets i and j; the diagonal is each preset's own count */
export function intersections(results: PresetResult[]): { ids: string[]; counts: number[][] } {
  const counts = results.map((a) => results.map((b) => {
    let c = 0;
    for (let i = 0; i < a.pass.length; i += 1) c += a.pass[i] & b.pass[i];
    return c;
  }));
  return { ids: results.map((r) => r.id), counts };
}

export const tickersOf = (universe: Universe, pass: Uint8Array): string[] => universe.rows.filter((_, i) => pass[i]).map((r) => r.ticker);
