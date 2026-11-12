/// <reference lib="esnext" />
/** Validation of the scoring config against its schema and the metric registry: every problem as a readable line, empty = valid */
import { isNumericMetric, REGISTRY, type Registry } from '../metrics';
import { validatePreset } from '../screener/validate';
import { ruleAsPreset } from './score';
import { type Note, type Rule, SCORE_IDS, SCORING_SCHEMA_VERSION, type ScoreItem, type ScoringConfig } from './types';

const isNum = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
const hasText = (t: unknown): boolean => !!t && typeof t === 'object' && ['en', 'ru'].every((l) => typeof (t as Record<string, unknown>)[l] === 'string' && !!String((t as Record<string, unknown>)[l]).trim());
const DIRECTIONS = ['higher-is-better', 'lower-is-better'];

function ruleErrors(rule: Rule, where: string, registry: Registry): string[] {
  if (!rule || typeof rule !== 'object') return [`${where}: not an object`];
  const errors = validatePreset(ruleAsPreset(rule), registry).map((e) => `${where}: ${e}`);
  if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') errors.push(`${where}: enabled must be true or false`);
  if (rule.or !== undefined && !Array.isArray(rule.or)) errors.push(`${where}: or must be a list of { match, conditions }`);
  else (rule.or ?? []).forEach((g, k) => {
    if (!g || typeof g !== 'object') { errors.push(`${where} or ${k + 1}: not an object`); return; }
    errors.push(...validatePreset(ruleAsPreset({ ...rule, match: g.match, conditions: g.conditions }), registry).map((e) => `${where} or ${k + 1}: ${e}`));
  });
  return errors;
}

function itemErrors(item: ScoreItem, where: string, archetypes: string[], registry: Registry): string[] {
  const errors: string[] = [];
  const metrics = [item.metric].concat(Array.isArray(item.or) ? item.or : []);
  metrics.forEach((m) => {
    const def = registry.byId[m];
    if (!def) { errors.push(`${where}: unknown metric ${m}`); return; }
    if (typeof item.good === 'boolean') { if (def.unit !== 'flag') errors.push(`${where}: good needs a flag metric, ${m} is ${def.unit}`); return; }
    if (!isNumericMetric(def)) errors.push(`${where}: ${m} is not numeric`);
    const direction = item.direction ?? def.direction;
    if (DIRECTIONS.indexOf(direction) < 0) errors.push(`${where}: ${m} needs a direction (the registry says ${def.direction})`);
  });
  if (item.direction !== undefined && DIRECTIONS.indexOf(item.direction) < 0) errors.push(`${where}: direction must be higher-is-better or lower-is-better`);
  if (item.scope !== undefined && item.scope !== 'sector' && item.scope !== 'peers') errors.push(`${where}: scope must be sector or peers`);
  const w = item.weight;
  if (isNum(w)) { if (w < 0) errors.push(`${where}: weight below 0`); }
  else if (w && typeof w === 'object') {
    Object.keys(w).forEach((k) => {
      if (archetypes.indexOf(k) < 0) errors.push(`${where}: weight for unknown archetype ${k}`);
      if (!isNum(w[k]) || w[k] < 0) errors.push(`${where}: weight of ${k} must be a number >= 0`);
    });
  } else errors.push(`${where}: weight must be a number or { archetype: number }`);
  return errors;
}

export function validateScoringConfig(config: ScoringConfig, registry: Registry = REGISTRY): string[] {
  if (!config || typeof config !== 'object') return ['config is not an object'];
  const errors: string[] = [];
  if (config.schemaVersion !== SCORING_SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCORING_SCHEMA_VERSION}`);
  if (!isNum(config.minGroupSize) || config.minGroupSize < 1) errors.push('minGroupSize must be a number >= 1');
  if (!isNum(config.minWeightShare) || config.minWeightShare <= 0 || config.minWeightShare > 1) errors.push('minWeightShare must be above 0 and at most 1');
  if (!config.colors || !isNum(config.colors.good) || !isNum(config.colors.bad) || config.colors.bad > config.colors.good) errors.push('colors needs good >= bad');
  if (!isNum(config.whyLimit) || config.whyLimit < 1) errors.push('whyLimit must be a number >= 1');
  const archetypes = config.archetypes && typeof config.archetypes === 'object' ? Object.keys(config.archetypes) : [];
  if (!archetypes.length) errors.push('no archetypes');
  if (archetypes.indexOf(config.defaultArchetype) < 0) errors.push(`defaultArchetype ${config.defaultArchetype} is not an archetype`);
  const stopIds = Array.isArray(config.stopFactors) ? config.stopFactors.map((r) => r && r.id) : [];
  archetypes.forEach((id) => {
    const a = config.archetypes[id];
    const where = `archetype ${id}`;
    if (!/^[a-z][a-z0-9-]*$/.test(id)) errors.push(`${where}: id must be lowercase letters, digits and hyphens`);
    if (!hasText(a.title)) errors.push(`${where}: title needs en and ru`);
    const weights = a.scoreWeights && typeof a.scoreWeights === 'object' ? a.scoreWeights : ({} as Record<string, number>);
    Object.keys(weights).forEach((k) => { if (SCORE_IDS.indexOf(k as never) < 0) errors.push(`${where}: unknown score ${k}`); });
    if (!SCORE_IDS.every((k) => isNum(weights[k]) && weights[k] >= 0)) errors.push(`${where}: scoreWeights needs a number >= 0 for ${SCORE_IDS.join(', ')}`);
    else if (!(SCORE_IDS.reduce((s, k) => s + weights[k], 0) > 0)) errors.push(`${where}: scoreWeights sum to 0`);
    if (!isNum(a.buy) || !isNum(a.reject) || a.reject > a.buy || a.reject < 0 || a.buy > 100) errors.push(`${where}: needs 0 <= reject <= buy <= 100`);
    (Array.isArray(a.stopFactors) ? a.stopFactors : []).forEach((s) => { if (stopIds.indexOf(s) < 0) errors.push(`${where}: unknown stop factor ${s}`); });
    if (!Array.isArray(a.stopFactors)) errors.push(`${where}: stopFactors must be a list`);
  });
  const seen: Record<string, boolean> = {};
  const unique = (id: string, where: string) => { if (seen[id]) errors.push(`${where}: duplicate rule id ${id}`); seen[id] = true; };
  (Array.isArray(config.archetypeRules) ? config.archetypeRules : []).forEach((r, i) => {
    const where = `archetypeRules ${i + 1} (${r && r.id})`;
    errors.push(...ruleErrors(r, where, registry));
    if (r && archetypes.indexOf(r.archetype) < 0) errors.push(`${where}: unknown archetype ${r.archetype}`);
    if (r) unique(r.id, where);
  });
  if (!Array.isArray(config.archetypeRules)) errors.push('archetypeRules must be a list');
  SCORE_IDS.forEach((id) => {
    const s = config.scores ? config.scores[id] : undefined;
    const where = `score ${id}`;
    if (!s) { errors.push(`${where}: missing`); return; }
    if (!hasText(s.title)) errors.push(`${where}: title needs en and ru`);
    if (!Array.isArray(s.appliesTo) || !s.appliesTo.length || s.appliesTo.some((t) => t !== 'stock' && t !== 'etf')) errors.push(`${where}: appliesTo must list stock and/or etf`);
    if (!Array.isArray(s.items) || !s.items.length) errors.push(`${where}: no items`);
    else s.items.forEach((item, k) => errors.push(...itemErrors(item, `${where} item ${k + 1} (${item && item.metric})`, archetypes, registry)));
    (s.adjust ?? []).forEach((a, k) => {
      const at = `${where} adjust ${k + 1}`;
      if (!isNum(a.factor) || a.factor < 0) errors.push(`${at}: factor must be a number >= 0`);
      errors.push(...ruleErrors({ id: 'adjust', title: s.title, appliesTo: s.appliesTo, match: 'all', conditions: [a.when] }, at, registry));
    });
  });
  (['stopFactors', 'flags'] as const).forEach((key) => {
    const list = config[key];
    if (!Array.isArray(list)) { errors.push(`${key} must be a list`); return; }
    list.forEach((r, i) => { const where = `${key} ${i + 1} (${r && r.id})`; errors.push(...ruleErrors(r, where, registry)); if (r) unique(r.id, where); });
  });
  (Array.isArray(config.notes) ? config.notes : []).forEach((note: Note, i) => {
    const where = `notes ${i + 1}`;
    if (!hasText(note.text)) errors.push(`${where}: text needs en and ru`);
    (note.archetypes ?? []).forEach((a) => { if (archetypes.indexOf(a) < 0) errors.push(`${where}: unknown archetype ${a}`); });
    errors.push(...ruleErrors({ id: 'note', title: note.text, appliesTo: ['stock', 'etf'], match: 'all', conditions: [note.condition] }, where, registry));
  });
  if (!Array.isArray(config.notes)) errors.push('notes must be a list');
  return errors;
}
