/// <reference lib="esnext" />
/** Sections of the guide and the metric picker: every registry entry belongs to exactly one, in this order */
import type { MetricDef, Text } from './types';

export type MetricGroup = 'valuation' | 'quality' | 'safety' | 'dividends' | 'growth' | 'price' | 'etf' | 'fields';

export const METRIC_GROUPS: ReadonlyArray<{ id: MetricGroup; title: Text }> = [
  { id: 'valuation', title: { en: 'Valuation', ru: 'Оценка' } },
  { id: 'quality', title: { en: 'Quality: returns, margins, cash', ru: 'Качество: доходность капитала, маржи, деньги' } },
  { id: 'safety', title: { en: 'Safety: liquidity, debt, risk', ru: 'Надёжность: ликвидность, долг, риск' } },
  { id: 'dividends', title: { en: 'Dividends', ru: 'Дивиденды' } },
  { id: 'growth', title: { en: 'Growth', ru: 'Рост' } },
  { id: 'price', title: { en: 'Price, returns and swings', ru: 'Цена, доходность и свинги' } },
  { id: 'etf', title: { en: 'ETF issuer data', ru: 'Данные эмитентов ETF' } },
  { id: 'fields', title: { en: 'Fields: ticker, type, sector, size', ru: 'Поля: тикер, тип, сектор, размер' } },
];

const LISTS: Record<string, MetricGroup> = {};
const put = (group: MetricGroup, ids: string[]) => ids.forEach((id) => { LISTS[id] = group; });
put('valuation', ['marketCap', 'enterpriseValue', 'sharesOutstanding', 'pe', 'forwardPe', 'ps', 'forwardPs', 'pFcf', 'evEbitda', 'pb', 'peg', 'pegGrowthSource', 'pegHist', 'forwardToTtmPe', 'epsGrowthNextYearEst', 'epsGrowth5yEst', 'epsRevision30d', 'pePct5y', 'pFcfPct5y']);
put('quality', ['roic', 'fcfToEbitda', 'operatingMargin', 'grossMarginSlope3y', 'operatingMarginSlope3y', 'cfoToNi', 'fcfToNi', 'niVolatility5y', 'fcfVolatility5y', 'capexToCfo', 'capexToRevenue', 'capexToRevenueDelta3y', 'ffoApprox']);
put('safety', ['currentRatio', 'quickRatio', 'debtToEquity', 'netDebtToEbitda', 'interestCoverage', 'interestCoverageNote', 'cashRunwayMonths', 'altmanZ', 'altmanVariant', 'piotroskiF', 'beta']);
put('dividends', ['dividendYield', 'dividendRate', 'payoutRatio', 'fcfPayout', 'ffoPayoutApprox', 'yieldVsAvg5y']);
put('fields', ['ticker', 'type', 'sector', 'industry', 'isMine', 'size']);

export function metricGroup(def: MetricDef): MetricGroup {
  const listed = LISTS[def.id];
  if (listed) return listed;
  if (/^dividendGrowth/.test(def.id)) return 'dividends';
  if (/Margin(Delta(3y)?)?$/.test(def.id)) return 'quality';
  if (/Growth(3y|5y)?$/.test(def.id)) return 'growth';
  if (def.appliesTo.length === 1 && def.appliesTo[0] === 'etf') return 'etf';
  return 'price';
}

/** The entries of each group in registry order */
export function groupMetrics(metrics: readonly MetricDef[]): Array<{ id: MetricGroup; title: Text; metrics: MetricDef[] }> {
  return METRIC_GROUPS.map((g) => ({ id: g.id, title: g.title, metrics: metrics.filter((m) => metricGroup(m) === g.id) }));
}
