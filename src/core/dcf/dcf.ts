/// <reference lib="esnext" />
/**
 * DCF calculator (plan stage 7). Two flows side by side: free cash flow of the whole company and earnings per share.
 * Flow of year t: CF(t) = CF(t-1) × (1 + g1) for years 1-5, × (1 + g2) for years 6-10, CF(0) = the base (TTM)
 * Value = Σ CF(t) / (1 + WACC)^t for t = 1..10 + CF(10) × (1 + g) / (WACC - g) / (1 + WACC)^10 (terminal value, g = terminal growth)
 * FCF flow: (value - net debt) / shares = value per share; EPS flow: the value already is per share. WACC <= g is rejected,
 * so is a base that is not positive (a DCF of a negative flow says nothing). Rates are percent (9.5 = 9.5%); nothing is rounded
 * inside, `cents` rounds a result for display and for the tests ("to the cent", owner decision В10)
 */

export type DcfKind = 'fcf' | 'eps';
export type DcfInput = {
  kind: DcfKind;
  /** CF(0): TTM free cash flow (USD) for fcf, TTM diluted EPS (USD per share) for eps */
  base: number;
  /** growth of years 1-5, percent */
  g1: number;
  /** growth of years 6-10, percent */
  g2: number;
  /** discount rate, percent */
  wacc: number;
  /** growth after year 10, percent */
  terminalGrowth: number;
  /** fcf only: debt - cash - short-term investments (negative = net cash), USD */
  netDebt?: number;
  /** fcf only: diluted shares */
  shares?: number;
};
export type DcfYear = { year: number; growth: number; flow: number; factor: number; pv: number };
export type DcfError = 'wacc-not-above-growth' | 'base-not-positive' | 'shares-not-positive' | 'not-a-number';
export type DcfResult =
  | { ok: true; kind: DcfKind; years: DcfYear[]; sumPv: number; terminalValue: number; pvTerminal: number; value: number; equity: number; perShare: number }
  | { ok: false; kind: DcfKind; error: DcfError };

export const DCF_DEFAULTS = { wacc: 9.5, terminalGrowth: 3, years: 10, firstStage: 5 };
/** bear and bull move the base inputs by these percentage points; the terminal growth stays */
export const DCF_SCENARIOS: Record<'bear' | 'base' | 'bull', { g1: number; g2: number; wacc: number }> = {
  bear: { g1: -5, g2: -3, wacc: 1 },
  base: { g1: 0, g2: 0, wacc: 0 },
  bull: { g1: 5, g2: 3, wacc: -1 },
};
export type ScenarioName = keyof typeof DCF_SCENARIOS;
export const SCENARIO_NAMES: ScenarioName[] = ['bear', 'base', 'bull'];
/** Tax rate of "operating income after tax" when the filing gives no usable effective rate (US federal statutory rate), percent */
export const DCF_STATUTORY_TAX_PCT = 21;
/** Effective tax rates are kept within 0 and this (one-off charges can push income tax / pretax income far out), percent */
export const DCF_MAX_TAX_PCT = 50;
/** reported: the diluted EPS of the filing; operating: operating income after tax per diluted share (owner answer N37) */
export type EpsSource = 'reported' | 'operating';
export const EPS_SOURCES: EpsSource[] = ['reported', 'operating'];

/** The two per-share values are flagged as diverging when the smaller is more than this share below the larger (percent) */
export const DCF_GAP_PCT = 30;

const finite = (v: unknown): v is number => typeof v === 'number' && isFinite(v);

export function dcf(input: DcfInput): DcfResult {
  const { kind } = input;
  const numbers = [input.base, input.g1, input.g2, input.wacc, input.terminalGrowth].concat(kind === 'fcf' ? [input.netDebt ?? 0, input.shares ?? NaN] : []);
  if (!numbers.every(finite)) return { ok: false, kind, error: kind === 'fcf' && !finite(input.shares) ? 'shares-not-positive' : 'not-a-number' };
  if (input.wacc <= input.terminalGrowth) return { ok: false, kind, error: 'wacc-not-above-growth' };
  if (input.base <= 0) return { ok: false, kind, error: 'base-not-positive' };
  if (kind === 'fcf' && !((input.shares as number) > 0)) return { ok: false, kind, error: 'shares-not-positive' };
  const w = input.wacc / 100;
  const years: DcfYear[] = [];
  let flow = input.base;
  let sumPv = 0;
  for (let t = 1; t <= DCF_DEFAULTS.years; t += 1) {
    const growth = t <= DCF_DEFAULTS.firstStage ? input.g1 : input.g2;
    flow *= 1 + growth / 100;
    const factor = Math.pow(1 + w, t);
    const pv = flow / factor;
    sumPv += pv;
    years.push({ year: t, growth, flow, factor, pv });
  }
  const g = input.terminalGrowth / 100;
  const terminalValue = (flow * (1 + g)) / (w - g);
  const pvTerminal = terminalValue / Math.pow(1 + w, DCF_DEFAULTS.years);
  const value = sumPv + pvTerminal;
  const equity = kind === 'fcf' ? value - (input.netDebt ?? 0) : value;
  const perShare = kind === 'fcf' ? equity / (input.shares as number) : value;
  return { ok: true, kind, years, sumPv, terminalValue, pvTerminal, value, equity, perShare };
}

/** Rounded to the cent, halves away from zero (2.675 -> 2.68 despite the binary 2.67499...) */
export function cents(v: number): number {
  const sign = v < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(v) * 100 + 1e-7)) / 100;
}

/** The input of a scenario: the base input moved by the scenario's percentage points */
export function scenarioInput(input: DcfInput, name: ScenarioName): DcfInput {
  const d = DCF_SCENARIOS[name];
  return { ...input, g1: input.g1 + d.g1, g2: input.g2 + d.g2, wacc: input.wacc + d.wacc };
}

/** (value - price) / value in percent; null without a positive value or a price */
export function marginOfSafety(value: number | null, price: number | null): number | null {
  if (!finite(value) || !finite(price) || value <= 0 || price <= 0) return null;
  return ((value - price) / value) * 100;
}

/** How far the smaller per-share value is below the larger (percent) and whether that is above DCF_GAP_PCT */
export function valueGap(fcfValue: number | null, epsValue: number | null, threshold: number = DCF_GAP_PCT): { gap: number | null; flagged: boolean } {
  if (!finite(fcfValue) || !finite(epsValue) || fcfValue <= 0 || epsValue <= 0) return { gap: null, flagged: false };
  const high = Math.max(fcfValue, epsValue);
  const gap = ((high - Math.min(fcfValue, epsValue)) / high) * 100;
  return { gap, flagged: gap > threshold };
}

type Json = Record<string, any>;
const num = (v: unknown): number | null => (finite(v) ? v : null);

export type DcfFeedInputs = {
  /** TTM operating cash flow - capex, USD */
  fcf: number | null;
  /** TTM diluted EPS in USD (a foreign issuer: USD net income / diluted shares) */
  eps: number | null;
  /** TTM operating income × (1 - tax rate) / diluted shares, USD: earnings without non-operating gains and losses (owner answer N37) */
  epsOperating: number | null;
  /** the tax rate behind epsOperating, percent: income tax / pretax income within 0-DCF_MAX_TAX_PCT, else DCF_STATUTORY_TAX_PCT */
  taxRate: number | null;
  netDebt: number | null;
  shares: number | null;
  /** capex / revenue and capex / operating cash flow, percent */
  capexToRevenue: number | null;
  capexToCfo: number | null;
  /** where the inputs come from: the SEC TTM layer (its end date), else the latest annual row */
  basis: string;
  /** the SEC layer is not in USD: amounts are the USD view, per share = per ordinary share (an ADR can stand for several) */
  foreign: boolean;
};

/**
 * Operating income after tax per share: operating income × (1 - tax rate) / shares. The tax rate is the effective one
 * (income tax / pretax income) when both are given and pretax income is positive, kept within 0-DCF_MAX_TAX_PCT, else the
 * statutory DCF_STATUTORY_TAX_PCT. null without operating income or positive shares
 */
export function operatingEpsAfterTax(operatingIncome: number | null, pretaxIncome: number | null, incomeTax: number | null, shares: number | null): { value: number | null; taxRate: number | null } {
  if (!finite(operatingIncome) || !finite(shares) || shares <= 0) return { value: null, taxRate: null };
  const effective = finite(pretaxIncome) && finite(incomeTax) && pretaxIncome > 0 ? (incomeTax / pretaxIncome) * 100 : null;
  const taxRate = effective === null ? DCF_STATUTORY_TAX_PCT : Math.min(DCF_MAX_TAX_PCT, Math.max(0, effective));
  return { value: (operatingIncome * (1 - taxRate / 100)) / shares, taxRate };
}

/**
 * DCF inputs from a company's meta.json and its index row: the SEC TTM layer (USD view for a foreign issuer), else the
 * latest annual row; shares are the TTM diluted weighted shares (all share classes, owner answer N36), else Yahoo sharesOutstanding.
 * Without a diluted EPS tag EPS = net income / those SEC shares, never over Yahoo's count (one class only for Visa). A missing debt
 * line counts as 0
 */
export function dcfInputsFromMeta(meta: Json | null, row: Json | null): DcfFeedInputs {
  const fundamentals = meta && meta.fundamentals ? meta.fundamentals : {};
  const sec = fundamentals.sec && fundamentals.sec.ttm ? fundamentals.sec : null;
  const metrics = row && row.metrics ? row.metrics : {};
  const yahooShares = num(metrics.sharesOutstanding);
  if (sec) {
    const foreign = typeof sec.currency === 'string' && sec.currency !== 'USD';
    const ttm: Json = foreign && fundamentals.usd && fundamentals.usd.ttm ? fundamentals.usd.ttm : sec.ttm;
    if (foreign && !(fundamentals.usd && fundamentals.usd.ttm)) return emptyInputs(`SEC TTM ${sec.ttm.end ?? ''} in ${sec.currency}, no USD view`, true);
    const cfo = num(ttm.cfo), capex = num(ttm.capex), revenue = num(ttm.revenue);
    // a TTM that is the last fiscal year keeps its per-share values in fy; an issuer without EPS tags (V reports by share class) gets NI / shares
    const sameAsFy = Array.isArray(sec.fy && sec.fy.end) && sec.fy.end[0] === sec.ttm.end;
    const fyFirst = (key: string): number | null => (sameAsFy && Array.isArray(sec.fy[key]) ? num(sec.fy[key][0]) : null);
    const secShares = num(sec.ttm.sharesDiluted) ?? fyFirst('sharesDiluted');
    const shares = secShares ?? yahooShares;
    const ni = num(ttm.netIncome);
    const reported = foreign ? null : num(sec.ttm.epsDiluted) ?? fyFirst('epsDiluted');
    const eps = reported ?? (ni !== null && secShares ? ni / secShares : null);
    const epsNote = reported === null && eps !== null ? '; EPS = net income / shares' : '';
    const debt = num(ttm.debt) ?? 0, cash = num(ttm.cash) ?? 0, sti = num(ttm.shortTermInvestments) ?? 0;
    const operating = operatingEpsAfterTax(num(ttm.operatingIncome), num(ttm.pretaxIncome), num(ttm.incomeTax), secShares);
    return {
      fcf: cfo !== null && capex !== null ? cfo - capex : null, eps, epsOperating: operating.value, taxRate: operating.taxRate, netDebt: debt - cash - sti, shares,
      capexToRevenue: capex !== null && revenue ? (capex / revenue) * 100 : null, capexToCfo: capex !== null && cfo && cfo > 0 ? (capex / cfo) * 100 : null,
      basis: `SEC TTM to ${sec.ttm.end ?? '?'}${foreign ? ` in USD (${sec.currency})` : ''}${epsNote}`, foreign,
    };
  }
  const annual: Json | null = Array.isArray(fundamentals.annual) && fundamentals.annual.length ? fundamentals.annual[0] : null;
  if (!annual) return emptyInputs('no fundamentals', false);
  const foreign = !!meta && typeof meta.financialCurrency === 'string' && meta.financialCurrency !== 'USD';
  if (foreign) return emptyInputs(`fiscal year ${annual.end ?? ''} in ${meta && meta.financialCurrency}`, true);
  const cfo = num(annual.operatingCashFlow), capexRaw = num(annual.capex), revenue = num(annual.revenue);
  const capex = capexRaw === null ? null : Math.abs(capexRaw);
  const fcf = num(annual.fcf) ?? (cfo !== null && capex !== null ? cfo - capex : null);
  const ni = num(annual.netIncome);
  const eps = num(annual.eps) ?? (ni !== null && yahooShares ? ni / yahooShares : null);
  return {
    fcf, eps, epsOperating: null, taxRate: null, netDebt: (num(annual.debt) ?? 0) - (num(annual.cash) ?? 0), shares: yahooShares,
    capexToRevenue: capex !== null && revenue ? (capex / revenue) * 100 : null, capexToCfo: capex !== null && cfo && cfo > 0 ? (capex / cfo) * 100 : null,
    basis: `fiscal year ${annual.end ?? '?'}${num(annual.eps) === null && eps !== null ? '; EPS = net income / shares' : ''}`, foreign: false,
  };
}

function emptyInputs(basis: string, foreign: boolean): DcfFeedInputs {
  return { fcf: null, eps: null, epsOperating: null, taxRate: null, netDebt: null, shares: null, capexToRevenue: null, capexToCfo: null, basis, foreign };
}

/**
 * Starting growth rates (the plan fixes only WACC and terminal growth): g1 = the 3-year revenue CAGR, else the 3-year EPS CAGR,
 * else 5, kept within 0-20 and rounded to a whole percent; g2 = half of g1. Starting values to overwrite, not a forecast
 */
export function defaultGrowth(metrics: Json | null): { g1: number; g2: number } {
  const m = metrics || {};
  const raw = num(m.revenueGrowth3y) ?? num(m.epsGrowth3y) ?? 5;
  const g1 = Math.round(Math.min(20, Math.max(0, raw)));
  return { g1, g2: Math.round(g1 * 5) / 10 };
}

// ---- the owner's DCF inputs of one ticker as a user-data file (owner answer N39): user-data/dcf/<T>.json ----

export const DCF_DOC_SCHEMA_VERSION = 1;
/** The edited inputs of one ticker; null amounts are empty fields. Rates in percent, amounts in USD, shares as a count */
export type DcfDoc = {
  schemaVersion: number;
  ticker: string;
  epsSource: EpsSource;
  g1: number;
  g2: number;
  wacc: number;
  terminalGrowth: number;
  fcf: number | null;
  eps: number | null;
  epsOperating: number | null;
  netDebt: number | null;
  shares: number | null;
};
const DOC_RATES = ['g1', 'g2', 'wacc', 'terminalGrowth'] as const;
const DOC_AMOUNTS = ['fcf', 'eps', 'epsOperating', 'netDebt', 'shares'] as const;

export function dcfDocText(doc: DcfDoc): string {
  const out: Record<string, unknown> = { schemaVersion: DCF_DOC_SCHEMA_VERSION, ticker: doc.ticker, epsSource: doc.epsSource };
  DOC_RATES.forEach((k) => { out[k] = doc[k]; });
  DOC_AMOUNTS.forEach((k) => { out[k] = finite(doc[k]) ? doc[k] : null; });
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Reads an exported file back: every rate a number, amounts a number or null, epsSource reported or operating (missing = reported) */
export function parseDcfDoc(textIn: string, ticker: string): { doc: DcfDoc | null; errors: string[] } {
  let data: any;
  try { data = JSON.parse(textIn); } catch (error) { return { doc: null, errors: [`not JSON: ${error instanceof Error ? error.message : String(error)}`] }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { doc: null, errors: ['DCF file needs {"schemaVersion": 1, "ticker": "T", "g1": ..., "wacc": ...}'] };
  const errors: string[] = [];
  if (data.schemaVersion !== DCF_DOC_SCHEMA_VERSION) errors.push(`schemaVersion must be ${DCF_DOC_SCHEMA_VERSION}`);
  if (data.ticker !== ticker) errors.push(`the file is for ${String(data.ticker)}, not ${ticker}`);
  const epsSource = data.epsSource === undefined ? 'reported' : data.epsSource;
  if (EPS_SOURCES.indexOf(epsSource) < 0) errors.push(`epsSource must be one of ${EPS_SOURCES.join(', ')}`);
  DOC_RATES.forEach((k) => { if (!finite(data[k])) errors.push(`${k} must be a number`); });
  DOC_AMOUNTS.forEach((k) => { if (data[k] !== undefined && data[k] !== null && !finite(data[k])) errors.push(`${k} must be a number or null`); });
  if (errors.length) return { doc: null, errors };
  const amount = (k: (typeof DOC_AMOUNTS)[number]): number | null => (finite(data[k]) ? data[k] : null);
  return {
    doc: { schemaVersion: DCF_DOC_SCHEMA_VERSION, ticker, epsSource, g1: data.g1, g2: data.g2, wacc: data.wacc, terminalGrowth: data.terminalGrowth, fcf: amount('fcf'), eps: amount('eps'), epsOperating: amount('epsOperating'), netDebt: amount('netDebt'), shares: amount('shares') },
    errors,
  };
}
