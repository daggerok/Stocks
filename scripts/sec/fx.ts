/// <reference lib="esnext" />
/**
 * Reporting currency -> USD for the SEC layer of a foreign issuer (screener plan 1.3). Pure functions, no IO: the updater loads
 * the daily Yahoo chart of the pair once per currency and run.
 *
 * - the pair is `<CUR>USD=X` (USD per one unit, TWDUSD=X, EURUSD=X, JPYUSD=X); a currency Yahoo has only the other way round
 *   (`USD<CUR>=X`) is inverted point by point, so every rate is USD per unit
 * - balance sheet lines (instant facts) use the rate at the period end: the last close on or before that day, at most 7 days back
 * - flows (revenue, net income, CFO, capex ...) and per-share values use the average of the daily closes from the period start to
 *   its end; the series must reach within 7 days of both ends
 * - share counts are not converted; growth and margins are never computed from these values (they stay in the reporting
 *   currency, where the exchange rate cannot bend a trend): the USD layer is for absolute amounts and multiples over market cap
 */
import type { Columns, SecFundamentals, TtmValues } from './companyfacts';
import { SEC_FIELDS } from './tags';

export type FxPoint = { date: string; rate: number };
export type FxSeries = { currency: string; pair: string; inverted: boolean; points: FxPoint[] };
export type FxRates = { flow: number | null; balance: number | null };
/** The SEC layer in USD: same fields and periods as the fiscal years and TTM of the layer, plus the rates applied */
export type UsdLayer = {
  currency: string;
  pair: string;
  inverted: boolean;
  ttm: TtmValues;
  fy: Columns;
  rates: { ttm: FxRates; fy: { flow: Array<number | null>; balance: Array<number | null> } };
};

const DAY = 86_400_000;
const MAX_GAP_DAYS = 7;
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** Yahoo symbols of a currency: the direct pair (USD per unit) and the inverse one (units per USD) */
export function fxPairs(currency: string): { direct: string; inverse: string } {
  return { direct: `${currency}USD=X`, inverse: `USD${currency}=X` };
}

/** USD-per-unit points from daily closes of a pair, oldest first; an inverse pair is inverted, non-positive closes are dropped */
export function fxPoints(days: Array<{ date: string; close: number }>, inverted: boolean): FxPoint[] {
  return days
    .filter((d) => typeof d.close === 'number' && isFinite(d.close) && d.close > 0)
    .map((d) => ({ date: d.date, rate: inverted ? 1 / d.close : d.close }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Rate on `date`: the last point on or before it, at most 7 days back; null without one */
export function rateAt(points: FxPoint[], date: string): number | null {
  let found: FxPoint | null = null;
  for (const p of points) {
    if (p.date > date) break;
    found = p;
  }
  return found && (ms(date) - ms(found.date)) / DAY <= MAX_GAP_DAYS ? found.rate : null;
}

/** Average of the points from `start` to `end` (both included); null unless the series reaches within 7 days of both ends */
export function averageRate(points: FxPoint[], start: string, end: string): number | null {
  let sum = 0;
  let n = 0;
  let first: string | null = null;
  let last: string | null = null;
  for (const p of points) {
    if (p.date < start) continue;
    if (p.date > end) break;
    sum += p.rate;
    n += 1;
    if (first === null) first = p.date;
    last = p.date;
  }
  if (!n || first === null || last === null) return null;
  if ((ms(first) - ms(start)) / DAY > MAX_GAP_DAYS || (ms(end) - ms(last)) / DAY > MAX_GAP_DAYS) return null;
  return sum / n;
}

const convert = (value: unknown, rate: number | null, perShare: boolean): number | null => {
  if (typeof value !== 'number' || !isFinite(value) || rate === null) return null;
  return perShare ? Math.round(value * rate * 1e4) / 1e4 : Math.round(value * rate);
};

/** One period's values in USD: flows and per-share values at the period average, balance lines at the period-end rate */
function convertPeriod(get: (key: string) => unknown, rates: FxRates): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  Object.keys(SEC_FIELDS).forEach((key) => {
    const kind = SEC_FIELDS[key].kind;
    const value = get(key);
    if (kind === 'shares') out[key] = typeof value === 'number' ? value : null;
    else out[key] = convert(value, kind === 'instant' ? rates.balance : rates.flow, kind === 'perShare');
  });
  return out;
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The fiscal years and TTM of a non-USD layer in USD; null for a USD layer or a series of another currency */
export function usdLayer(sec: SecFundamentals, fx: FxSeries): UsdLayer | null {
  if (sec.currency === 'USD' || fx.currency !== sec.currency) return null;
  // 10 significant digits: the stored rate is the one applied, free of float noise from the averaging
  const precise = (v: number | null) => (v === null ? null : Number(v.toPrecision(10)));
  const ratesOf = (start: string | null, end: string | null): FxRates => ({
    flow: start && end ? precise(averageRate(fx.points, start, end)) : null,
    balance: end ? precise(rateAt(fx.points, end)) : null,
  });
  const ttmRates = ratesOf(text(sec.ttm.start), text(sec.ttm.end));
  const ttmValues = convertPeriod((k) => sec.ttm[k], ttmRates);
  const ttm: TtmValues = { end: sec.ttm.end ?? null, start: sec.ttm.start ?? null, fiscalYear: sec.ttm.fiscalYear ?? null, period: 'TTM', basis: sec.ttm.basis ?? null, filed: sec.ttm.filed ?? null, ...ttmValues };
  const fy: Columns = { end: [], start: [], fiscalYear: [], period: [], filed: [] };
  Object.keys(SEC_FIELDS).forEach((k) => { fy[k] = []; });
  const flow: Array<number | null> = [];
  const balance: Array<number | null> = [];
  const ends = sec.fy.end ?? [];
  for (let i = 0; i < ends.length; i += 1) {
    const rates = ratesOf(text(sec.fy.start?.[i]), text(ends[i]));
    flow.push(rates.flow);
    balance.push(rates.balance);
    ['end', 'start', 'fiscalYear', 'period', 'filed'].forEach((k) => { fy[k].push(sec.fy[k]?.[i] ?? null); });
    const values = convertPeriod((k) => sec.fy[k]?.[i], rates);
    Object.keys(SEC_FIELDS).forEach((k) => { fy[k].push(values[k]); });
  }
  return { currency: sec.currency, pair: fx.pair, inverted: fx.inverted, ttm, fy, rates: { ttm: ttmRates, fy: { flow, balance } } };
}

/** The layer as the formulas that mix market cap with amounts read it: the USD fiscal years and TTM, no quarters */
export function usdView(sec: SecFundamentals, usd: UsdLayer): SecFundamentals {
  const quarters: Columns = { end: [], start: [], fiscalYear: [], period: [], filed: [] };
  return { ...sec, currency: 'USD', fy: usd.fy, ttm: usd.ttm, quarters };
}
