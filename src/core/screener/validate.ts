/// <reference lib="esnext" />
/** Preset validation against the schema and the metric registry: every problem as a readable line, empty = valid */
import { isNumericMetric, REGISTRY, Registry } from '../metrics';
import { BENCHMARK_TICKER, Condition, HISTORY_METRICS, OPS, Preset, PRESET_SCHEMA_VERSION, RELATIVE_SCOPES, SCOPES } from './types';
import { pickerCombinations, unresolvedTokens, withPickers } from './variants';

const isNum = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
const hasText = (t: unknown): boolean => !!t && typeof t === 'object' && ['en', 'ru'].every((l) => typeof (t as Record<string, unknown>)[l] === 'string' && !!String((t as Record<string, unknown>)[l]).trim());

function conditionErrors(c: Condition, where: string, registry: Registry): string[] {
  const errors: string[] = [];
  const def = registry.byId[c.metric];
  const scope = c.scope ?? 'absolute';
  const tokens = unresolvedTokens(c);
  if (tokens.length) return [`${where}: unknown token ${tokens.join(', ')}`];
  if (!def) return [`${where}: unknown metric ${c.metric}`];
  if (OPS.indexOf(c.op) < 0) errors.push(`${where}: unknown op ${c.op}`);
  if (SCOPES.indexOf(scope) < 0) errors.push(`${where}: unknown scope ${scope}`);
  if (c.missing !== undefined && c.missing !== 'fail' && c.missing !== 'skip') errors.push(`${where}: missing must be fail or skip`);
  if (scope === 'history' && HISTORY_METRICS.indexOf(c.metric) < 0) errors.push(`${where}: scope history only reads ${HISTORY_METRICS.join(', ')}`);
  if (scope === 'benchmark') {
    if (!isNumericMetric(def)) errors.push(`${where}: scope benchmark needs a numeric metric`);
    if (typeof c.benchmark !== 'string' || !BENCHMARK_TICKER.test(c.benchmark)) errors.push(`${where}: scope benchmark needs a ticker in benchmark`);
    if (['>', '>=', '<', '<=', 'range'].indexOf(c.op) < 0) errors.push(`${where}: scope benchmark compares with >, >=, <, <= or range`);
  } else if (c.benchmark !== undefined) errors.push(`${where}: benchmark only goes with scope benchmark`);
  const relative = RELATIVE_SCOPES.indexOf(scope) >= 0;
  const numericMetric = isNumericMetric(def) || relative;
  if (relative && !isNumericMetric(def)) errors.push(`${where}: scope ${scope} needs a numeric metric`);
  const inPct = (v: unknown) => !relative || (isNum(v) && v >= 0 && v <= 100);
  if (c.op === 'in') {
    if (!Array.isArray(c.value) || !c.value.length) errors.push(`${where}: in needs a non-empty list`);
  } else if (c.op === 'range') {
    const v = c.value;
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => x === null || isNum(x)) || (v[0] === null && v[1] === null)) errors.push(`${where}: range needs [min, max] with at least one number (null = open)`);
    else if (isNum(v[0]) && isNum(v[1]) && v[0] > v[1]) errors.push(`${where}: range min is above max`);
    else if (relative && !v.every((x) => x === null || inPct(x))) errors.push(`${where}: a percentile is 0-100`);
    if (!numericMetric) errors.push(`${where}: range needs a numeric metric`);
  } else if (c.op === '=') {
    if (Array.isArray(c.value)) errors.push(`${where}: = needs a single value`);
    else if (def.unit === 'flag' && typeof c.value !== 'boolean') errors.push(`${where}: a flag compares with true or false`);
  } else {
    if (!numericMetric) errors.push(`${where}: ${c.op} needs a numeric metric`);
    if (!isNum(c.value)) errors.push(`${where}: ${c.op} needs a number`);
    else if (!inPct(c.value)) errors.push(`${where}: a percentile is 0-100`);
  }
  if (c.help !== undefined && !hasText(c.help)) errors.push(`${where}: help needs en and ru`);
  return errors;
}

export function validatePreset(preset: Preset, registry: Registry = REGISTRY): string[] {
  const id = preset && typeof preset.id === 'string' ? preset.id : '(no id)';
  const errors: string[] = [];
  if (!preset || typeof preset !== 'object') return ['preset is not an object'];
  if (preset.schemaVersion !== PRESET_SCHEMA_VERSION) errors.push(`${id}: schemaVersion must be ${PRESET_SCHEMA_VERSION}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) errors.push(`${id}: id must be lowercase letters, digits and hyphens`);
  if (!hasText(preset.title)) errors.push(`${id}: title needs en and ru`);
  if (preset.description !== undefined && !hasText(preset.description)) errors.push(`${id}: description needs en and ru`);
  if (!Array.isArray(preset.appliesTo) || !preset.appliesTo.length || preset.appliesTo.some((t) => t !== 'stock' && t !== 'etf')) errors.push(`${id}: appliesTo must list stock and/or etf`);
  if (preset.refine !== undefined && typeof preset.refine !== 'boolean') errors.push(`${id}: refine must be true or false`);
  const conditions = Array.isArray(preset.conditions) ? preset.conditions : [];
  const pickers = preset.pickers;
  if (pickers !== undefined) {
    errors.push(...pickerErrors(preset, registry));
    if (preset.variants !== undefined) errors.push(`${id}: a preset has variants or pickers, never both`);
    if (preset.match !== 'all') errors.push(`${id}: a preset with pickers needs match "all"`);
    return errors;
  }
  if (preset.picked !== undefined && (!preset.picked || typeof preset.picked !== 'object' || Object.keys(preset.picked).some((k) => typeof preset.picked![k] !== 'string'))) errors.push(`${id}: picked must map picker ids to option ids`);
  const variants = preset.variants;
  if (variants !== undefined) {
    if (!Array.isArray(variants) || !variants.length) errors.push(`${id}: variants must be a non-empty list`);
    else {
      const ids: string[] = [];
      variants.forEach((v, k) => {
        const at = `${id} variant ${k + 1} (${v && v.id})`;
        if (!v || typeof v.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(v.id)) errors.push(`${at}: id must be lowercase letters, digits and hyphens`);
        else if (ids.indexOf(v.id) >= 0) errors.push(`${at}: duplicate variant id`);
        else ids.push(v.id);
        if (!v || !hasText(v.title)) errors.push(`${at}: title needs en and ru`);
        const list = v && Array.isArray(v.conditions) ? v.conditions : [];
        if (!list.length) errors.push(`${at}: no conditions`);
        list.forEach((c, i) => { errors.push(...conditionErrors(c, `${at} condition ${i + 1} (${c && c.metric})`, registry)); });
      });
      if (preset.defaultVariant !== undefined && ids.indexOf(preset.defaultVariant) < 0) errors.push(`${id}: defaultVariant ${preset.defaultVariant} is not a variant`);
    }
    if (preset.match !== 'all') errors.push(`${id}: a preset with variants needs match "all"`);
  } else if (preset.defaultVariant !== undefined) errors.push(`${id}: defaultVariant without variants`);
  if (preset.variant !== undefined && typeof preset.variant !== 'string') errors.push(`${id}: variant must be a variant id`);
  if (!conditions.length && !(Array.isArray(variants) && variants.length)) errors.push(`${id}: no conditions`);
  if (preset.match !== 'all' && !(typeof preset.match === 'number' && Math.floor(preset.match) === preset.match && preset.match >= 1 && preset.match <= conditions.length)) errors.push(`${id}: match must be "all" or a whole number from 1 to the number of conditions`);
  conditions.forEach((c, i) => { errors.push(...conditionErrors(c, `${id} condition ${i + 1} (${c && c.metric})`, registry)); });
  return errors;
}

const PICK_ID = /^[a-z0-9][a-z0-9-]*$/;
const VAR_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

/** Pickers (benchmark plan 4.2): ids, titles, defaults, var names without clashes, then every combination resolved and validated */
function pickerErrors(preset: Preset, registry: Registry): string[] {
  const id = preset.id;
  const errors: string[] = [];
  const pickers = preset.pickers;
  if (!Array.isArray(pickers) || !pickers.length) return [`${id}: pickers must be a non-empty list`];
  const pickerIds: string[] = [];
  const varOwner: Record<string, string> = {};
  pickers.forEach((p, k) => {
    const at = `${id} picker ${k + 1} (${p && p.id})`;
    if (!p || typeof p.id !== 'string' || !PICK_ID.test(p.id)) errors.push(`${at}: id must be lowercase letters, digits and hyphens`);
    else if (pickerIds.indexOf(p.id) >= 0) errors.push(`${at}: duplicate picker id`);
    else pickerIds.push(p.id);
    if (!p || !hasText(p.title)) errors.push(`${at}: title needs en and ru`);
    const options = p && Array.isArray(p.options) ? p.options : [];
    if (!options.length) { errors.push(`${at}: options must be a non-empty list`); return; }
    const optionIds: string[] = [];
    options.forEach((o, j) => {
      const ot = `${at} option ${j + 1} (${o && o.id})`;
      if (!o || typeof o.id !== 'string' || !PICK_ID.test(o.id)) errors.push(`${ot}: id must be lowercase letters, digits and hyphens`);
      else if (optionIds.indexOf(o.id) >= 0) errors.push(`${ot}: duplicate option id`);
      else optionIds.push(o.id);
      if (!o || !hasText(o.title)) errors.push(`${ot}: title needs en and ru`);
      if (o && o.vars !== undefined) {
        if (!o.vars || typeof o.vars !== 'object') errors.push(`${ot}: vars must be an object`);
        else Object.keys(o.vars).forEach((name) => {
          const v = (o.vars as Record<string, unknown>)[name];
          if (!VAR_NAME.test(name)) errors.push(`${ot}: var name ${name} must be letters and digits`);
          if (typeof v !== 'string' && !isNum(v)) errors.push(`${ot}: var ${name} must be a text or a number`);
          if (varOwner[name] !== undefined && varOwner[name] !== p.id) errors.push(`${ot}: var ${name} is also set by picker ${varOwner[name]}`);
          else varOwner[name] = p.id;
        });
      }
      if (o && o.conditions !== undefined && !Array.isArray(o.conditions)) errors.push(`${ot}: conditions must be a list`);
    });
    if (p && optionIds.indexOf(p.default) < 0) errors.push(`${at}: default ${p.default} is not an option`);
  });
  if (errors.length) return errors;
  const seen: Record<string, boolean> = {};
  pickerCombinations(preset).forEach((combo) => {
    const resolved = withPickers(preset, combo);
    const at = `${id} [${pickers.map((p) => combo[p.id]).join(' ')}]`;
    if (!resolved.conditions.length) errors.push(`${at}: no conditions`);
    resolved.conditions.forEach((c, i) => {
      conditionErrors(c, `${at} condition ${i + 1} (${c && c.metric})`, registry).forEach((e) => {
        const key = e.replace(/^[^:]*: /, '') + '|' + c.metric;
        if (!seen[key]) { seen[key] = true; errors.push(e); }
      });
    });
  });
  return errors;
}
