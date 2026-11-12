/// <reference lib="esnext" />
/**
 * Weighted average diluted shares of every share class from one XBRL instance document (owner answer N36). companyfacts holds
 * only facts without dimensions, so an issuer that reports EPS and shares per class (Visa: class A, B-1, B-2, B-3, C) has no
 * diluted EPS and no diluted share count in it. The instance of the filing behind the TTM has them per class on
 * `us-gaap:StatementClassOfStockAxis`; the count of all classes then gives EPS = net income / shares. Pure functions, no IO
 */
import { column, type Columns, type SecFundamentals } from './companyfacts';

type Json = Record<string, any>;
export type ClassShares = { member: string; shares: number; eps: number | null };
/** Per period `start|end`: the count without dimensions (when tagged) and the per-class counts */
export type InstanceShares = Record<string, { total: number | null; classes: ClassShares[] }>;

const SHARE_TAGS = ['us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding', 'us-gaap:WeightedAverageNumberOfShareOutstandingBasicAndDiluted', 'ifrs-full:AdjustedWeightedAverageShares'];
const EPS_TAGS = ['us-gaap:EarningsPerShareDiluted', 'us-gaap:EarningsPerShareBasicAndDiluted', 'ifrs-full:DilutedEarningsLossPerShare'];
const CLASS_AXIS = 'us-gaap:StatementClassOfStockAxis';
/** Shares × EPS of one class within this share of net income: that class's count already includes the converted others */
export const AS_CONVERTED_TOLERANCE = 0.02;

type Context = { period: string | null; members: Array<{ dimension: string; member: string }> };

function contexts(xml: string): Record<string, Context> {
  const out: Record<string, Context> = {};
  const re = /<(?:[\w-]+:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?context>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[2];
    const start = /<(?:[\w-]+:)?startDate>\s*([\d-]+)\s*</.exec(body);
    const end = /<(?:[\w-]+:)?endDate>\s*([\d-]+)\s*</.exec(body);
    const members: Array<{ dimension: string; member: string }> = [];
    const mre = /<(?:[\w-]+:)?explicitMember\b[^>]*\bdimension="([^"]+)"[^>]*>\s*([^<\s]+)\s*</g;
    let mm: RegExpExecArray | null;
    while ((mm = mre.exec(body))) members.push({ dimension: mm[1], member: mm[2] });
    // a typed member (or any other segment content) makes the context unusable here
    if (/typedMember/.test(body)) members.push({ dimension: 'typed', member: 'typed' });
    out[m[1]] = { period: start && end ? `${start[1]}|${end[1]}` : null, members };
  }
  return out;
}

function facts(xml: string, tags: string[]): Array<{ context: string; value: number }> {
  const out: Array<{ context: string; value: number }> = [];
  tags.forEach((tag) => {
    const re = new RegExp(`<${tag.replace(':', '\\:')}\\b([^>]*)>\\s*([-\\d.eE+]+)\\s*<`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const ctx = /\bcontextRef="([^"]+)"/.exec(m[1]);
      const value = Number(m[2]);
      if (ctx && Number.isFinite(value)) out.push({ context: ctx[1], value });
    }
  });
  return out;
}

/** Diluted weighted shares per duration period of an instance: without dimensions as `total`, per share class in `classes` */
export function parseInstanceShares(xml: string): InstanceShares {
  const ctx = contexts(xml);
  const out: InstanceShares = {};
  const slot = (period: string) => out[period] ?? (out[period] = { total: null, classes: [] });
  const classOf = (c: Context | undefined): string | null => (c && c.members.length === 1 && c.members[0].dimension === CLASS_AXIS ? c.members[0].member : null);
  const eps: Record<string, number> = {};
  facts(xml, EPS_TAGS).forEach((f) => {
    const c = ctx[f.context];
    const member = classOf(c);
    if (c && c.period && member && !((`${c.period}#${member}`) in eps)) eps[`${c.period}#${member}`] = f.value;
  });
  facts(xml, SHARE_TAGS).forEach((f) => {
    const c = ctx[f.context];
    if (!c || !c.period || !(f.value > 0)) return;
    if (!c.members.length) { if (slot(c.period).total === null) slot(c.period).total = f.value; return; }
    const member = classOf(c);
    if (!member) return;
    const s = slot(c.period);
    if (s.classes.some((x) => x.member === member)) return;
    s.classes.push({ member, shares: f.value, eps: eps[`${c.period}#${member}`] ?? null });
  });
  return out;
}

/**
 * The diluted share count of all classes of one period: the count without dimensions when tagged; else a class whose diluted EPS
 * × count equals net income within 2% (its count is as-converted and already includes the other classes: Visa class A); else
 * the sum of the class counts. null without any count
 */
export function allClassShares(entry: { total: number | null; classes: ClassShares[] } | undefined, netIncome: number | null): number | null {
  if (!entry) return null;
  if (entry.total !== null) return entry.total;
  if (!entry.classes.length) return null;
  if (netIncome !== null && netIncome !== 0) {
    const converted = entry.classes.filter((c) => c.eps !== null && Math.abs(c.shares * (c.eps as number) - netIncome) / Math.abs(netIncome) <= AS_CONVERTED_TOLERANCE);
    if (converted.length) return Math.max(...converted.map((c) => c.shares));
  }
  return entry.classes.reduce((s, c) => s + c.shares, 0);
}

/** true when the TTM of the layer has net income but neither a diluted EPS nor a diluted share count: the instance can fill it */
export function needsClassShares(sec: SecFundamentals | null): boolean {
  if (!sec || !sec.ttm) return false;
  const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  return n(sec.ttm.netIncome) && !n(sec.ttm.epsDiluted) && !n(sec.ttm.sharesDiluted);
}

/**
 * The layer with `sharesDiluted` filled from the instance where it is null: fiscal years and quarters by their `start|end`, TTM
 * from the period it stands for (the fiscal year for basis fy, else the quarter ending at the TTM end). EPS is not filled: the
 * consumers (DCF, P/E history) take net income / shares and say so
 */
export function withClassShares(sec: SecFundamentals, shares: InstanceShares): SecFundamentals {
  const fill = (c: Columns): Columns => {
    const out: Columns = { ...c };
    const ni = column(c, 'netIncome');
    const own = column(c, 'sharesDiluted');
    out.sharesDiluted = own.map((v, i) => {
      if (v !== null) return v;
      const value = allClassShares(shares[`${c.start?.[i]}|${c.end?.[i]}`], ni[i]);
      return value === null ? null : Math.round(value);
    });
    return out;
  };
  const fy = fill(sec.fy);
  const quarters = fill(sec.quarters);
  const ttm = { ...sec.ttm };
  if (typeof ttm.sharesDiluted !== 'number') {
    const from = ttm.basis === 'fy' ? fy : quarters;
    const i = (from.end ?? []).indexOf(ttm.end as string);
    const v = i >= 0 ? column(from, 'sharesDiluted')[i] : null;
    if (v !== null) ttm.sharesDiluted = v;
  }
  return { ...sec, fy, quarters, ttm };
}

/** The diluted share counts a published layer already carries, by `start|end`: a rerun reuses them instead of a new download */
export function publishedShares(prev: SecFundamentals | null | undefined): InstanceShares {
  const out: InstanceShares = {};
  if (!prev) return out;
  [prev.fy, prev.quarters].forEach((c) => {
    if (!c) return;
    const shares = column(c, 'sharesDiluted');
    shares.forEach((v, i) => { if (v !== null) out[`${c.start?.[i]}|${c.end?.[i]}`] = { total: v, classes: [] }; });
  });
  return out;
}

/** The accession number of the latest filing (of a read form) with a net income fact ending at the TTM end: its instance holds the TTM shares */
export function ttmAccession(facts: Json, sec: SecFundamentals, forms: string[]): string | null {
  const end = sec.ttm?.end;
  let best: { accn: string; filed: string } | null = null;
  ['us-gaap', 'ifrs-full'].forEach((taxonomy) => {
    const tags = facts?.facts?.[taxonomy] ?? {};
    ['NetIncomeLoss', 'ProfitLoss', 'ProfitLossAttributableToOwnersOfParent'].forEach((tag) => {
      const units = tags[tag]?.units ?? {};
      Object.keys(units).forEach((u) => {
        (Array.isArray(units[u]) ? units[u] : []).forEach((row: Json) => {
          if (row?.end !== end || !row?.accn || forms.indexOf(String(row.form)) < 0) return;
          const filed = String(row.filed ?? '');
          if (!best || filed > best.filed) best = { accn: String(row.accn), filed };
        });
      });
    });
  });
  return best ? (best as { accn: string }).accn : null;
}

/** The XBRL instance of a filing from its EDGAR folder listing (index.json): the inline XBRL `*_htm.xml`, else the one plain instance */
export function instanceFile(listing: Json): string | null {
  const names: string[] = (listing?.directory?.item ?? []).map((x: Json) => String(x?.name ?? ''));
  const inline = names.filter((n) => /_htm\.xml$/i.test(n));
  if (inline.length) return inline[0];
  const plain = names.filter((n) => /\.xml$/i.test(n) && !/^FilingSummary\.xml$/i.test(n) && !/_(cal|def|lab|pre)\.xml$/i.test(n));
  return plain.length === 1 ? plain[0] : null;
}
