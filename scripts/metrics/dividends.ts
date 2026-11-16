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

/** Calendar years looked at by dividendIrregular: the current partial year and the 5 complete ones before it */
export const IRREGULAR_WINDOW_YEARS = 6;
export const DIVIDEND_REGULARITY_KEYS = ['dividendIrregular'];

/**
 * Irregular (special or one-off) dividends: true when, among the current calendar year and the 5 complete years before it, a
 * year without any payment lies between two years with payments (FUTU: $2.00 in 2024, nothing in 2025, $2.60 in 2026).
 * A regular payer, also a yearly one, pays every year and is false; a dividend that stopped or just started has no gap
 * between payments and is false too (the stop is dividendCut10y). null without a payment in the window
 */
export function dividendIrregular(annual: AnnualDps[], lastDate: string): boolean | null {
  const lastYear = Number(String(lastDate).slice(0, 4));
  if (!Number.isFinite(lastYear)) return null;
  const first = lastYear - IRREGULAR_WINDOW_YEARS + 1;
  const paid = new Set<number>();
  annual.forEach((a) => { if (Number.isFinite(a.year) && Number.isFinite(a.dps) && a.dps > 0 && a.year >= first && a.year <= lastYear) paid.add(a.year); });
  if (!paid.size) return null;
  const years = Array.from(paid).sort((x, y) => x - y);
  return years.some((y, i) => i > 0 && y - years[i - 1] > 1);
}

/** Payments in 12 months and the payment frequency (benchmark plan 3.2), the same rule as the shared dividends block of the 29 ETF updaters */
export const DIVIDEND_FREQUENCY_KEYS = ['paymentsPerYear', 'payFrequency'];
export type DividendEvent = { date: string; amount: number };
const monthIndex = (date: string): number => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

/**
 * Events in the dividendRate window (`date > asOf - 365.25 days`) and the frequency, first rule that matches: no event -> null;
 * 40 events or more -> weekly; 11 calendar months or more, or the last 4 events of the whole history in 4 consecutive months with
 * the newest in the window -> monthly; history under 365 days -> null (too young); 3-5 months with 6 events or fewer -> quarterly;
 * 2 months -> semiannual; 1 month -> annual; else irregular. Counting months keeps MAIN (16 events in 12 months) monthly
 */
export function payFrequency(events: readonly DividendEvent[], asOf: string, firstDay: string | null): { paymentsPerYear: number | null; payFrequency: string | null } {
  const list = events.filter((e) => e && typeof e.date === 'string' && Number.isFinite(e.amount) && e.amount > 0).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const cutoff = new Date(asOfMs - 365.25 * 86400000).toISOString().slice(0, 10);
  const window = list.filter((e) => e.date > cutoff);
  if (!window.length) return { paymentsPerYear: null, payFrequency: null };
  const months = new Set(window.map((e) => e.date.slice(0, 7))).size;
  const n = list.length;
  const lastFour = n >= 4 && list[n - 1].date > cutoff && [n - 3, n - 2, n - 1].every((i) => monthIndex(list[i].date) - monthIndex(list[i - 1].date) === 1);
  const firstMs = firstDay ? Date.parse(`${firstDay}T00:00:00Z`) : NaN;
  let frequency: string | null;
  if (window.length >= 40) frequency = 'weekly';
  else if (months >= 11 || lastFour) frequency = 'monthly';
  else if (!Number.isFinite(firstMs) || asOfMs - firstMs < 365 * 86400000) frequency = null;
  else if (months >= 3 && months <= 5 && window.length <= 6) frequency = 'quarterly';
  else if (months === 2) frequency = 'semiannual';
  else if (months === 1) frequency = 'annual';
  else frequency = 'irregular';
  return { paymentsPerYear: window.length, payFrequency: frequency };
}
