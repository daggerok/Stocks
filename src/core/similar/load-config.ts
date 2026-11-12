/// <reference types="node" />
/** Reads src/core/similar/config.json (Bun and Node only: the tests; the page fetches dist/similar.json) */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SimilarConfig } from './config';

export const SIMILAR_CONFIG_FILE = join(__dirname, 'config.json');

export function loadSimilarConfig(file: string = SIMILAR_CONFIG_FILE): SimilarConfig {
  return JSON.parse(readFileSync(file, 'utf8')) as SimilarConfig;
}
