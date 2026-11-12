/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { column, fiscalYearOf, parseCompanyFacts } from './companyfacts';

// A slice of Apple's companyfacts (CIK 0000320193, real values): fiscal year 2025 ends 2025-09-27, 10-Q income lines carry
// the 3-month and the year-to-date facts, the cash flow statement only the year-to-date ones
const K = (start: string, end: string, val: number, filed = '2025-10-31', form = '10-K') => ({ start, end, val, form, filed });
const Q = (start: string, end: string, val: number, filed: string) => ({ start, end, val, form: '10-Q', filed });
const I = (end: string, val: number, filed = '2025-10-31', form = '10-K') => ({ end, val, form, filed });
const FY24 = ['2023-10-01', '2024-09-28'] as const;
const FY25 = ['2024-09-29', '2025-09-27'] as const;
const Q1 = '2024-12-28', H1 = '2025-03-29', M9 = '2025-06-28';
const FILED = { q1: '2025-01-31', h1: '2025-05-02', m9: '2025-08-01', next: '2026-01-30' };
const NEXT_Q1 = ['2025-09-28', '2025-12-27'] as const;

function apple(): any {
  const usd = (list: unknown[]) => ({ units: { USD: list } });
  return {
    facts: {
      'us-gaap': {
        RevenueFromContractWithCustomerExcludingAssessedTax: usd([
          K(...FY24, 383000000000, '2024-11-01'), // an earlier value of FY2024, restated by the next filing
          K(...FY24, 391035000000, '2025-10-31'),
          K(...FY25, 416161000000),
          Q(FY25[0], Q1, 124300000000, FILED.q1),
          Q(FY25[0], H1, 219659000000, FILED.h1), Q('2024-12-29', H1, 95359000000, FILED.h1),
          Q(FY25[0], M9, 313695000000, FILED.m9), Q('2025-03-30', M9, 94036000000, FILED.m9),
          Q(...NEXT_Q1, 143756000000, FILED.next), Q(FY25[0], Q1, 124300000000, FILED.next),
        ]),
        NetIncomeLoss: usd([
          K(...FY24, 93736000000), K(...FY25, 112010000000),
          Q(FY25[0], Q1, 36330000000, FILED.q1),
          Q(FY25[0], H1, 61110000000, FILED.h1), Q('2024-12-29', H1, 24780000000, FILED.h1),
          Q(FY25[0], M9, 84544000000, FILED.m9), Q('2025-03-30', M9, 23434000000, FILED.m9),
          Q(...NEXT_Q1, 42097000000, FILED.next),
        ]),
        NetCashProvidedByUsedInOperatingActivities: usd([
          K(...FY24, 118254000000), K(...FY25, 111482000000),
          Q(FY25[0], Q1, 29935000000, FILED.q1), Q(FY25[0], H1, 53887000000, FILED.h1), Q(FY25[0], M9, 81754000000, FILED.m9),
          Q(...NEXT_Q1, 53925000000, FILED.next),
        ]),
        EarningsPerShareDiluted: { units: { 'USD/shares': [K(...FY24, 6.08), K(...FY25, 7.46), Q(FY25[0], Q1, 2.4, FILED.q1), Q(...NEXT_Q1, 2.84, FILED.next)] } },
        WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: [K(...FY24, 15408095000), K(...FY25, 15004697000), Q(...NEXT_Q1, 14810356000, FILED.next)] } },
        Assets: usd([I('2025-09-27', 359241000000), I('2025-12-27', 379297000000, FILED.next, '10-Q')]),
        Liabilities: usd([I('2025-09-27', 285508000000), I('2025-12-27', 291107000000, FILED.next, '10-Q')]),
        StockholdersEquity: usd([I('2025-09-27', 73733000000), I('2025-12-27', 88190000000, FILED.next, '10-Q')]),
        // a 20-F style fact and a non-SEC form are ignored
        GrossProfit: usd([{ start: FY25[0], end: FY25[1], val: 1, form: '8-K', filed: '2025-10-31' }]),
      },
    },
  };
}

describe('sec companyfacts', () => {
  test('Apple FY2025 matches the 10-K: revenue 416.2B, NI 112.0B, diluted EPS 7.46, diluted shares 15.00B, CFO 111.5B; restatements take the latest filing', () => {
    const sec = parseCompanyFacts(apple());
    if (!sec) throw new Error('no SEC layer');
    const i = sec.fy.end.indexOf('2025-09-27');
    expect([sec.fy.fiscalYear[i], sec.fy.period[i], sec.fy.start[i]]).toEqual([2025, 'FY', '2024-09-29']);
    expect(column(sec.fy, 'revenue')[i]).toBe(416161000000);
    expect(column(sec.fy, 'netIncome')[i]).toBe(112010000000);
    expect(column(sec.fy, 'epsDiluted')[i]).toBe(7.46);
    expect(column(sec.fy, 'sharesDiluted')[i]).toBe(15004697000);
    expect(column(sec.fy, 'cfo')[i]).toBe(111482000000);
    expect(column(sec.fy, 'revenue')[sec.fy.end.indexOf('2024-09-28')]).toBe(391035000000); // the 2025 filing restated 383.0B
    expect(column(sec.fy, 'grossProfit')[i]).toBeNull(); // an 8-K fact is not a period value
    expect(sec.units.revenue).toBe('USD');
    expect(sec.units.epsDiluted).toBe('USD/shares');
  });

  test('quarters: 3-month facts, year-to-date differences, Q4 = FY - 9M; the four quarters sum to the fiscal year', () => {
    const sec = parseCompanyFacts(apple());
    if (!sec) throw new Error('no SEC layer');
    const q = (end: string, key: string) => column(sec.quarters, key)[sec.quarters.end.indexOf(end)];
    expect(sec.quarters.period.slice(0, 5)).toEqual(['Q1', 'Q4', 'Q3', 'Q2', 'Q1']);
    expect(sec.quarters.fiscalYear.slice(0, 5)).toEqual([2026, 2025, 2025, 2025, 2025]);
    expect([q(Q1, 'revenue'), q(H1, 'revenue'), q(M9, 'revenue'), q('2025-09-27', 'revenue')]).toEqual([124300000000, 95359000000, 94036000000, 102466000000]);
    expect([q(Q1, 'cfo'), q(H1, 'cfo'), q(M9, 'cfo'), q('2025-09-27', 'cfo')]).toEqual([29935000000, 23952000000, 27867000000, 29728000000]); // cash flow from YTD only
    const ni = [Q1, H1, M9, '2025-09-27'].map((e) => q(e, 'netIncome') as number);
    expect(ni.reduce((s, v) => s + v, 0)).toBe(112010000000);
    expect(q('2025-09-27', 'epsDiluted')).toBeNull(); // a per-share Q4 is not derived
    expect(sec.checks.quarterSum).toEqual({ ok: true, diffPct: 0 });
  });

  test('TTM = last fiscal year + current year-to-date - the same year-to-date a year earlier; balance lines of the last quarter', () => {
    const sec = parseCompanyFacts(apple());
    if (!sec) throw new Error('no SEC layer');
    expect([sec.ttm.end, sec.ttm.period, sec.ttm.fiscalYear]).toEqual(['2025-12-27', 'TTM', 2026]);
    expect(sec.ttm.revenue).toBe(416161000000 + 143756000000 - 124300000000);
    expect(sec.ttm.netIncome).toBe(112010000000 + 42097000000 - 36330000000);
    expect(sec.ttm.cfo).toBe(111482000000 + 53925000000 - 29935000000);
    expect(sec.ttm.epsDiluted).toBe(7.9); // 7.46 + 2.84 - 2.40
    expect(sec.ttm.sharesDiluted).toBe(14810356000);
    expect(sec.ttm.assets).toBe(379297000000);
    expect(sec.checks.balance).toEqual({ ok: true, diffPct: 0 });
  });

  test('a split after the filing date restates share counts and per-share values; no us-gaap facts give null', () => {
    const facts = apple();
    facts.facts['us-gaap'].WeightedAverageNumberOfDilutedSharesOutstanding.units.shares.push(K('2019-09-29', '2020-09-26', 4474590000, '2020-10-30'));
    facts.facts['us-gaap'].EarningsPerShareDiluted.units['USD/shares'].push(K('2019-09-29', '2020-09-26', 13.0, '2020-08-01')); // filed before the 4:1 split
    facts.facts['us-gaap'].NetIncomeLoss.units.USD.push(K('2019-09-29', '2020-09-26', 57411000000, '2020-10-30'));
    const sec = parseCompanyFacts(facts, { splits: [{ date: '2020-08-31', ratio: 4 }] });
    if (!sec) throw new Error('no SEC layer');
    const i = sec.fy.end.indexOf('2020-09-26');
    expect(column(sec.fy, 'sharesDiluted')[i]).toBe(4474590000); // filed after the split: already restated
    expect(column(sec.fy, 'epsDiluted')[i]).toBe(3.25);
    expect(parseCompanyFacts({ facts: { 'ifrs-full': {} } })).toBeNull();
    expect(parseCompanyFacts(null as unknown as Record<string, unknown>)).toBeNull();
  });

  test('fiscal year label by end date: a 52/53-week year ending in early January belongs to the year before', () => {
    expect(fiscalYearOf('2025-09-27')).toBe(2025);
    expect(fiscalYearOf('2023-01-01')).toBe(2022);
    expect(fiscalYearOf('2023-01-31')).toBe(2023);
  });
});

// A slice of TSM's companyfacts (CIK 0001046179, real values of the 20-F filed 2025-04-17): ifrs-full in TWD plus a USD
// convenience translation of the latest year, no quarterly XBRL
const F = (start: string | null, end: string, val: number, filed = '2025-04-17', form = '20-F') => (start ? { start, end, val, form, filed } : { end, val, form, filed });
const Y22 = ['2022-01-01', '2022-12-31'] as const;
const Y23 = ['2023-01-01', '2023-12-31'] as const;
const Y24 = ['2024-01-01', '2024-12-31'] as const;

function tsm(): any {
  const twd = (list: unknown[], usd?: unknown) => ({ units: usd ? { TWD: list, USD: [usd] } : { TWD: list } });
  return {
    facts: {
      'ifrs-full': {
        Revenue: twd([F(...Y22, 2263891300000), F(...Y23, 2161735800000), F(...Y24, 2894307700000)], F(...Y24, 88268000000)),
        ProfitLossAttributableToOwnersOfParent: twd([F(...Y22, 992923400000), F(...Y23, 851740000000), F(...Y24, 1158380200000)], F(...Y24, 35327200000)),
        ProfitLoss: twd([F(...Y23, 851027700000), F(...Y24, 1157523900000)]), // includes minorities: the parent's line wins
        CashFlowsFromUsedInOperatingActivities: twd([F(...Y23, 1241967300000), F(...Y24, 1826177100000)]),
        PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities: twd([F(...Y23, 949816800000), F(...Y24, 956006500000)]),
        Assets: twd([F(null, Y23[1], 5532196600000), F(null, Y24[1], 6691764700000)], F(null, Y24[1], 204079400000)),
        EquityAttributableToOwnersOfParent: twd([F(null, Y23[1], 3429522400000), F(null, Y24[1], 4244266500000)]),
        DilutedEarningsLossPerShare: { units: { 'TWD/shares': [F(...Y23, 32.85), F(...Y24, 44.67)], 'USD/shares': [F(...Y24, 1.36)] } },
        AdjustedWeightedAverageShares: { units: { shares: [F(...Y23, 25929300000), F(...Y24, 25929700000)] } },
        // no Borrowings total: debt = long-term + current portion + bonds (non-current and current)
        LongtermBorrowings: twd([F(null, Y24[1], 31824400000)]),
        CurrentPortionOfLongtermBorrowings: twd([F(null, Y24[1], 59857900000)]),
        NoncurrentPortionOfNoncurrentBondsIssued: twd([F(null, Y24[1], 926604500000)]),
        CurrentBondsIssuedAndCurrentPortionOfNoncurrentBondsIssued: twd([F(null, Y24[1], 57148000000)]),
      },
    },
  };
}

describe('sec companyfacts: ifrs-full and 20-F (plan 1.3)', () => {
  test('ifrs-full mapping: TSM FY2024 in TWD from the 20-F, the USD convenience translation is not the reporting currency', () => {
    const sec = parseCompanyFacts(tsm());
    if (!sec) throw new Error('no SEC layer');
    expect([sec.currency, sec.taxonomy, sec.annualForm]).toEqual(['TWD', 'ifrs-full', '20-F']);
    expect(sec.fy.end).toEqual(['2024-12-31', '2023-12-31', '2022-12-31']);
    expect(column(sec.fy, 'revenue')).toEqual([2894307700000, 2161735800000, 2263891300000]);
    expect(column(sec.fy, 'netIncome')[0]).toBe(1158380200000);
    expect([column(sec.fy, 'cfo')[0], column(sec.fy, 'capex')[0], column(sec.fy, 'epsDiluted')[0], column(sec.fy, 'sharesDiluted')[0]]).toEqual([1826177100000, 956006500000, 44.67, 25929700000]);
    expect([column(sec.fy, 'assets')[0], column(sec.fy, 'equity')[0]]).toEqual([6691764700000, 4244266500000]);
    expect(column(sec.fy, 'debt')[0]).toBe(31824400000 + 59857900000 + 926604500000 + 57148000000);
    expect([sec.units.revenue, sec.units.epsDiluted, sec.units.sharesDiluted]).toEqual(['TWD', 'TWD/shares', 'shares']);
  });

  test('ttmIsAnnual: an issuer without quarterly XBRL gets TTM = the last fiscal year; a 10-K and 10-Q filer does not', () => {
    const sec = parseCompanyFacts(tsm());
    if (!sec) throw new Error('no SEC layer');
    expect([sec.ttmIsAnnual, sec.ttm.basis, sec.ttm.end, sec.quarters.end.length]).toEqual([true, 'fy', '2024-12-31', 0]);
    expect([sec.ttm.revenue, sec.ttm.netIncome, sec.ttm.assets]).toEqual([2894307700000, 1158380200000, 6691764700000]);
    const us = parseCompanyFacts(apple());
    expect([us?.ttmIsAnnual, us?.currency, us?.taxonomy, us?.annualForm]).toEqual([false, 'USD', 'us-gaap', '10-K']);
  });

  test('us-gaap first, then ifrs-full: Toyota moved to IFRS in FY2021 and one series joins both, us-gaap wins a shared period', () => {
    // real values (JPY): us-gaap 20-F up to FY2020 (year to 2020-03-31), ifrs-full from the 20-F filed 2021-06-24, which restated FY2020
    const jpy = (list: unknown[]) => ({ units: { JPY: list } });
    const facts = {
      facts: {
        'us-gaap': { NetIncomeLoss: jpy([F('2018-04-01', '2019-03-31', 1882873000000, '2019-06-21'), F('2019-04-01', '2020-03-31', 2076183000000, '2020-06-24')]) },
        'ifrs-full': {
          ProfitLossAttributableToOwnersOfParent: jpy([F('2019-04-01', '2020-03-31', 2036140000000, '2021-06-24'), F('2020-04-01', '2021-03-31', 2245261000000, '2021-06-24'), F('2021-04-01', '2022-03-31', 2850110000000, '2022-06-23')]),
          Revenue: jpy([F('2020-04-01', '2021-03-31', 27214594000000, '2021-06-24'), F('2021-04-01', '2022-03-31', 31379507000000, '2022-06-23')]),
        },
      },
    };
    const sec = parseCompanyFacts(facts);
    if (!sec) throw new Error('no SEC layer');
    expect([sec.currency, sec.taxonomy, sec.ttmIsAnnual]).toEqual(['JPY', 'ifrs-full', true]);
    expect(sec.fy.end).toEqual(['2022-03-31', '2021-03-31', '2020-03-31', '2019-03-31']);
    expect(column(sec.fy, 'netIncome')).toEqual([2850110000000, 2245261000000, 2076183000000, 1882873000000]);
    expect(parseCompanyFacts(facts, { taxonomies: ['us-gaap'] })?.fy.end).toEqual(['2020-03-31', '2019-03-31']);
  });
});
