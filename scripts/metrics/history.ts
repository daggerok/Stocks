/// <reference lib="esnext" />
/**
 * Own-history valuation (screener plan 1.5): where today's P/E, P/FCF and dividend yield sit against the company's own
 * monthly series of the last 5 years. Pure functions, no IO.
 *
 * - month-end closes of the daily chart (split adjusted, not dividend adjusted) over the last 5 years
 * - P/E at a month end = close × diluted weighted shares / TTM net income, P/FCF the same with TTM free cash flow (CFO - capex);
 *   TTM is the sum of 4 consecutive discrete SEC quarters, known from 60 days after the quarter end (no look-ahead), shares
 *   are those of the latest quarter or fiscal year known by then; a month with TTM of zero or less has no value
 * - the current value uses the last price, the latest shares and the latest TTM the same way
 * - percentile = share of the monthly values strictly below the current one × 100
 * - yieldVsAvg5y = current dividend yield / mean of the month-end trailing-12-month yields of the last 5 years
 */
import { column, type SecFundamentals } from '../sec/companyfacts';

type Num = number | null;
type Day = { date: string; close: number };
type Dividend = { date: string; amount: number };

const DAY = 86_400_000;
/** a quarter's numbers count from this many days after its end (10-Q and 10-K filing deadlines) */
export const REPORT_LAG_DAYS = 60;
/** monthly points needed out of the 60 of five years */
export const MIN_MONTHS = 48;
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const shift = (iso: string, days: number) => new Date(ms(iso) + days * DAY).toISOString().slice(0, 10);
const r2 = (v: number) => Math.round(v * 100) / 100;

export type HistoryMetrics = { pePct5y: Num; pFcfPct5y: Num; yieldVsAvg5y: Num };
export const HISTORY_METRIC_KEYS: Array<keyof HistoryMetrics> = ['pePct5y', 'pFcfPct5y', 'yieldVsAvg5y'];

/** Last close of each calendar month from `from` on, oldest first */
export function monthEnds(days: Day[], from: string): Day[] {
  const out: Day[] = [];
  for (const d of days) {
    if (d.date < from) continue;
    if (out.length && out[out.length - 1].date.slice(0, 7) === d.date.slice(0, 7)) out[out.length - 1] = d;
    else out.push(d);
  }
  return out;
}

type Point = { known: string; value: number };

/** TTM sums at each quarter end (4 consecutive quarters, all present), with the date they become known; newest first */
export function ttmSeries(sec: SecFundamentals | null, value: (i: number) => Num): Point[] {
  if (!sec) return [];
  const ends = (sec.quarters?.end ?? []) as Array<string | null>;
  const starts = (sec.quarters?.start ?? []) as Array<string | null>;
  const out: Point[] = [];
  for (let i = 0; i + 3 < ends.length; i += 1) {
    let sum = 0;
    let ok = true;
    for (let k = i; k < i + 4 && ok; k += 1) {
      const v = value(k);
      if (v === null) ok = false;
      else sum += v;
      // consecutive: this quarter starts the day after the next older one ends
      if (k < i + 3) {
        const start = starts[k];
        const olderEnd = ends[k + 1];
        if (!start || !olderEnd || Math.abs(ms(start) - ms(shift(olderEnd, 1))) > 10 * DAY) ok = false;
      }
    }
    if (ok && ends[i]) out.push({ known: shift(ends[i] as string, REPORT_LAG_DAYS), value: sum });
  }
  return out;
}

/** Diluted weighted shares of quarters and fiscal years, newest first, with the date they become known */
function sharesSeries(sec: SecFundamentals | null): Point[] {
  if (!sec) return [];
  const out: Point[] = [];
  const add = (ends: Array<string | number | null>, values: Num[]) => ends.forEach((e, i) => {
    const v = values[i];
    if (typeof e === 'string' && v !== null && v > 0) out.push({ known: shift(e, REPORT_LAG_DAYS), value: v });
  });
  add(sec.quarters?.end ?? [], column(sec.quarters, 'sharesDiluted'));
  add(sec.fy?.end ?? [], column(sec.fy, 'sharesDiluted'));
  return out.sort((a, b) => b.known.localeCompare(a.known));
}

const at = (series: Point[], date: string | null): Num => {
  for (const p of series) if (date === null || p.known <= date) return p.value;
  return null;
};

/** Percentile (0-100) of `current` among `values`: the share strictly below it */
export function percentileOf(current: number, values: number[]): number {
  return r2((values.filter((v) => v < current).length / values.length) * 100);
}

function multiplePct(closes: Day[], price: number, shares: Point[], ttm: Point[]): Num {
  const value = (close: number, date: string | null): Num => {
    const s = at(shares, date);
    const t = at(ttm, date);
    return s !== null && t !== null && t > 0 ? (close * s) / t : null;
  };
  const current = value(price, null);
  if (current === null) return null;
  const history = closes.map((d) => value(d.close, d.date)).filter((v): v is number => v !== null);
  return history.length >= MIN_MONTHS ? percentileOf(current, history) : null;
}

/**
 * Own-history metrics; null when the daily history is shorter than 5 years, fewer than MIN_MONTHS monthly values exist, or the
 * current value is not computable (a loss, negative FCF, no dividend)
 */
export function historyMetrics(days: Day[], price: Num, sec: SecFundamentals | null, dividends: Dividend[], dividendYield: Num): HistoryMetrics {
  const none: HistoryMetrics = { pePct5y: null, pFcfPct5y: null, yieldVsAvg5y: null };
  const last = days[days.length - 1];
  if (!last || price === null || !(price > 0)) return none;
  const from = shift(last.date, -Math.round(5 * 365.25));
  if (days[0].date > shift(from, 31)) return none; // less than 5 years of closes
  const closes = monthEnds(days, from);
  const shares = sharesSeries(sec);
  const ni = ttmSeries(sec, (i) => column(sec?.quarters, 'netIncome')[i] ?? null);
  const cfo = column(sec?.quarters, 'cfo');
  const capex = column(sec?.quarters, 'capex');
  const fcf = ttmSeries(sec, (i) => (cfo[i] !== null && capex[i] !== null ? (cfo[i] as number) - (capex[i] as number) : null));

  let yieldVsAvg5y: Num = null;
  if (dividendYield !== null && dividendYield > 0) {
    const yields = closes.map((d) => {
      const since = shift(d.date, -365);
      const paid = dividends.filter((x) => x.date > since && x.date <= d.date).reduce((s, x) => s + x.amount, 0);
      return d.close > 0 ? (paid / d.close) * 100 : null;
    }).filter((v): v is number => v !== null);
    const mean = yields.length >= MIN_MONTHS ? yields.reduce((s, v) => s + v, 0) / yields.length : 0;
    yieldVsAvg5y = mean > 0 ? r2(dividendYield / mean) : null;
  }
  return { pePct5y: multiplePct(closes, price, shares, ni), pFcfPct5y: multiplePct(closes, price, shares, fcf), yieldVsAvg5y };
}
