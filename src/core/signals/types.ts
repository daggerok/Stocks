/// <reference lib="esnext" />
/**
 * Schema of the signals (plan stage 8): what changed for a stock from one updater run to the next, kept in api/stocks/signals.json
 * next to the index. The updater writes it after a run (`--signals`), the page reads it for the Signals view and the weekly issue
 * lists the signals of the last 7 days
 */

export const SIGNALS_SCHEMA_VERSION = 1;
/** The file next to api/stocks/index.json */
export const SIGNALS_FILE = 'signals.json';
/** Where the page fetches it */
export const SIGNALS_URL = './api/stocks/signals.json';

/**
 * preset-enter / preset-exit: the stock started or stopped passing a base or committed own preset (an exit only after two runs in
 * a row); flag-new / flag-removed: a flag of the scoring config fired or stopped firing; status, archetype: the scoring status or
 * archetype changed; score: one of the five scores moved by at least `scoreDelta` points
 */
export type SignalType = 'preset-enter' | 'preset-exit' | 'flag-new' | 'flag-removed' | 'status' | 'archetype' | 'score';
export const SIGNAL_TYPES: readonly SignalType[] = ['preset-enter', 'preset-exit', 'flag-new', 'flag-removed', 'status', 'archetype', 'score'];

export type Signal = {
  /** run date, YYYY-MM-DD (UTC) */
  date: string;
  ticker: string;
  type: SignalType;
  /** preset id, flag id or score id; null for status and archetype */
  key: string | null;
  /** status, archetype or score before and after; null for the other types */
  from: string | number | null;
  to: string | number | null;
  /**
   * true when the stock's fiscal period ends (fundamentalsAsOf, ttmAsOf) did not move while its SEC values did: the change comes
   * from restated past periods, not from a new report
   */
  restated: boolean;
};

/** A preset exit seen once: it becomes a signal when the next run with fresh data (another asOfDate) still sees the stock outside */
export type PendingExit = {
  ticker: string;
  preset: string;
  /** run date of the first run that saw the stock outside */
  since: string;
  /** runs in a row that saw the stock outside */
  runs: number;
  /** asOfDate of the row at the last run that counted */
  asOf: string | null;
};

export type SignalsDoc = {
  schemaVersion: number;
  generatedAt: string;
  /** signals older than this many days are dropped */
  retentionDays: number;
  pendingExits: PendingExit[];
  /** newest first */
  signals: Signal[];
};

export type SignalsConfig = {
  /** a score change of at least this many points (0-100 scale) is a signal */
  scoreDelta: number;
  /** runs in a row with fresh data a stock must be outside a preset before the exit is a signal */
  exitRuns: number;
  /** 12 weeks */
  retentionDays: number;
  /** preset ids that never give signals (Mine follows the owner's list, not the data) */
  skipPresets: string[];
  /** refinements (Pays a dividend, Up over 1 year) are filters on top of a selection, not a selection: no signals */
  skipRefine: boolean;
  /** days the weekly issue covers */
  issueDays: number;
};
