/// <reference lib="esnext" />
/**
 * Precomputed scores (perf plan stage 2): the updater writes api/stocks/scores.json with the scoring of every row and the base
 * presets it passes, the page reads it next to index.json and skips computeScoring and the base presets when the key matches.
 * No DOM, no fs: the updater and the page call the same functions, so the file always holds what computeScoring gives.
 *
 * - stocks: the scoring of the stock universe (what the page computes on load); key = SCORING_FORMULA_VERSION of score.ts,
 *   config, effective peer groups, index.json generatedAt and company count. Stocks lists stocks only: the ETFs hub scores its
 *   funds itself (hub plan H4), so the file has no ETF part; the `etfs` part of an older file is ignored
 * - a key that differs (a newer config, a peers overlay in the browser) means the page recomputes as before; a preset whose definition differs from the published one (a draft, another variant) is evaluated
 *   as before, the others take their pass bits from the file
 */
import { createUniverse, evaluatePreset, evaluatePresets, type PresetResult, type Universe } from '../screener/engine';
import type { PeerGroups, Preset, ScreenerRow } from '../screener/types';
import { computeScoring, SCORING_FORMULA_VERSION, type ScoringResult, withScoreMetrics } from './score';
import { type RowScoring, SCORE_IDS, type ScoreId, type ScoringConfig, type Status } from './types';

export const SCORES_SCHEMA_VERSION = 1;
/** Next to index.json: api/stocks/scores.json */
export const SCORES_FILE = 'scores.json';
/** The order of a snapshot row */
export const SCORES_FIELDS = ['ticker', 'archetype', ...SCORE_IDS, 'total', 'status', 'flags', 'stops', 'caps', 'missing', 'notes', 'adjusted', 'presetMask'] as const;
/** The preset bits are a plain number: exact up to 2^53 */
const MAX_PRESETS = 52;

/** one row in SCORES_FIELDS order */
export type SnapshotRow = unknown[];
export type ScoresPart = { key: string; rows: SnapshotRow[] };
export type ScoresSnapshot = {
  schemaVersion: number;
  generatedAt: string;
  fields: string[];
  presets: Array<{ id: string; hash: string }>;
  stocks: ScoresPart;
};

/** JSON with object keys in name order, so equal values give equal text whatever order they were built in */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined || typeof v === 'function' ? 'null' : canonicalJson(v))).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined && typeof o[k] !== 'function').map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** Two 32-bit FNV-1a hashes (different offsets) as 16 hex digits: a version key, not a security hash */
export function fnv1a(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

export const presetHash = (preset: Preset): string => fnv1a(canonicalJson(preset));

/** The key of the stock part: what the scoring of the stock universe depends on (the formula version stands for the code) */
export function stocksScoresKey(config: ScoringConfig, peers: PeerGroups, feed: { generatedAt: string; companies: number }): string {
  return fnv1a(canonicalJson({ v: SCORES_SCHEMA_VERSION, f: SCORING_FORMULA_VERSION, config, peers, generatedAt: feed.generatedAt, companies: feed.companies }));
}

/** Scoring and base presets of one universe of rows, the same steps the page runs */
function scoreRows(rows: ScreenerRow[], config: ScoringConfig, presets: Preset[], peers: PeerGroups): SnapshotRow[] {
  const result = computeScoring(createUniverse(rows, { peers }), config);
  const universe = createUniverse(withScoreMetrics(rows, result), { peers });
  const results = evaluatePresets(universe, presets);
  return rows.map((row, i) => {
    const r = result.rows[i];
    let mask = 0;
    presets.forEach((p, k) => { if (results[p.id].pass[i]) mask += 2 ** k; });
    return [row.ticker, r.archetype, ...SCORE_IDS.map((id) => r.scores[id]), r.statusScore, r.status, r.flags, r.stops, r.caps, r.missing, r.notes, r.adjusted, mask] as SnapshotRow;
  });
}

export type ScoresInput = {
  config: ScoringConfig;
  /** the base presets as the page uses them by default (variants resolved to the default) */
  presets: Preset[];
  /** the effective peer groups (the repo file) */
  peers: PeerGroups;
  /** index.json generatedAt and its company count */
  feed: { generatedAt: string; companies: number };
  now?: Date;
};

/** The snapshot of the stock rows; they must be the page's stock rows (storeRows: feedMineSet + stockRow of every index row with a ticker) */
export function buildScoresSnapshot(input: ScoresInput, stockRows: ScreenerRow[]): ScoresSnapshot {
  if (input.presets.length > MAX_PRESETS) throw new Error(`scores.json: ${input.presets.length} base presets, at most ${MAX_PRESETS} fit the preset bits`);
  const { config, presets, peers } = input;
  const stocksKey = stocksScoresKey(config, peers, input.feed);
  const stocks = scoreRows(stockRows, config, presets, peers);
  return {
    schemaVersion: SCORES_SCHEMA_VERSION,
    generatedAt: (input.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    fields: SCORES_FIELDS.slice(),
    presets: presets.map((p) => ({ id: p.id, hash: presetHash(p) })),
    stocks: { key: stocksKey, rows: stocks },
  };
}

/** The file text: one row per line, small diffs and readable */
export function scoresText(snapshot: ScoresSnapshot): string {
  const rows = (list: SnapshotRow[]) => (list.length ? `[\n${list.map((r) => JSON.stringify(r)).join(',\n')}\n]` : '[]');
  const part = (p: ScoresPart) => `{"key": ${JSON.stringify(p.key)}, "rows": ${rows(p.rows)}}`;
  return `{"schemaVersion": ${snapshot.schemaVersion}, "generatedAt": ${JSON.stringify(snapshot.generatedAt)}, "fields": ${JSON.stringify(snapshot.fields)}, "presets": ${JSON.stringify(snapshot.presets)},\n"stocks": ${part(snapshot.stocks)}\n}\n`;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);

function decodeRow(row: SnapshotRow): RowScoring {
  const k = 2 + SCORE_IDS.length;
  const scores = {} as Record<ScoreId, number | null>;
  SCORE_IDS.forEach((id, j) => { scores[id] = numOrNull(row[2 + j]); });
  const status = row[k + 1];
  return {
    // the key order of computeScoring's rows
    archetype: String(row[1]), scores, statusScore: numOrNull(row[k]), status: status === 'buy' || status === 'watch' || status === 'rejected' ? status : null,
    stops: strings(row[k + 3]), caps: strings(row[k + 4]), missing: strings(row[k + 5]) as ScoreId[], flags: strings(row[k + 2]),
    notes: Array.isArray(row[k + 6]) ? (row[k + 6] as unknown[]).filter((n): n is number => typeof n === 'number') : [], adjusted: strings(row[k + 7]) as ScoreId[],
  };
}

export type AppliedScores = {
  result: ScoringResult;
  /** pass bits of each base preset by id, one per row */
  pass: Record<string, Uint8Array>;
  /** the preset hash each pass array belongs to */
  hashes: Record<string, string>;
};

/** A snapshot read from the network: the shape this code writes, else null; the `etfs` part of an older file is dropped unread */
export function parseScoresSnapshot(data: unknown): ScoresSnapshot | null {
  const d = data as ScoresSnapshot;
  if (!d || typeof d !== 'object' || d.schemaVersion !== SCORES_SCHEMA_VERSION || canonicalJson(d.fields) !== canonicalJson(SCORES_FIELDS)) return null;
  if (!Array.isArray(d.presets) || !d.stocks || typeof d.stocks.key !== 'string' || !Array.isArray(d.stocks.rows)) return null;
  return { schemaVersion: d.schemaVersion, generatedAt: d.generatedAt, fields: d.fields, presets: d.presets, stocks: d.stocks };
}

/**
 * The scoring of `rows` (the page's stock rows, any order) from the snapshot, or null when it does not fit: another key, a row
 * that is not a stock, a row the snapshot does not have or the other way round
 */
export function applyScoresSnapshot(snapshot: ScoresSnapshot, rows: ScreenerRow[], config: ScoringConfig, stocksKey: string): AppliedScores | null {
  if (snapshot.stocks.key !== stocksKey) return null;
  const byKey = new Map<string, SnapshotRow>();
  snapshot.stocks.rows.forEach((r) => byKey.set(`stock:${r[0]}`, r));
  if (byKey.size !== rows.length) return null;
  const pass: Record<string, Uint8Array> = {};
  const hashes: Record<string, string> = {};
  snapshot.presets.forEach((p) => { pass[p.id] = new Uint8Array(rows.length); hashes[p.id] = p.hash; });
  const out: RowScoring[] = new Array(rows.length);
  const maskAt = SCORES_FIELDS.length - 1;
  for (let i = 0; i < rows.length; i += 1) {
    const enc = byKey.get(`${rows[i].type}:${rows[i].ticker}`);
    if (!enc) return null;
    out[i] = decodeRow(enc);
    let mask = Number(enc[maskAt]) || 0;
    for (let k = 0; k < snapshot.presets.length && mask > 0; k += 1) {
      if (mask % 2 === 1) pass[snapshot.presets[k].id][i] = 1;
      mask = Math.floor(mask / 2);
    }
  }
  return { result: { config, rows: out }, pass, hashes };
}

/**
 * A preset result whose pass bits come from the snapshot: count from the bits, the funnel, start and the condition problems are
 * evaluated on first read (only the preset editor reads them)
 */
export function snapshotPresetResult(universe: Universe, preset: Preset, pass: Uint8Array): PresetResult {
  let count = 0;
  for (let i = 0; i < pass.length; i += 1) count += pass[i];
  let full: PresetResult | null = null;
  const lazy = (): PresetResult => full || (full = evaluatePreset(universe, preset));
  return {
    id: preset.id, pass, count,
    get start() { return lazy().start; },
    get funnel() { return lazy().funnel; },
    get unavailable() { return lazy().unavailable; },
    get invalid() { return lazy().invalid; },
  };
}
