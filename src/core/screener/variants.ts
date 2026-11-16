/// <reference lib="esnext" />
/**
 * Preset variants (owner 2026-11-14, Stable growth over 1Y, 3Y, 5Y or 10Y): one preset file, several horizons. A variant adds its
 * conditions after the shared ones; everything else in the screener (engine, funnel, editor, share link, signals) reads the plain
 * preset that withVariant() returns, so only the picker knows about variants
 */
import type { Condition, PickerOption, Preset, PresetPicker, PresetVariant } from './types';

/** The variant a choice picks: the chosen id when the preset has it, else defaultVariant, else the first one; null without variants */
export function pickVariant(preset: Preset, chosen?: string | null): PresetVariant | null {
  const list = Array.isArray(preset.variants) ? preset.variants : [];
  if (!list.length) return null;
  const by = (id: string | null | undefined) => (id ? list.filter((v) => v.id === id)[0] : undefined);
  return by(chosen) ?? by(preset.defaultVariant) ?? list[0];
}

/** A plain preset: shared conditions plus the picked variant's, `variant` set and `variants` dropped; a preset without variants as is */
export function withVariant(preset: Preset, chosen?: string | null): Preset {
  const v = pickVariant(preset, chosen);
  if (!v) return preset;
  const { variants, defaultVariant, ...rest } = preset;
  return { ...rest, conditions: preset.conditions.concat(v.conditions), variant: v.id };
}

/** The option a picker uses: the chosen id when the picker has it, else its default (else the first option) */
export function pickOption(picker: PresetPicker, chosen?: string | null): PickerOption | null {
  const list = Array.isArray(picker.options) ? picker.options : [];
  const by = (id: string | null | undefined) => (id ? list.filter((o) => o.id === id)[0] : undefined);
  return by(chosen) ?? by(picker.default) ?? list[0] ?? null;
}

const TOKEN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
const WHOLE_TOKEN = /^\{([A-Za-z][A-Za-z0-9]*)\}$/;

/** "{name}" -> the var's value (a number stays a number); a text with tokens inside gets them replaced; an unknown token stays as written */
function tokenValue(v: unknown, vars: Record<string, string | number>): unknown {
  if (typeof v !== 'string') return v;
  const whole = WHOLE_TOKEN.exec(v);
  if (whole) return Object.prototype.hasOwnProperty.call(vars, whole[1]) ? vars[whole[1]] : v;
  return tokenText(v, vars);
}

function tokenText(text: string, vars: Record<string, string | number>): string {
  return text.replace(TOKEN, (all, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
}

function resolveCondition(c: Condition, vars: Record<string, string | number>): Condition {
  const out: Condition = { ...c, metric: tokenText(c.metric, vars) };
  if (typeof c.benchmark === 'string') out.benchmark = tokenText(c.benchmark, vars);
  out.value = (Array.isArray(c.value) ? c.value.map((x) => tokenValue(x, vars)) : tokenValue(c.value, vars)) as Condition['value'];
  return out;
}

/** Tokens left in a resolved condition (an unknown var name): validation reports them */
export function unresolvedTokens(c: Condition): string[] {
  const texts = [c.metric, c.benchmark ?? ''].concat((Array.isArray(c.value) ? c.value : [c.value]).filter((x): x is string => typeof x === 'string'));
  const out: string[] = [];
  texts.forEach((t) => { (t.match(TOKEN) || []).forEach((m) => { if (out.indexOf(m) < 0) out.push(m); }); });
  return out;
}

/**
 * A plain preset from a preset with pickers (benchmark plan 4.2): the shared conditions, then each picker's picked conditions in
 * picker order, every `{name}` replaced with the merged vars of the picked options; `picked` records the choice. Without pickers as is
 */
export function withPickers(preset: Preset, chosen?: Record<string, string> | null): Preset {
  const pickers = Array.isArray(preset.pickers) ? preset.pickers : [];
  if (!pickers.length) return preset;
  const vars: Record<string, string | number> = {};
  const picked: Record<string, string> = {};
  let conditions: Condition[] = preset.conditions.slice();
  pickers.forEach((p) => {
    const option = pickOption(p, chosen ? chosen[p.id] : null);
    if (!option) return;
    picked[p.id] = option.id;
    if (option.vars) Object.keys(option.vars).forEach((k) => { vars[k] = (option.vars as Record<string, string | number>)[k]; });
    if (Array.isArray(option.conditions)) conditions = conditions.concat(option.conditions);
  });
  const { pickers: _drop, ...rest } = preset;
  return { ...rest, conditions: conditions.map((c) => resolveCondition(c, vars)), picked };
}

/** Every combination of picker options (picker id -> option id), first picker outermost; [{}] without pickers */
export function pickerCombinations(preset: Preset): Array<Record<string, string>> {
  let out: Array<Record<string, string>> = [{}];
  (Array.isArray(preset.pickers) ? preset.pickers : []).forEach((p) => {
    const next: Array<Record<string, string>> = [];
    out.forEach((combo) => (Array.isArray(p.options) ? p.options : []).forEach((o) => { next.push({ ...combo, [p.id]: o.id }); }));
    out = next;
  });
  return out;
}
