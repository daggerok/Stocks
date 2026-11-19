/// <reference lib="esnext" />
/**
 * Business types (owner 2026-11-19: "maybe our app will be able to know it and behave properly"): some sectors look bad on the generic
 * metrics by design. A REIT pays out 90% and grows with new shares, a regulated utility spends more than its operating cash on capex
 * the regulator pays a return on, a bank's debt is its raw material. The type comes from the Yahoo industry; a condition on a metric
 * that does not apply to the row's type is skipped (never fails), the table shows such a cell grey with the reason, and the dilution
 * flags judge the share count change with the limit of the type. The Guide section Sectors explains the same rules in words
 */
import type { Text } from '../metrics/types';

export type BusinessType = 'reit' | 'utility' | 'bank' | 'insurer' | 'midstream' | 'regular';
export const BUSINESS_TYPES: BusinessType[] = ['reit', 'utility', 'bank', 'insurer', 'midstream', 'regular'];

/** The business type of a Yahoo industry: REIT - ..., Utilities - Regulated ... or Diversified, Banks - ..., Insurance - ... (not brokers), Oil & Gas Midstream */
export function businessType(industry: string | null | undefined): BusinessType {
  const s = industry ?? '';
  if (/^REIT\b/.test(s)) return 'reit';
  if (/^Utilities - (Regulated|Diversified)\b/.test(s)) return 'utility';
  if (/\bBanks\b/.test(s)) return 'bank';
  if (/^Insurance - /.test(s)) return 'insurer';
  if (/^Oil & Gas Midstream$/.test(s)) return 'midstream';
  return 'regular';
}

const FCF_KEYS = ['pFcf', 'pFcfPct5y', 'fcfMargin', 'fcfMarginDelta', 'fcfMarginDelta3y', 'fcfPayout', 'fcfToNi', 'fcfToEbitda', 'fcfGrowth', 'fcfGrowth3y',
  'fcfGrowth5y', 'fcfVolatility5y', 'fcfNegativeYears'];
const FINANCIAL_KEYS = FCF_KEYS.concat(['debtToEquity', 'netDebtToEbitda', 'currentRatio', 'quickRatio', 'grossMargin', 'grossMarginDelta', 'grossMarginDelta3y',
  'ebitdaMargin', 'ebitdaMarginDelta', 'ebitdaMarginDelta3y', 'evEbitda', 'altmanZ', 'piotroskiF', 'interestCoverage', 'capexToCfo', 'capexToRevenue',
  'capexToRevenueDelta3y', 'cashRunwayMonths']);

export type BusinessRule = {
  title: Text;
  /** metrics whose conditions are skipped for this type and whose cells are grey */
  notApplicable: string[];
  reason: Text;
  /** the yearly share count change (%) the type may reach in the sector mode of the dilution flags, when per-share growth beats it */
  dilutionLimit: number;
};

export const BUSINESS_RULES: Record<BusinessType, BusinessRule> = {
  reit: {
    title: { en: 'REIT', ru: 'REIT' },
    notApplicable: ['pe', 'forwardPe', 'peg', 'pegHist', 'pePct5y', 'forwardToTtmPe', 'payoutRatio', 'fcfPayout', 'epsNiGrowthGap3y', 'altmanZ', 'piotroskiF'],
    reason: { en: 'REIT: depreciation of buildings depresses earnings and EPS, and the law makes it pay out 90%; judge it by ffoApprox, ffoPayoutApprox and ffoGrowth3y', ru: 'REIT: амортизация зданий занижает прибыль и EPS, а закон обязывает раздавать 90%; оценивайте по ffoApprox, ffoPayoutApprox и ffoGrowth3y' },
    dilutionLimit: 4,
  },
  utility: {
    title: { en: 'Regulated utility', ru: 'Регулируемая коммунальная' },
    notApplicable: FCF_KEYS.concat(['capexToCfo', 'capexToRevenue', 'capexToRevenueDelta3y', 'altmanZ', 'cashRunwayMonths', 'epsNiGrowthGap3y']),
    reason: { en: 'Regulated utility: capex above the operating cash flow is the business (the regulator pays a return on it), so free cash flow is negative by design; judge it by EPS and dividend growth per share', ru: 'Регулируемая коммунальная компания: капзатраты больше операционного потока - это и есть бизнес (регулятор платит на них доходность), поэтому свободный поток отрицательный по природе; оценивайте по росту EPS и дивиденда на акцию' },
    dilutionLimit: 3,
  },
  bank: {
    title: { en: 'Bank', ru: 'Банк' },
    notApplicable: FINANCIAL_KEYS,
    reason: { en: 'Bank: deposits are liabilities and debt is the raw material, there is no free cash flow in the usual sense; judge it by P/B, ROE, ROA and EPS growth', ru: 'Банк: вклады - это обязательства, долг - сырьё бизнеса, свободного потока в обычном смысле нет; оценивайте по P/B, ROE, ROA и росту EPS' },
    dilutionLimit: 1,
  },
  insurer: {
    title: { en: 'Insurer', ru: 'Страховщик' },
    notApplicable: FINANCIAL_KEYS,
    reason: { en: 'Insurer: premiums arrive before claims are paid (the float), so debt and cash flow ratios mislead; judge it by P/B, ROE and book value growth', ru: 'Страховщик: премии приходят раньше выплат (float), поэтому долговые и денежные коэффициенты вводят в заблуждение; оценивайте по P/B, ROE и росту балансовой стоимости' },
    dilutionLimit: 1,
  },
  midstream: {
    title: { en: 'Midstream', ru: 'Мидстрим' },
    notApplicable: ['payoutRatio'],
    reason: { en: 'Midstream: pipelines pay out most of their cash, so a payout over 100% of net income is common; judge it by distributable cash flow (10-K) and netDebtToEbitda', ru: 'Мидстрим: трубопроводы раздают большую часть денег, поэтому выплаты больше 100% чистой прибыли - обычное дело; оценивайте по распределяемому потоку (10-K) и netDebtToEbitda' },
    dilutionLimit: 2,
  },
  regular: {
    title: { en: 'Regular company', ru: 'Обычная компания' },
    notApplicable: [],
    reason: { en: '', ru: '' },
    dilutionLimit: 1,
  },
};

const NA: Record<string, Record<string, boolean>> = {};
BUSINESS_TYPES.forEach((type) => { NA[type] = {}; BUSINESS_RULES[type].notApplicable.forEach((m) => { NA[type][m] = true; }); });

/** true when a condition on this metric is skipped for this business type */
export function isNotApplicable(type: string | null | undefined, metric: string): boolean {
  return !!type && !!NA[type] && NA[type][metric] === true;
}

/** Why a metric does not apply to the type, null when it does */
export function notApplicableReason(type: string | null | undefined, metric: string): Text | null {
  return isNotApplicable(type, metric) ? BUSINESS_RULES[type as BusinessType].reason : null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);

export type DilutionFlags = { dilutionOkStrict: boolean | null; dilutionOkPerShare: boolean | null; dilutionOkSector: boolean | null };

/**
 * Three readings of the share count change (sharesChange5y, else sharesChange3y), null without it (owner 2026-11-19, a chip picker):
 * strict - the count did not grow; per share - it did not grow, or EPS or dividend per share grew faster over the same horizon; sector -
 * up to 1% a year for anyone, up to the type's limit (REIT 4, utility 3, midstream 2) when per-share growth beats the count
 */
export function dilutionFlags(metrics: Record<string, unknown>, type: BusinessType): DilutionFlags {
  const five = num(metrics.sharesChange5y);
  const shares = five ?? num(metrics.sharesChange3y);
  if (shares === null) return { dilutionOkStrict: null, dilutionOkPerShare: null, dilutionOkSector: null };
  const h = five !== null ? '5y' : '3y';
  const growth = [num(metrics[`epsGrowth${h}`]), num(metrics[`dividendGrowth${h}`])].filter((x): x is number => x !== null);
  const beats = growth.some((g) => g > shares);
  const perShare = shares <= 0 || beats;
  const limit = BUSINESS_RULES[type].dilutionLimit;
  return { dilutionOkStrict: shares <= 0, dilutionOkPerShare: perShare, dilutionOkSector: shares <= 1 || (shares <= limit && beats) };
}
