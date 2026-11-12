/// <reference lib="esnext" />
/**
 * SEC XBRL companyfacts -> fiscal years, discrete quarters and TTM (screener plan 1.2, data principles of section 3).
 * Pure functions: no IO, no Bun or Node APIs.
 *
 * - forms 10-K, 10-K/A, 10-KT, 10-Q, 10-Q/A; taxonomy `us-gaap` (the `taxonomies` option is the hook for `ifrs-full`, plan 1.3)
 * - periods come from the start and end dates and the duration of each fact, never from its `fy` and `fp` (they describe the
 *   filing, not the period); the same period in several filings takes the value of the latest `filed`
 * - a fiscal year starts the day after the previous one ends, so the fiscal year starts are the starts of the 52/53-week facts
 *   and the day after their ends; a quarter end belongs to the latest fiscal start before it, its number is the elapsed quarters
 * - a discrete quarter is the 3-month fact when the filing has one, else year-to-date minus the previous year-to-date
 *   (cash flow statements are cumulative); Q4 = fiscal year minus 9 months
 * - TTM of a flow = last fiscal year + current year-to-date - the same year-to-date a year earlier; balance lines at TTM are
 *   the last quarter; per-share values the same formula on the per-share facts, share counts those of the last quarter
 * - the fiscal year label is the year of the end date (a 52/53-week year ending in the first days of January belongs to the
 *   year before); share counts and per-share values filed before a stock split are restated with the split ratio
 * - values are stored in the SEC unit of the field with scale 1 (USD, USD/shares, shares)
 */
import { HELPER_TAGS, KIND_UNITS, SEC_FIELDS, type FieldKind } from './tags';

type Json = Record<string, any>;
export type Split = { date: string; ratio: number };
export type Columns = Record<string, Array<number | string | null>>;
export type TtmValues = Record<string, number | string | null>;
export type CheckResult = { ok: boolean; diffPct: number } | null;
export type SecChecks = { balance: CheckResult; grossProfit: CheckResult; quarterSum: CheckResult };
/** The SEC layer stored in meta.json `fundamentals.sec`: arrays by field, newest period first */
export type SecFundamentals = {
  currency: string;
  units: Record<string, string>;
  fy: Columns;
  quarters: Columns;
  ttm: TtmValues;
  checks: SecChecks;
};

export const SEC_FORMS = ['10-K', '10-K/A', '10-KT', '10-Q', '10-Q/A'];
const ANNUAL = { min: 340, max: 380 };
const QUARTER = { min: 70, max: 120 };
const QUARTER_DAYS = 365.25 / 4;
export const FY_LIMIT = 10;
export const QUARTER_LIMIT = 40;
const DAY = 86_400_000;

const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const days = (from: string, to: string) => (ms(to) - ms(from)) / DAY;
const addDays = (iso: string, n: number) => new Date(ms(iso) + n * DAY).toISOString().slice(0, 10);
/** Calendar year of a period end; a year ending in the first two weeks of January belongs to the year before (JNJ 2023-01-01) */
export function fiscalYearOf(end: string): number {
  const year = Number(end.slice(0, 4));
  return end.slice(5, 7) === '01' && Number(end.slice(8, 10)) <= 14 ? year - 1 : year;
}

type Fact = { start: string | null; end: string; val: number; filed: string };
type Value = { val: number; filed: string };

/** Facts of one tag in one unit, split-restated, forms filtered; duplicates resolved later */
function tagFacts(facts: Json, taxonomies: string[], tag: string, unit: string, splits: Split[]): Fact[] {
  const out: Fact[] = [];
  for (let t = 0; t < taxonomies.length; t += 1) {
    const rows = facts?.facts?.[taxonomies[t]]?.[tag]?.units?.[unit];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (SEC_FORMS.indexOf(String(row?.form)) < 0 || typeof row?.val !== 'number' || !Number.isFinite(row.val) || !row.end) continue;
      const filed = String(row.filed ?? '');
      let val = row.val;
      if (unit === 'shares' || unit === 'USD/shares') {
        // a split after the filing date: the filing still shows the old share basis
        for (let i = 0; i < splits.length; i += 1) {
          if (splits[i].date > filed && splits[i].ratio > 0) val = unit === 'shares' ? val * splits[i].ratio : val / splits[i].ratio;
        }
      }
      out.push({ start: row.start ? String(row.start) : null, end: String(row.end), val, filed });
    }
    if (out.length) break; // the first taxonomy that has the tag wins (us-gaap before ifrs-full)
  }
  return out;
}

/** Durations: `start|end` -> value, instants: `end` -> value; per key the latest filed wins inside a tag, the first tag wins across tags */
type Series = { dur: Map<string, Value>; inst: Map<string, Value>; any: boolean };
function series(facts: Json, taxonomies: string[], tags: string[], unit: string, splits: Split[], abs = false): Series {
  const dur = new Map<string, Value>();
  const inst = new Map<string, Value>();
  let any = false;
  for (let t = 0; t < tags.length; t += 1) {
    const ownDur = new Map<string, Value>();
    const ownInst = new Map<string, Value>();
    for (const f of tagFacts(facts, taxonomies, tags[t], unit, splits)) {
      const map = f.start ? ownDur : ownInst;
      const key = f.start ? `${f.start}|${f.end}` : f.end;
      const seen = map.get(key);
      if (!seen || f.filed >= seen.filed) map.set(key, { val: abs ? Math.abs(f.val) : f.val, filed: f.filed });
    }
    if (ownDur.size || ownInst.size) any = true;
    ownDur.forEach((v, k) => { if (!dur.has(k)) dur.set(k, v); });
    ownInst.forEach((v, k) => { if (!inst.has(k)) inst.set(k, v); });
  }
  return { dur, inst, any };
}

/** Duration facts by end: [{ start, value }] */
function byEnd(s: Series): Map<string, Array<{ start: string; v: Value }>> {
  const out = new Map<string, Array<{ start: string; v: Value }>>();
  s.dur.forEach((v, key) => {
    const [start, end] = key.split('|');
    const list = out.get(end) ?? [];
    list.push({ start, v });
    out.set(end, list);
  });
  return out;
}

type Quarter = { s: string; n: number; end: string; start: string };
type FiscalYear = { s: string; end: string | null; label: number; quarters: Array<Quarter | undefined> }; // quarters[1..4]

const pick = (list: Array<{ start: string; v: Value }> | undefined, test: (start: string) => boolean): Value | null => {
  if (!list) return null;
  let best: Value | null = null;
  for (const item of list) if (test(item.start) && (!best || item.v.filed > best.filed)) best = item.v;
  return best;
};
const near = (a: string, b: string, tolerance: number) => Math.abs(days(a, b)) <= tolerance;

type FieldData = { kind: FieldKind; series: Series; ends: Map<string, Array<{ start: string; v: Value }>> };

/** Field values per period: year-to-date, discrete quarter, fiscal year, instant */
class FieldReader {
  constructor(private d: FieldData) {}
  get kind(): FieldKind { return this.d.kind; }
  /** cumulative value from the fiscal start to `end` as reported (start within 3 days of the fiscal start) */
  cumFact(fy: FiscalYear, end: string): Value | null {
    return pick(this.d.ends.get(end), (start) => near(start, fy.s, 3) && days(start, end) > 60 && days(start, end) <= ANNUAL.max);
  }
  /** a 3-month fact ending at the quarter end and starting right after the previous quarter */
  direct(q: Quarter): Value | null {
    return pick(this.d.ends.get(q.end), (start) => near(start, q.start, 10) && days(start, q.end) >= QUARTER.min && days(start, q.end) <= QUARTER.max);
  }
  /** cumulative value through quarter n (n = 0 is zero) */
  cumAt(fy: FiscalYear, n: number): Value | null {
    if (n === 0) return { val: 0, filed: '' };
    const q = fy.quarters[n];
    if (!q) return null;
    const reported = this.cumFact(fy, q.end);
    if (reported || this.d.kind !== 'flow') return reported;
    const before = this.cumAt(fy, n - 1);
    const own = this.direct(q);
    return before && own ? { val: before.val + own.val, filed: maxFiled(before.filed, own.filed) } : null;
  }
  quarter(fy: FiscalYear, n: number): Value | null {
    const q = fy.quarters[n];
    if (!q) return null;
    if (this.d.kind === 'instant') return this.d.series.inst.get(q.end) ?? null;
    const own = this.direct(q);
    if (own || this.d.kind !== 'flow') return own;
    const a = this.cumAt(fy, n);
    const b = this.cumAt(fy, n - 1);
    return a && b ? { val: a.val - b.val, filed: maxFiled(a.filed, b.filed) } : null;
  }
  year(fy: FiscalYear): Value | null {
    if (!fy.end) return null;
    if (this.d.kind === 'instant') return this.d.series.inst.get(fy.end) ?? null;
    return pick(this.d.ends.get(fy.end), (start) => near(start, fy.s, 3) && days(start, fy.end as string) >= ANNUAL.min && days(start, fy.end as string) <= ANNUAL.max);
  }
}
const maxFiled = (a: string, b: string) => (a > b ? a : b);

/** Fiscal years with their quarter ends, oldest first */
function fiscalYears(fields: FieldData[]): FiscalYear[] {
  const annual: Array<{ start: string; end: string }> = [];
  for (const f of fields) {
    if (f.kind !== 'flow') continue;
    f.series.dur.forEach((_v, key) => {
      const [start, end] = key.split('|');
      const d = days(start, end);
      if (d >= ANNUAL.min && d <= ANNUAL.max) annual.push({ start, end });
    });
  }
  const startSet: Record<string, boolean> = {};
  const endOf: Record<string, string> = {};
  for (const a of annual) { startSet[a.start] = true; startSet[addDays(a.end, 1)] = true; endOf[a.start] = a.end; }
  // two starts within a week of each other are the same fiscal year (a filer that moves its start by a day)
  const starts: string[] = [];
  Object.keys(startSet).sort().forEach((s) => { if (!starts.length || days(starts[starts.length - 1], s) > 7) starts.push(s); });
  const years: FiscalYear[] = starts.map((s) => {
    const end = endOf[s] ?? Object.keys(endOf).filter((k) => near(k, s, 7)).map((k) => endOf[k])[0] ?? null;
    return { s, end, label: fiscalYearOf(end ?? addDays(s, 364)), quarters: [] };
  });
  const yearOf = (end: string): FiscalYear | null => {
    let found: FiscalYear | null = null;
    for (const y of years) if (y.s < end) found = y;
    return found && days(found.s, end) <= ANNUAL.max ? found : null;
  };
  // quarter ends: ends of year-to-date facts and of 3-month facts, numbered by the quarters elapsed since the fiscal start
  const ends: Record<string, boolean> = {};
  for (const f of fields) {
    if (f.kind === 'instant') continue;
    f.series.dur.forEach((_v, key) => {
      const [start, end] = key.split('|');
      const d = days(start, end);
      if (d >= QUARTER.min && d <= ANNUAL.max) ends[end] = true;
    });
  }
  Object.keys(ends).sort().forEach((end) => {
    const y = yearOf(end);
    if (!y) return;
    const n = Math.round((days(y.s, end) + 1) / QUARTER_DAYS);
    if (n < 1 || n > 4 || y.quarters[n]) return;
    if (n === 4 && y.end && y.end !== end) return;
    y.quarters[n] = { s: y.s, n, end, start: '' };
  });
  for (const y of years) {
    if (y.end && !y.quarters[4]) y.quarters[4] = { s: y.s, n: 4, end: y.end, start: '' };
    for (let n = 1; n <= 4; n += 1) {
      const q = y.quarters[n];
      if (q) q.start = n === 1 ? y.s : y.quarters[n - 1] ? addDays((y.quarters[n - 1] as Quarter).end, 1) : addDays(q.end, -90);
    }
  }
  return years;
}

const round = (v: number, kind: FieldKind) => (kind === 'perShare' ? Math.round(v * 1e4) / 1e4 : Math.round(v));

function checkPct(a: number | null, b: number | null, tolerancePct = 1): CheckResult {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) return null;
  const base = Math.max(Math.abs(a), Math.abs(b));
  const diffPct = Math.round((Math.abs(a - b) / base) * 10000) / 100;
  return { ok: diffPct <= tolerancePct, diffPct };
}

export type ParseOptions = { splits?: Split[]; taxonomies?: string[] };

/** The SEC layer of one company, or null when the response has no usable facts in the taxonomies */
export function parseCompanyFacts(facts: Json, options: ParseOptions = {}): SecFundamentals | null {
  const taxonomies = options.taxonomies ?? ['us-gaap'];
  const splits = (options.splits ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (!taxonomies.some((t) => facts?.facts?.[t])) return null;
  const keys = Object.keys(SEC_FIELDS);
  const data: Record<string, FieldData> = {};
  const read = (tags: string[], kind: FieldKind, abs = false): FieldData => {
    const s = series(facts, taxonomies, tags, KIND_UNITS[kind], splits, abs);
    return { kind, series: s, ends: byEnd(s) };
  };
  for (const key of keys) data[key] = read(SEC_FIELDS[key].tags, SEC_FIELDS[key].kind, SEC_FIELDS[key].abs);
  const helper: Record<string, FieldData> = {};
  (Object.keys(HELPER_TAGS) as Array<keyof typeof HELPER_TAGS>).forEach((k) => {
    helper[k] = read(HELPER_TAGS[k], k === 'depreciation' || k === 'amortization' ? 'flow' : 'instant');
  });
  const years = fiscalYears(keys.map((k) => data[k]).filter((d) => d.kind === 'flow'));
  if (!years.length) return null;

  const readers: Record<string, FieldReader> = {};
  keys.forEach((k) => { readers[k] = new FieldReader(data[k]); });
  const helpers: Record<string, FieldReader> = {};
  Object.keys(helper).forEach((k) => { helpers[k] = new FieldReader(helper[k]); });

  /** Stored value of every field for one period; `at` reads one reader for the period */
  const period = (at: (r: FieldReader) => Value | null): { values: Record<string, number | null>; filed: string; reported: Record<string, boolean> } => {
    const values: Record<string, number | null> = {};
    const reported: Record<string, boolean> = {};
    let filed = '';
    for (const k of keys) {
      const v = k === 'debt' ? null : at(readers[k]);
      values[k] = v ? v.val : null;
      reported[k] = !!v;
      if (v && v.filed > filed) filed = v.filed;
    }
    const h = (k: string) => { const v = at(helpers[k]); return v ? v.val : null; };
    // fallbacks for lines a filer reports in parts or not at all
    if (values.grossProfit === null && values.revenue !== null && values.costOfRevenue !== null) values.grossProfit = values.revenue - values.costOfRevenue;
    if (values.da === null && h('depreciation') !== null) values.da = (h('depreciation') as number) + (h('amortization') ?? 0);
    if (values.cash === null && h('cashAndShortTerm') !== null) values.cash = (h('cashAndShortTerm') as number) - (values.shortTermInvestments ?? 0);
    if (values.liabilities === null && h('liabilitiesAndEquity') !== null) {
      const equityTotal = h('equityTotal') ?? (values.equity === null ? null : values.equity + (values.minorityInterest ?? 0));
      if (equityTotal !== null) values.liabilities = (h('liabilitiesAndEquity') as number) - equityTotal;
    }
    const combined = h('debtCombined');
    const nonCurrent = h('debtNoncurrent');
    const fallback = h('debtTotalFallback');
    const cp = h('commercialPaper');
    values.debt = combined
      ?? (nonCurrent !== null ? nonCurrent + (h('debtCurrent') ?? 0) + (cp ?? 0) : null)
      ?? (fallback !== null ? fallback + (cp ?? 0) : null);
    if (values.debt === null) {
      const parts = [h('notesPayable'), h('securedDebt'), h('lineOfCredit'), cp].filter((v): v is number => v !== null);
      if (parts.length) values.debt = parts.reduce((s, v) => s + v, 0);
    }
    for (const k of keys) if (values[k] !== null) values[k] = round(values[k] as number, SEC_FIELDS[k].kind);
    return { values, filed, reported };
  };

  const emptyColumns = (): Columns => {
    const c: Columns = { end: [], start: [], fiscalYear: [], period: [], filed: [] };
    keys.forEach((k) => { c[k] = []; });
    return c;
  };
  const push = (c: Columns, meta: { end: string; start: string; fiscalYear: number; period: string; filed: string }, values: Record<string, number | null>) => {
    c.end.push(meta.end); c.start.push(meta.start); c.fiscalYear.push(meta.fiscalYear); c.period.push(meta.period); c.filed.push(meta.filed || null);
    keys.forEach((k) => { c[k].push(values[k]); });
  };
  const hasCore = (values: Record<string, number | null>) => values.revenue !== null || values.netIncome !== null || values.cfo !== null;

  // fiscal years, newest first
  const fy = emptyColumns();
  const newestFirst = years.slice().reverse();
  for (const y of newestFirst) {
    if (!y.end || (fy.end.length >= FY_LIMIT)) continue;
    const p = period((r) => r.year(y));
    if (!hasCore(p.values)) continue;
    push(fy, { end: y.end, start: y.s, fiscalYear: y.label, period: 'FY', filed: p.filed }, p.values);
  }

  // discrete quarters, newest first
  const quarters = emptyColumns();
  const quarterPeriods: Array<{ y: FiscalYear; n: number; values: Record<string, number | null>; filed: string }> = [];
  for (const y of newestFirst) {
    for (let n = 4; n >= 1; n -= 1) {
      const q = y.quarters[n];
      if (!q || quarterPeriods.length >= QUARTER_LIMIT) continue;
      const p = period((r) => r.quarter(y, n));
      if (!hasCore(p.values)) continue;
      quarterPeriods.push({ y, n, values: p.values, filed: p.filed });
      push(quarters, { end: q.end, start: q.start, fiscalYear: y.label, period: `Q${n}`, filed: p.filed }, p.values);
    }
  }

  // TTM at the latest quarter: last fiscal year + year-to-date - the same year-to-date a year earlier; a filer without 10-Q
  // quarters after its latest 10-K (annual-only filers too) gets the fiscal year itself (basis fy)
  const ttm: TtmValues = { end: null, start: null, fiscalYear: null, period: 'TTM', basis: null, filed: null };
  keys.forEach((k) => { ttm[k] = null; });
  const latestYear = newestFirst.filter((y) => !!y.end && fy.end.indexOf(y.end) >= 0)[0];
  const latestQuarter = quarterPeriods[0];
  const latest: { y: FiscalYear; n: number } | undefined = latestYear && (!latestQuarter || (latestYear.end as string) >= (latestQuarter.y.quarters[latestQuarter.n] as Quarter).end)
    ? { y: latestYear, n: 4 }
    : latestQuarter;
  let ttmReported: Record<string, boolean> = {};
  if (latest) {
    const y = latest.y;
    const n = latest.n;
    const prev = years[years.indexOf(y) - 1];
    const prevLinked = prev && prev.end && near(addDays(prev.end, 1), y.s, 7) ? prev : null;
    const p = period((r) => {
      if (n === 4) return r.year(y);
      if (r.kind === 'instant' || r.kind === 'shares') return r.quarter(y, n) ?? r.cumFact(y, (y.quarters[n] as Quarter).end);
      if (!prevLinked) return null;
      const full = r.year(prevLinked);
      const ytd = r.cumAt(y, n);
      const ytdBefore = r.cumAt(prevLinked, n);
      return full && ytd && ytdBefore ? { val: full.val + ytd.val - ytdBefore.val, filed: maxFiled(full.filed, ytd.filed) } : null;
    });
    const q = y.quarters[n] as Quarter;
    ttm.end = q.end;
    ttm.start = addDays(q.end, -364);
    ttm.fiscalYear = y.label;
    ttm.basis = n === 4 ? 'fy' : `fy${prevLinked ? prevLinked.label : ''}+ytd-q${n}`;
    ttm.filed = p.filed || null;
    ttmReported = p.reported;
    keys.forEach((k) => { ttm[k] = p.values[k]; });
  }

  // data checks (plan 1.8), non-fatal: balance at the TTM date, gross profit, sum of quarters of the latest full fiscal year
  const at = (k: string) => (typeof ttm[k] === 'number' ? (ttm[k] as number) : null);
  const balanceReported = latest ? readers.liabilities.quarter(latest.y, latest.n) !== null : false;
  const equityTotal = at('equity') === null ? null : (at('equity') as number) + (at('minorityInterest') ?? 0);
  const balance = balanceReported && at('liabilities') !== null && equityTotal !== null ? checkPct(at('assets'), (at('liabilities') as number) + equityTotal) : null;
  const gross = ttmReported.grossProfit && ttmReported.revenue && ttmReported.costOfRevenue ? checkPct(at('grossProfit'), (at('revenue') as number) - (at('costOfRevenue') as number)) : null;
  let quarterSum: CheckResult = null;
  for (const y of newestFirst) {
    const full = readers.revenue.year(y) ?? readers.netIncome.year(y);
    if (!full) continue;
    const field = readers.revenue.year(y) ? readers.revenue : readers.netIncome;
    const parts = [1, 2, 3, 4].map((n) => field.quarter(y, n));
    if (parts.every((v) => v !== null)) quarterSum = checkPct(parts.reduce((s, v) => s + (v as Value).val, 0), full.val);
    break;
  }

  const units: Record<string, string> = {};
  keys.forEach((k) => { units[k] = KIND_UNITS[SEC_FIELDS[k].kind]; });
  return { currency: 'USD', units, fy, quarters, ttm, checks: { balance, grossProfit: gross, quarterSum } };
}

/** Field `key` of the columns as numbers (null for missing) */
export function column(c: Columns | undefined, key: string): Array<number | null> {
  const list = c && Array.isArray(c[key]) ? c[key] : [];
  return list.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
}
