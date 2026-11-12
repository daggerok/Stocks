/// <reference lib="esnext" />
/** Schema of a metric registry entry (plan section 5). Every text is a `{ en, ru }` pair; `guide` is the guide article */

export type Text = { en: string; ru: string };
export type AssetType = 'stock' | 'etf';

/** percent: 12.5 means 12.5%; pp: percentage points; ratio: a plain multiple; usd: US dollars; count: a plain number */
export type Unit = 'percent' | 'pp' | 'ratio' | 'usd' | 'count' | 'text' | 'date' | 'flag' | 'category';

/** The period a value describes: fy = latest fiscal year of the 10-K, ttm = trailing twelve months, price = last close */
export type Basis = 'fy' | 'ttm' | 'forward' | 'price' | 'snapshot' | 'calendar-year' | 'issuer' | 'history' | 'meta';

export type Source =
  | 'sec' // SEC EDGAR XBRL facts: 10-K and 10-Q, the 20-F and 40-F of foreign issuers (Yahoo fundamentals-timeseries fills gaps, see fundamentalsBasis)
  | 'yahoo-summary' // Yahoo quoteSummary snapshot
  | 'yahoo-chart' // Yahoo chart: closes and dividends
  | 'issuer' // ETF issuer pages and files, as published by the 29 brand updaters
  | 'computed' // computed by the updater from other published values
  | 'feed' // row fields of the feed (ticker, sector, ...)
  | 'user' // the owner's data (watchlist, user-data/)
  | 'planned'; // registered ahead of the updater: presets may reference it, the engine reports it as unavailable

export type Direction = 'higher-is-better' | 'lower-is-better' | 'neutral';

export type MetricDef = {
  id: string;
  name: Text;
  formula: string;
  unit: Unit;
  basis: Basis;
  source: Source;
  direction: Direction;
  thresholds?: { good?: number; bad?: number };
  appliesTo: AssetType[];
  nullWhen?: Text;
  sectorNotes?: Text;
  short: Text;
  guide: Text;
};

/** Units the screener compares with >, <, range and percentiles; the rest are compared with = and in */
export const NUMERIC_UNITS: readonly Unit[] = ['percent', 'pp', 'ratio', 'usd', 'count'];
export const isNumericMetric = (def: MetricDef | undefined): boolean => !!def && NUMERIC_UNITS.indexOf(def.unit) >= 0;
