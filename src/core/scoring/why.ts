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
import { scoreSkipped, zeroScores } from './score';
import { type Rule, type RowScoring, SCORE_IDS, type ScoreId, type ScoringConfig, type Status } from './types';

const tr = (locale: Locale, key: string, params?: Params): string => format(DICTIONARIES[locale]?.[key] ?? DICTIONARIES.en[key] ?? key, params);

const trim = (text: string): string => (text.indexOf('.') >= 0 ? text.replace(/0+$/, '').replace(/\.$/, '') : text);

/** Large dollar amounts as $1.5B, $820M, $2T (market cap of the buy cap) */
const usdShort = (v: number): string => {
  const a = Math.abs(v);
  const [d, s] = a >= 1e12 ? [1e12, 'T'] : a >= 1e9 ? [1e9, 'B'] : [1e6, 'M'];
  return `${v < 0 ? '-' : ''}$${trim((a / d).toFixed(a / d >= 10 ? 0 : 1))}${s}`;
};

/** A metric value as the Why column shows it: 85%, 1.25, 7.5, yes */
export function formatValue(def: MetricDef | undefined, value: unknown, locale: Locale): string {
  if (typeof value === 'boolean') return tr(locale, value ? 'bool.true' : 'bool.false');
  const v = numeric(value);
  if (v === null) return typeof value === 'string' ? value : '';
  const unit = def ? def.unit : 'ratio';
  if (unit === 'percent') return `${trim(v.toFixed(Math.abs(v) >= 10 ? 0 : 1))}%`;
  if (unit === 'pp') return `${trim(v.toFixed(1))} ${tr(locale, 'scoring.pp')}`;
  if (unit === 'count') return trim(v.toFixed(1));
  if (unit === 'usd' && Math.abs(v) >= 1e6) return usdShort(v);
  return trim(v.toFixed(2));
}

/** "Cash runway 7.5 < 12" for a numeric comparison of a row; empty for = and in conditions (altmanVariant = classic) */
export function conditionText(condition: Condition, row: ScreenerRow, locale: Locale, registry: Registry = REGISTRY): string {
  if (['>', '>=', '<', '<='].indexOf(condition.op) < 0) return '';
  const def = registry.byId[condition.metric];
  const name = def ? pick(def.name, locale) : condition.metric;
  const threshold = def && def.unit === 'usd' ? formatValue(def, condition.value, locale) : String(condition.value);
  return `${name} ${formatValue(def, fieldValue(row, condition.metric), locale)} ${condition.op} ${threshold}`;
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

/** "no data for the Cheap score": the score's noData text of the config, else the generic one with its title */
export const noDataText = (config: ScoringConfig, id: ScoreId, locale: Locale): string => {
  const def = config.scores[id];
  return def && def.noData ? pick(def.noData, locale) : tr(locale, 'scoring.why.noData', { score: def ? pick(def.title, locale) : id });
};

const pctText = (share: number): string => `${trim((share * 100).toFixed(share * 100 >= 10 || Number.isInteger(share * 100) ? 0 : 1))}%`;

/**
 * Tooltip of the Total score cell: each score that counts times its archetype weight, heaviest first, and the total.
 * "Growth: quality 66 × 35% + entry point 53 × 30% + cheap 86 × 20% + safety 62 × 15% = 65". An empty heavy score counts as 0
 * and shows as "cheap (no data × 15% = 0)" with a line that says so; a lighter empty one is listed as "no data" (a non-payer's
 * Dividend as "no dividend") and the scaling of the other weights is spelled out on a second line
 */
export function totalScoreText(config: ScoringConfig, scoring: RowScoring, row: ScreenerRow, locale: Locale): string {
  const a = config.archetypes[scoring.archetype];
  if (!a) return '';
  const ids = SCORE_IDS.filter((id) => (a.scoreWeights[id] ?? 0) > 0 && config.scores[id].appliesTo.indexOf(row.type) >= 0)
    .sort((x, y) => a.scoreWeights[y] - a.scoreWeights[x] || SCORE_IDS.indexOf(x) - SCORE_IDS.indexOf(y));
  if (!ids.length) return '';
  const total = ids.reduce((s, id) => s + a.scoreWeights[id], 0);
  const name = (id: ScoreId) => pick(config.scores[id].title, locale).toLocaleLowerCase(locale);
  const zero = zeroScores(config, a.scoreWeights, scoring.scores, row);
  const empty = ids.filter((id) => scoring.scores[id] === null && zero.indexOf(id) < 0); // left out, the other weights scaled up
  const terms = ids.map((id) => {
    const v = scoring.scores[id];
    const w = pctText(a.scoreWeights[id] / total);
    if (zero.indexOf(id) >= 0) return `${name(id)} (${tr(locale, 'scoring.total.noData')} × ${w} = 0)`;
    const value = v !== null ? String(v) : tr(locale, scoreSkipped(config, id, row) ? 'scoring.total.noDividend' : 'scoring.total.noData');
    return `${name(id)} ${value} × ${w}`;
  });
  const head = `${archetypeText(config, scoring.archetype, locale)}: ${terms.join(' + ')}`;
  const weightOf = (list: ScoreId[]) => list.reduce((s, id) => s + a.scoreWeights[id], 0) / total;
  const data = weightOf(ids.filter((id) => scoring.scores[id] !== null));
  if (scoring.statusScore === null) return `${head}\n${tr(locale, 'scoring.total.none', { share: pctText(data), min: pctText(config.minWeightShare) })}`;
  const zeroLine = zero.length ? `\n${tr(locale, 'scoring.total.zero', { missing: zero.map(name).join(', '), min: pctText(config.buyRequiresScores ? config.buyRequiresScores.minWeight : 0) })}` : '';
  if (!empty.length) return `${head} = ${scoring.statusScore}${zeroLine}`;
  const share = data + weightOf(zero);
  return `${head}\n= ${Math.round(scoring.statusScore * share)} / ${pctText(share)} = ${scoring.statusScore}\n${tr(locale, 'scoring.total.scaled', { missing: empty.map(name).join(', '), share: pctText(share) })}${zeroLine}`;
}

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
  else if ((scoring.caps && scoring.caps.length) || (scoring.missing && scoring.missing.length)) {
    parts.push(tr(locale, 'scoring.why.buy', { score: scoring.statusScore, buy: a.buy, reject: a.reject }));
    (scoring.missing ?? []).forEach((id) => parts.push(tr(locale, 'scoring.why.cap', { reason: noDataText(config, id, locale) })));
    (scoring.caps ?? []).forEach((id) => {
      const rule = (config.buyCaps ?? []).filter((r) => r.id === id)[0];
      if (rule) parts.push(tr(locale, 'scoring.why.cap', { reason: ruleText(rule, row, locale, registry) }));
    });
  }
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
    // the group that fired (the rule's own conditions, else the first `or` group that holds); a soft group (match 1 of 2) shows only the conditions that hold
    const groups = [{ match: rule.match, conditions: rule.conditions }].concat(rule.or ?? []);
    const fired = groups.filter((g) => groupHolds(g.match, g.conditions, row))[0] ?? groups[0];
    const states = fired.conditions.filter((c) => c.enabled !== false && conditionHolds(c, row));
    return { id, title: ruleTitle(rule, row, locale, registry), detail: ruleText({ ...rule, conditions: states }, row, locale, registry) };
  });
}

/** true when enough enabled numeric conditions of a group hold with a value present */
function groupHolds(match: 'all' | number, conditions: Condition[], row: ScreenerRow): boolean {
  const enabled = conditions.filter((c) => c.enabled !== false);
  const held = enabled.filter((c) => fieldValue(row, c.metric) != null && conditionHolds(c, row)).length;
  return held >= (match === 'all' ? enabled.length : Math.min(match, enabled.length));
}

function conditionHolds(c: Condition, row: ScreenerRow): boolean {
  const v = numeric(fieldValue(row, c.metric));
  const t = numeric(c.value);
  if (v === null || t === null) return true;
  return c.op === '>' ? v > t : c.op === '>=' ? v >= t : c.op === '<' ? v < t : c.op === '<=' ? v <= t : true;
}
