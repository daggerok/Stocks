/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { SecFundamentals } from './companyfacts';
import { allClassShares, instanceFile, needsClassShares, parseInstanceShares, publishedShares, ttmAccession, withClassShares } from './shares';

// A slice of Visa's 10-K instance for fiscal 2026 (v-20260930_htm.xml, real values): diluted shares and EPS per class only;
// class A is as-converted (1,907M × 12.32 = net income 23,504M), the B and C counts are their own classes
const ctx = (id: string, member: string | null, start = '2025-10-01', end = '2026-09-30') => `
    <xbrli:context id="${id}">
        <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0001403161</xbrli:identifier>${member ? `
            <xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">${member}</xbrldi:explicitMember></xbrli:segment>` : ''}
        </xbrli:entity>
        <xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period>
    </xbrli:context>`;
const VISA = `<xbrli:xbrl>
${ctx('c-1', null)}${ctx('c-2', 'us-gaap:CommonClassAMember')}${ctx('c-9', 'v:CommonClassB1Member')}${ctx('c-11', 'us-gaap:CommonClassCMember')}
${ctx('c-31', 'us-gaap:CommonClassAMember', '2024-10-01', '2025-09-30')}
    <us-gaap:NetIncomeLoss contextRef="c-1" decimals="-6" unitRef="usd">23504000000</us-gaap:NetIncomeLoss>
    <us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding contextRef="c-2" decimals="-6" id="f-281" unitRef="shares">1907000000</us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding>
    <us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding contextRef="c-31" decimals="-6" unitRef="shares">1966000000</us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding>
    <us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding contextRef="c-9" decimals="-6" unitRef="shares">4000000</us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding>
    <us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding contextRef="c-11" decimals="-6" unitRef="shares">12000000</us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding>
    <us-gaap:EarningsPerShareDiluted contextRef="c-2" decimals="2"
      unitRef="usdPerShare">12.32</us-gaap:EarningsPerShareDiluted>
    <us-gaap:EarningsPerShareDiluted contextRef="c-9" decimals="2" unitRef="usdPerShare">19.10</us-gaap:EarningsPerShareDiluted>
    <us-gaap:EarningsPerShareDiluted contextRef="c-11" decimals="2" unitRef="usdPerShare">49.30</us-gaap:EarningsPerShareDiluted>
</xbrli:xbrl>`;
const FY26 = '2025-10-01|2026-09-30';

function layer(): SecFundamentals {
  return {
    currency: 'USD', units: {}, checks: { balance: null, grossProfit: null, quarterSum: null },
    fy: { end: ['2026-09-30', '2025-09-30', '2024-09-30'], start: ['2025-10-01', '2024-10-01', '2023-10-01'], netIncome: [23504000000, 20058000000, 19743000000], sharesDiluted: [null, null, null] },
    quarters: { end: [], start: [] },
    ttm: { end: '2026-09-30', basis: 'fy', netIncome: 23504000000, epsDiluted: null, sharesDiluted: null },
  };
}

describe('sec share classes (N36)', () => {
  test('instance parsing: diluted shares and EPS per class of every duration period, multi-line tags, no dimension as total', () => {
    const shares = parseInstanceShares(VISA);
    expect(Object.keys(shares).sort()).toEqual(['2024-10-01|2025-09-30', FY26]);
    expect(shares[FY26]).toEqual({ total: null, classes: [
      { member: 'us-gaap:CommonClassAMember', shares: 1907000000, eps: 12.32 },
      { member: 'v:CommonClassB1Member', shares: 4000000, eps: 19.1 },
      { member: 'us-gaap:CommonClassCMember', shares: 12000000, eps: 49.3 },
    ] });
    const plain = parseInstanceShares(`${ctx('d', null)}<us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding contextRef="d" unitRef="shares">15004697000</us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding>`);
    expect(plain[FY26]).toEqual({ total: 15004697000, classes: [] });
  });

  test('all classes: the count without dimension, else the as-converted class (shares × EPS = NI within 2%), else the sum', () => {
    const v = parseInstanceShares(VISA)[FY26];
    expect(allClassShares(v, 23504000000)).toBe(1907000000); // Visa: EPS 23,504 / 1,907 = 12.33, the 10-K says 12.32
    expect(allClassShares(v, null)).toBe(1907000000 + 4000000 + 12000000);
    // two-class method with equal rights (each class's EPS × its count is only its share of NI): the counts add up
    expect(allClassShares({ total: null, classes: [{ member: 'A', shares: 600, eps: 10 }, { member: 'C', shares: 400, eps: 10 }] }, 10000)).toBe(1000);
    expect(allClassShares({ total: 900, classes: [{ member: 'A', shares: 600, eps: 10 }] }, 10000)).toBe(900);
    expect([allClassShares(undefined, 1), allClassShares({ total: null, classes: [] }, 1)]).toEqual([null, null]);
  });

  test('the layer gets sharesDiluted where null (fiscal years by period, TTM of basis fy), EPS stays as tagged', () => {
    const sec = layer();
    expect(needsClassShares(sec)).toBe(true);
    const filled = withClassShares(sec, parseInstanceShares(VISA));
    expect(filled.fy.sharesDiluted).toEqual([1907000000, 1966000000, null]);
    expect([filled.ttm.sharesDiluted, filled.ttm.epsDiluted, needsClassShares(filled)]).toEqual([1907000000, null, false]);
    expect(sec.fy.sharesDiluted).toEqual([null, null, null]); // the input is not changed
    const tagged = withClassShares({ ...sec, fy: { ...sec.fy, sharesDiluted: [1, null, null] } }, parseInstanceShares(VISA));
    expect(tagged.fy.sharesDiluted[0]).toBe(1);
    // a rerun reuses the published counts: no download needed when the TTM period is unchanged
    expect(needsClassShares(withClassShares(sec, publishedShares(filled)))).toBe(false);
    expect(publishedShares(null)).toEqual({});
  });

  test('the filing behind the TTM and its instance file', () => {
    const facts = { facts: { 'us-gaap': { NetIncomeLoss: { units: { USD: [
      { end: '2026-09-30', val: 1, form: '10-K', filed: '2026-11-05', accn: '0001403161-26-000134' },
      { end: '2026-09-30', val: 1, form: '8-K', filed: '2026-12-01', accn: 'x' },
      { end: '2026-06-30', val: 1, form: '10-Q', filed: '2026-07-29', accn: '0001403161-26-000104' },
    ] } } } } };
    expect(ttmAccession(facts, layer(), ['10-K', '10-Q'])).toBe('0001403161-26-000134');
    expect(ttmAccession({}, layer(), ['10-K'])).toBeNull();
    const item = (names: string[]) => ({ directory: { item: names.map((name) => ({ name })) } });
    expect(instanceFile(item(['FilingSummary.xml', 'v-20260930.xsd', 'v-20260930_htm.xml', 'v-20260930_lab.xml']))).toBe('v-20260930_htm.xml');
    expect(instanceFile(item(['FilingSummary.xml', 'v-20180930.xml', 'v-20180930_cal.xml', 'v-20180930_pre.xml']))).toBe('v-20180930.xml');
    expect(instanceFile(item(['R1.htm']))).toBeNull();
  });
});
