/// <reference lib="esnext" />
/**
 * Price and swing metrics (screener plan 1.5 "Цена и свинги", 1.6): pure formulas over a daily close series, no IO and no
 * Bun or Node APIs, so the same file can become the shared block of the 29 ETF brand updaters byte for byte.
 *
 * Input: daily closes oldest first, split adjusted and NOT dividend adjusted (Yahoo chart `close`), plus the last price.
 * Every value is null when the series is too short or the spread is zero, never 0 for "unknown".
 */

export type SwingDay = { date: string; close: number };

export type SwingMetrics = {
  athPrice: number | null; // highest close of the series
  athDate: string | null; // date of that close (the earliest one on a tie)
  athBasis: string | null; // which history the ATH covers: `daily closes since <first date>`
  pctFromAth: number | null; // (price / athPrice - 1) × 100
  volatility1y: number | null; // sample stdev of the last 252 daily log returns × √252 × 100
  sigmaFromMean60d: number | null; // (price - mean of the last 60 closes) / sample stdev of those closes
  high60d: number | null; // highest of the last 60 closes
  low60d: number | null; // lowest of the last 60 closes
};

/** Sessions in a trading year: volatility1y uses this many daily returns (one more close) */
export const SWING_YEAR_SESSIONS = 252;
/** Closes behind sigmaFromMean60d, high60d and low60d */
export const SWING_WINDOW = 60;

const roundTo = (value: number, digits: number): number | null => {
  if (!Number.isFinite(value)) return null;
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
};
const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Sample standard deviation (n - 1); null below 2 values or when every value is equal */
export function sampleStdev(values: number[]): number | null {
  if (values.length < 2) return null;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  const mean = sum / values.length;
  let squares = 0;
  for (let i = 0; i < values.length; i += 1) squares += (values[i] - mean) * (values[i] - mean);
  const sd = Math.sqrt(squares / (values.length - 1));
  return sd > 0 && Number.isFinite(sd) ? sd : null;
}

/** (price / reference - 1) × 100, 2 decimals; null when a value is missing or not positive */
export function pctFrom(price: unknown, reference: unknown): number | null {
  return isPositive(price) && isPositive(reference) ? roundTo((price / reference - 1) * 100, 2) : null;
}

/** pctFrom52wHigh = (price / week52High - 1) × 100 */
export const pctFrom52wHigh = (price: unknown, week52High: unknown): number | null => pctFrom(price, week52High);

/** Highest close and its first date; null for an empty series */
export function allTimeHigh(days: SwingDay[]): { price: number; date: string } | null {
  let best: SwingDay | null = null;
  for (let i = 0; i < days.length; i += 1) if (isPositive(days[i].close) && (!best || days[i].close > best.close)) best = days[i];
  return best ? { price: best.close, date: best.date } : null;
}

/** Annualized volatility in percent from the last 252 daily log returns (253 closes); null with fewer closes */
export function volatility1y(closes: number[]): number | null {
  if (closes.length < SWING_YEAR_SESSIONS + 1) return null;
  const tail = closes.slice(closes.length - SWING_YEAR_SESSIONS - 1);
  const returns: number[] = [];
  for (let i = 1; i < tail.length; i += 1) {
    if (!isPositive(tail[i]) || !isPositive(tail[i - 1])) return null;
    returns.push(Math.log(tail[i] / tail[i - 1]));
  }
  const sd = sampleStdev(returns);
  return sd === null ? null : roundTo(sd * Math.sqrt(SWING_YEAR_SESSIONS) * 100, 2);
}

/** Distance of the price from the mean of the last 60 closes in sample standard deviations; null with fewer closes or no spread */
export function sigmaFromMean(price: unknown, closes: number[], window = SWING_WINDOW): number | null {
  if (!isPositive(price) || closes.length < window) return null;
  const tail = closes.slice(closes.length - window);
  const sd = sampleStdev(tail);
  if (sd === null) return null;
  let sum = 0;
  for (let i = 0; i < tail.length; i += 1) sum += tail[i];
  return roundTo((price - sum / tail.length) / sd, 2);
}

/** Every swing metric of one security. `price` is the last price (the last close when the quote has none) */
export function swingMetrics(days: SwingDay[], price: unknown): SwingMetrics {
  const closes = days.map((d) => d.close);
  const ath = allTimeHigh(days);
  const tail = closes.length >= SWING_WINDOW ? closes.slice(closes.length - SWING_WINDOW) : [];
  return {
    athPrice: ath ? roundTo(ath.price, 4) : null,
    athDate: ath ? ath.date : null,
    athBasis: ath ? `daily closes since ${days[0].date}` : null,
    pctFromAth: ath ? pctFrom(price, ath.price) : null,
    volatility1y: volatility1y(closes),
    sigmaFromMean60d: sigmaFromMean(price, closes),
    high60d: tail.length ? roundTo(Math.max.apply(null, tail), 4) : null,
    low60d: tail.length ? roundTo(Math.min.apply(null, tail), 4) : null,
  };
}
