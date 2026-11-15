/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { type AnnualDps, dividendHistory, dividendIrregular } from './dividends';

/** Calendar-year sums from a list starting at `from`, newest first like market.annualDps; the current partial year 2026 is added */
const years = (from: number, values: number[], partial = 0.5): AnnualDps[] =>
  [{ year: 2026, dps: partial }].concat(values.map((dps, i) => ({ year: from + i, dps })).reverse()).filter((a) => a.dps > 0);

describe('dividend streak and cut', () => {
  test('a steady raiser: the streak counts the yearly increases, no cut', () => {
    // 2016..2025, rising every year: 9 increases (2017..2025 over the year before)
    expect(dividendHistory(years(2016, [1, 1.05, 1.1, 1.16, 1.22, 1.28, 1.35, 1.42, 1.5, 1.58]), '2026-11-07')).toEqual({ dividendStreak: 9, dividendCut10y: false });
    // a flat year ends the streak: 2023 = 2022
    expect(dividendHistory(years(2016, [1, 1.05, 1.1, 1.16, 1.22, 1.28, 1.35, 1.35, 1.5, 1.58]), '2026-11-07').dividendStreak).toBe(2);
  });

  test('a real cut fires, a small dip and a suspension behave as written', () => {
    expect(dividendHistory(years(2016, [1, 1.05, 1.1, 0.6, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85]), '2026-11-07')).toEqual({ dividendStreak: 5, dividendCut10y: true });
    // a 5% dip (currency of an ADR) is not a cut
    expect(dividendHistory(years(2016, [1, 1, 1, 0.95, 1, 1, 1, 1, 1, 1]), '2026-11-07').dividendCut10y).toBe(false);
    // payments stopped in 2024: a cut, and no streak for a non-payer in the last complete year
    expect(dividendHistory(years(2016, [1, 1, 1, 1, 1, 1, 1, 1, 0, 0], 0), '2026-11-07')).toEqual({ dividendStreak: null, dividendCut10y: true });
  });

  test('special dividends and shifted payments do not count as cuts', () => {
    // a special dividend in 2020: 2021 goes back to the regular level, compared with 2019 it is an increase
    expect(dividendHistory(years(2016, [1, 1.05, 1.1, 1.15, 3, 1.2, 1.25, 1.3, 1.35, 1.4]), '2026-11-07')).toEqual({ dividendStreak: 9, dividendCut10y: false });
    // one December payment slipped into January: 2021 is short (3 of 4), 2022 long (5 of 4), not a cut
    expect(dividendHistory(years(2016, [1, 1, 1, 1, 1, 0.75, 1.25, 1, 1, 1]), '2026-11-07').dividendCut10y).toBe(false);
  });

  test('empty for a stock that never paid, unknown years before the first payment stop the streak', () => {
    expect(dividendHistory([], '2026-11-07')).toEqual({ dividendStreak: null, dividendCut10y: null });
    expect(dividendHistory([{ year: 2026, dps: 0.2 }], '2026-11-07')).toEqual({ dividendStreak: null, dividendCut10y: null }); // the partial year alone
    expect(dividendHistory(years(2023, [0.5, 0.6, 0.7]), '2026-11-07')).toEqual({ dividendStreak: 2, dividendCut10y: false });
  });
});

describe('irregular dividend', () => {
  test('a gap year between paying years in the current year and the 5 before it is irregular (FUTU)', () => {
    expect(dividendIrregular([{ year: 2026, dps: 2.6 }, { year: 2024, dps: 2 }], '2026-11-13')).toBe(true); // FUTU: 2024, nothing in 2025, 2026
    expect(dividendIrregular([{ year: 2025, dps: 1 }, { year: 2022, dps: 1 }], '2026-11-13')).toBe(true); // two gap years
  });

  test('regular, yearly, stopped and new payers are not irregular; a gap before the window does not count; no payment is empty', () => {
    expect(dividendIrregular(years(2016, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), '2026-11-13')).toBe(false); // every year, the current one included
    expect(dividendIrregular(years(2016, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 0), '2026-11-13')).toBe(false); // a yearly payer not yet paid this year
    expect(dividendIrregular(years(2016, [1, 1, 1, 1, 1, 1, 1, 1, 0, 0], 0), '2026-11-13')).toBe(false); // stopped in 2024: a cut, not a gap
    expect(dividendIrregular([{ year: 2026, dps: 0.3 }, { year: 2025, dps: 0.5 }], '2026-11-13')).toBe(false); // just started
    expect(dividendIrregular([{ year: 2026, dps: 1 }, { year: 2025, dps: 1 }, { year: 2019, dps: 1 }], '2026-11-13')).toBe(false); // 2019 is outside 2021..2026
    expect(dividendIrregular([{ year: 2019, dps: 1 }], '2026-11-13')).toBeNull();
    expect(dividendIrregular([], '2026-11-13')).toBeNull();
  });
});
