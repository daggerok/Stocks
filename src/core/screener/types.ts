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

/** absolute compares the value itself; market, sector, industry and peers compare its percentile (0-100) in the group; history reads the updater's own-history metrics */
export type Scope = 'absolute' | 'market' | 'sector' | 'industry' | 'peers' | 'history';
export const SCOPES: readonly Scope[] = ['absolute', 'market', 'sector', 'industry', 'peers', 'history'];
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
  conditions: Condition[];
};

/** A preset id, or and/or/not over expressions: { "and": ["cashflow-machines", { "not": "high-debt" }] } */
export type Expression = string | { and: Expression[] } | { or: Expression[] } | { not: Expression };

/** Peer groups of user-data/peers.json: group name -> tickers */
export type PeerGroups = Record<string, string[]>;
export type PeersFile = { schemaVersion: number; groups: PeerGroups };
