/// <reference lib="esnext" />
/**
 * Schema of the "Similar to X" config (plan stage 6, owner answer N33): src/core/similar/config.json holds the metric groups, how
 * many hits, the share of common metrics a pair needs, the smallest group a percentile is taken in, the sector size that switches
 * the comparison to the sector (owner answer N31) and the tolerance of "Make a filter from X". package.json copies it next to the
 * built page as similar.json, the page fetches it like scoring.json, so the numbers and lists change without code
 */
import { isNumericMetric, REGISTRY, type Registry, type Text } from '../metrics';

export const SIMILAR_SCHEMA_VERSION = 1;
/** Where the page fetches the config */
export const SIMILAR_CONFIG_URL = './similar.json';

export type SimilarGroup = { id: string; title: Text; metrics: string[] };
export type SimilarConfig = {
  schemaVersion: number;
  /** hits shown */
  top: number;
  /** a candidate needs at least this share of X's usable metrics in common (rounded up, at least 1) */
  minShare: number;
  /** a metric with fewer values in the compared group gives no percentile (same as the engine's MIN_GROUP) */
  minGroup: number;
  /** X's sector (fund category of an ETF) with at least this many rows of X's type: compare inside it, else the whole market of the type */
  minSectorRows: number;
  /** main differences listed per hit */
  differences: number;
  /** "Make a filter from X": each value of X widened by this share of its size in both directions (0.2 = ±20%) */
  tolerance: number;
  groups: SimilarGroup[];
};

const isNum = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
const hasText = (t: unknown): boolean => !!t && typeof t === 'object' && ['en', 'ru'].every((l) => typeof (t as Record<string, unknown>)[l] === 'string' && !!String((t as Record<string, unknown>)[l]).trim());

/** Every problem of the config as a readable line, empty = valid */
export function validateSimilarConfig(config: SimilarConfig, registry: Registry = REGISTRY): string[] {
  if (!config || typeof config !== 'object') return ['config is not an object'];
  const errors: string[] = [];
  if (config.schemaVersion !== SIMILAR_SCHEMA_VERSION) errors.push(`schemaVersion must be ${SIMILAR_SCHEMA_VERSION}`);
  (['top', 'minGroup', 'minSectorRows', 'differences'] as const).forEach((k) => { if (!isNum(config[k]) || config[k] < 1 || Math.round(config[k]) !== config[k]) errors.push(`${k} must be a whole number >= 1`); });
  if (!isNum(config.minShare) || config.minShare <= 0 || config.minShare > 1) errors.push('minShare must be above 0 and at most 1');
  if (!isNum(config.tolerance) || config.tolerance < 0) errors.push('tolerance must be a number >= 0');
  if (!Array.isArray(config.groups) || !config.groups.length) return errors.concat('groups must be a non-empty list');
  const seen: Record<string, boolean> = {};
  config.groups.forEach((g, i) => {
    const where = `group ${i + 1} (${g && g.id})`;
    if (!g || typeof g !== 'object') { errors.push(`${where}: not an object`); return; }
    if (typeof g.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(g.id) || g.id === 'custom') errors.push(`${where}: id must be lowercase letters, digits and hyphens, not custom`);
    else if (seen[g.id]) errors.push(`${where}: duplicate id`);
    seen[g.id] = true;
    if (!hasText(g.title)) errors.push(`${where}: title needs en and ru`);
    if (!Array.isArray(g.metrics) || !g.metrics.length) { errors.push(`${where}: no metrics`); return; }
    g.metrics.forEach((m) => { if (!isNumericMetric(registry.byId[m])) errors.push(`${where}: ${m} is not a numeric registry metric`); });
  });
  return errors;
}
