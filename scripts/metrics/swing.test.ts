/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { allTimeHigh, pctFrom52wHigh, sampleStdev, sigmaFromMean, swingMetrics, volatility1y } from './swing';

const series = (closes: number[]) => closes.map((close, i) => ({ date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), close }));
// 253 closes alternating 100 and 110: 252 log returns of +-ln(1.1), mean 0
const zigzag = Array.from({ length: 253 }, (_, i) => (i % 2 ? 110 : 100));
const oneToSixty = Array.from({ length: 60 }, (_, i) => i + 1);

describe('swing formulas', () => {
  test('distance from the 52-week high and the all-time high, the earliest date on a tie', () => {
    expect(pctFrom52wHigh(80, 100)).toBe(-20);
    expect(pctFrom52wHigh(100, 100)).toBe(0);
    expect(pctFrom52wHigh(null, 100)).toBeNull();
    expect(pctFrom52wHigh(80, 0)).toBeNull();
    expect(allTimeHigh(series([10, 30, 20, 30, 5]))).toEqual({ price: 30, date: '2020-01-02' });
    expect(allTimeHigh([])).toBeNull();
  });

  test('volatility1y: sample stdev of 252 log returns × √252 × 100; null below 253 closes or with no spread', () => {
    // sd = ln(1.1) × √(252 / 251), × √252 × 100 = ln(1.1) × 252 / √251 × 100 = 151.60
    expect(volatility1y(zigzag)).toBe(151.6);
    expect(volatility1y([5, 5, 5].concat(zigzag))).toBe(151.6); // only the last 253 closes count
    expect(volatility1y(zigzag.slice(1))).toBeNull();
    expect(volatility1y(Array.from({ length: 253 }, () => 50))).toBeNull();
  });

  test('sigmaFromMean60d: (price - mean of 60 closes) / their sample stdev; null below 60 closes or with no spread', () => {
    // closes 1..60: mean 30.5, sample stdev √305 = 17.464; (60 - 30.5) / 17.464 = 1.69
    expect(sigmaFromMean(60, oneToSixty)).toBe(1.69);
    expect(sigmaFromMean(30.5, oneToSixty)).toBe(0);
    expect(sigmaFromMean(1, [1000].concat(oneToSixty))).toBe(-1.69); // only the last 60 closes count
    expect(sigmaFromMean(60, oneToSixty.slice(1))).toBeNull();
    expect(sigmaFromMean(10, Array.from({ length: 60 }, () => 10))).toBeNull();
    expect(sampleStdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
  });

  test('swingMetrics: every field from one series, nulls (never 0) for a short history', () => {
    const days = series([200].concat(oneToSixty));
    expect(swingMetrics(days, 60)).toEqual({
      athPrice: 200, athDate: '2020-01-01', athBasis: 'daily closes since 2020-01-01', pctFromAth: -70,
      volatility1y: null, sigmaFromMean60d: 1.69, high60d: 60, low60d: 1,
    });
    expect(swingMetrics(series([10, 12]), 12)).toEqual({
      athPrice: 12, athDate: '2020-01-02', athBasis: 'daily closes since 2020-01-01', pctFromAth: 0,
      volatility1y: null, sigmaFromMean60d: null, high60d: null, low60d: null,
    });
    expect(swingMetrics([], 10)).toEqual({ athPrice: null, athDate: null, athBasis: null, pctFromAth: null, volatility1y: null, sigmaFromMean60d: null, high60d: null, low60d: null });
  });
});
