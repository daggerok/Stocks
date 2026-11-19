/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { SecFundamentals } from '../sec/companyfacts';
import { altman, capMultiples, FUNDAMENTAL_METRIC_KEYS, fundamentalMetrics, ownEbitdaMetrics, piotroski, slope, staleAnnualTtm, stdev, ttmAmounts, withRevenueSanity, withSectorExceptions, REVENUE_RATIO_KEYS } from './fundamentals';

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
    expect(reit.ffoGrowth3y).toBeNull(); // one fiscal year only
    // annual FFO 200 now (150 + 60 - 10) and 100 three years back (80 + 20): (200 / 100)^(1/3) - 1 = 25.99%
    const years: Row[] = [{ ...GOOD, netIncome: 150, da: 60, gainOnSaleOfProperty: 10 }, GOOD, GOOD, { ...GOOD, netIncome: 80, da: 20 }];
    const grown = fundamentalMetrics(sec(years, { netIncome: 100, da: 60 }), { ...CTX, industry: 'REIT - Retail' });
    expect(grown.ffoGrowth3y).toBe(25.99);
    expect(fundamentalMetrics(sec(years, { netIncome: 100, da: 60 }), CTX).ffoGrowth3y).toBeNull(); // not a REIT
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

  test('share count change per year: dilution positive, buybacks negative, unit errors fixed, unexplained jumps empty', () => {
    // 100 -> 110 diluted shares over 3 years, NI / EPS confirms every year: +3.23% a year
    const grow: Row[] = [110, 106, 103, 100].map((s) => ({ sharesDiluted: s, netIncome: s * 2, epsDiluted: 2 }));
    expect(fundamentalMetrics(sec(grow, {}), CTX).sharesChange3y).toBe(3.23);
    expect(fundamentalMetrics(sec(grow, {}), CTX).sharesChange5y).toBeNull(); // only 4 years
    // one year filed in millions (0.000106 of the real count): NI / EPS gives 106 back
    const unit: Row[] = grow.map((r, i) => (i === 1 ? { ...r, sharesDiluted: 0.000106 } : r));
    expect(fundamentalMetrics(sec(unit, {}), CTX).sharesChange3y).toBe(3.23);
    // buybacks 100 -> 90 without EPS: -3.45% a year
    const buy: Row[] = [90, 94, 97, 100].map((s) => ({ sharesDiluted: s }));
    expect(fundamentalMetrics(sec(buy, {}), CTX).sharesChange3y).toBe(-3.45);
    // a 3x jump nothing can confirm stays empty, never a guess
    const jump: Row[] = [270, 100, 100, 100].map((s) => ({ sharesDiluted: s }));
    expect(fundamentalMetrics(sec(jump, {}), CTX).sharesChange3y).toBeNull();
    // a 10:1 split the older filings were not restated for (AVGO 2024): 4232 after, 429 and 421 before -> read as 4290 and 4210
    const split: Row[] = [4232, 429, 421, 419].map((s) => ({ sharesDiluted: s }));
    expect(fundamentalMetrics(sec(split, {}), CTX).sharesChange3y).toBe(0.33);
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

describe('sec layer defaults', () => {
  test('a debt-free issuer (debt 0 from the SEC layer, N13) gets EV, EV/EBITDA and net debt to EBITDA; missing debt or operating income stays null', () => {
    const free = sec([GOOD], { operatingIncome: 80, da: 20, cfo: 90, capex: 10, debt: 0, cash: 150, shortTermInvestments: 50 });
    expect(ownEbitdaMetrics(free, 1000)).toEqual({ evEbitda: 8, fcfToEbitda: 80, netDebtToEbitda: -2 }); // EV 1000 - 150 - 50 = 800
    expect(capMultiples(free, 1000).enterpriseValue).toBe(800);
    expect(ownEbitdaMetrics(sec([GOOD], { operatingIncome: 80, da: 20, debt: null, cash: 150 }), 1000).evEbitda).toBeNull();
    // a REIT without operating income: no EBITDA, so nothing even with debt 0
    expect(ownEbitdaMetrics(sec([GOOD], { operatingIncome: null, da: 20, debt: 0, cash: 10 }), 1000)).toEqual({ evEbitda: null, fcfToEbitda: null, netDebtToEbitda: null });
  });

  test('absolute TTM amounts in USD (N38): revenue, net income, FCF = CFO - capex; a loss stays negative, no layer gives null', () => {
    expect(ttmAmounts(sec([GOOD], { revenue: 430.4, netIncome: -12.6, cfo: 90, capex: 100 }))).toEqual({ revenueTtm: 430, netIncomeTtm: -13, fcfTtm: -10 });
    expect(ttmAmounts(sec([GOOD], { revenue: 1, cfo: 5 }))).toEqual({ revenueTtm: 1, netIncomeTtm: null, fcfTtm: null });
    expect(ttmAmounts(null)).toEqual({ revenueTtm: null, netIncomeTtm: null, fcfTtm: null });
    expect(withSectorExceptions({ fcfTtm: 5, revenueTtm: 9 }, 'Banks - Regional')).toEqual({ fcfTtm: null, revenueTtm: 9 });
  });

  test('stale annual TTM (N29): an annual-only TTM ending more than 12 months before the last close; a quarterly TTM never', () => {
    const annual = { ...sec([GOOD], {}), ttmIsAnnual: true, ttm: { end: '2025-03-31' } };
    expect([staleAnnualTtm(annual, '2026-03-31'), staleAnnualTtm(annual, '2026-04-02'), staleAnnualTtm(annual, null)]).toEqual([false, true, false]);
    expect(staleAnnualTtm({ ...annual, ttmIsAnnual: false }, '2027-01-01')).toBe(false);
    expect(staleAnnualTtm(null, '2027-01-01')).toBe(false);
  });
});

describe('revenue sanity (owner 2026-11-15, FUTU)', () => {
  const nulls = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, null]));
  const all = Object.fromEntries(REVENUE_RATIO_KEYS.map((k, i) => [k, i + 1]));

  test('a profit line above revenue: every ratio over revenue is null, marginNote says why, key order and other metrics kept', () => {
    // FUTU on 2026-11-13: revenue 1.36B below net income 1.45B, operating margin 133%, FCF margin 385%
    const futu = { pe: 9.09, ...all, operatingMargin: 133.18, fcfMargin: 385.27, cfoToNi: 3.6, fcfToNi: 3.59, roic: 63.43, revenueTtm: 1356208014, netIncomeTtm: 1454334663, fcfTtm: 5225035701, marginNote: null };
    const out = withRevenueSanity(futu);
    expect(Object.keys(out)).toEqual(Object.keys(futu));
    expect(out).toEqual({ ...futu, ...nulls(REVENUE_RATIO_KEYS), cfoToNi: null, fcfToNi: null, marginNote: 'revenue below profit; FCF above revenue' });
    // each impossible margin alone triggers it; TTM net income above TTM revenue too
    for (const k of ['netMargin', 'grossMargin', 'ebitdaMargin', 'operatingMargin']) expect(withRevenueSanity({ [k]: 100.5, operatingMarginSlope3y: 2, cfoToNi: 1.1 })).toEqual({ [k]: null, operatingMarginSlope3y: null, cfoToNi: 1.1, marginNote: 'revenue below profit' });
    expect(withRevenueSanity({ revenueTtm: 100, netIncomeTtm: 101, grossMargin: 60 }).grossMargin).toBeNull();
  });

  test('FCF above revenue (a BDC or closed-end fund): only the FCF margin and the cash conversion ratios are null', () => {
    const fund = { netMargin: 95.2, fcfMargin: 257.6, fcfMarginDelta: 10, fcfMarginDelta3y: 5, cfoToNi: 2.7, fcfToNi: 2.7, grossMargin: 98, marginNote: null };
    expect(withRevenueSanity(fund)).toEqual({ netMargin: 95.2, fcfMargin: null, fcfMarginDelta: null, fcfMarginDelta3y: null, cfoToNi: null, fcfToNi: null, grossMargin: 98, marginNote: 'FCF above revenue' });
    expect(withRevenueSanity({ revenueTtm: 100, fcfTtm: 150, fcfMargin: null, cfoToNi: 2 }).cfoToNi).toBeNull();
  });

  test('real margins stay: 100% exactly, 90%, a loss far below -100% and empty values give the same object back', () => {
    for (const m of [{ netMargin: 100, grossMargin: 100, fcfMargin: 100 }, { netMargin: 90, operatingMargin: 92, fcfMargin: 99 }, { netMargin: -19343, fcfMargin: -500 }, { netMargin: null, revenueTtm: 0, netIncomeTtm: 5 }]) {
      expect(withRevenueSanity(m)).toBe(m);
    }
  });
});
