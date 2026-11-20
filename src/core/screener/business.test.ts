/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { REGISTRY } from '../metrics';
import { BUSINESS_RULES, BUSINESS_TYPES, businessType, dilutionFlags, isNotApplicable } from './business';
import { createUniverse, evaluateCondition } from './engine';
import { stockRow } from './rows';

describe('business types', () => {
  test('the type comes from the Yahoo industry', () => {
    expect(['REIT - Retail', 'Utilities - Regulated Gas', 'Utilities - Diversified', 'Utilities - Renewable', 'Banks - Regional', 'Insurance - Life', 'Insurance Brokers', 'Oil & Gas Midstream', 'Software - Application', null]
      .map((industry) => businessType(industry))).toEqual(['reit', 'utility', 'utility', 'regular', 'bank', 'insurer', 'regular', 'midstream', 'regular', 'regular']);
  });

  test('a BDC is told apart by its NAV per share, whatever its industry says', () => {
    expect(businessType('Asset Management', { navPerShare: 19.31 })).toBe('bdc'); // ARCC
    expect(businessType('Asset Management', { navPerShare: null })).toBe('regular'); // BLK tags no NAV per share
    expect(businessType('Banks - Regional', { navPerShare: 10 })).toBe('bank'); // the industry types come first
    const arcc = stockRow({ ticker: 'ARCC', industry: 'Asset Management', metrics: { navPerShare: 19.31, sharesChange5y: 4.5, epsGrowth5y: 6 } });
    expect([arcc.metrics.businessType, arcc.metrics.dilutionOkSector, isNotApplicable('bdc', 'pFcf'), isNotApplicable('bdc', 'pNav')]).toEqual(['bdc', true, true, false]);
  });

  test('every not-applicable metric is a registry metric of stocks', () => {
    BUSINESS_TYPES.forEach((type) => BUSINESS_RULES[type].notApplicable.forEach((id) => {
      expect(REGISTRY.byId[id] ? id : `unknown ${id} of ${type}`).toBe(id);
    }));
    expect([isNotApplicable('bank', 'debtToEquity'), isNotApplicable('regular', 'debtToEquity'), isNotApplicable('reit', 'pe'), isNotApplicable(null, 'pe')]).toEqual([true, false, true, false]);
  });

  test('a condition on a metric that does not apply to the type is skipped, never failed', () => {
    const u = createUniverse([
      stockRow({ ticker: 'JPM', industry: 'Banks - Diversified', metrics: { debtToEquity: 9 } }),
      stockRow({ ticker: 'KO', industry: 'Beverages - Non-Alcoholic', metrics: { debtToEquity: 9 } }),
    ]);
    const r = evaluateCondition(u, { metric: 'debtToEquity', op: '<', value: 2, scope: 'absolute', missing: 'fail' });
    expect(Array.from(r.states)).toEqual([2, 0]); // SKIP for the bank, FAIL for KO
  });

  test('dilution flags: strict, per share, by sector', () => {
    // ATO: +5.29% a year, EPS +10.6% a year: fine per share, too much for a utility (3%), not strict
    expect(dilutionFlags({ sharesChange5y: 5.29, epsGrowth5y: 10.6, dividendGrowth5y: 9.4 }, 'utility')).toEqual({ dilutionOkStrict: false, dilutionOkPerShare: true, dilutionOkSector: false });
    // NEE-like utility: +1.8%, EPS +8%: within the utility limit
    expect(dilutionFlags({ sharesChange5y: 1.8, epsGrowth5y: 8 }, 'utility').dilutionOkSector).toBe(true);
    // the same numbers at a regular company: over 1% fails the sector mode
    expect(dilutionFlags({ sharesChange5y: 1.8, epsGrowth5y: 8 }, 'regular').dilutionOkSector).toBe(false);
    // buybacks pass every mode; 3Y is used without 5Y; no share data -> null, never a guess
    expect(dilutionFlags({ sharesChange3y: -2 }, 'regular')).toEqual({ dilutionOkStrict: true, dilutionOkPerShare: true, dilutionOkSector: true });
    expect(dilutionFlags({ sharesChange3y: 2, epsGrowth3y: 1 }, 'reit').dilutionOkPerShare).toBe(false);
    expect(dilutionFlags({}, 'regular').dilutionOkStrict).toBeNull();
  });
});
