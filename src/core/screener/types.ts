/// <reference lib="esnext" />
/** Screener schema (plan sections 4 stage 3 and 6): engine rows, conditions, presets, expressions */
import type { AssetType, Text } from '../metrics/types';

export const PRESET_SCHEMA_VERSION = 1;

/** One security for the engine: the stock and ETF feeds are turned into this shape by rows.ts */
export type ScreenerRow = {
  ticker: string;
  type: AssetType;
  sector: string | null;
  industry: string | null;
  isMine: boolean;
  /** marketCap of a stock, aumValue of an ETF */
  size: number | null;
  metrics: Record<string, unknown>;
};

export type Op = '>' | '>=' | '<' | '<=' | '=' | 'range' | 'in';
export const OPS: readonly Op[] = ['>', '>=', '<', '<=', '=', 'range', 'in'];

/**
 * absolute compares the value itself; market, sector, industry and peers compare its percentile (0-100) in the group; history reads
 * the updater's own-history metrics; benchmark compares the row's value minus the value of the named ticker (`benchmark`) of the same
 * metric, in the metric's own unit (benchmark plan 4.1)
 */
export type Scope = 'absolute' | 'market' | 'sector' | 'industry' | 'peers' | 'history' | 'benchmark';
export const SCOPES: readonly Scope[] = ['absolute', 'market', 'sector', 'industry', 'peers', 'history', 'benchmark'];
/** The ticker a benchmark condition names: SPY, BRK-B, BRK.B */
export const BENCHMARK_TICKER = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;
export const RELATIVE_SCOPES: readonly Scope[] = ['market', 'sector', 'industry', 'peers'];
/** The only metrics scope history accepts: percentiles and ratios to the own history the updater computes */
export const HISTORY_METRICS: readonly string[] = ['pePct5y', 'pFcfPct5y', 'yieldVsAvg5y'];

/** fail: an empty value fails the condition; skip: the condition is ignored for that row */
export type Missing = 'fail' | 'skip';

export type ConditionValue = number | string | boolean | Array<number | string | null>;

export type Condition = {
  metric: string;
  op: Op;
  /** a number, string or boolean for comparisons, [min, max] for range (null = open bound), a list for in */
  value: ConditionValue;
  scope?: Scope;
  /** the ticker of scope benchmark (SPY, QQQ, any row of the universe) */
  benchmark?: string;
  missing?: Missing;
  /** false switches the condition off without deleting it (editor toggle) */
  enabled?: boolean;
  help?: Text;
};

export type Preset = {
  schemaVersion: number;
  id: string;
  title: Text;
  description?: Text;
  appliesTo: AssetType[];
  /** all, or N for the soft mode "N of M conditions" */
  match: 'all' | number;
  /** true: a refinement (pays a dividend, up over a year) the screener always combines with AND on top of the chosen presets */
  refine?: boolean;
  conditions: Condition[];
  /**
   * Switchable horizons of one preset (Stable growth: 1Y, 3Y, 5Y, 10Y): the screener shows a picker, the chosen variant adds its
   * conditions after the shared `conditions`. withVariant() turns such a preset into a plain one (no `variants`, `variant` set)
   */
  variants?: PresetVariant[];
  /** the variant used when nothing is chosen; the first one when absent */
  defaultVariant?: string;
  /** the variant a resolved preset was built from (a plain preset made by withVariant) */
  variant?: string;
  /**
   * Selects on the chip (benchmark plan 4.2: benchmark, horizon, yield level, ...): each picked option adds its `vars` and conditions;
   * withPickers() turns such a preset into a plain one (no `pickers`, `picked` set). A preset has `variants` or `pickers`, never both
   */
  pickers?: PresetPicker[];
  /** picker id -> option id of a resolved preset (a plain preset made by withPickers) */
  picked?: Record<string, string>;
};

/** One option of a picker: `{name}` tokens in the conditions (metric, benchmark, a value or list item that is exactly "{name}") take its vars */
export type PickerOption = { id: string; title: Text; vars?: Record<string, string | number>; conditions?: Condition[] };
export type PresetPicker = { id: string; title: Text; default: string; options: PickerOption[] };

export type PresetVariant = { id: string; title: Text; conditions: Condition[] };

/** A preset id, or and/or/not over expressions: { "and": ["cashflow-machines", { "not": "high-debt" }] } */
export type Expression = string | { and: Expression[] } | { or: Expression[] } | { not: Expression };

/** Peer groups of user-data/peers.json: group name -> tickers */
export type PeerGroups = Record<string, string[]>;
export type PeersFile = { schemaVersion: number; groups: PeerGroups };
