/// <reference types="node" />
/** Reads the preset JSON files of a folder in name order, without its index.json (Bun and Node only: tests, bench, and later the signals job) */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Preset } from './types';
import { withVariant } from './variants';

export const BASE_PRESET_DIR = join(__dirname, 'presets');
/** The file list the browser fetches (the site has no directory listing): { schemaVersion, files: ["gold.json", ...] } */
export const PRESET_INDEX = 'index.json';

/** Preset file names of a folder in name order, as its index.json must list them */
export function presetFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.json') && f !== PRESET_INDEX).sort();
}

/** The preset files as written, a preset with variants keeps them (the page shows a picker) */
export function loadRawPresets(dir: string = BASE_PRESET_DIR): Preset[] {
  return presetFiles(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Preset);
}

/** Plain presets: a preset with variants resolved to its default variant (tests and the signals job read these) */
export function loadPresets(dir: string = BASE_PRESET_DIR): Preset[] {
  return loadRawPresets(dir).map((p) => withVariant(p));
}
