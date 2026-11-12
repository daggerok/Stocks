/// <reference lib="esnext" />
/**
 * Analyst estimates from Yahoo quoteSummary `earningsTrend` (screener plan 1.4) and the two PEGs (plan 1.5, owner decision В7).
 * Pure functions, no IO. Growth rates are percent (12.5 = 12.5%); a zero or negative denominator gives null, never 0
 */

type Json = Record<string, any>;
type Num = number | null;

/** EPS estimate of one period and its values 7, 30, 60 and 90 days ago */
export type EpsTrend = { current: Num; d7: Num; d30: Num; d60: Num; d90: Num };
/** What the updater keeps from earningsTrend (in meta.json market.estimates) */
export type Estimates = {
  epsCurrentYear: Num; // consensus EPS of the current fiscal year (period 0y)
  epsNextYear: Num; // consensus EPS of the next fiscal year (period +1y)
  growthNextYear: Num; // expected EPS growth of the next fiscal year, %
  growth5y: Num; // expected yearly EPS growth over 5 years, % (period +5y; Yahoo often has none)
  trendCurrentYear: EpsTrend;
  trendNextYear: EpsTrend;
};

const num = (v: unknown): Num => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v && typeof v === 'object' && 'raw' in (v as Json)) return num((v as Json).raw);
  return null;
};
const r2 = (v: number): number => Math.round(v * 100) / 100;
const pos = (v: Num): v is number => v !== null && v > 0;

const trendOf = (t: Json | undefined): EpsTrend => {
  const e = t?.epsTrend ?? {};
  return { current: num(e.current), d7: num(e['7daysAgo']), d30: num(e['30daysAgo']), d60: num(e['60daysAgo']), d90: num(e['90daysAgo']) };
};

/** The estimates of a quoteSummary result (`r` = quoteSummary.result[0]); null without an earningsTrend module */
export function parseEstimates(r: Json | undefined): Estimates | null {
  const list: Json[] = Array.isArray(r?.earningsTrend?.trend) ? r?.earningsTrend?.trend : [];
  if (!list.length) return null;
  const period = (p: string) => list.filter((t) => t?.period === p)[0];
  const cy = period('0y');
  const ny = period('+1y');
  const five = period('+5y') ?? period('LTG');
  const pct = (v: Num) => (v === null ? null : r2(v * 100));
  return {
    epsCurrentYear: num(cy?.earningsEstimate?.avg),
    epsNextYear: num(ny?.earningsEstimate?.avg),
    growthNextYear: pct(num(ny?.growth) ?? num(ny?.earningsEstimate?.growth)),
    growth5y: pct(num(five?.growth)),
    trendCurrentYear: trendOf(cy),
    trendNextYear: trendOf(ny),
  };
}

export type EstimateMetrics = {
  epsGrowthNextYearEst: Num; epsGrowth5yEst: Num; peg: Num; pegGrowthSource: string | null; pegHist: Num; forwardToTtmPe: Num; epsRevision30d: Num;
};
export const ESTIMATE_METRIC_KEYS: Array<keyof EstimateMetrics> = ['epsGrowthNextYearEst', 'epsGrowth5yEst', 'peg', 'pegGrowthSource', 'pegHist', 'forwardToTtmPe', 'epsRevision30d'];

/**
 * peg = forwardPe / expected EPS growth in % (5-year consensus, else next-year growth; the source in pegGrowthSource);
 * pegHist = pe / 3-year EPS CAGR in %; forwardToTtmPe = forwardPe / pe; epsRevision30d = change of the current-year EPS estimate
 * versus 30 days ago in %
 */
export function estimateMetrics(e: Estimates | null, pe: Num, forwardPe: Num, epsCagr3y: Num): EstimateMetrics {
  const growth5y = e?.growth5y ?? null;
  const growthNext = e?.growthNextYear ?? null;
  const source = pos(growth5y) ? '5y' : pos(growthNext) ? 'next-year' : null;
  const growth = source === '5y' ? growth5y : source === 'next-year' ? growthNext : null;
  const trend = e?.trendCurrentYear;
  return {
    epsGrowthNextYearEst: growthNext,
    epsGrowth5yEst: growth5y,
    peg: pos(forwardPe) && pos(growth) ? r2(forwardPe / growth) : null,
    pegGrowthSource: pos(forwardPe) ? source : null,
    pegHist: pos(pe) && pos(epsCagr3y) ? r2(pe / epsCagr3y) : null,
    forwardToTtmPe: pos(forwardPe) && pos(pe) ? r2(forwardPe / pe) : null,
    epsRevision30d: trend && pos(trend.current) && pos(trend.d30) ? r2((trend.current / trend.d30 - 1) * 100) : null,
  };
}

/** CAGR in % of diluted EPS (split restated) from the fiscal year 3 years before the latest one; null unless both are positive */
export function epsCagr3y(fy: Record<string, Array<number | string | null>> | undefined): Num {
  const ends = (fy?.end ?? []) as Array<string | null>;
  const eps = (fy?.epsDiluted ?? []) as Array<number | string | null>;
  if (!ends[0]) return null;
  const target = Date.parse(`${ends[0]}T00:00:00Z`) - 3 * 365.25 * 86_400_000;
  const i = ends.findIndex((e) => !!e && Math.abs(Date.parse(`${e}T00:00:00Z`) - target) <= 40 * 86_400_000);
  const now = eps[0], then = i < 0 ? null : eps[i];
  return typeof now === 'number' && typeof then === 'number' && now > 0 && then > 0 ? r2((Math.pow(now / then, 1 / 3) - 1) * 100) : null;
}
