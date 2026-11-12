/// <reference lib="esnext" />
/**
 * Dividend streak and cut flag (screener plan 1.5 "Dividends") from the calendar-year dividend sums the updater already keeps
 * as `market.annualDps` (split adjusted, newest first, the current partial year included). Pure functions, no IO.
 *
 * A year Y is compared with its base: the year before, unless that year was a spike (more than SPIKE_FACTOR above both
 * neighbours: a special dividend or a payment that slipped in from the next year), then the year before the spike.
 * - increase: dps(Y) above the base
 * - cut: dps(Y) more than CUT_TOLERANCE below the base and the next complete year does not come back to the base (a payment
 *   that moved from December to January makes one year short and the next one long); the latest complete year has no next
 *   year to confirm it, so a cut in it is reported at once
 * A year with no payment after a paying year is a cut (suspension). Years before the first payment in the data are unknown
 */

type Num = number | null;
export type AnnualDps = { year: number; dps: number };
export type DividendHistory = { dividendStreak: Num; dividendCut10y: boolean | null };

export const DIVIDEND_HISTORY_KEYS: Array<keyof DividendHistory> = ['dividendStreak', 'dividendCut10y'];
/** A drop smaller than this share of the base is noise (rounding, ADR currency moves), not a cut */
export const CUT_TOLERANCE = 0.1;
/** A year more than this factor above both neighbours is a special dividend or a shifted payment */
export const SPIKE_FACTOR = 1.2;
/**
 * Complete calendar years of dividends per share kept in `market.annualDps` (plus the current partial year): 30, so the streak
 * can reach 29 (owner answer N20; with 15 KO showed 13 despite 60 years of raises)
 */
export const ANNUAL_DPS_YEARS = 30;
/** Window of the cut flag in complete calendar years */
export const CUT_WINDOW_YEARS = 10;

export function dividendHistory(annual: AnnualDps[], lastDate: string): DividendHistory {
  const none: DividendHistory = { dividendStreak: null, dividendCut10y: null };
  const lastYear = Number(String(lastDate).slice(0, 4));
  if (!Number.isFinite(lastYear) || !annual.length) return none;
  const complete = lastYear - 1; // the current calendar year is partial
  const byYear: Record<number, number> = {};
  let first = Infinity;
  annual.forEach((a) => {
    if (!Number.isFinite(a.year) || !Number.isFinite(a.dps) || a.dps <= 0 || a.year > complete) return;
    byYear[a.year] = (byYear[a.year] ?? 0) + a.dps;
    first = Math.min(first, a.year);
  });
  if (first === Infinity) return none;
  /** dps of a year, 0 for a year without payments after the first one, null before it */
  const dps = (y: number): Num => (y < first ? null : byYear[y] ?? 0);
  const base = (y: number): Num => {
    const prev = dps(y - 1), before = dps(y - 2), cur = dps(y);
    if (prev === null) return null;
    if (before !== null && before > 0 && cur !== null && prev > SPIKE_FACTOR * before && prev > SPIKE_FACTOR * cur) return before;
    return prev;
  };
  const isCut = (y: number): boolean => {
    const b = base(y), cur = dps(y);
    if (b === null || cur === null || b <= 0 || cur >= (1 - CUT_TOLERANCE) * b) return false;
    const next = y < complete ? dps(y + 1) : null;
    return next === null || next < (1 - CUT_TOLERANCE) * b;
  };
  let paidInWindow = false;
  let cut = false;
  for (let y = complete - CUT_WINDOW_YEARS + 1; y <= complete; y += 1) {
    if ((dps(y) ?? 0) > 0 || (dps(y - 1) ?? 0) > 0) paidInWindow = true;
    if (isCut(y)) cut = true;
  }
  let streak: Num = null;
  if ((dps(complete) ?? 0) > 0) {
    streak = 0;
    for (let y = complete; ; y -= 1) {
      const b = base(y), cur = dps(y);
      if (b === null || cur === null || !(b > 0) || !(cur > b)) break;
      streak += 1;
    }
  }
  return { dividendStreak: streak, dividendCut10y: paidInWindow ? cut : null };
}
