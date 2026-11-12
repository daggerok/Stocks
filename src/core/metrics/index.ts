/// <reference lib="esnext" />
/** Metric registry API: the entries, lookup and the validator the CI test runs (every metric has name, short and guide in EN and RU) */
import { METRICS, REGISTRY_SCHEMA_VERSION } from './registry';
import type { MetricDef } from './types';

export { METRICS, REGISTRY_SCHEMA_VERSION };
export { isNumericMetric, NUMERIC_UNITS } from './types';
export type { AssetType, Basis, Direction, MetricDef, Source, Text, Unit } from './types';

const UNITS = ['percent', 'pp', 'ratio', 'usd', 'count', 'text', 'date', 'flag', 'category'];
const BASES = ['fy', 'ttm', 'forward', 'price', 'snapshot', 'calendar-year', 'issuer', 'history', 'meta'];
const SOURCES = ['sec', 'yahoo-summary', 'yahoo-chart', 'issuer', 'computed', 'feed', 'user', 'planned'];
const DIRECTIONS = ['higher-is-better', 'lower-is-better', 'neutral'];
const LANGS = ['en', 'ru'] as const;

export type Registry = { schemaVersion: number; metrics: MetricDef[]; byId: Record<string, MetricDef> };

export function createRegistry(metrics: MetricDef[] = METRICS): Registry {
  const byId: Record<string, MetricDef> = {};
  metrics.forEach((m) => { byId[m.id] = m; });
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, metrics, byId };
}

export const REGISTRY: Registry = createRegistry();
export const metricById = (id: string): MetricDef | undefined => REGISTRY.byId[id];

/** Every problem of the entries as a readable line; an empty list means the registry is valid */
export function validateRegistry(metrics: MetricDef[]): string[] {
  const errors: string[] = [];
  const seen: Record<string, boolean> = {};
  const text = (id: string, field: string, value: unknown) => {
    const pair = value as Record<string, unknown> | undefined;
    LANGS.forEach((lang) => {
      const v = pair ? pair[lang] : undefined;
      if (typeof v !== 'string' || !v.trim()) errors.push(`${id}: ${field}.${lang} is empty`);
      else if (/[\u2013\u2014]/.test(v)) errors.push(`${id}: ${field}.${lang} has an en or em dash`);
    });
  };
  metrics.forEach((m) => {
    const id = m && typeof m.id === 'string' && m.id ? m.id : '(no id)';
    if (seen[id]) errors.push(`${id}: duplicate id`);
    seen[id] = true;
    text(id, 'name', m.name);
    text(id, 'short', m.short);
    text(id, 'guide', m.guide);
    if (m.nullWhen) text(id, 'nullWhen', m.nullWhen);
    if (m.sectorNotes) text(id, 'sectorNotes', m.sectorNotes);
    if (typeof m.formula !== 'string' || !m.formula.trim()) errors.push(`${id}: formula is empty`);
    if (UNITS.indexOf(m.unit) < 0) errors.push(`${id}: unknown unit ${m.unit}`);
    if (BASES.indexOf(m.basis) < 0) errors.push(`${id}: unknown basis ${m.basis}`);
    if (SOURCES.indexOf(m.source) < 0) errors.push(`${id}: unknown source ${m.source}`);
    if (DIRECTIONS.indexOf(m.direction) < 0) errors.push(`${id}: unknown direction ${m.direction}`);
    if (!Array.isArray(m.appliesTo) || !m.appliesTo.length || m.appliesTo.some((t) => t !== 'stock' && t !== 'etf')) errors.push(`${id}: appliesTo must list stock and/or etf`);
  });
  return errors;
}

/** Feed keys without a registry entry */
export function unregisteredKeys(keys: readonly string[], registry: Registry = REGISTRY): string[] {
  return keys.filter((k) => !registry.byId[k]);
}
export { groupMetrics, metricGroup, METRIC_GROUPS } from './groups';
export type { MetricGroup } from './groups';
