/// <reference lib="esnext" />
/**
 * "Similar to X" (plan stage 6). Every metric of the chosen set becomes a percentile (0-100) among the securities of X's type,
 * the same rule as the engine: the share of the values that are strictly lower, ties share it, a metric with fewer than
 * `minGroup` values gives none. The distance of a candidate is the root mean square of the percentile gaps over the metrics
 * both have (an empty metric is left out pair by pair), similarity = 100 - distance. A candidate needs at least `minShare` of
 * X's usable metrics in common. The hits are the closest `top`, each with its `differences` largest gaps
 */
import { createRegistry, isNumericMetric, Registry } from '../metrics';
import { canonicalPreset, numeric, Preset, PRESET_SCHEMA_VERSION, ScreenerRow, uniqueId } from '../screener';
import { SIMILAR_CONFIG, SimilarConfig } from './config';

export type Difference = { metric: string; x: number; y: number; xPct: number; yPct: number; gap: number };
export type SimilarHit = { index: number; ticker: string; similarity: number; distance: number; common: number; differences: Difference[] };
export type SimilarResult = {
  /** metrics of the set X has a percentile for (in set order) */
  usable: string[];
  /** metrics of the set without a percentile for X: empty value, not in the feed or fewer than minGroup values */
  skipped: string[];
  /** common metrics a candidate needs */
  needed: number;
  hits: SimilarHit[];
};

/** Percentile tables by metric and type, built once per rows array */
export type SimilarContext = { rows: ScreenerRow[]; minGroup: number; tables: Record<string, Float64Array> };

export function createSimilarContext(rows: ScreenerRow[], minGroup: number = SIMILAR_CONFIG.minGroup): SimilarContext {
  return { rows, minGroup, tables: {} };
}

const valueOf = (row: ScreenerRow, metric: string): number | null => numeric(row.metrics[metric]);

/** Percentile of each row's metric among the rows of `type` (NaN: other type, no value, or fewer than minGroup values) */
export function typePercentiles(ctx: SimilarContext, metric: string, type: ScreenerRow['type']): Float64Array {
  const key = `${type}|${metric}`;
  const cached = ctx.tables[key];
  if (cached) return cached;
  const n = ctx.rows.length;
  const out = new Float64Array(n);
  out.fill(NaN);
  const members: number[] = [];
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const row = ctx.rows[i];
    if (row.type !== type) continue;
    const v = valueOf(row, metric);
    if (v === null) continue;
    values[i] = v;
    members.push(i);
  }
  if (members.length >= ctx.minGroup) {
    members.sort((a, b) => values[a] - values[b]);
    let below = 0;
    for (let j = 0; j < members.length; j += 1) {
      if (j > 0 && values[members[j]] !== values[members[j - 1]]) below = j;
      out[members[j]] = (below / members.length) * 100;
    }
  }
  ctx.tables[key] = out;
  return out;
}

const round = (v: number, digits: number): number => Math.round(v * 10 ** digits) / 10 ** digits;

/** The closest securities of X's type by the percentile vectors of `metrics`; unknown or non-numeric metrics are skipped */
export function similarTo(ctx: SimilarContext, xIndex: number, metrics: readonly string[], config: SimilarConfig = SIMILAR_CONFIG, registry: Registry = createRegistry()): SimilarResult {
  const x = ctx.rows[xIndex];
  const set = metrics.filter((m, k) => metrics.indexOf(m) === k && isNumericMetric(registry.byId[m]));
  const tables = set.map((m) => typePercentiles(ctx, m, x.type));
  const usableAt: number[] = [];
  set.forEach((_, k) => { if (!isNaN(tables[k][xIndex])) usableAt.push(k); });
  const usable = usableAt.map((k) => set[k]);
  const skipped = metrics.filter((m) => usable.indexOf(m) < 0);
  const needed = Math.max(1, Math.ceil(usable.length * config.minShare));
  const hits: SimilarHit[] = [];
  if (!usable.length) return { usable, skipped, needed, hits };
  ctx.rows.forEach((row, i) => {
    if (i === xIndex || row.type !== x.type || row.ticker === x.ticker) return;
    let sum = 0;
    let common = 0;
    const gaps: Difference[] = [];
    usableAt.forEach((k) => {
      const yPct = tables[k][i];
      if (isNaN(yPct)) return;
      const xPct = tables[k][xIndex];
      const gap = yPct - xPct;
      sum += gap * gap;
      common += 1;
      gaps.push({ metric: set[k], x: valueOf(x, set[k]) as number, y: valueOf(row, set[k]) as number, xPct, yPct, gap });
    });
    if (common < needed) return;
    const distance = Math.sqrt(sum / common);
    gaps.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || (a.metric < b.metric ? -1 : 1));
    hits.push({ index: i, ticker: row.ticker, similarity: round(100 - distance, 1), distance, common, differences: gaps.slice(0, config.differences) });
  });
  hits.sort((a, b) => a.distance - b.distance || b.common - a.common || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  return { usable, skipped, needed, hits: hits.slice(0, config.top) };
}

/** A bound with at most 6 significant digits (no floating noise such as 30.000000000000004 in the preset file) */
const tidy = (v: number): number => Number(v.toPrecision(6));

/**
 * "Make a filter from X": one range condition per metric of the set X has a value for, X's value ± tolerance × |value|
 * (0 stays [0, 0]). An own preset of X's type; null when X has none of the metrics
 */
export function filterFromX(x: ScreenerRow, metrics: readonly string[], options: { group: string; groupTitle?: { en: string; ru: string }; taken?: readonly string[]; tolerance?: number; registry?: Registry } = { group: 'custom' }): Preset | null {
  const registry = options.registry ?? createRegistry();
  const tolerance = options.tolerance ?? SIMILAR_CONFIG.tolerance;
  const conditions = metrics.filter((m, k) => metrics.indexOf(m) === k && isNumericMetric(registry.byId[m]) && valueOf(x, m) !== null).map((metric) => {
    const v = valueOf(x, metric) as number;
    const spread = Math.abs(v) * tolerance;
    return { metric, op: 'range' as const, value: [tidy(v - spread), tidy(v + spread)], scope: 'absolute' as const, missing: 'fail' as const };
  });
  if (!conditions.length) return null;
  const pct = Math.round(tolerance * 100);
  const group = options.groupTitle ?? { en: options.group, ru: options.group };
  return canonicalPreset({
    schemaVersion: PRESET_SCHEMA_VERSION,
    id: uniqueId(`like-${x.ticker}-${options.group}`, options.taken ?? []),
    title: { en: `Like ${x.ticker} (${group.en.toLowerCase()})`, ru: `Как ${x.ticker} (${group.ru.toLowerCase()})` },
    description: {
      en: `Made from ${x.ticker}: every ${group.en.toLowerCase()} metric it has, within ±${pct}% of its value`,
      ru: `Сделан из ${x.ticker}: каждая метрика группы «${group.ru.toLowerCase()}», которая у него есть, в пределах ±${pct}% от его значения`,
    },
    appliesTo: [x.type],
    match: 'all',
    conditions,
  });
}
