/// <reference types="node" />
/**
 * Inputs of the signals job from the repo (Bun and Node only: the updater and tests): the base presets, the committed own presets
 * of user-data/presets, the peer groups of user-data/peers.json and the scoring config. Presets that live only in a browser are not
 * in the repo and give no signals
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_PRESET_DIR, loadPresets } from '../screener/load-presets';
import { parsePeersText } from '../screener/peers';
import type { PeerGroups, Preset } from '../screener/types';
import { loadScoringConfig } from '../scoring/load-config';
import type { ScoringConfig } from '../scoring/types';

export const REPO_ROOT = join(__dirname, '..', '..', '..');

export type SignalSources = { presets: Preset[]; peers: PeerGroups; scoring: ScoringConfig; warnings: string[] };

export function loadSignalSources(root: string = REPO_ROOT): SignalSources {
  const warnings: string[] = [];
  const own = join(root, 'user-data', 'presets');
  const presets = loadPresets(BASE_PRESET_DIR).concat(existsSync(own) ? loadPresets(own) : []);
  let peers: PeerGroups = {};
  const peersFile = join(root, 'user-data', 'peers.json');
  if (existsSync(peersFile)) {
    const parsed = parsePeersText(readFileSync(peersFile, 'utf8'));
    peers = parsed.groups;
    parsed.errors.forEach((e) => warnings.push(`user-data/peers.json: ${e}`));
  }
  return { presets, peers, scoring: loadScoringConfig(), warnings };
}
