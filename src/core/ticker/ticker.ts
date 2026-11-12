/// <reference lib="esnext" />
/**
 * Data of the ticker page (plan stage 7) from a company's meta.json and the index rows, no DOM: the three statements with
 * year-over-year changes, the long-run series for the charts and the peers table. The SEC layer (`fundamentals.sec`, arrays by
 * field, newest first) is the source; a foreign issuer can switch to its USD view (`fundamentals.usd`); a feed without the SEC
 * layer falls back to the annual rows (`fundamentals.annual`) with fewer lines
 */
import type { Text } from '../metrics';

type Json = Record<string, any>;
export type StatementId = 'income' | 'balance' | 'cashflow';
export type LineKind = 'amount' | 'perShare' | 'shares';
export type StatementLine = { key: string; label: Text; kind: LineKind };

export const STATEMENTS: Array<{ id: StatementId; title: Text; lines: StatementLine[] }> = [
  {
    id: 'income', title: { en: 'Income statement: what it earned', ru: 'Отчёт о прибылях: что заработала' }, lines: [
      { key: 'revenue', label: { en: 'Revenue', ru: 'Выручка' }, kind: 'amount' },
      { key: 'costOfRevenue', label: { en: 'Cost of revenue', ru: 'Себестоимость' }, kind: 'amount' },
      { key: 'grossProfit', label: { en: 'Gross profit', ru: 'Валовая прибыль' }, kind: 'amount' },
      { key: 'operatingIncome', label: { en: 'Operating income', ru: 'Операционная прибыль' }, kind: 'amount' },
      { key: 'interestExpense', label: { en: 'Interest expense', ru: 'Процентные расходы' }, kind: 'amount' },
      { key: 'pretaxIncome', label: { en: 'Pretax income', ru: 'Прибыль до налога' }, kind: 'amount' },
      { key: 'incomeTax', label: { en: 'Income tax', ru: 'Налог на прибыль' }, kind: 'amount' },
      { key: 'netIncome', label: { en: 'Net income', ru: 'Чистая прибыль' }, kind: 'amount' },
      { key: 'epsDiluted', label: { en: 'EPS, diluted', ru: 'EPS, разводнённая' }, kind: 'perShare' },
      { key: 'sharesDiluted', label: { en: 'Diluted shares', ru: 'Акции, разводнённые' }, kind: 'shares' },
    ],
  },
  {
    id: 'balance', title: { en: 'Balance sheet: what it owns and owes', ru: 'Баланс: что есть и что должна' }, lines: [
      { key: 'cash', label: { en: 'Cash and equivalents', ru: 'Денежные средства' }, kind: 'amount' },
      { key: 'shortTermInvestments', label: { en: 'Short-term investments', ru: 'Краткосрочные вложения' }, kind: 'amount' },
      { key: 'receivables', label: { en: 'Receivables', ru: 'Дебиторская задолженность' }, kind: 'amount' },
      { key: 'currentAssets', label: { en: 'Current assets', ru: 'Оборотные активы' }, kind: 'amount' },
      { key: 'assets', label: { en: 'Total assets', ru: 'Активы' }, kind: 'amount' },
      { key: 'currentLiabilities', label: { en: 'Current liabilities', ru: 'Краткосрочные обязательства' }, kind: 'amount' },
      { key: 'liabilities', label: { en: 'Total liabilities', ru: 'Обязательства' }, kind: 'amount' },
      { key: 'debt', label: { en: 'Debt', ru: 'Долг' }, kind: 'amount' },
      { key: 'equity', label: { en: 'Equity', ru: 'Капитал' }, kind: 'amount' },
    ],
  },
  {
    id: 'cashflow', title: { en: 'Cash flow statement: did the money arrive', ru: 'Отчёт о движении денег: пришли ли деньги' }, lines: [
      { key: 'cfo', label: { en: 'Operating cash flow', ru: 'Операционный поток' }, kind: 'amount' },
      { key: 'capex', label: { en: 'Capital expenditure', ru: 'Капзатраты (capex)' }, kind: 'amount' },
      { key: 'fcf', label: { en: 'Free cash flow', ru: 'Свободный поток' }, kind: 'amount' },
      { key: 'buybacks', label: { en: 'Buybacks', ru: 'Выкуп акций' }, kind: 'amount' },
      { key: 'dividendsPaid', label: { en: 'Dividends paid', ru: 'Выплаченные дивиденды' }, kind: 'amount' },
      { key: 'cfi', label: { en: 'Investing cash flow', ru: 'Инвестиционный поток' }, kind: 'amount' },
      { key: 'cff', label: { en: 'Financing cash flow', ru: 'Финансовый поток' }, kind: 'amount' },
    ],
  },
];

export type StatementTable = {
  source: 'sec' | 'sec-usd' | 'annual' | 'none';
  currency: string;
  /** column headers: 'TTM' first when the SEC layer has one, then fiscal year ends, newest first */
  periods: string[];
  /** true for the TTM column (it has no year-over-year change) */
  ttm: boolean[];
  values: Record<string, Array<number | null>>;
  /** change against the next older fiscal year, percent; null for TTM, the oldest year or a zero or missing base */
  yoy: Record<string, Array<number | null>>;
  /** a foreign issuer: the USD view exists */
  hasUsd: boolean;
};

const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
const ALL_KEYS = STATEMENTS.reduce((keys: string[], s) => keys.concat(s.lines.map((l) => l.key)), []);
/** annual rows of older feeds: their keys for the statement lines (capex was published negative there) */
const ANNUAL_KEYS: Record<string, string> = { revenue: 'revenue', grossProfit: 'grossProfit', operatingIncome: 'operatingIncome', netIncome: 'netIncome', epsDiluted: 'eps', cfo: 'operatingCashFlow', capex: 'capex', fcf: 'fcf', dividendsPaid: 'dividendsPaid', assets: 'assets', cash: 'cash', debt: 'debt', equity: 'equity' };

/** Year-over-year change in percent against the base's absolute value (a loss that shrinks is a positive change) */
export function yoyChange(value: number | null, base: number | null): number | null {
  if (value === null || base === null || base === 0) return null;
  return ((value - base) / Math.abs(base)) * 100;
}

/** The statements of `meta` with up to `years` fiscal years (plus TTM); `usd` picks the USD view of a foreign issuer when it exists */
export function statementTable(meta: Json | null, options: { years?: number; usd?: boolean } = {}): StatementTable {
  const years = options.years ?? 5;
  const f = meta && meta.fundamentals ? meta.fundamentals : {};
  const sec = f.sec && f.sec.fy && Array.isArray(f.sec.fy.end) ? f.sec : null;
  const hasUsd = !!(sec && sec.currency !== 'USD' && f.usd && f.usd.fy);
  const values: Record<string, Array<number | null>> = {};
  const periods: string[] = [];
  const ttm: boolean[] = [];
  let source: StatementTable['source'] = 'none';
  let currency = 'USD';
  if (sec) {
    const useUsd = hasUsd && options.usd === true;
    const fy: Json = useUsd ? f.usd.fy : sec.fy;
    const t: Json | null = useUsd ? f.usd.ttm : sec.ttm;
    source = useUsd ? 'sec-usd' : 'sec';
    currency = useUsd ? 'USD' : String(sec.currency || 'USD');
    const ends: Array<string | null> = sec.fy.end.slice(0, years);
    const withTtm = !!(t && sec.ttm && sec.ttm.end && !sec.ttmIsAnnual && sec.ttm.end !== ends[0]);
    if (withTtm) { periods.push('TTM'); ttm.push(true); }
    ends.forEach((end) => { periods.push(String(end)); ttm.push(false); });
    const pickValue = (key: string, source2: Json | null, i: number | null): number | null => {
      if (!source2) return null;
      const read = (k: string) => (i === null ? num(source2[k]) : num(Array.isArray(source2[k]) ? source2[k][i] : null));
      // share counts are not converted: read them from the reporting layer; the USD view's EPS is USD net income / diluted shares
      const own = key === 'epsDiluted' || key === 'sharesDiluted' ? (i === null ? num(sec.ttm[key]) : num(sec.fy[key] ? sec.fy[key][i] : null)) : read(key);
      if (key === 'fcf') { const cfo = read('cfo'), capex = read('capex'); return cfo !== null && capex !== null ? cfo - capex : null; }
      if (key === 'epsDiluted' && useUsd) { const ni = read('netIncome'), sh = pickValue('sharesDiluted', source2, i); return ni !== null && sh ? ni / sh : null; }
      return own;
    };
    ALL_KEYS.forEach((key) => {
      const row: Array<number | null> = [];
      if (withTtm) row.push(pickValue(key, t, null));
      ends.forEach((_, i) => row.push(pickValue(key, fy, i)));
      values[key] = row;
    });
  } else if (Array.isArray(f.annual) && f.annual.length) {
    source = 'annual';
    currency = meta && typeof meta.financialCurrency === 'string' ? meta.financialCurrency : 'USD';
    const rows: Json[] = f.annual.slice(0, years);
    rows.forEach((r) => { periods.push(String(r.end)); ttm.push(false); });
    ALL_KEYS.forEach((key) => {
      const annualKey = ANNUAL_KEYS[key];
      values[key] = rows.map((r) => {
        const v = annualKey ? num(r[annualKey]) : null;
        return key === 'capex' && v !== null ? Math.abs(v) : v;
      });
    });
  }
  const yoy: Record<string, Array<number | null>> = {};
  Object.keys(values).forEach((key) => {
    yoy[key] = values[key].map((v, i) => {
      if (ttm[i]) return null;
      const older = i + 1 < values[key].length ? values[key][i + 1] : null;
      return yoyChange(v, older);
    });
  });
  return { source, currency, periods, ttm, values, yoy, hasUsd };
}

export type ChartSeries = { key: string; label: Text; points: Array<{ period: string; value: number | null }> };

/**
 * Long-run series for the charts, oldest first, fiscal years only (10 at most): amounts (revenue, net income, operating cash
 * flow, free cash flow) and margins in percent of revenue (gross, operating, net, free cash flow)
 */
export function longRunSeries(meta: Json | null, usd = false): { currency: string; amounts: ChartSeries[]; margins: ChartSeries[] } {
  const table = statementTable(meta, { years: 10, usd });
  const idx = table.periods.map((_, i) => i).filter((i) => !table.ttm[i]).reverse();
  const series = (key: string, label: Text, value: (i: number) => number | null): ChartSeries => ({ key, label, points: idx.map((i) => ({ period: table.periods[i].slice(0, 4), value: value(i) })) });
  const v = (key: string) => (i: number) => (table.values[key] ? table.values[key][i] : null);
  const margin = (key: string) => (i: number) => { const rev = v('revenue')(i); const x = v(key)(i); return rev && x !== null && rev > 0 ? (x / rev) * 100 : null; };
  return {
    currency: table.currency,
    amounts: [
      series('revenue', { en: 'Revenue', ru: 'Выручка' }, v('revenue')),
      series('netIncome', { en: 'Net income', ru: 'Чистая прибыль' }, v('netIncome')),
      series('cfo', { en: 'Operating cash flow', ru: 'Операционный поток' }, v('cfo')),
      series('fcf', { en: 'Free cash flow', ru: 'Свободный поток' }, v('fcf')),
    ],
    margins: [
      series('grossMargin', { en: 'Gross margin', ru: 'Валовая маржа' }, margin('grossProfit')),
      series('operatingMargin', { en: 'Operating margin', ru: 'Операционная маржа' }, margin('operatingIncome')),
      series('netMargin', { en: 'Net margin', ru: 'Чистая маржа' }, margin('netIncome')),
      series('fcfMargin', { en: 'FCF margin', ru: 'Маржа FCF' }, margin('fcf')),
    ],
  };
}

/** Value range of the series with a little room, always including 0 (bars and lines of losses stay readable) */
export function chartScale(series: ChartSeries[]): { min: number; max: number } {
  let min = 0, max = 0;
  series.forEach((s) => s.points.forEach((p) => { if (p.value !== null) { min = Math.min(min, p.value); max = Math.max(max, p.value); } }));
  if (min === max) return { min: 0, max: 1 };
  const pad = (max - min) * 0.05;
  return { min: min < 0 ? min - pad : 0, max: max + pad };
}

export type PeerRow = {
  ticker: string; marketCap: number | null; revenue: number | null; netIncome: number | null; fcf: number | null;
  pe: number | null; peg: number | null; pegHist: number | null; pb: number | null; ps: number | null;
};

/**
 * One row of the peers table from an index row: market cap and the multiples as published (USD for every issuer); revenue, net
 * income and free cash flow are the published TTM amounts in USD (revenueTtm, netIncomeTtm, fcfTtm; owner answer N38). A row
 * published before them, or without an SEC layer, falls back to revenue = market cap / P/S and net income and FCF = that revenue
 * × the net and FCF margins (so a loss stays visible)
 */
export function peerRow(row: Json): PeerRow {
  const m: Json = row && row.metrics ? row.metrics : {};
  const cap = num(m.marketCap);
  const ps = num(m.ps);
  const derived = cap !== null && ps !== null && ps > 0 ? cap / ps : null;
  const part = (margin: unknown) => { const x = num(margin); return derived !== null && x !== null ? (derived * x) / 100 : null; };
  const revenue = num(m.revenueTtm) ?? derived;
  return { ticker: String(row.ticker), marketCap: cap, revenue, netIncome: num(m.netIncomeTtm) ?? part(m.netMargin), fcf: num(m.fcfTtm) ?? part(m.fcfMargin), pe: num(m.pe), peg: num(m.peg), pegHist: num(m.pegHist), pb: num(m.pb), ps };
}

/**
 * The rows the peers table compares X with: the members of X's first peer group, else the stocks of its industry by market cap
 * (at most `limit`), X first either way
 */
export function peerTickers(x: string, groups: Record<string, string[]>, rows: Json[], limit = 12): { tickers: string[]; basis: 'group' | 'industry' | 'none'; group: string | null } {
  const names = Object.keys(groups).sort().filter((name) => groups[name].indexOf(x) >= 0);
  const known: Record<string, Json> = {};
  rows.forEach((r) => { known[String(r.ticker)] = r; });
  if (names.length) {
    const members = groups[names[0]].filter((t) => t !== x && known[t]);
    return { tickers: [x].concat(members.slice(0, limit - 1)), basis: 'group', group: names[0] };
  }
  const self = known[x];
  const industry = self ? self.industry : null;
  if (!industry) return { tickers: [x], basis: 'none', group: null };
  const capOf = (r: Json) => num(r.metrics ? r.metrics.marketCap : null) ?? -1;
  const others = rows.filter((r) => r.industry === industry && r.ticker !== x).sort((a, b) => capOf(b) - capOf(a)).map((r) => String(r.ticker));
  return { tickers: [x].concat(others.slice(0, limit - 1)), basis: 'industry', group: null };
}
