/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { capMultiples, fundamentalMetrics } from '../metrics/fundamentals';
import type { SecFundamentals } from './companyfacts';
import { averageRate, fxPoints, rateAt, usdLayer, usdView, type FxSeries } from './fx';

/** EUR layer: fiscal years 2022-2025 (calendar years), flat net income of 100 EUR, TTM = FY2025 (an annual-only 20-F filer) */
function eurLayer(): SecFundamentals {
  const years = [2025, 2024, 2023, 2022];
  const fy: SecFundamentals['fy'] = {
    end: years.map((y) => `${y}-12-31`), start: years.map((y) => `${y}-01-01`), fiscalYear: years, period: years.map(() => 'FY'), filed: years.map(() => '2026-02-01'),
    revenue: [1000, 900, 800, 700], netIncome: [100, 100, 100, 100], cfo: [150, 140, 130, 120], capex: [50, 50, 50, 50], assets: [2000, 1900, 1800, 1700],
    equity: [800, 700, 600, 500], debt: [300, 300, 300, 300], cash: [100, 100, 100, 100], epsDiluted: [2, 2, 2, 2], sharesDiluted: [50, 50, 50, 50],
  };
  const ttm = { end: '2025-12-31', start: '2025-01-01', fiscalYear: 2025, period: 'TTM', basis: 'fy', filed: '2026-02-01', revenue: 1000, netIncome: 100, cfo: 150, capex: 50, assets: 2000, equity: 800, debt: 300, cash: 100, epsDiluted: 2, sharesDiluted: 50 };
  return { currency: 'EUR', taxonomy: 'ifrs-full', annualForm: '20-F', ttmIsAnnual: true, units: {}, fy, quarters: { end: [] }, ttm, checks: { balance: null, grossProfit: null, quarterSum: null } };
}

/** EURUSD: 1.00 in the first half of each year, 1.20 in the second half, 1.30 on the last trading days of December (year-end rate) */
function eurusd(): FxSeries {
  const days: Array<{ date: string; close: number }> = [];
  for (let y = 2022; y <= 2025; y += 1) {
    for (let m = 1; m <= 12; m += 1) {
      for (const d of [1, 15, 28]) {
        const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        days.push({ date, close: m <= 6 ? 1 : 1.2 });
      }
    }
    days.push({ date: `${y}-12-30`, close: 1.3 });
  }
  return { currency: 'EUR', pair: 'EURUSD=X', inverted: false, points: fxPoints(days, false) };
}

describe('fx conversion (plan 1.3)', () => {
  test('rates: the last close on or before a date within 7 days, the average over a period, an inverse pair inverted', () => {
    const points = fxPoints([{ date: '2025-01-02', close: 1.1 }, { date: '2025-01-03', close: 1.3 }, { date: '2025-01-06', close: 0 }], false);
    expect(points.length).toBe(2); // a zero close is dropped
    expect([rateAt(points, '2025-01-05'), rateAt(points, '2025-01-01'), rateAt(points, '2025-01-20')]).toEqual([1.3, null, null]);
    expect(averageRate(points, '2025-01-01', '2025-01-03')).toBeCloseTo(1.2, 10);
    expect(averageRate(points, '2024-12-01', '2025-01-03')).toBeNull(); // the series starts more than 7 days after the period
    expect(fxPoints([{ date: '2025-01-02', close: 32 }], true)[0].rate).toBe(1 / 32); // USDTWD=X 32 -> 0.03125 USD per TWD
  });

  test('balance lines at the period-end rate, flows and per-share values at the period average, share counts as reported', () => {
    const usd = usdLayer(eurLayer(), eurusd());
    if (!usd) throw new Error('no USD layer');
    const avg = usd.rates.ttm.flow as number; // 18 points at 1.00, 18 at 1.20 and one at 1.30 in 2025
    expect(avg).toBeCloseTo((18 * 1 + 18 * 1.2 + 1.3) / 37, 8); // stored with 10 significant digits
    expect(usd.rates.ttm.balance).toBe(1.3);
    expect(usd.ttm.revenue).toBe(Math.round(1000 * avg)); // 1105 USD
    expect(usd.ttm.netIncome).toBe(Math.round(100 * avg));
    expect(usd.ttm.assets).toBe(2600); // 2000 EUR at 1.30 on 2025-12-31
    expect(usd.ttm.epsDiluted).toBe(Math.round(2 * avg * 1e4) / 1e4);
    expect(usd.ttm.sharesDiluted).toBe(50);
    expect(usd.fy.end).toEqual(['2025-12-31', '2024-12-31', '2023-12-31', '2022-12-31']);
    expect([usd.currency, usd.pair, usdLayer({ ...eurLayer(), currency: 'USD' }, eurusd())]).toEqual(['EUR', 'EURUSD=X', null]);
  });

  test('growth and margins stay in the reporting currency: flat EUR net income is 0% growth whatever EURUSD did', () => {
    const sec = eurLayer();
    const fx = eurusd();
    fx.points = fx.points.map((p) => ({ date: p.date, rate: p.rate * (p.date >= '2025-01-01' ? 1 : 0.8) })); // the dollar was dearer before 2025
    const usd = usdLayer(sec, fx);
    if (!usd) throw new Error('no USD layer');
    expect((usd.fy.netIncome[0] as number) / (usd.fy.netIncome[3] as number)).toBeGreaterThan(1.2); // in USD it looks like growth
    const m = fundamentalMetrics(sec, { marketCap: 5000, sector: 'Technology', industry: 'Semiconductors', usd: usdView(sec, usd) });
    expect([m.niGrowth3y, m.operatingMargin, m.cfoToNi, m.capexToRevenue]).toEqual([0, null, 1.5, 5]);
  });

  test('ADR P/E over market cap: market cap / net income in USD, not price / EPS of an ordinary share; a loss gives null', () => {
    const sec = eurLayer();
    const usd = usdLayer(sec, eurusd());
    if (!usd) throw new Error('no USD layer');
    const view = usdView(sec, usd);
    const cap = 2210; // USD
    const m = capMultiples(view, cap);
    expect(m.pe).toBe(Math.round((cap / (usd.ttm.netIncome as number)) * 100) / 100); // 2210 / 111 = 19.91
    expect(m.ps).toBe(Math.round((cap / (usd.ttm.revenue as number)) * 100) / 100);
    expect(m.pFcf).toBe(Math.round((cap / ((usd.ttm.cfo as number) - (usd.ttm.capex as number))) * 100) / 100);
    expect(m.pb).toBe(Math.round((cap / 1040) * 100) / 100); // equity 800 EUR at 1.30
    expect(m.enterpriseValue).toBe(cap + 390 - 130); // debt 300 and cash 100 at 1.30
    const loss = usdView(sec, { ...usd, ttm: { ...usd.ttm, netIncome: -5 } });
    expect([capMultiples(loss, cap).pe, capMultiples(view, null).pe, capMultiples(null, cap).pe]).toEqual([null, null, null]);
  });
});
