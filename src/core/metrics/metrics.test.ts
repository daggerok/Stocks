/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { STOCK_METRIC_KEYS } from '../../../scripts/update-data';
import { groupMetrics, METRIC_GROUPS, metricGroup, METRICS, MetricDef, REGISTRY, unregisteredKeys, validateRegistry } from '.';

/** Every key of `metrics` in the 29 ETF brand feeds (2552 funds, 2026-11-11); `bun src/core/metrics/check-feeds.ts` checks the live feeds */
const ETF_METRIC_KEYS = [
  'ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn', 'dividendYield', 'dividendYieldText', 'distributionYield',
  'distributionYieldText', 'yield12M', 'yield12MText', 'secYield', 'secYieldText', 'dividendYieldBasis', 'ytdAsOf', 'week52Low', 'week52High',
  'range52w', 'range52wClose', 'range52wAsOf', 'range52wSince', 'range52wBasis', 'returnsBasis', 'performanceAsOf', 'dividendYieldSource',
  'indicatedDividendYield', 'secYieldUnsubsidized', 'tr1yText', 'tr3yText', 'tr5yText', 'tr10yText', 'cagr3yText', 'cagr5yText', 'cagr10yText',
  'siAnnText', 'indicatedDividendYieldText', 'secYieldUnsubsidizedText', 'ytdText', 'dividendYieldBasisText', 'dividendYieldComputed', 'secYieldKind',
];
/** Row fields and the metrics the base presets reference before the updater publishes them */
const SCREENER_KEYS = ['ticker', 'type', 'sector', 'industry', 'isMine', 'size', 'peg', 'pePct5y', 'pFcfPct5y', 'yieldVsAvg5y', 'operatingMarginSlope3y', 'niVolatility5y', 'fcfVolatility5y', 'cfoToNi', 'forwardToTtmPe', 'volatility1y', 'pctFromAth', 'capexToRevenueDelta3y', 'sigmaFromMean60d'];

describe('metrics registry', () => {
  test('covers every metrics key of the Stocks feed, the ETF feeds and the screener', () => {
    expect(STOCK_METRIC_KEYS.length).toBe(138);
    expect(unregisteredKeys(STOCK_METRIC_KEYS)).toEqual([]);
    expect(unregisteredKeys(ETF_METRIC_KEYS)).toEqual([]);
    expect(unregisteredKeys(SCREENER_KEYS)).toEqual([]);
  });

  test('every entry is valid: name, short and guide in EN and RU, known unit, basis, source and direction', () => {
    expect(validateRegistry(METRICS)).toEqual([]);
    expect(METRICS.filter((m) => m.guide.en.length < 80 || m.guide.ru.length < 80).map((m) => m.id)).toEqual([]);
  });

  test('a deliberately broken entry fails the validator', () => {
    const good = REGISTRY.byId.pe;
    const broken: MetricDef = { ...good, id: 'brokenPe', guide: { en: good.guide.en, ru: '' }, short: { en: 'a \u2014 b', ru: 'ok' }, unit: 'furlong' as MetricDef['unit'] };
    const errors = validateRegistry([good, broken, good]);
    expect(errors).toContain('brokenPe: guide.ru is empty');
    expect(errors).toContain('brokenPe: short.en has an en or em dash');
    expect(errors).toContain('brokenPe: unknown unit furlong');
    expect(errors).toContain('pe: duplicate id');
    expect(unregisteredKeys(['pe', 'notAMetric'])).toEqual(['notAMetric']);
  });

  test('ETF-only and stock-only metrics say so in appliesTo', () => {
    expect(REGISTRY.byId.secYield.appliesTo).toEqual(['etf']);
    expect(REGISTRY.byId.quickRatio.appliesTo).toEqual(['stock']);
    expect(REGISTRY.byId.range52w.appliesTo).toEqual(['stock', 'etf']);
    expect(ETF_METRIC_KEYS.filter((k) => REGISTRY.byId[k].appliesTo.indexOf('etf') < 0)).toEqual([]);
    expect(STOCK_METRIC_KEYS.filter((k) => REGISTRY.byId[k].appliesTo.indexOf('stock') < 0)).toEqual([]);
    expect(REGISTRY.byId.perf1y.appliesTo).toEqual(['stock', 'etf']); // ETFs read tr1y as perf1y (plan N2)
  });

  test('every entry sits in exactly one guide group, in registry order', () => {
    const groups = groupMetrics(METRICS);
    expect(groups.map((g) => g.id)).toEqual(METRIC_GROUPS.map((g) => g.id));
    expect(groups.reduce((n, g) => n + g.metrics.length, 0)).toBe(METRICS.length);
    expect(groups.every((g) => g.metrics.length > 0)).toBe(true);
    const of = (id: string) => metricGroup(REGISTRY.byId[id]);
    expect(['pe', 'roic', 'grossMarginDelta3y', 'quickRatio', 'dividendGrowth5y', 'epsGrowth3y', 'perf1y', 'secYieldText', 'isMine'].map(of))
      .toEqual(['valuation', 'quality', 'quality', 'safety', 'dividends', 'growth', 'price', 'etf', 'fields']);
  });
});
