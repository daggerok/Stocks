/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { SecFundamentals } from '../sec/companyfacts';
import { historyMetrics, monthEnds, percentileOf, ttmSeries } from './history';

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
/** one close on the 28th of every month, 2020-01 to 2025-12 (72 months) */
const months = (close: (i: number) => number) => Array.from({ length: 72 }, (_, i) => ({ date: iso(2020, i, 28), close: close(i) }));
/** 28 calendar quarters, newest first, ending 2025-09-30: net income, CFO and capex per quarter, 100 diluted shares */
function quarters(ni: number, cfo = 15, capex = 5): SecFundamentals {
  const ends: string[] = [], starts: string[] = [];
  for (let k = 0; k < 28; k += 1) { ends.push(iso(2025, 9 - 3 * k, 0)); starts.push(iso(2025, 6 - 3 * k, 1)); }
  const fill = (v: number) => ends.map(() => v);
  return {
    currency: 'USD', units: {}, fy: { end: [] }, ttm: {}, checks: { balance: null, grossProfit: null, quarterSum: null },
    quarters: { end: ends, start: starts, netIncome: fill(ni), cfo: fill(cfo), capex: fill(capex), sharesDiluted: fill(100) },
  };
}

describe('own 5-year history', () => {
  test('month ends, TTM of 4 consecutive quarters known 60 days after the end, percentile strictly below', () => {
    expect(monthEnds([{ date: '2025-01-02', close: 1 }, { date: '2025-01-31', close: 2 }, { date: '2025-02-03', close: 3 }], '2025-01-01')).toEqual([{ date: '2025-01-31', close: 2 }, { date: '2025-02-03', close: 3 }]);
    const sec = quarters(10);
    const ttm = ttmSeries(sec, (i) => (sec.quarters.netIncome as number[])[i]);
    expect(ttm[0]).toEqual({ known: '2025-11-29', value: 40 }); // 2025-09-30 + 60 days
    expect(ttm.length).toBe(25);
    sec.quarters.start[5] = '2024-01-15'; // a gap after quarter 5 breaks the 3 sums that need quarter 5 to follow quarter 6
    expect(ttmSeries(sec, (i) => (sec.quarters.netIncome as number[])[i]).length).toBe(22);
    expect(percentileOf(5, [1, 5, 9, 3])).toBe(50);
  });

  test('pePct5y and pFcfPct5y: close × shares / TTM against the own monthly series; null for a loss or a short history', () => {
    // closes 10 + i; the 61 month ends from 2020-12-28 have i = 11..71, P/E = close × 100 / 40; today 40 beats 10 + i < 40: i = 11..29
    const days = months((i) => 10 + i);
    const m = historyMetrics(days, 40, quarters(10), [], null);
    expect(m.pePct5y).toBe(31.15); // 19 of 61
    expect(m.pFcfPct5y).toBe(31.15); // FCF 10 a quarter: the same shape
    expect(historyMetrics(days, 40, quarters(-1), [], null).pePct5y).toBeNull(); // a loss today
    expect(historyMetrics(days, 40, quarters(10, 3, 5), [], null).pFcfPct5y).toBeNull(); // negative FCF
    expect(historyMetrics(days.slice(24), 40, quarters(10), [], null).pePct5y).toBeNull(); // 4 years of prices
    expect(historyMetrics(days, 40, null, [], null)).toEqual({ pePct5y: null, pFcfPct5y: null, yieldVsAvg5y: null });
  });

  test('yieldVsAvg5y: current yield over the mean of month-end trailing-12-month yields; null without a dividend', () => {
    const days = months(() => 50);
    const dividends = Array.from({ length: 24 }, (_, i) => ({ date: iso(2020, 3 * i, 15), amount: 0.25 })); // 1.00 a year: 2% of 50
    expect(historyMetrics(days, 50, null, dividends, 3).yieldVsAvg5y).toBe(1.5);
    expect(historyMetrics(days, 50, null, dividends, 0).yieldVsAvg5y).toBeNull();
    expect(historyMetrics(days, 50, null, [], 3).yieldVsAvg5y).toBeNull(); // no past payments: no average
  });
});
