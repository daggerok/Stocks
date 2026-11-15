/// <reference lib="esnext" />
/**
 * Preset variants (owner 2026-11-14, Stable growth over 1Y, 3Y, 5Y or 10Y): one preset file, several horizons. A variant adds its
 * conditions after the shared ones; everything else in the screener (engine, funnel, editor, share link, signals) reads the plain
 * preset that withVariant() returns, so only the picker knows about variants
 */
import type { Preset, PresetVariant } from './types';

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
