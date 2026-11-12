/// <reference types="node" />
/** Reads src/core/scoring/config.json (Bun and Node only: tests, and later the signals job; the page fetches dist/scoring.json) */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScoringConfig } from './types';

export const SCORING_CONFIG_FILE = join(__dirname, 'config.json');

export function loadScoringConfig(file: string = SCORING_CONFIG_FILE): ScoringConfig {
  return JSON.parse(readFileSync(file, 'utf8')) as ScoringConfig;
}
