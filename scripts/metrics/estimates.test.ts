/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { epsCagr3y, estimateMetrics, parseEstimates } from './estimates';

// trimmed Yahoo quoteSummary earningsTrend (AAPL, 2026-11-11 shape: no +5y period)
const trend = (period: string, growth: number, avg: number, d30: number) => ({ period, growth: { raw: growth }, earningsEstimate: { avg: { raw: avg } }, epsTrend: { current: { raw: avg }, '7daysAgo': { raw: avg }, '30daysAgo': { raw: d30 }, '60daysAgo': { raw: d30 }, '90daysAgo': { raw: d30 } } });
const RESULT = { earningsTrend: { trend: [trend('0q', 0.5752, 2.91, 2.9), trend('0y', 0.12, 9.6, 9.5), trend('+1y', 0.1, 10.56, 10.4)] } };

describe('estimates and PEG', () => {
  test('earningsTrend: current and next fiscal year, growth in percent, EPS trend; no module gives null', () => {
    const e = parseEstimates(RESULT);
    expect(e).toMatchObject({ epsCurrentYear: 9.6, epsNextYear: 10.56, growthNextYear: 10, growth5y: null });
    expect(e?.trendCurrentYear).toEqual({ current: 9.6, d7: 9.6, d30: 9.5, d60: 9.5, d90: 9.5 });
    expect(parseEstimates({ earningsTrend: { trend: [...RESULT.earningsTrend.trend, trend('+5y', 0.15, 0, 0)] } })?.growth5y).toBe(15);
    expect(parseEstimates({})).toBeNull();
  });

  test('peg on 5-year growth, else next-year growth; pegHist, forward to TTM P/E, revision; null on non-positive inputs', () => {
    const e = parseEstimates(RESULT);
    // next-year growth 10%: forward P/E 25 / 10 = 2.5; pegHist 30 / 15 = 2; forward to TTM 25 / 30; revision 9.6 / 9.5 - 1
    expect(estimateMetrics(e, 30, 25, 15)).toEqual({ epsGrowthNextYearEst: 10, epsGrowth5yEst: null, peg: 2.5, pegGrowthSource: 'next-year', pegHist: 2, forwardToTtmPe: 0.83, epsRevision30d: 1.05 });
    expect(estimateMetrics(e ? { ...e, growth5y: 20 } : null, 30, 25, 15)).toMatchObject({ peg: 1.25, pegGrowthSource: '5y' });
    expect(estimateMetrics(e ? { ...e, growthNextYear: -5 } : null, 30, 25, -2)).toMatchObject({ peg: null, pegGrowthSource: null, pegHist: null });
    expect(estimateMetrics(null, null, null, null)).toEqual({ epsGrowthNextYearEst: null, epsGrowth5yEst: null, peg: null, pegGrowthSource: null, pegHist: null, forwardToTtmPe: null, epsRevision30d: null });
  });

  test('3-year EPS CAGR from fiscal years exactly 3 years apart, both positive', () => {
    expect(epsCagr3y({ end: ['2025-09-27', '2024-09-28', '2023-09-30', '2022-09-24'], epsDiluted: [8, 7, 6, 4] })).toBe(25.99); // (8 / 4)^(1/3) - 1
    expect(epsCagr3y({ end: ['2025-09-27', '2024-09-28'], epsDiluted: [8, 7] })).toBeNull();
    expect(epsCagr3y({ end: ['2025-09-27', '2024-09-28', '2023-09-30', '2022-09-24'], epsDiluted: [8, 7, 6, -1] })).toBeNull();
  });
});
