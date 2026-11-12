/// <reference types="node" />
/** Reads the preset JSON files of a folder in name order (Bun and Node only: tests, bench, and later the signals job) */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Preset } from './types';

export const BASE_PRESET_DIR = join(__dirname, 'presets');

export function loadPresets(dir: string = BASE_PRESET_DIR): Preset[] {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Preset);
}
