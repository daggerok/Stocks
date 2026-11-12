/// <reference lib="esnext" />
/**
 * Derived fundamentals (screener plan 1.5 quality, safety and capital, 1.7 sector exceptions) from the SEC layer of
 * scripts/sec/companyfacts.ts. Pure formulas, no IO. Flows are TTM unless the name says otherwise (3y, 5y, slopes and
 * Piotroski read fiscal years). A zero or negative denominator gives null, never 0 (plan section 3)
 */
import { column, type SecFundamentals } from '../sec/companyfacts';

type Num = number | null;
/**
 * `usd`: the layer in USD (scripts/sec/fx.ts usdView) of an issuer that reports in another currency. Formulas that mix the market
 * cap with amounts (Altman's market cap over liabilities, the approximate FFO amount) read it; every ratio, growth rate and
 * margin reads the layer in its reporting currency (plan 1.3)
 */
export type FundamentalsContext = { marketCap: Num; sector: string | null; industry: string | null; usd?: SecFundamentals | null };

/** Keys this module adds to `metrics`, in the order they are published */
export const FUNDAMENTAL_METRIC_KEYS = [
  'operatingMargin', 'grossMarginSlope3y', 'operatingMarginSlope3y', 'cfoToNi', 'fcfToNi', 'interestCoverage', 'interestCoverageNote',
  'cashRunwayMonths', 'altmanZ', 'altmanVariant', 'piotroskiF', 'niVolatility5y', 'fcfVolatility5y', 'capexToCfo', 'capexToRevenue',
  'capexToRevenueDelta3y', 'niGrowth3y', 'niGrowth5y', 'ffoApprox', 'ffoPayoutApprox',
  // inputs of the stage 5 stop factors and flags (src/core/scoring)
  'fcfNegativeYears', 'cfoGrowth3y', 'epsNiGrowthGap3y', 'balanceYoyMaxChange', 'balanceYoyMaxLine',
] as const;

/** Yahoo industries (plan 1.7): REIT - prefix REIT, banks - Banks, insurers - Insurance */
export const isReit = (industry: string | null) => /^REIT\b/.test(industry ?? '');
export const isBank = (industry: string | null) => /\bBanks\b/.test(industry ?? '');
export const isInsurer = (industry: string | null) => /^Insurance\b/.test(industry ?? '');
export const isFinancial = (industry: string | null) => isBank(industry) || isInsurer(industry);

/**
 * Sectors scored with the classic manufacturing Altman Z (market cap over liabilities, sales over assets); every other sector,
 * an unknown one included, gets Z'' for non-manufacturers (book equity over liabilities, no sales term). Kept in code (owner
 * answer N12, a config only if cheap): scripts/ allows only its listed files and update-data.config.json holds control defaults
 * only, so there is no allowed place for a data table outside this module
 */
export const ALTMAN_CLASSIC_SECTORS = ['Industrials', 'Basic Materials', 'Consumer Cyclical', 'Consumer Defensive', 'Energy', 'Technology', 'Healthcare'];

/** Absolute TTM amounts in USD published in the index row (owner answer N38): the peers table reads them instead of deriving them */
export const TTM_AMOUNT_KEYS = ['revenueTtm', 'netIncomeTtm', 'fcfTtm'] as const;

/**
 * Revenue, net income and free cash flow (operating cash flow - capex) of the TTM, in USD: `usd` is the layer in USD (the SEC
 * layer itself for a USD filer, its USD view for a foreign one). null without a layer or a value
 */
export function ttmAmounts(usd: SecFundamentals | null): Record<(typeof TTM_AMOUNT_KEYS)[number], Num> {
  if (!usd) return { revenueTtm: null, netIncomeTtm: null, fcfTtm: null };
  const v = view(usd);
  const whole = (x: Num): Num => (fin(x) ? Math.round(x) : null);
  return { revenueTtm: whole(v.ttm('revenue')), netIncomeTtm: whole(v.ttm('netIncome')), fcfTtm: whole(fcfOf(v.ttm('cfo'), v.ttm('capex'))) };
}

/** Metrics left empty for banks and insurers (plan 1.7): no EBITDA, current ratio or free cash flow in a meaningful sense */
export const FINANCIALS_NULL_KEYS = [
  'netDebtToEbitda', 'evEbitda', 'quickRatio', 'currentRatio', 'pFcf', 'fcfToEbitda', 'fcfPayout', 'fcfMargin', 'fcfMarginDelta', 'fcfMarginDelta3y',
  'fcfGrowth', 'fcfGrowth3y', 'fcfGrowth5y', 'fcfToNi', 'fcfVolatility5y', 'cashRunwayMonths', 'altmanZ', 'altmanVariant', 'piotroskiF',
  'interestCoverage', 'interestCoverageNote', 'pFcfPct5y', 'fcfNegativeYears', 'fcfTtm',
];

const DAY = 86_400_000;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const roundTo = (v: number, digits = 2): number => { const f = Math.pow(10, digits); return Math.round(v * f) / f; };
const r2 = (v: Num): Num => (fin(v) ? roundTo(v, 2) : null);
const pos = (v: Num): v is number => fin(v) && v > 0;
/** a / b, null unless b > 0 */
export const ratio = (a: Num, b: Num): Num => (fin(a) && pos(b) ? a / b : null);

/** Sample standard deviation; null below 2 values */
export function stdev(values: number[]): Num {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (values.length - 1));
}

/** Least-squares slope of y over x */
export function slope(points: Array<[number, number]>): Num {
  if (points.length < 2) return null;
  const mx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const my = points.reduce((s, p) => s + p[1], 0) / points.length;
  let num = 0, den = 0;
  for (const [x, y] of points) { num += (x - mx) * (y - my); den += (x - mx) * (x - mx); }
  return den > 0 ? num / den : null;
}

type View = {
  ttm: (k: string) => Num;
  /** value of fiscal year `back` (0 = latest) when that year ends `back` years before the latest, else null */
  fy: (k: string, back: number) => Num;
};

function view(sec: SecFundamentals): View {
  const ends = (sec.fy?.end ?? []) as Array<string | null>;
  const at = (back: number): number => {
    if (!ends[0]) return -1;
    const target = Date.parse(`${ends[0]}T00:00:00Z`) - back * 365.25 * DAY;
    for (let i = 0; i < ends.length; i += 1) {
      const e = ends[i];
      if (e && Math.abs(Date.parse(`${e}T00:00:00Z`) - target) <= 40 * DAY) return i;
    }
    return -1;
  };
  const cache: Record<string, Array<number | null>> = {};
  return {
    ttm: (k) => (fin(sec.ttm?.[k]) ? (sec.ttm[k] as number) : null),
    fy: (k, back) => {
      const i = at(back);
      if (i < 0) return null;
      const col = cache[k] ?? (cache[k] = column(sec.fy, k));
      return col[i] ?? null;
    },
  };
}

const fcfOf = (cfo: Num, capex: Num): Num => (fin(cfo) && fin(capex) ? cfo - capex : null);
/** Operating income plus depreciation and amortization of the trailing twelve months (own EBITDA) */
export const ebitdaTtm = (sec: SecFundamentals | null): Num => {
  if (!sec) return null;
  const v = view(sec);
  const oi = v.ttm('operatingIncome');
  const da = v.ttm('da');
  return fin(oi) && fin(da) ? oi + da : null;
};

/** CAGR in % between fiscal year `back` and the latest; both endpoints positive */
function cagr(v: View, key: string, back: number): Num {
  const now = v.fy(key, 0);
  const then = v.fy(key, back);
  return pos(now) && pos(then) ? r2((Math.pow(now / then, 1 / back) - 1) * 100) : null;
}

/** Slope of a margin over the latest 4 fiscal years, percentage points per year */
function marginSlope(v: View, key: string): Num {
  const points: Array<[number, number]> = [];
  for (let back = 0; back <= 3; back += 1) {
    const m = ratio(v.fy(key, back), v.fy('revenue', back));
    if (m === null) return null;
    points.push([-back, m * 100]);
  }
  return r2(slope(points));
}

/** Standard deviation of 5 yearly growth rates (6 consecutive fiscal years, every base positive), percentage points */
function growthVolatility(v: View, value: (back: number) => Num): Num {
  const rates: number[] = [];
  for (let back = 0; back < 5; back += 1) {
    const cur = value(back);
    const base = value(back + 1);
    if (!fin(cur) || !pos(base)) return null;
    rates.push(((cur - base) / base) * 100);
  }
  return r2(stdev(rates));
}

/** Balance lines checked for a large year-over-year change (flag of plan stage 5) */
export const BALANCE_LINES = ['cash', 'receivables', 'currentAssets', 'assets', 'currentLiabilities', 'liabilities', 'debt', 'equity'];
/** A line smaller than this share of the total assets of the year before is too small to matter */
export const BALANCE_MATERIALITY = 0.1;

/** The balance line with the largest year-over-year change in %, latest fiscal year end against the one before */
function balanceJump(v: View): { line: string; change: number } | null {
  const prevAssets = v.fy('assets', 1);
  if (!pos(prevAssets)) return null;
  let best: { line: string; change: number } | null = null;
  for (const line of BALANCE_LINES) {
    const cur = v.fy(line, 0), prev = v.fy(line, 1);
    if (!fin(cur) || !pos(prev) || prev < BALANCE_MATERIALITY * prevAssets) continue;
    const change = ((cur - prev) / prev) * 100;
    if (!best || Math.abs(change) > Math.abs(best.change)) best = { line, change: roundTo(change, 2) };
  }
  return best;
}

export type AltmanResult = { altmanZ: Num; altmanVariant: string | null };

/** Altman Z (plan 1.5): classic for manufacturing sectors, Z'' for the rest; null for banks, insurers and REITs */
export function altman(sec: SecFundamentals | null, ctx: FundamentalsContext): AltmanResult {
  const none = { altmanZ: null, altmanVariant: null };
  if (!sec || isFinancial(ctx.industry) || isReit(ctx.industry)) return none;
  const v = view(sec);
  const assets = v.ttm('assets');
  const liabilities = v.ttm('liabilities');
  const ca = v.ttm('currentAssets');
  const cl = v.ttm('currentLiabilities');
  const re = v.ttm('retainedEarnings');
  const ebit = v.ttm('operatingIncome');
  if (!pos(assets) || !pos(liabilities) || !fin(ca) || !fin(cl) || !fin(re) || !fin(ebit)) return none;
  const x1 = (ca - cl) / assets;
  const x2 = re / assets;
  const x3 = ebit / assets;
  if (ALTMAN_CLASSIC_SECTORS.indexOf(ctx.sector ?? '') >= 0) {
    const revenue = v.ttm('revenue');
    if (!pos(ctx.marketCap) || !fin(revenue)) return none;
    const z = 1.2 * x1 + 1.4 * x2 + 3.3 * x3 + 0.6 * (ctx.marketCap / liabilities) + 1.0 * (revenue / assets);
    return { altmanZ: r2(z), altmanVariant: 'classic' };
  }
  const equity = v.ttm('equity');
  if (!fin(equity)) return none;
  const z = 6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * (equity / liabilities);
  return { altmanZ: r2(z), altmanVariant: 'z2' };
}

/** Piotroski F-score 0-9 on the latest two fiscal years; null when any of the 9 tests cannot be computed */
export function piotroski(sec: SecFundamentals | null): Num {
  if (!sec) return null;
  const v = view(sec);
  const get = (k: string) => [v.fy(k, 0), v.fy(k, 1)];
  const [ni0, ni1] = get('netIncome');
  const [a0, a1] = get('assets');
  const [cfo0] = get('cfo');
  const [ltd0, ltd1] = get('longTermDebt');
  const [ca0, ca1] = get('currentAssets');
  const [cl0, cl1] = get('currentLiabilities');
  const [sh0, sh1] = get('sharesDiluted');
  const [gp0, gp1] = get('grossProfit');
  const [rev0, rev1] = get('revenue');
  const roa0 = ratio(ni0, a0), roa1 = ratio(ni1, a1);
  const lev0 = ratio(ltd0, a0), lev1 = ratio(ltd1, a1);
  const cr0 = ratio(ca0, cl0), cr1 = ratio(ca1, cl1);
  const gm0 = ratio(gp0, rev0), gm1 = ratio(gp1, rev1);
  const at0 = ratio(rev0, a0), at1 = ratio(rev1, a1);
  const inputs = [roa0, roa1, cfo0, ni0, lev0, lev1, cr0, cr1, sh0, sh1, gm0, gm1, at0, at1];
  if (inputs.some((x) => !fin(x))) return null;
  const n = (x: Num) => x as number;
  const tests = [
    n(roa0) > 0, // 1 return on assets is positive
    n(cfo0) > 0, // 2 operating cash flow is positive
    n(roa0) > n(roa1), // 3 return on assets improved
    n(cfo0) > n(ni0), // 4 cash flow exceeds net income (accruals)
    n(lev0) < n(lev1) || (n(lev0) === 0 && n(lev1) === 0), // 5 long-term debt to assets fell (or there is none)
    n(cr0) > n(cr1), // 6 current ratio improved
    n(sh0) <= n(sh1), // 7 no new shares (diluted weighted shares did not grow)
    n(gm0) > n(gm1), // 8 gross margin improved
    n(at0) > n(at1), // 9 asset turnover improved
  ];
  return tests.filter(Boolean).length;
}

/**
 * The metrics this module owns, from the SEC layer and the market context. `ebitda`-based valuation (evEbitda, fcfToEbitda,
 * netDebtToEbitda) is in `ownEbitdaMetrics`; the bank and insurer exceptions are applied to the whole metrics object by
 * `withSectorExceptions`
 */
export function fundamentalMetrics(sec: SecFundamentals | null, ctx: FundamentalsContext): Record<string, number | string | null> {
  const out: Record<string, number | string | null> = {};
  FUNDAMENTAL_METRIC_KEYS.forEach((k) => { out[k] = null; });
  if (!sec) return out;
  const v = view(sec);
  const revenue = v.ttm('revenue');
  const ni = v.ttm('netIncome');
  const cfo = v.ttm('cfo');
  const capex = v.ttm('capex');
  const fcf = fcfOf(cfo, capex);

  const pct = (a: Num, b: Num) => { const x = ratio(a, b); return x === null ? null : r2(x * 100); };
  out.operatingMargin = pct(v.ttm('operatingIncome'), revenue);
  out.grossMarginSlope3y = marginSlope(v, 'grossProfit');
  out.operatingMarginSlope3y = marginSlope(v, 'operatingIncome');
  out.cfoToNi = r2(ratio(cfo, ni));
  out.fcfToNi = r2(ratio(fcf, ni));

  // interest coverage: EBIT (operating income, else pretax income + interest) / interest expense
  const interest = v.ttm('interestExpense');
  const ebit = v.ttm('operatingIncome') ?? (fin(v.ttm('pretaxIncome')) && fin(interest) ? (v.ttm('pretaxIncome') as number) + interest : null);
  const debt = v.ttm('debt');
  if (debt === 0 && !pos(interest)) out.interestCoverageNote = 'no debt';
  else out.interestCoverage = r2(ratio(ebit, interest));

  // cash runway: only a company that burns cash
  const cash = v.ttm('cash');
  if (fin(fcf) && fcf < 0 && fin(cash)) out.cashRunwayMonths = roundTo((cash + (v.ttm('shortTermInvestments') ?? 0)) / (-fcf / 12), 1);

  // a foreign layer without a USD conversion (ctx.usd null) has no Altman Z: its classic form mixes market cap with liabilities
  const z = altman(ctx.usd === undefined ? sec : ctx.usd, ctx);
  out.altmanZ = z.altmanZ;
  out.altmanVariant = z.altmanVariant;
  out.piotroskiF = isFinancial(ctx.industry) ? null : piotroski(sec);

  out.niVolatility5y = growthVolatility(v, (back) => v.fy('netIncome', back));
  out.fcfVolatility5y = growthVolatility(v, (back) => fcfOf(v.fy('cfo', back), v.fy('capex', back)));
  out.capexToCfo = pct(capex, cfo);
  out.capexToRevenue = pct(capex, revenue);
  const intensity = (back: number) => ratio(v.fy('capex', back), v.fy('revenue', back));
  const i0 = intensity(0), i3 = intensity(3);
  out.capexToRevenueDelta3y = i0 !== null && i3 !== null ? r2((i0 - i3) * 100) : null;
  out.niGrowth3y = cagr(v, 'netIncome', 3);
  out.niGrowth5y = cagr(v, 'netIncome', 5);

  // stop factor and flag inputs
  let negative = 0;
  for (let back = 0; back < 10; back += 1) {
    const f = fcfOf(v.fy('cfo', back), v.fy('capex', back));
    if (!fin(f) || f >= 0) break;
    negative += 1;
  }
  out.fcfNegativeYears = fin(fcfOf(v.fy('cfo', 0), v.fy('capex', 0))) ? negative : null;
  out.cfoGrowth3y = cagr(v, 'cfo', 3);
  const epsCagr = cagr(v, 'epsDiluted', 3);
  out.epsNiGrowthGap3y = epsCagr !== null && out.niGrowth3y !== null ? r2(epsCagr - (out.niGrowth3y as number)) : null;
  const jump = balanceJump(v);
  out.balanceYoyMaxChange = jump ? jump.change : null;
  out.balanceYoyMaxLine = jump ? jump.line : null;

  if (isReit(ctx.industry) && fin(ni) && fin(v.ttm('da'))) {
    // approximate FFO: net income + depreciation (the cash flow D&A line: Schedule III real estate depreciation is annual only)
    // - gains on sale of property (a REIT without a gain line counts 0)
    const ffo = ni + (v.ttm('da') as number) - (v.ttm('gainOnSaleOfProperty') ?? 0);
    const u = ctx.usd ? view(ctx.usd) : null; // the amount is published in USD
    const ffoUsd = ctx.usd === undefined ? ffo : u && fin(u.ttm('netIncome')) && fin(u.ttm('da')) ? (u.ttm('netIncome') as number) + (u.ttm('da') as number) - (u.ttm('gainOnSaleOfProperty') ?? 0) : null;
    out.ffoApprox = ffoUsd === null ? null : Math.round(ffoUsd);
    out.ffoPayoutApprox = pct(v.ttm('dividendsPaid'), ffo);
  }
  return out;
}

/**
 * Own EBITDA (TTM operating income + D&A) behind evEbitda, fcfToEbitda and netDebtToEbitda (plan 1.5; they used Yahoo's EBITDA
 * before). EV = market cap + debt + minority interest + preferred - cash - short-term investments, balance of the TTM quarter
 */
export function ownEbitdaMetrics(sec: SecFundamentals | null, marketCap: Num): { evEbitda: Num; fcfToEbitda: Num; netDebtToEbitda: Num } {
  const none = { evEbitda: null, fcfToEbitda: null, netDebtToEbitda: null };
  if (!sec) return none;
  const v = view(sec);
  const ebitda = ebitdaTtm(sec);
  if (!pos(ebitda)) return none;
  const debt = v.ttm('debt');
  const cash = v.ttm('cash');
  const sti = v.ttm('shortTermInvestments') ?? 0;
  const fcf = fcfOf(v.ttm('cfo'), v.ttm('capex'));
  const ev = pos(marketCap) && fin(debt) && fin(cash) ? marketCap + debt + (v.ttm('minorityInterest') ?? 0) + (v.ttm('preferredStock') ?? 0) - cash - sti : null;
  return {
    evEbitda: ev !== null && ev > 0 ? r2(ev / ebitda) : null,
    fcfToEbitda: fin(fcf) ? r2((fcf / ebitda) * 100) : null,
    netDebtToEbitda: fin(debt) && fin(cash) ? r2((debt - cash - sti - (v.ttm('longTermInvestments') ?? 0)) / ebitda) : null,
  };
}

export type CapMultiples = { pe: Num; ps: Num; pFcf: Num; pb: Num; enterpriseValue: Num };

/**
 * Multiples over market cap for a foreign issuer (plan 1.3): P/E = market cap / TTM net income, P/S over revenue, P/FCF over
 * CFO - capex, P/B over equity, EV = market cap + debt + minority interest + preferred - cash - short-term investments, every
 * amount of the USD layer. Price over EPS would mix a price per ADR with EPS per ordinary share (the ADR ratio is not in the SEC
 * data). A denominator of zero or less gives null
 */
export function capMultiples(usd: SecFundamentals | null, marketCap: Num): CapMultiples {
  const none: CapMultiples = { pe: null, ps: null, pFcf: null, pb: null, enterpriseValue: null };
  if (!usd || !pos(marketCap)) return none;
  const v = view(usd);
  const debt = v.ttm('debt');
  const cash = v.ttm('cash');
  const ev = fin(debt) && fin(cash) ? marketCap + debt + (v.ttm('minorityInterest') ?? 0) + (v.ttm('preferredStock') ?? 0) - cash - (v.ttm('shortTermInvestments') ?? 0) : null;
  return {
    pe: r2(ratio(marketCap, v.ttm('netIncome'))),
    ps: r2(ratio(marketCap, v.ttm('revenue'))),
    pFcf: r2(ratio(marketCap, fcfOf(v.ttm('cfo'), v.ttm('capex')))),
    pb: r2(ratio(marketCap, v.ttm('equity'))),
    enterpriseValue: ev === null ? null : Math.round(ev),
  };
}

/** Multiples hidden for a stale annual-only TTM (owner answer N29): price or EV over a fiscal year that ended long ago */
export const STALE_TTM_MULTIPLE_KEYS = ['pe', 'ps', 'pFcf', 'pb', 'evEbitda'];
/** An annual-only TTM (ttmIsAnnual) older than this before the last close has its multiples hidden */
export const STALE_ANNUAL_TTM_DAYS = 365;

/**
 * true for an annual-only TTM (20-F filers without quarterly XBRL) whose period ends more than 12 months before `asOf` (the last
 * close): price or EV over a year that old says little about today (a year-old annual TTM gave BP a P/E of 2119 next to Yahoo's
 * 22), so such multiples are left empty
 */
export function staleAnnualTtm(sec: SecFundamentals | null, asOf: string | null): boolean {
  const end = sec && typeof sec.ttm?.end === 'string' ? sec.ttm.end : null;
  if (!sec || !sec.ttmIsAnnual || !end || !asOf) return false;
  return (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${end}T00:00:00Z`)) / DAY > STALE_ANNUAL_TTM_DAYS;
}

/** Banks and insurers (plan 1.7): the metrics of FINANCIALS_NULL_KEYS become null, key order kept */
export function withSectorExceptions(metrics: Record<string, unknown>, industry: string | null): Record<string, unknown> {
  if (!isFinancial(industry)) return metrics;
  const out: Record<string, unknown> = {};
  Object.keys(metrics).forEach((k) => { out[k] = FINANCIALS_NULL_KEYS.indexOf(k) >= 0 ? null : metrics[k]; });
  return out;
}
