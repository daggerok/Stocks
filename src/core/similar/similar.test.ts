/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { createRegistry } from '../metrics';
import { ScreenerRow, validatePreset } from '../screener';
import { createSimilarContext, filterFromX, SIMILAR_CONFIG, similarTo, typePercentiles } from '.';

const row = (ticker: string, metrics: Record<string, unknown>, type: ScreenerRow['type'] = 'stock'): ScreenerRow => ({ ticker, type, sector: null, industry: null, isMine: false, size: null, metrics });
const BUSINESS = SIMILAR_CONFIG.groups.filter((g) => g.id === 'business')[0].metrics;

// Synthetic card networks and others: V and MA share fat margins, high ROIC, low capex; banks and miners do not
const UNIVERSE: ScreenerRow[] = [
  row('V', { grossMargin: 80, operatingMargin: 61, netMargin: 51, fcfMargin: 48, roic: 52, revenueGrowth3y: 12, epsGrowth3y: 14, capexToRevenue: 3.6, fcfToNi: 0.94 }),
  row('MA', { grossMargin: 78, operatingMargin: 59, netMargin: 46, fcfMargin: 52, roic: 94, revenueGrowth3y: 14, epsGrowth3y: 17, capexToRevenue: 2.2, fcfToNi: 0.95 }),
  row('AXP', { grossMargin: null, operatingMargin: null, netMargin: 26, fcfMargin: 39, roic: null, revenueGrowth3y: 6, epsGrowth3y: 16, capexToRevenue: null, fcfToNi: null }),
  row('JPM', { grossMargin: null, operatingMargin: null, netMargin: 30, fcfMargin: null, roic: 9, revenueGrowth3y: 8, epsGrowth3y: 10, capexToRevenue: null, fcfToNi: null }),
  row('KO', { grossMargin: 61, operatingMargin: 29, netMargin: 23, fcfMargin: 20, roic: 18, revenueGrowth3y: 5, epsGrowth3y: 4, capexToRevenue: 4.5, fcfToNi: 0.9 }),
  row('XOM', { grossMargin: 31, operatingMargin: 13, netMargin: 10, fcfMargin: 9, roic: 12, revenueGrowth3y: -3, epsGrowth3y: -9, capexToRevenue: 8.8, fcfToNi: 0.7 }),
  row('NEM', { grossMargin: 42, operatingMargin: 25, netMargin: 18, fcfMargin: 15, roic: 8, revenueGrowth3y: 20, epsGrowth3y: 30, capexToRevenue: 17, fcfToNi: 0.6 }),
  row('MSFT', { grossMargin: 69, operatingMargin: 45, netMargin: 36, fcfMargin: 25, roic: 29, revenueGrowth3y: 14, epsGrowth3y: 15, capexToRevenue: 22, fcfToNi: 0.7 }),
  row('F', { grossMargin: 8, operatingMargin: 3, netMargin: 2, fcfMargin: 3, roic: 3, revenueGrowth3y: 6, epsGrowth3y: -20, capexToRevenue: 4.6, fcfToNi: 1.4 }),
  row('NVDA', { grossMargin: 75, operatingMargin: 62, netMargin: 55, fcfMargin: 45, roic: 90, revenueGrowth3y: 90, epsGrowth3y: 120, capexToRevenue: 2.5, fcfToNi: 0.85 }),
  row('GLD', { grossMargin: 80, netMargin: 51 }, 'etf'),
];

describe('similar', () => {
  test('percentiles among the type: share strictly lower, ties share it, a metric with fewer than minGroup values gives none', () => {
    const ctx = createSimilarContext([row('A', { pe: 10 }), row('B', { pe: 20 }), row('C', { pe: 20 }), row('D', { pe: 30 }), row('E', { pe: null }), row('F', { pe: 5 }), row('G', { pe: 40 }, 'etf')]);
    // stocks with a value: F 5, A 10, B 20, C 20, D 30 -> below 0, 1, 2, 2, 4 of 5
    expect(Array.from(typePercentiles(ctx, 'pe', 'stock'))).toEqual([20, 40, 40, 80, NaN, 0, NaN]);
    expect(Array.from(typePercentiles(createSimilarContext(ctx.rows, 6), 'pe', 'stock')).every((v) => isNaN(v))).toBe(true);
  });

  test('distance by hand: root mean square of the percentile gaps, similarity = 100 - distance', () => {
    const rows = [row('X', { pe: 10, pb: 1 }), row('A', { pe: 20, pb: 2 }), row('B', { pe: 30, pb: 3 }), row('C', { pe: 40, pb: null }), row('D', { pe: 50, pb: 5 }), row('E', { pe: 60, pb: 4 })];
    const r = similarTo(createSimilarContext(rows), 0, ['pe', 'pb']);
    // pe has 6 values: X 0, A 16.67, B 33.33, C 50, D 66.67, E 83.33; pb has 5 (C is empty): X 0, A 20, B 40, E 60, D 80
    const byTicker: Record<string, number> = {};
    r.hits.forEach((h) => { byTicker[h.ticker] = h.distance; });
    // X-A: pe gap 16.667, pb gap 20 -> sqrt((277.78 + 400) / 2) = 18.409
    expect(byTicker.A).toBeCloseTo(Math.sqrt(((100 / 6) ** 2 + 20 ** 2) / 2), 9);
    expect(byTicker.A).toBeCloseTo(18.409, 3);
    // X-B: sqrt((33.33^2 + 40^2) / 2) = 36.82; X-C: only pe in common (1 >= ceil(2 x 0.5)), gap 50 -> 50
    // X-E: sqrt((83.33^2 + 60^2) / 2) = 72.61; X-D: sqrt((66.67^2 + 80^2) / 2) = 73.64
    expect(byTicker.C).toBeCloseTo(50, 9);
    expect(r.hits.map((h) => h.ticker)).toEqual(['A', 'B', 'C', 'E', 'D']);
    expect(byTicker.B).toBeCloseTo(36.818, 3);
    expect(r.hits[0].similarity).toBe(81.6); // 100 - 18.409, one decimal
  });

  test('V in the business group: MA is the closest, the distance excludes empty metrics pair by pair, ETFs never match', () => {
    const r = similarTo(createSimilarContext(UNIVERSE), 0, BUSINESS);
    expect(r.usable).toEqual(BUSINESS);
    expect(r.needed).toBe(5); // 9 usable metrics x 0.5, rounded up
    expect(r.hits[0].ticker).toBe('MA');
    expect(r.hits.slice(0, 3).map((h) => h.ticker)).toContain('MA');
    expect(r.hits.some((h) => h.ticker === 'GLD' || h.ticker === 'V')).toBe(false);
    // AXP shares only netMargin, fcfMargin, revenueGrowth3y, epsGrowth3y (4 < 5): not comparable; JPM has 4 too
    expect(r.hits.map((h) => h.ticker)).not.toContain('AXP');
    expect(r.hits.map((h) => h.ticker)).not.toContain('JPM');
    expect(r.hits[0].common).toBe(9);
  });

  test('top-10 order, three main differences with X and Y values, the half rule', () => {
    const r = similarTo(createSimilarContext(UNIVERSE), 0, BUSINESS);
    expect(r.hits.length).toBeLessThanOrEqual(SIMILAR_CONFIG.top);
    expect(r.hits.map((h) => h.distance)).toEqual(r.hits.map((h) => h.distance).slice().sort((a, b) => a - b));
    const f = r.hits.filter((h) => h.ticker === 'F')[0];
    expect(f.differences.length).toBe(3);
    expect(f.differences.map((d) => Math.abs(d.gap))).toEqual(f.differences.map((d) => Math.abs(d.gap)).slice().sort((a, b) => b - a));
    expect(f.differences[0]).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    // a two-metric pair: X has 2 usable metrics, a candidate with 1 in common passes (ceil(2 x 0.5) = 1)
    const small = similarTo(createSimilarContext([row('X', { pe: 10, pb: 1 }), row('A', { pe: 11, pb: null }), row('B', { pe: 30, pb: 5 }), row('C', { pe: 20, pb: 2 }), row('D', { pe: 40, pb: 3 }), row('E', { pe: 50, pb: 4 })]), 0, ['pe', 'pb']);
    expect(small.needed).toBe(1);
    expect(small.hits[0].ticker).toBe('A');
  });

  test('unknown, non-numeric and empty metrics are skipped; X without any usable metric has no hits', () => {
    const r = similarTo(createSimilarContext(UNIVERSE), 2, ['netMargin', 'grossMargin', 'sector', 'nope']);
    expect(r.usable).toEqual(['netMargin']);
    expect(r.skipped).toEqual(['grossMargin', 'sector', 'nope']);
    expect(similarTo(createSimilarContext(UNIVERSE), 2, ['roic']).hits).toEqual([]);
  });

  test('filter from X: a valid own preset of range conditions within ±20%, empty metrics left out', () => {
    const p = filterFromX(UNIVERSE[2], ['netMargin', 'grossMargin', 'revenueGrowth3y'], { group: 'business', groupTitle: { en: 'Business', ru: 'Бизнес' }, taken: ['like-axp-business'] });
    if (!p) throw new Error('no preset');
    expect(validatePreset(p, createRegistry())).toEqual([]);
    expect(p.id).toBe('like-axp-business-2');
    expect(p.title).toEqual({ en: 'Like AXP (business)', ru: 'Как AXP (бизнес)' });
    // 26 x 0.8 = 20.8, 26 x 1.2 = 31.2; 6 x 0.8 = 4.8, 6 x 1.2 = 7.2
    expect(p.conditions.map((c) => [c.metric, c.value])).toEqual([['netMargin', [20.8, 31.2]], ['revenueGrowth3y', [4.8, 7.2]]]);
    // a negative value keeps min below max: -3 -> [-3.6, -2.4]; 0 stays [0, 0]
    const neg = filterFromX(row('Z', { revenueGrowth3y: -3, epsGrowth3y: 0 }), ['revenueGrowth3y', 'epsGrowth3y'], { group: 'custom' });
    expect(neg && neg.conditions.map((c) => c.value)).toEqual([[-3.6, -2.4], [0, 0]]);
    expect(filterFromX(row('Y', {}), ['pe'], { group: 'custom' })).toBeNull();
  });

  test('the config lists numeric registry metrics only', () => {
    const registry = createRegistry();
    const bad = SIMILAR_CONFIG.groups.flatMap((g) => g.metrics.filter((m) => !registry.byId[m] || ['percent', 'pp', 'ratio', 'usd', 'count'].indexOf(registry.byId[m].unit) < 0).map((m) => `${g.id}:${m}`));
    expect(bad).toEqual([]);
    expect(SIMILAR_CONFIG.groups.map((g) => g.id)).toEqual(['business', 'dividend', 'valuation', 'risk']);
  });
});
