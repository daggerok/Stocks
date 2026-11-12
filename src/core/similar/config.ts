/// <reference lib="esnext" />
/**
 * Starting values of "Similar to X" (plan stage 6): the metric groups, how many hits, the share of common metrics a pair needs,
 * the smallest group a percentile is taken in and the tolerance of "Make a filter from X". Edit the numbers and the lists here;
 * the test checks every metric against the registry. A plain module instead of a JSON file: the page bundles it, no extra fetch
 */
import type { Text } from '../metrics';

export type SimilarGroup = { id: string; title: Text; metrics: string[] };
export type SimilarConfig = {
  schemaVersion: number;
  /** hits shown */
  top: number;
  /** a candidate needs at least this share of X's usable metrics in common (rounded up, at least 1) */
  minShare: number;
  /** a metric with fewer values among the securities of X's type gives no percentile (same as the engine's MIN_GROUP) */
  minGroup: number;
  /** main differences listed per hit */
  differences: number;
  /** "Make a filter from X": each value of X widened by this share of its size in both directions (0.2 = ±20%) */
  tolerance: number;
  groups: SimilarGroup[];
};

export const SIMILAR_CONFIG: SimilarConfig = {
  schemaVersion: 1,
  top: 10,
  minShare: 0.5,
  minGroup: 5,
  differences: 3,
  tolerance: 0.2,
  groups: [
    {
      id: 'business',
      title: { en: 'Business', ru: 'Бизнес' },
      metrics: ['grossMargin', 'operatingMargin', 'netMargin', 'fcfMargin', 'roic', 'revenueGrowth3y', 'epsGrowth3y', 'capexToRevenue', 'fcfToNi'],
    },
    {
      id: 'dividend',
      title: { en: 'Dividend', ru: 'Дивиденд' },
      metrics: ['dividendYield', 'dividendGrowth5y', 'dividendStreak', 'payoutRatio', 'fcfPayout', 'yieldVsAvg5y'],
    },
    {
      id: 'valuation',
      title: { en: 'Valuation', ru: 'Оценка' },
      metrics: ['pe', 'forwardPe', 'ps', 'pFcf', 'evEbitda', 'pb', 'peg', 'pegHist'],
    },
    {
      id: 'risk',
      title: { en: 'Risk', ru: 'Риск' },
      metrics: ['beta', 'volatility1y', 'debtToEquity', 'netDebtToEbitda', 'interestCoverage', 'altmanZ', 'currentRatio', 'pctFromAth'],
    },
  ],
};
