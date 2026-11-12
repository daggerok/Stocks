/// <reference lib="esnext" />
/**
 * Schema of the scoring config (plan stage 5, src/core/scoring/config.json): five scores, archetypes, statuses, stop factors,
 * flags and the notes of the Why column. Every rule and condition uses the preset format of the screener (plan section 6), so
 * thresholds change in the JSON without code changes
 */
import type { AssetType, Direction, Text } from '../metrics/types';
import type { Condition } from '../screener/types';

export const SCORING_SCHEMA_VERSION = 1;
/** Where the page fetches the config: package.json copies config.json next to the built page */
export const SCORING_CONFIG_URL = './scoring.json';

export type ScoreId = 'cheap' | 'quality' | 'safety' | 'dividend' | 'entry';
export const SCORE_IDS: readonly ScoreId[] = ['cheap', 'quality', 'safety', 'dividend', 'entry'];
/** The registry metric (and the column) of each score */
export const SCORE_METRICS: Record<ScoreId, string> = { cheap: 'scoreCheap', quality: 'scoreQuality', safety: 'scoreSafety', dividend: 'scoreDividend', entry: 'scoreEntry' };

export type Status = 'buy' | 'watch' | 'rejected';
export const STATUSES: readonly Status[] = ['buy', 'watch', 'rejected'];

/** One number for every archetype, or a number per archetype id (a missing archetype weighs 0) */
export type Weight = number | Record<string, number>;

export type ScoreItem = {
  metric: string;
  /** fallbacks in order when `metric` is empty for the row (REIT: ffoPayoutApprox, else fcfPayout) */
  or?: string[];
  weight: Weight;
  /** overrides the registry direction (the registry calls drawdowns and sigma neutral; here lower is better) */
  direction?: Direction;
  /** sector (default): percentile in the sector, the market below minGroupSize values; peers: the engine's peers percentile */
  scope?: 'sector' | 'peers';
  /** a flag metric scores 100 when it equals `good`, 0 otherwise (no percentile) */
  good?: boolean;
};

export type ScoreAdjust = { when: Condition; factor: number };

export type ScoreDef = {
  title: Text;
  appliesTo: AssetType[];
  /** only rows with dividendYield > 0 get the score */
  payersOnly?: boolean;
  items: ScoreItem[];
  /** the score is multiplied by `factor` when the condition passes (Entry point: EPS estimates cut) */
  adjust?: ScoreAdjust[];
};

/** A rule in preset format: archetype rules, stop factors and flags */
export type Rule = {
  id: string;
  title: Text;
  appliesTo: AssetType[];
  match: 'all' | number;
  conditions: Condition[];
  /** false keeps the rule in the config without applying it (a flag waiting for its data) */
  enabled?: boolean;
};

export type ArchetypeRule = Rule & { archetype: string };

export type ArchetypeDef = {
  title: Text;
  /** weights of the five scores in the status score */
  scoreWeights: Record<ScoreId, number>;
  /** statusScore >= buy -> buy zone; < reject -> rejected; else watch */
  buy: number;
  reject: number;
  /** ids of `stopFactors` that reject a row of this archetype */
  stopFactors: string[];
};

/** A reason for the Why column, shown when its condition passes; `{value}` and `{threshold}` are filled in */
export type Note = { condition: Condition; text: Text; archetypes?: string[] };

export type ScoringConfig = {
  schemaVersion: number;
  /** a sector with fewer values of a metric compares with the whole market of its type */
  minGroupSize: number;
  /** a score or status score is empty below this share of its weight */
  minWeightShare: number;
  /** score colors: >= good green, < bad red, amber between */
  colors: { good: number; bad: number };
  /** at most this many reasons in the Why column */
  whyLimit: number;
  defaultArchetype: string;
  archetypes: Record<string, ArchetypeDef>;
  archetypeRules: ArchetypeRule[];
  scores: Record<ScoreId, ScoreDef>;
  stopFactors: Rule[];
  flags: Rule[];
  notes: Note[];
};

/** The scoring of one row */
export type RowScoring = {
  archetype: string;
  scores: Record<ScoreId, number | null>;
  statusScore: number | null;
  status: Status | null;
  /** ids of the stop factors that fired */
  stops: string[];
  /** ids of the flags that fire */
  flags: string[];
  /** indexes of config.notes whose condition passes */
  notes: number[];
  /** score ids lowered by an adjust rule */
  adjusted: ScoreId[];
};
