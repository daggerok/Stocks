/// <reference lib="esnext" />
/** Thresholds of the signals (plan stage 8): starting values, tuned after the first real runs (owner decision В13) */
import type { SignalsConfig } from './types';

export const SIGNALS_CONFIG: SignalsConfig = {
  scoreDelta: 15,
  exitRuns: 2,
  retentionDays: 84,
  skipPresets: ['mine'],
  skipRefine: true,
  issueDays: 7,
};
