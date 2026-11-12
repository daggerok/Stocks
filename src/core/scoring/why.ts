/// <reference lib="esnext" />
/**
 * Texts of the scoring in a given language (no DOM): the Why column (archetype, stop factor or status rule, config notes), the
 * flag titles with their numbers and the status names. The page passes the current locale, so a language switch changes them
 */
import { DICTIONARIES, format, type Locale, type Params, pick } from '../i18n';
import { REGISTRY, type Registry } from '../metrics';
import type { MetricDef } from '../metrics/types';
import { fieldValue, numeric } from '../screener/engine';
import type { Condition, ScreenerRow } from '../screener/types';
import type { Rule, RowScoring, ScoringConfig, Status } from './types';

const tr = (locale: Locale, key: string, params?: Params): string => format(DICTIONARIES[locale]?.[key] ?? DICTIONARIES.en[key] ?? key, params);

const trim = (text: string): string => (text.indexOf('.') >= 0 ? text.replace(/0+$/, '').replace(/\.$/, '') : text);

/** A metric value as the Why column shows it: 85%, 1.25, 7.5, yes */
export function formatValue(def: MetricDef | undefined, value: unknown, locale: Locale): string {
  if (typeof value === 'boolean') return tr(locale, value ? 'bool.true' : 'bool.false');
  const v = numeric(value);
  if (v === null) return typeof value === 'string' ? value : '';
  const unit = def ? def.unit : 'ratio';
  if (unit === 'percent') return `${trim(v.toFixed(Math.abs(v) >= 10 ? 0 : 1))}%`;
  if (unit === 'pp') return `${trim(v.toFixed(1))} ${tr(locale, 'scoring.pp')}`;
  if (unit === 'count') return trim(v.toFixed(1));
  return trim(v.toFixed(2));
}

/** "Cash runway 7.5 < 12" for a numeric comparison of a row; empty for = and in conditions (altmanVariant = classic) */
export function conditionText(condition: Condition, row: ScreenerRow, locale: Locale, registry: Registry = REGISTRY): string {
  if (['>', '>=', '<', '<='].indexOf(condition.op) < 0) return '';
  const def = registry.byId[condition.metric];
  const name = def ? pick(def.name, locale) : condition.metric;
  return `${name} ${formatValue(def, fieldValue(row, condition.metric), locale)} ${condition.op} ${condition.value}`;
}

/** A rule title with `{metricId}` placeholders filled from the row: "Large change of {balanceYoyMaxLine} in a year" -> "... of debt ..." */
export function ruleTitle(rule: Rule, row: ScreenerRow, locale: Locale, registry: Registry = REGISTRY): string {
  return pick(rule.title, locale).replace(/\{(\w+)\}/g, (whole, id: string) => (registry.byId[id] ? formatValue(registry.byId[id], fieldValue(row, id), locale) : whole));
}

/** Title of a rule with the numbers behind it: "Cash for less than 12 months: Cash runway 7.5 < 12" */
export function ruleText(rule: Rule, row: ScreenerRow, locale: Locale, registry: Registry = REGISTRY): string {
  const parts = rule.conditions.filter((c) => c.enabled !== false).map((c) => conditionText(c, row, locale, registry)).filter(Boolean);
  const title = ruleTitle(rule, row, locale, registry);
  return parts.length ? `${title}: ${parts.join(', ')}` : title;
}

export const statusText = (status: Status | null, locale: Locale): string => (status ? tr(locale, `scoring.status.${status}`) : '');
export const archetypeText = (config: ScoringConfig, archetype: string, locale: Locale): string => {
  const a = config.archetypes[archetype];
  return a ? pick(a.title, locale) : archetype;
};

/** The reasons of the Why column in order, at most config.whyLimit */
export function whyParts(config: ScoringConfig, scoring: RowScoring, row: ScreenerRow, locale: Locale, registry: Registry = REGISTRY): string[] {
  const parts: string[] = [archetypeText(config, scoring.archetype, locale)];
  const a = config.archetypes[scoring.archetype];
  if (scoring.stops.length) {
    scoring.stops.forEach((id) => {
      const rule = config.stopFactors.filter((r) => r.id === id)[0];
      if (rule) parts.push(tr(locale, 'scoring.why.stop', { reason: ruleText(rule, row, locale, registry) }));
    });
  } else if (scoring.statusScore === null || !a) parts.push(tr(locale, 'scoring.why.none'));
  else parts.push(tr(locale, `scoring.why.${scoring.status}`, { score: scoring.statusScore, buy: a.buy, reject: a.reject }));
  scoring.notes.forEach((k) => {
    const note = config.notes[k];
    if (!note) return;
    const def = registry.byId[note.condition.metric];
    const value = fieldValue(row, note.condition.metric);
    parts.push(format(pick(note.text, locale), { value: formatValue(def, value, locale), threshold: String(note.condition.value) }));
  });
  return parts.slice(0, Math.max(1, config.whyLimit));
}

export const whyText = (config: ScoringConfig, scoring: RowScoring, row: ScreenerRow, locale: Locale, registry: Registry = REGISTRY): string =>
  whyParts(config, scoring, row, locale, registry).join('; ');

/** Each firing flag as its title and numbers, in config order */
export function flagTexts(config: ScoringConfig, scoring: RowScoring, row: ScreenerRow, locale: Locale, registry: Registry = REGISTRY): Array<{ id: string; title: string; detail: string }> {
  return scoring.flags.map((id) => {
    const rule = config.flags.filter((r) => r.id === id)[0];
    if (!rule) return { id, title: id, detail: id };
    // a soft rule (match 1 of 2) shows only the conditions that hold
    const states = rule.conditions.filter((c) => c.enabled !== false && conditionHolds(c, row));
    return { id, title: ruleTitle(rule, row, locale, registry), detail: ruleText({ ...rule, conditions: states }, row, locale, registry) };
  });
}

function conditionHolds(c: Condition, row: ScreenerRow): boolean {
  const v = numeric(fieldValue(row, c.metric));
  const t = numeric(c.value);
  if (v === null || t === null) return true;
  return c.op === '>' ? v > t : c.op === '>=' ? v >= t : c.op === '<' ? v < t : c.op === '<=' ? v <= t : true;
}
