/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { SecFundamentals } from '../sec/companyfacts';
import { altman, FUNDAMENTAL_METRIC_KEYS, fundamentalMetrics, ownEbitdaMetrics, piotroski, slope, stdev, withSectorExceptions } from './fundamentals';

type Row = Record<string, number | null>;
/** Fiscal years newest first, one per calendar year ending 2025-12-31, plus TTM values */
function sec(years: Row[], ttm: Row): SecFundamentals {
  const keys = Array.from(new Set(years.flatMap((r) => Object.keys(r))));
  const fy: SecFundamentals['fy'] = { end: years.map((_r, i) => `${2025 - i}-12-31`), period: years.map(() => 'FY') };
  keys.forEach((k) => { fy[k] = years.map((r) => (k in r ? r[k] : null)); });
  return { currency: 'USD', units: {}, fy, quarters: { end: [] }, ttm: { end: '2026-09-30', ...ttm }, checks: { balance: null, grossProfit: null, quarterSum: null } };
}
const CTX = { marketCap: 1000, sector: 'Industrials', industry: 'Specialty Industrial Machinery' };
// a company that improves on all nine Piotroski tests between FY-1 and FY0
const GOOD: Row = { netIncome: 120, assets: 1000, cfo: 150, longTermDebt: 100, currentAssets: 400, currentLiabilities: 200, sharesDiluted: 90, grossProfit: 500, revenue: 1100, capex: 30 };
const PREV: Row = { netIncome: 100, assets: 1000, cfo: 120, longTermDebt: 150, currentAssets: 360, currentLiabilities: 200, sharesDiluted: 100, grossProfit: 440, revenue: 1000, capex: 20 };

describe('fundamentals formulas', () => {
  test('ratios on TTM with null for zero or negative denominators, never 0', () => {
    const m = fundamentalMetrics(sec([GOOD, PREV], { revenue: 1000, operatingIncome: 200, netIncome: 100, cfo: 130, capex: 40, interestExpense: 25, debt: 300, cash: 50 }), CTX);
    expect([m.operatingMargin, m.cfoToNi, m.fcfToNi, m.interestCoverage, m.interestCoverageNote, m.capexToCfo, m.capexToRevenue, m.cashRunwayMonths]).toEqual([20, 1.3, 0.9, 8, null, 30.77, 4, null]);
    const loss = fundamentalMetrics(sec([GOOD], { revenue: 0, operatingIncome: -5, netIncome: -10, cfo: -20, capex: 10, interestExpense: 0, debt: 0, cash: 60, shortTermInvestments: 30 }), CTX);
    expect([loss.operatingMargin, loss.cfoToNi, loss.fcfToNi, loss.capexToCfo, loss.capexToRevenue, loss.interestCoverage]).toEqual([null, null, null, null, null, null]);
    expect(loss.interestCoverageNote).toBe('no debt'); // debt 0 and no interest
    expect(loss.cashRunwayMonths).toBe(36); // (60 + 30) / (30 / 12)
    expect(Object.keys(fundamentalMetrics(null, CTX))).toEqual([...FUNDAMENTAL_METRIC_KEYS]);
  });

  test('Altman Z: classic for manufacturing sectors, Z\'\' for the others, none for banks, insurers and REITs', () => {
    const s = sec([GOOD], { assets: 1000, liabilities: 500, currentAssets: 400, currentLiabilities: 200, retainedEarnings: 300, operatingIncome: 150, revenue: 1200, equity: 500 });
    // X1 0.2, X2 0.3, X3 0.15; classic X4 = 1000 / 500 = 2, X5 1.2: 0.24 + 0.42 + 0.495 + 1.2 + 1.2 = 3.555
    expect(altman(s, CTX)).toEqual({ altmanZ: 3.56, altmanVariant: 'classic' });
    // Z'': 6.56 × 0.2 + 3.26 × 0.3 + 6.72 × 0.15 + 1.05 × 1 = 1.312 + 0.978 + 1.008 + 1.05 = 4.348
    expect(altman(s, { ...CTX, sector: 'Communication Services' })).toEqual({ altmanZ: 4.35, altmanVariant: 'z2' });
    for (const industry of ['Banks - Regional', 'Insurance - Life', 'REIT - Retail']) expect(altman(s, { ...CTX, industry })).toEqual({ altmanZ: null, altmanVariant: null });
    expect(altman(sec([GOOD], { assets: 1000 }), CTX).altmanZ).toBeNull();
  });

  test('Piotroski F: one point per test, each of the 9 can flip; null when one cannot be computed', () => {
    expect(piotroski(sec([GOOD, PREV], {}))).toBe(9);
    const flips: Row[] = [
      { netIncome: -1, cfo: -2 }, // a loss with cash burn fails 1 ROA > 0, 2 CFO > 0, 3 ROA up and 4 CFO > NI
      { cfo: 0 }, // 2 CFO > 0, also 4 CFO > NI
      { netIncome: 90, cfo: 95 }, // 3 ROA up
      { cfo: 110 }, // 4 CFO > NI
      { longTermDebt: 200 }, // 5 leverage down
      { currentAssets: 300 }, // 6 current ratio up
      { sharesDiluted: 101 }, // 7 no new shares
      { grossProfit: 400 }, // 8 gross margin up
      { revenue: 900, grossProfit: 400 }, // 9 asset turnover up (gross margin 44.4% still beats 44%)
    ];
    expect(flips.map((f) => piotroski(sec([{ ...GOOD, ...f }, PREV], {})))).toEqual([5, 7, 8, 8, 8, 8, 8, 8, 8]);
    expect(piotroski(sec([{ ...GOOD, longTermDebt: 0 }, { ...PREV, longTermDebt: 0 }], {}))).toBe(9); // no debt in both years passes
    expect(piotroski(sec([{ ...GOOD, currentAssets: null }, PREV], {}))).toBeNull();
    expect(piotroski(sec([GOOD], {}))).toBeNull();
  });

  test('slopes, volatility, CAGR and capex intensity over fiscal years', () => {
    expect(slope([[-3, 10], [-2, 12], [-1, 14], [0, 16]])).toBe(2);
    expect(stdev([10, 20, 30])).toBe(10);
    const years: Row[] = [200, 160, 150, 120, 100, 80].map((ni, i) => ({ netIncome: ni, revenue: 1000, operatingIncome: 100 + 10 * (5 - i), grossProfit: 400, cfo: ni + 20, capex: 20 + i }));
    const m = fundamentalMetrics(sec(years, {}), CTX);
    expect(m.operatingMarginSlope3y).toBe(1); // 12%, 13%, 14%, 15%
    expect(m.grossMarginSlope3y).toBe(0);
    // growth rates 25, 6.67, 25, 20, 25 %: sample stdev 7.94
    expect(m.niVolatility5y).toBe(7.94);
    expect(m.niGrowth3y).toBe(18.56); // (200 / 120)^(1/3) - 1
    expect(m.niGrowth5y).toBe(20.11); // (200 / 80)^(1/5) - 1
    expect(m.capexToRevenueDelta3y).toBe(-0.3); // 2.0% - 2.3%
    const gap = fundamentalMetrics(sec([...years.slice(0, 5), { netIncome: 0, revenue: 1000 }], {}), CTX);
    expect([gap.niVolatility5y, gap.niGrowth5y]).toEqual([null, null]); // a base of zero
  });

  test('own EBITDA valuation, REIT approximate FFO and the bank and insurer exceptions', () => {
    const s = sec([GOOD], { operatingIncome: 80, da: 20, cfo: 90, capex: 30, debt: 300, cash: 50, shortTermInvestments: 50, longTermInvestments: 100, minorityInterest: 10, preferredStock: 0 });
    // EV = 1000 + 300 + 10 + 0 - 50 - 50 = 1210, EBITDA 100
    expect(ownEbitdaMetrics(s, 1000)).toEqual({ evEbitda: 12.1, fcfToEbitda: 60, netDebtToEbitda: 1 });
    expect(ownEbitdaMetrics(sec([GOOD], { operatingIncome: -30, da: 20 }), 1000)).toEqual({ evEbitda: null, fcfToEbitda: null, netDebtToEbitda: null });
    const reit = fundamentalMetrics(sec([GOOD], { netIncome: 100, da: 60, gainOnSaleOfProperty: 10, dividendsPaid: 120 }), { ...CTX, industry: 'REIT - Retail' });
    expect([reit.ffoApprox, reit.ffoPayoutApprox]).toEqual([150, 80]);
    expect(fundamentalMetrics(sec([GOOD], { netIncome: 100, da: 60 }), CTX).ffoApprox).toBeNull(); // not a REIT
    const bank = withSectorExceptions({ pe: 10, quickRatio: 1, evEbitda: 5, piotroskiF: 7, fcfMargin: 20 }, 'Banks - Diversified');
    expect(bank).toEqual({ pe: 10, quickRatio: null, evEbitda: null, piotroskiF: null, fcfMargin: null });
    expect(withSectorExceptions({ quickRatio: 1 }, 'Software - Application')).toEqual({ quickRatio: 1 });
  });
});

describe('stop factor and flag inputs', () => {
  test('negative FCF years in a row, CFO growth and the EPS over NI growth gap', () => {
    // FCF = cfo - capex: -10, -5, -1, then +10: three negative years in a row
    const burn: Row[] = [[10, 20], [15, 20], [19, 20], [30, 20]].map(([cfo, capex]) => ({ cfo, capex }));
    expect(fundamentalMetrics(sec(burn, {}), CTX).fcfNegativeYears).toBe(3);
    expect(fundamentalMetrics(sec([{ cfo: 30, capex: 20 }, ...burn], {}), CTX).fcfNegativeYears).toBe(0); // the latest year is positive
    expect(fundamentalMetrics(sec([{ cfo: 30 }], {}), CTX).fcfNegativeYears).toBeNull(); // no capex: unknown, never 0
    // NI 100 -> 133.1 (10% a year), EPS 1 -> 1.728 (20% a year, buybacks), CFO 150 -> 150: gap 10 pp, CFO growth 0
    const y: Row[] = [[133.1, 1.728], [121, 1.44], [110, 1.2], [100, 1]].map(([netIncome, epsDiluted]) => ({ netIncome, epsDiluted, cfo: 150 }));
    const m = fundamentalMetrics(sec(y, {}), CTX);
    expect([m.niGrowth3y, m.cfoGrowth3y, m.epsNiGrowthGap3y]).toEqual([10, 0, 10]);
  });

  test('the largest material year-over-year balance change and its line', () => {
    const prev: Row = { assets: 1000, cash: 50, receivables: 200, debt: 300, equity: 400 };
    // cash +300% is below 10% of the assets of the year before, so the debt jump (+100%) wins
    const m = fundamentalMetrics(sec([{ assets: 1300, cash: 200, receivables: 210, debt: 600, equity: 420 }, prev], {}), CTX);
    expect([m.balanceYoyMaxChange, m.balanceYoyMaxLine]).toEqual([100, 'debt']);
    const calm = fundamentalMetrics(sec([{ assets: 1020, cash: 52, receivables: 205, debt: 290, equity: 410 }, prev], {}), CTX);
    expect([calm.balanceYoyMaxChange, calm.balanceYoyMaxLine]).toEqual([-3.33, 'debt']);
    expect(fundamentalMetrics(sec([prev], {}), CTX).balanceYoyMaxChange).toBeNull(); // one year only
  });
});
