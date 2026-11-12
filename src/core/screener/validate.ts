/// <reference lib="esnext" />
/** Preset validation against the schema and the metric registry: every problem as a readable line, empty = valid */
import { isNumericMetric, REGISTRY, Registry } from '../metrics';
import { Condition, HISTORY_METRICS, OPS, Preset, PRESET_SCHEMA_VERSION, RELATIVE_SCOPES, SCOPES } from './types';

const isNum = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
const hasText = (t: unknown): boolean => !!t && typeof t === 'object' && ['en', 'ru'].every((l) => typeof (t as Record<string, unknown>)[l] === 'string' && !!String((t as Record<string, unknown>)[l]).trim());

function conditionErrors(c: Condition, where: string, registry: Registry): string[] {
  const errors: string[] = [];
  const def = registry.byId[c.metric];
  const scope = c.scope ?? 'absolute';
  if (!def) return [`${where}: unknown metric ${c.metric}`];
  if (OPS.indexOf(c.op) < 0) errors.push(`${where}: unknown op ${c.op}`);
  if (SCOPES.indexOf(scope) < 0) errors.push(`${where}: unknown scope ${scope}`);
  if (c.missing !== undefined && c.missing !== 'fail' && c.missing !== 'skip') errors.push(`${where}: missing must be fail or skip`);
  if (scope === 'history' && HISTORY_METRICS.indexOf(c.metric) < 0) errors.push(`${where}: scope history only reads ${HISTORY_METRICS.join(', ')}`);
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
  const conditions = Array.isArray(preset.conditions) ? preset.conditions : [];
  if (!conditions.length) errors.push(`${id}: no conditions`);
  if (preset.match !== 'all' && !(typeof preset.match === 'number' && Math.floor(preset.match) === preset.match && preset.match >= 1 && preset.match <= conditions.length)) errors.push(`${id}: match must be "all" or a whole number from 1 to the number of conditions`);
  conditions.forEach((c, i) => { errors.push(...conditionErrors(c, `${id} condition ${i + 1} (${c && c.metric})`, registry)); });
  return errors;
}
