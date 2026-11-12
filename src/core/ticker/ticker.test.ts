/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { chartScale, longRunSeries, peerRow, peerTickers, statementTable, yoyChange } from '.';

// a SEC layer in the meta.json shape: arrays by field, newest first, plus TTM
const META = {
  financialCurrency: 'USD',
  fundamentals: {
    sec: {
      currency: 'USD', ttmIsAnnual: false,
      fy: { end: ['2025-12-31', '2024-12-31', '2023-12-31'], revenue: [120, 100, 80], grossProfit: [60, 45, 40], operatingIncome: [30, 20, -10], netIncome: [24, 16, -8], cfo: [40, 30, 10], capex: [10, 12, 15], epsDiluted: [2.4, 1.6, -0.8], sharesDiluted: [10, 10, 10], debt: [5, 0, 0] },
      ttm: { end: '2026-09-30', revenue: 130, netIncome: 26, cfo: 44, capex: 11, epsDiluted: 2.6, sharesDiluted: 10 },
    },
  },
};

describe('ticker', () => {
  test('statements: TTM first, fiscal years newest first, YoY against the next older year, FCF = CFO - capex', () => {
    const t = statementTable(META, { years: 5 });
    expect(t.source).toBe('sec');
    expect(t.periods).toEqual(['TTM', '2025-12-31', '2024-12-31', '2023-12-31']);
    expect(t.values.revenue).toEqual([130, 120, 100, 80]);
    // 120 vs 100: +20%; 100 vs 80: +25%; TTM and the oldest year have none
    expect(t.yoy.revenue).toEqual([null, 20, 25, null]);
    // a loss that turns into a profit: -8 -> 16 = (16 + 8) / 8 = +300%
    expect(t.yoy.netIncome[2]).toBe(300);
    expect(t.values.fcf).toEqual([33, 30, 18, -5]);
    // debt 0 -> 5: no change against a zero base
    expect(t.yoy.debt[1]).toBeNull();
    expect(yoyChange(-5, -10)).toBe(50);
  });

  test('USD view of a foreign issuer, annual fallback of an older feed, no data', () => {
    const foreign = { fundamentals: { sec: { currency: 'DKK', fy: { end: ['2025-12-31'], revenue: [700], netIncome: [70], sharesDiluted: [100], epsDiluted: [0.7] }, ttm: { end: '2025-12-31' }, ttmIsAnnual: true }, usd: { fy: { revenue: [100], netIncome: [10] }, ttm: {} } } };
    const local = statementTable(foreign);
    expect([local.source, local.currency, local.hasUsd, local.periods.join()]).toEqual(['sec', 'DKK', true, '2025-12-31']);
    const usd = statementTable(foreign, { usd: true });
    expect([usd.source, usd.currency, usd.values.revenue[0], usd.values.epsDiluted[0], usd.values.sharesDiluted[0]]).toEqual(['sec-usd', 'USD', 100, 0.1, 100]);
    const old = statementTable({ financialCurrency: 'USD', fundamentals: { annual: [{ end: '2025-12-31', revenue: 10, capex: -2, operatingCashFlow: 5, fcf: 3 }, { end: '2024-12-31', revenue: 8 }] } });
    expect([old.source, old.values.capex[0], old.values.fcf[0], old.yoy.revenue[0], old.values.costOfRevenue[0]]).toEqual(['annual', 2, 3, 25, null]);
    expect(statementTable(null).source).toBe('none');
  });

  test('long-run series oldest first with margins in percent of revenue; the scale keeps 0', () => {
    const s = longRunSeries(META);
    expect(s.amounts[0].points).toEqual([{ period: '2023', value: 80 }, { period: '2024', value: 100 }, { period: '2025', value: 120 }]);
    expect(s.margins.filter((m) => m.key === 'operatingMargin')[0].points.map((p) => p.value)).toEqual([-12.5, 20, 25]);
    // values from -8 (net income 2023) to 120 (revenue 2025): 5% of the 128 range = 6.4 on both sides
    expect(chartScale(s.amounts)).toEqual({ min: -14.4, max: 126.4 });
    expect(chartScale([{ key: 'x', label: { en: 'x', ru: 'x' }, points: [{ period: '2025', value: null }] }])).toEqual({ min: 0, max: 1 });
  });

  test('peers table rows: revenue = cap / P/S, NI and FCF from the margins; group members first, else the industry by cap', () => {
    expect(peerRow({ ticker: 'V', metrics: { marketCap: 600, ps: 20, netMargin: 50, fcfMargin: -10, pe: 30, peg: 2, pegHist: null, pb: 12 } }))
      .toEqual({ ticker: 'V', marketCap: 600, revenue: 30, netIncome: 15, fcf: -3, pe: 30, peg: 2, pegHist: null, pb: 12, ps: 20 });
    expect(peerRow({ ticker: 'X', metrics: { marketCap: 600, ps: null, netMargin: 5 } }).netIncome).toBeNull();
    const rows = [
      { ticker: 'V', industry: 'Credit', metrics: { marketCap: 600 } }, { ticker: 'MA', industry: 'Credit', metrics: { marketCap: 500 } },
      { ticker: 'AXP', industry: 'Credit', metrics: { marketCap: 200 } }, { ticker: 'COF', industry: 'Credit', metrics: { marketCap: 100 } },
    ];
    expect(peerTickers('V', { cards: ['V', 'MA', 'PYPL'] }, rows)).toEqual({ tickers: ['V', 'MA'], basis: 'group', group: 'cards' });
    expect(peerTickers('COF', {}, rows, 3)).toEqual({ tickers: ['COF', 'V', 'MA'], basis: 'industry', group: null });
    expect(peerTickers('ZZZ', {}, rows).basis).toBe('none');
  });
});
