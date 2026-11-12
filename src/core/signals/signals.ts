/// <reference lib="esnext" />
/**
 * Signals (plan stage 8): the previous and the new stock index are scored and screened the same way the page does it (scoring
 * config, base presets and the committed own presets, peer groups), and every stock that is in both gets the changes between them.
 * No DOM and no file system: the updater passes the documents in and writes the result.
 *
 * Noise rules:
 * - a quiet stock (its source failed in this run, or the run did not refresh it) gives no signals and keeps its pending exits
 * - a preset exit becomes a signal only after `exitRuns` runs in a row with fresh data (another asOfDate) see the stock outside;
 *   coming back in between cancels it without an entry signal
 * - a preset whose metrics are missing from either feed is left out (a new metric would otherwise "enter" every stock)
 * - status and score changes need a value on both sides (an empty score is missing data, not a change)
 * - a change whose fiscal period ends stayed while the SEC values moved is marked `restated`
 * No previous index: the first run, no signals
 */
import { REGISTRY, type Registry } from '../metrics';
import { createUniverse, evaluatePreset } from '../screener/engine';
import { normalizeTicker, stockRow } from '../screener/rows';
import type { PeerGroups, Preset, ScreenerRow } from '../screener/types';
import { validatePreset } from '../screener/validate';
import { computeScoring, withScoreMetrics } from '../scoring/score';
import { type RowScoring, SCORE_IDS, type ScoringConfig } from '../scoring/types';
import { SIGNALS_CONFIG } from './config';
import { type PendingExit, type Signal, SIGNAL_TYPES, SIGNALS_SCHEMA_VERSION, type SignalsConfig, type SignalsDoc } from './types';

type Feed = Record<string, unknown>;

export type SignalsInput = {
  /** api/stocks/index.json before the run; null on the first run */
  previous: Feed | null;
  /** api/stocks/index.json after the run */
  current: Feed;
  /** base presets plus the committed own presets of user-data/presets */
  presets: Preset[];
  peers?: PeerGroups;
  scoring: ScoringConfig;
  /** tickers that give no signals in this run */
  quiet?: readonly string[];
  /** signals.json before the run, null when there is none */
  state: SignalsDoc | null;
  now: Date;
  config?: SignalsConfig;
  registry?: Registry;
};

export type SignalsResult = { doc: SignalsDoc; added: Signal[]; firstRun: boolean };

type Snapshot = { rows: ScreenerRow[]; raw: Feed[]; at: Record<string, number>; scoring: RowScoring[]; pass: Record<string, Uint8Array>; usable: Record<string, boolean> };

const companiesOf = (doc: Feed | null): Feed[] => (doc && Array.isArray(doc.companies) ? (doc.companies as Feed[]).filter((c) => !!c && typeof c === 'object') : []);
export const isoDay = (now: Date): string => now.toISOString().slice(0, 10);
const daysBefore = (now: Date, days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

/** The presets that may give signals: stock presets that validate, without refinements and skipped ids */
export function signalPresets(presets: Preset[], config: SignalsConfig = SIGNALS_CONFIG, registry: Registry = REGISTRY): Preset[] {
  const seen: Record<string, boolean> = {};
  return presets.filter((p) => {
    if (!p || typeof p.id !== 'string' || seen[p.id]) return false;
    seen[p.id] = true;
    if (config.skipPresets.indexOf(p.id) >= 0 || (config.skipRefine && p.refine) || !Array.isArray(p.appliesTo) || p.appliesTo.indexOf('stock') < 0) return false;
    return validatePreset(p, registry).length === 0;
  });
}

function snapshot(doc: Feed, presets: Preset[], peers: PeerGroups | undefined, scoring: ScoringConfig, registry: Registry): Snapshot {
  const raw = companiesOf(doc);
  const base = raw.map((c) => stockRow(c));
  const result = computeScoring(createUniverse(base, { peers, registry }), scoring);
  const universe = createUniverse(withScoreMetrics(base, result), { peers, registry });
  const at: Record<string, number> = {};
  universe.rows.forEach((row, i) => { if (at[row.ticker] === undefined) at[row.ticker] = i; });
  const pass: Record<string, Uint8Array> = {};
  const usable: Record<string, boolean> = {};
  presets.forEach((p) => {
    const r = evaluatePreset(universe, p);
    pass[p.id] = r.pass;
    usable[p.id] = !r.unavailable.length && !r.invalid.length;
  });
  return { rows: universe.rows, raw, at, scoring: result.rows, pass, usable };
}

/** SEC values of a row moved while its fiscal period ends did not: restated past periods */
export function isRestated(previous: Feed, current: Feed, registry: Registry = REGISTRY): boolean {
  const ends = ['fundamentalsAsOf', 'ttmAsOf'];
  if (ends.some((k) => (previous[k] ?? null) !== (current[k] ?? null))) return false;
  if (ends.every((k) => !current[k])) return false;
  const before = (previous.metrics && typeof previous.metrics === 'object' ? previous.metrics : {}) as Feed;
  const after = (current.metrics && typeof current.metrics === 'object' ? current.metrics : {}) as Feed;
  return registry.metrics.some((m) => m.source === 'sec' && m.appliesTo.indexOf('stock') >= 0 && before[m.id] !== undefined && after[m.id] !== undefined
    && JSON.stringify(before[m.id]) !== JSON.stringify(after[m.id]));
}

const typeOrder = (s: Signal) => SIGNAL_TYPES.indexOf(s.type);
/** Newest first, then ticker, type and key: a stable order, so an unchanged list writes the same file */
export function sortSignals(signals: Signal[]): Signal[] {
  return signals.slice().sort((a, b) => (a.date === b.date ? 0 : a.date > b.date ? -1 : 1) || a.ticker.localeCompare(b.ticker) || typeOrder(a) - typeOrder(b) || String(a.key ?? '').localeCompare(String(b.key ?? '')));
}

/** Signals of the last `retentionDays` days (the cut-off day included) */
export function retained(signals: Signal[], now: Date, retentionDays: number): Signal[] {
  const from = daysBefore(now, retentionDays);
  return signals.filter((s) => s.date >= from);
}

const pendingKey = (ticker: string, preset: string) => `${preset}|${ticker}`;

export function computeSignals(input: SignalsInput): SignalsResult {
  const config = input.config ?? SIGNALS_CONFIG;
  const registry = input.registry ?? REGISTRY;
  const date = isoDay(input.now);
  const state = input.state && Array.isArray(input.state.signals) ? input.state : null;
  const pending: Record<string, PendingExit> = {};
  (state && Array.isArray(state.pendingExits) ? state.pendingExits : []).forEach((p) => { pending[pendingKey(p.ticker, p.preset)] = p; });
  const kept = retained(state ? state.signals : [], input.now, config.retentionDays);
  const added: Signal[] = [];
  const firstRun = !input.previous || !companiesOf(input.previous).length;
  const presets = signalPresets(input.presets, config, registry);

  if (!firstRun && input.previous) {
    const before = snapshot(input.previous, presets, input.peers, input.scoring, registry);
    const after = snapshot(input.current, presets, input.peers, input.scoring, registry);
    const quiet: Record<string, boolean> = {};
    (input.quiet ?? []).forEach((t) => { quiet[normalizeTicker(t)] = true; });
    const live = presets.filter((p) => before.usable[p.id] && after.usable[p.id]);
    const presetIds: Record<string, boolean> = {};
    presets.forEach((p) => { presetIds[p.id] = true; });

    after.rows.forEach((row, j) => {
      const ticker = row.ticker;
      const i = before.at[ticker];
      if (i === undefined || quiet[ticker] || after.at[ticker] !== j) return;
      const restated = isRestated(before.raw[i], after.raw[j], registry);
      const push = (type: Signal['type'], key: string | null, from: string | number | null = null, to: string | number | null = null) => {
        added.push({ date, ticker, type, key, from, to, restated });
      };
      const asOf = typeof after.raw[j].asOfDate === 'string' ? (after.raw[j].asOfDate as string) : null;

      live.forEach((p) => {
        const was = before.pass[p.id][i] === 1;
        const is = after.pass[p.id][j] === 1;
        const key = pendingKey(ticker, p.id);
        const open = pending[key];
        if (is) {
          if (open) delete pending[key]; // back in before the exit was confirmed: no exit and no entry
          else if (!was) push('preset-enter', p.id);
          return;
        }
        if (open) {
          if (asOf === open.asOf) return; // the same data again: not another run
          const runs = open.runs + 1;
          if (runs >= config.exitRuns) { delete pending[key]; push('preset-exit', p.id); }
          else pending[key] = { ...open, runs, asOf };
        } else if (was) {
          if (config.exitRuns <= 1) push('preset-exit', p.id);
          else pending[key] = { ticker, preset: p.id, since: date, runs: 1, asOf };
        }
      });

      const a = before.scoring[i];
      const b = after.scoring[j];
      b.flags.filter((f) => a.flags.indexOf(f) < 0).forEach((f) => push('flag-new', f));
      a.flags.filter((f) => b.flags.indexOf(f) < 0).forEach((f) => push('flag-removed', f));
      if (a.status !== null && b.status !== null && a.status !== b.status) push('status', null, a.status, b.status);
      if (a.archetype !== b.archetype) push('archetype', null, a.archetype, b.archetype);
      SCORE_IDS.forEach((id) => {
        const x = a.scores[id];
        const y = b.scores[id];
        if (x !== null && y !== null && Math.abs(y - x) >= config.scoreDelta) push('score', id, x, y);
      });
    });

    // a pending exit of a stock that left the index, or of a preset that no longer exists, is dropped
    Object.keys(pending).forEach((key) => {
      const p = pending[key];
      if (after.at[p.ticker] === undefined || !presetIds[p.preset]) delete pending[key];
    });
  }

  const pendingExits = Object.keys(pending).sort().map((k) => pending[k]);
  const doc: SignalsDoc = {
    schemaVersion: SIGNALS_SCHEMA_VERSION,
    generatedAt: input.now.toISOString(),
    retentionDays: config.retentionDays,
    pendingExits,
    signals: sortSignals(kept.concat(added)),
  };
  return { doc, added: sortSignals(added), firstRun };
}

/** A signals.json read back: null when it is not a signals document of a known schema */
export function parseSignals(value: unknown): SignalsDoc | null {
  const doc = value as SignalsDoc | null;
  if (!doc || typeof doc !== 'object' || doc.schemaVersion !== SIGNALS_SCHEMA_VERSION || !Array.isArray(doc.signals)) return null;
  return { ...doc, pendingExits: Array.isArray(doc.pendingExits) ? doc.pendingExits : [] };
}
