/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { cents, dcf, DcfInput, dcfInputsFromMeta, defaultGrowth, marginOfSafety, scenarioInput, valueGap } from '.';

const value = (input: DcfInput): number => {
  const r = dcf(input);
  if (!r.ok) throw new Error(r.error);
  return r.perShare;
};

describe('dcf', () => {
  test('set 1: growth equal to WACC, every discounted flow equals the base', () => {
    // EPS flow, base 5, g1 = g2 = WACC = 10%, terminal growth 3%
    // CF(t) = 5 x 1.1^t and the factor is 1.1^t, so every PV(t) = 5: sum of 10 PVs = 50
    // terminal: CF(10) x 1.03 / (0.10 - 0.03) / 1.1^10 = 5 x 1.03 / 0.07 = 73.5714285714
    // value = 50 + 73.5714285714 = 123.5714285714 -> 123.57
    const eps = dcf({ kind: 'eps', base: 5, g1: 10, g2: 10, wacc: 10, terminalGrowth: 3 });
    if (!eps.ok) throw new Error(eps.error);
    expect(cents(eps.sumPv)).toBe(50);
    expect(cents(eps.pvTerminal)).toBe(73.57);
    expect(cents(eps.perShare)).toBe(123.57);
    // FCF flow, base 100, same rates, net debt 300, 10 shares
    // sum of PVs = 10 x 100 = 1000; terminal PV = 100 x 1.03 / 0.07 = 1471.4285714286
    // value 2471.4285714286 - net debt 300 = 2171.4285714286 equity / 10 shares = 217.1428571429 -> 217.14
    const fcf = dcf({ kind: 'fcf', base: 100, g1: 10, g2: 10, wacc: 10, terminalGrowth: 3, netDebt: 300, shares: 10 });
    if (!fcf.ok) throw new Error(fcf.error);
    expect(cents(fcf.value)).toBe(2471.43);
    expect(cents(fcf.equity)).toBe(2171.43);
    expect(cents(fcf.perShare)).toBe(217.14);
  });

  test('set 2: no growth, an annuity plus a growing perpetuity, net cash adds to the value', () => {
    // 1.1^10 = 2.5937424601, 1 / 1.1^10 = 0.3855432894
    // annuity factor of 10 years at 10%: (1 - 0.3855432894) / 0.10 = 6.1445671057
    // FCF base 1000, g1 = g2 = 0, WACC 10%, terminal 2%, net debt -500 (net cash), 100 shares
    // sum of PVs = 1000 x 6.1445671057 = 6144.5671057
    // terminal value = 1000 x 1.02 / (0.10 - 0.02) = 12750; PV = 12750 x 0.3855432894 = 4915.6769399
    // value = 11060.2440456; equity = 11060.2440456 + 500 = 11560.2440456; / 100 = 115.6024405 -> 115.60
    const fcf = dcf({ kind: 'fcf', base: 1000, g1: 0, g2: 0, wacc: 10, terminalGrowth: 2, netDebt: -500, shares: 100 });
    if (!fcf.ok) throw new Error(fcf.error);
    expect(cents(fcf.sumPv)).toBe(6144.57);
    expect(cents(fcf.terminalValue)).toBe(12750);
    expect(cents(fcf.pvTerminal)).toBe(4915.68);
    expect(cents(fcf.perShare)).toBe(115.6);
    // EPS base 4, same rates: 4 x 6.1445671057 = 24.5782684; terminal 4 x 1.02 / 0.08 = 51 -> PV 51 x 0.3855432894 = 19.6627078
    // value = 44.2409762 -> 44.24 (no net debt and no shares in the EPS flow)
    expect(cents(value({ kind: 'eps', base: 4, g1: 0, g2: 0, wacc: 10, terminalGrowth: 2 }))).toBe(44.24);
  });

  test('set 3: Alphabet (GOOGL) on the feed values of 2026-11-11 (SEC TTM to 2026-09-30), both flows', () => {
    // Inputs taken from api/stocks/companies/GOOGL/meta.json fundamentals.sec.ttm of a local updater run on 2026-11-11:
    //   cfo 179,551,000,000, capex 159,804,000,000 -> FCF 19,747,000,000
    //   debt 126,118,000,000, cash 56,334,000,000, short-term investments 208,764,000,000 -> net debt -138,980,000,000
    //   diluted shares 12,368,000,000, diluted EPS 19.15, price 293.45
    // Rates: g1 12%, g2 6%, WACC 9.5%, terminal growth 3%
    // FCF flow, year: flow / 1.095^t = PV
    //   1: 22,116,640,000.00 / 1.095000000 = 20,197,844,748.86
    //   2: 24,770,636,800.00 / 1.199025000 = 20,658,982,756.82
    //   3: 27,743,113,216.00 / 1.312932375 = 21,130,649,029.81
    //   4: 31,072,286,801.92 / 1.437660951 = 21,613,083,939.17
    //   5: 34,800,961,218.15 / 1.574238741 = 22,106,533,344.17
    //   6: 36,889,018,891.24 / 1.723791421 = 21,399,931,821.75
    //   7: 39,102,360,024.71 / 1.887551606 = 20,715,915,736.13
    //   8: 41,448,501,626.20 / 2.066869009 = 20,053,763,178.35
    //   9: 43,935,411,723.77 / 2.263221565 = 19,412,775,314.20
    //  10: 46,571,536,427.19 / 2.478227613 = 18,792,275,646.63
    //   sum of PVs 206,081,755,515.89
    //   terminal 46,571,536,427.19 x 1.03 / 0.065 = 737,979,731,077.08; / 2.478227613 = 297,785,291,015.76
    //   value 503,867,046,531.65 + net cash 138,980,000,000 = 642,847,046,531.65 / 12,368,000,000 = 51.9766 -> 51.98
    const googl = { g1: 12, g2: 6, wacc: 9.5, terminalGrowth: 3 };
    const fcf = dcf({ kind: 'fcf', base: 179551e6 - 159804e6, netDebt: 126118e6 - 56334e6 - 208764e6, shares: 12368e6, ...googl });
    if (!fcf.ok) throw new Error(fcf.error);
    expect(fcf.years.map((y) => cents(y.pv))).toEqual([20197844748.86, 20658982756.82, 21130649029.81, 21613083939.17, 22106533344.17, 21399931821.75, 20715915736.13, 20053763178.35, 19412775314.2, 18792275646.63]);
    expect(cents(fcf.sumPv)).toBe(206081755515.89);
    expect(cents(fcf.terminalValue)).toBe(737979731077.08);
    expect(cents(fcf.pvTerminal)).toBe(297785291015.76);
    expect(cents(fcf.value)).toBe(503867046531.65);
    expect(cents(fcf.perShare)).toBe(51.98);
    // EPS flow, base 19.15:
    //   1: 21.448000 / 1.095 = 19.587215   2: 24.021760 / 1.199025 = 20.034411   3: 26.904371 / 1.312932375 = 20.491818
    //   4: 30.132896 / 1.437660951 = 20.959668   5: 33.748843 / 1.574238741 = 21.438199   6: 35.773774 / 1.723791421 = 20.752960
    //   7: 37.920200 / 1.887551606 = 20.089623   8: 40.195412 / 2.066869009 = 19.447489   9: 42.607137 / 2.263221565 = 18.825880
    //  10: 45.163565 / 2.478227613 = 18.224139
    //   sum 199.851401; terminal 45.163565 x 1.03 / 0.065 = 715.668803 / 2.478227613 = 288.782515; value 488.633916 -> 488.63
    const eps = dcf({ kind: 'eps', base: 19.15, ...googl });
    if (!eps.ok) throw new Error(eps.error);
    expect(cents(eps.sumPv)).toBe(199.85);
    expect(cents(eps.pvTerminal)).toBe(288.78);
    expect(cents(eps.perShare)).toBe(488.63);
    // the flows diverge (capex of 159.8B eats most of the 179.6B operating cash flow): 51.98 is 89.4% below 488.63
    const gap = valueGap(fcf.perShare, eps.perShare);
    expect(gap.flagged).toBe(true);
    expect(cents(gap.gap as number)).toBe(89.36);
    // against the price 293.45: FCF flow (51.98 - 293.45) / 51.98 = -464.6%, EPS flow (488.63 - 293.45) / 488.63 = 39.9%
    expect(cents(marginOfSafety(eps.perShare, 293.45) as number)).toBe(39.94);
    expect(cents(marginOfSafety(fcf.perShare, 293.45) as number)).toBe(-464.58);
  });

  test('WACC at or below the terminal growth, a non-positive base and missing shares are rejected', () => {
    expect(dcf({ kind: 'eps', base: 5, g1: 10, g2: 5, wacc: 3, terminalGrowth: 3 })).toEqual({ ok: false, kind: 'eps', error: 'wacc-not-above-growth' });
    expect(dcf({ kind: 'eps', base: 5, g1: 10, g2: 5, wacc: 2, terminalGrowth: 3 })).toEqual({ ok: false, kind: 'eps', error: 'wacc-not-above-growth' });
    expect(dcf({ kind: 'eps', base: -1, g1: 10, g2: 5, wacc: 9.5, terminalGrowth: 3 })).toEqual({ ok: false, kind: 'eps', error: 'base-not-positive' });
    expect(dcf({ kind: 'fcf', base: 100, g1: 10, g2: 5, wacc: 9.5, terminalGrowth: 3, netDebt: 0, shares: 0 })).toEqual({ ok: false, kind: 'fcf', error: 'shares-not-positive' });
    expect(dcf({ kind: 'fcf', base: 100, g1: 10, g2: 5, wacc: 9.5, terminalGrowth: 3, netDebt: 0 })).toEqual({ ok: false, kind: 'fcf', error: 'shares-not-positive' });
    expect(dcf({ kind: 'eps', base: NaN, g1: 10, g2: 5, wacc: 9.5, terminalGrowth: 3 })).toEqual({ ok: false, kind: 'eps', error: 'not-a-number' });
  });

  test('scenarios, margin of safety, gap, cents and the inputs read from meta.json', () => {
    const base: DcfInput = { kind: 'eps', base: 5, g1: 10, g2: 6, wacc: 9.5, terminalGrowth: 3 };
    expect(scenarioInput(base, 'bear')).toMatchObject({ g1: 5, g2: 3, wacc: 10.5, terminalGrowth: 3 });
    expect(scenarioInput(base, 'bull')).toMatchObject({ g1: 15, g2: 9, wacc: 8.5 });
    expect(value(scenarioInput(base, 'bear')) < value(base) && value(base) < value(scenarioInput(base, 'bull'))).toBe(true);
    expect(marginOfSafety(100, 75)).toBe(25);
    expect(marginOfSafety(null, 75)).toBeNull();
    expect(valueGap(100, 80)).toEqual({ gap: 20, flagged: false });
    expect(cents(2.675)).toBe(2.68);
    expect(cents(-2.675)).toBe(-2.68);
    expect(defaultGrowth({ revenueGrowth3y: 31.4 })).toEqual({ g1: 20, g2: 10 });
    expect(defaultGrowth({ revenueGrowth3y: null, epsGrowth3y: 7.4 })).toEqual({ g1: 7, g2: 3.5 });
    expect(defaultGrowth(null)).toEqual({ g1: 5, g2: 2.5 });
    const meta = { fundamentals: { sec: { currency: 'USD', ttm: { end: '2026-09-30', cfo: 1000, capex: 400, revenue: 4000, epsDiluted: 2.5, sharesDiluted: 100, debt: 300, cash: 50, shortTermInvestments: null, netIncome: 250 } } } };
    expect(dcfInputsFromMeta(meta, { metrics: { sharesOutstanding: 90 } })).toEqual({ fcf: 600, eps: 2.5, netDebt: 250, shares: 100, capexToRevenue: 10, capexToCfo: 40, basis: 'SEC TTM to 2026-09-30', foreign: false });
    // no EPS tag (V, owner answer N36): EPS = net income / the SEC diluted shares of all classes, said in the basis; never over
    // Yahoo's count (one class only), which stays only for the per-share value of the FCF flow
    const noEps = { fundamentals: { sec: { currency: 'USD', fy: { end: ['2026-09-30'], epsDiluted: [null], sharesDiluted: [5] as Array<number | null> }, ttm: { end: '2026-09-30', cfo: 10, capex: 1, revenue: 40, netIncome: 20, epsDiluted: null, sharesDiluted: null, debt: 2, cash: 1 } } } };
    expect(dcfInputsFromMeta(noEps, { metrics: { sharesOutstanding: 4 } })).toMatchObject({ fcf: 9, eps: 4, shares: 5, basis: 'SEC TTM to 2026-09-30; EPS = net income / shares' });
    noEps.fundamentals.sec.fy.sharesDiluted = [null];
    expect(dcfInputsFromMeta(noEps, { metrics: { sharesOutstanding: 4 } })).toMatchObject({ fcf: 9, eps: null, shares: 4, basis: 'SEC TTM to 2026-09-30' });
    // a foreign issuer reads the USD view; EPS = USD net income / diluted shares
    const foreign = { fundamentals: { sec: { currency: 'DKK', ttm: { end: '2025-12-31', sharesDiluted: 4000 } }, usd: { ttm: { cfo: 1500, capex: 500, revenue: 5000, netIncome: 1000, debt: 0, cash: 100 } } } };
    expect(dcfInputsFromMeta(foreign, null)).toMatchObject({ fcf: 1000, eps: 0.25, netDebt: -100, shares: 4000, foreign: true, basis: 'SEC TTM to 2025-12-31 in USD (DKK); EPS = net income / shares' });
    // an older feed without the SEC layer: the latest annual row, Yahoo shares
    const old = { financialCurrency: 'USD', fundamentals: { annual: [{ end: '2025-12-31', revenue: 1000, operatingCashFlow: 300, capex: -100, fcf: 200, eps: 3, debt: 50, cash: 20 }] } };
    expect(dcfInputsFromMeta({ fundamentals: { annual: [{ end: '2026-09-30', netIncome: 30, eps: null }] } }, { metrics: { sharesOutstanding: 10 } })).toMatchObject({ eps: 3, basis: 'fiscal year 2026-09-30; EPS = net income / shares' });
    expect(dcfInputsFromMeta(old, { metrics: { sharesOutstanding: 10 } })).toEqual({ fcf: 200, eps: 3, netDebt: 30, shares: 10, capexToRevenue: 10, capexToCfo: (100 / 300) * 100, basis: 'fiscal year 2025-12-31', foreign: false });
  });
});
