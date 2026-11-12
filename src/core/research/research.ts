/// <reference lib="esnext" />
/**
 * The owner's research data of the ticker page (plan stage 7): TAM scenarios (user-data/tam/<T>.json), research notes with the
 * 9-question checklist and the dated thesis (user-data/notes/<T>.md) and the management promises tracker
 * (user-data/promises/<T>.json). They live in the browser and are exported to files with these exact names; the committed
 * files are the starting state (each folder has an index.json, the site has no directory listing). A browser copy wins and is
 * "not exported" until its text equals the repo file or the last export. No DOM
 */

export const RESEARCH_SCHEMA_VERSION = 1;
export type ResearchKind = 'tam' | 'notes' | 'promises';
export const RESEARCH_KINDS: ResearchKind[] = ['tam', 'notes', 'promises'];

/** user-data/<kind>/<T>.<json|md> */
export const researchFileName = (kind: ResearchKind, ticker: string): string => `${ticker}.${kind === 'notes' ? 'md' : 'json'}`;
export const researchRepoPath = (kind: ResearchKind, ticker: string): string => `user-data/${kind}/${researchFileName(kind, ticker)}`;

/** The text a record shows: the browser copy when there is one, else the repo file; exported = equal to the repo or to the last export */
export function recordState(repoText: string | null, browserText: string | null, lastExported: string | null): { text: string | null; source: 'browser' | 'repo' | 'none'; exported: boolean } {
  if (browserText === null) return { text: repoText, source: repoText === null ? 'none' : 'repo', exported: true };
  return { text: browserText, source: 'browser', exported: browserText === repoText || browserText === lastExported };
}

const finite = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
const isoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

// ---- TAM ----

export type TamScenario = 'low' | 'mid' | 'high';
export const TAM_SCENARIOS: TamScenario[] = ['low', 'mid', 'high'];
export type TamDoc = {
  schemaVersion: number;
  ticker: string;
  /** date of the estimate */
  asOf: string;
  /** what the market is, in words */
  market: string;
  /** market size today, USD */
  size: number | null;
  /** market growth, percent a year */
  growth: number | null;
  /** horizon of the scenarios, years */
  years: number;
  /** the company's share of the market at the horizon, percent */
  share: Record<TamScenario, number | null>;
  source: string;
};

export function emptyTam(ticker: string, today: string): TamDoc {
  return { schemaVersion: RESEARCH_SCHEMA_VERSION, ticker, asOf: today, market: '', size: null, growth: null, years: 5, share: { low: null, mid: null, high: null }, source: '' };
}

/** TAM at the horizon, the implied revenue of each scenario and its CAGR from today's revenue (null where an input is missing) */
export function tamScenarios(doc: TamDoc, revenueNow: number | null): Record<TamScenario, { revenue: number | null; cagr: number | null }> & { tamAtHorizon: number | null } {
  const tamAtHorizon = finite(doc.size) && finite(doc.growth) && doc.years > 0 ? doc.size * Math.pow(1 + doc.growth / 100, doc.years) : null;
  const one = (s: TamScenario) => {
    const share = doc.share[s];
    const revenue = tamAtHorizon !== null && finite(share) ? (tamAtHorizon * share) / 100 : null;
    const cagr = revenue !== null && finite(revenueNow) && revenueNow > 0 && revenue > 0 ? (Math.pow(revenue / revenueNow, 1 / doc.years) - 1) * 100 : null;
    return { revenue, cagr };
  };
  return { tamAtHorizon, low: one('low'), mid: one('mid'), high: one('high') };
}

export function tamFileText(doc: TamDoc): string {
  const clean: TamDoc = {
    schemaVersion: RESEARCH_SCHEMA_VERSION, ticker: doc.ticker, asOf: doc.asOf, market: doc.market, size: doc.size, growth: doc.growth, years: doc.years,
    share: { low: doc.share.low, mid: doc.share.mid, high: doc.share.high }, source: doc.source,
  };
  return `${JSON.stringify(clean, null, 2)}\n`;
}

export function parseTam(textIn: string, ticker: string): { doc: TamDoc | null; errors: string[] } {
  let data: any;
  try { data = JSON.parse(textIn); } catch (error) { return { doc: null, errors: [`not JSON: ${error instanceof Error ? error.message : String(error)}`] }; }
  const errors: string[] = [];
  if (!data || typeof data !== 'object') return { doc: null, errors: ['TAM file is not an object'] };
  if (data.schemaVersion !== RESEARCH_SCHEMA_VERSION) errors.push(`schemaVersion must be ${RESEARCH_SCHEMA_VERSION}`);
  if (data.ticker !== ticker) errors.push(`the file is for ${String(data.ticker)}, not ${ticker}`);
  const numOrNull = (v: unknown, name: string) => { if (v === null || v === undefined) return null; if (!finite(v)) { errors.push(`${name} must be a number or null`); return null; } return v; };
  const years = finite(data.years) && data.years >= 1 && data.years <= 30 && Math.floor(data.years) === data.years ? data.years : (errors.push('years must be a whole number from 1 to 30'), 5);
  const share = data.share && typeof data.share === 'object' ? data.share : {};
  const doc: TamDoc = {
    schemaVersion: RESEARCH_SCHEMA_VERSION, ticker, asOf: isoDate(data.asOf) ? data.asOf : (errors.push('asOf must be YYYY-MM-DD'), ''), market: text(data.market),
    size: numOrNull(data.size, 'size'), growth: numOrNull(data.growth, 'growth'), years,
    share: { low: numOrNull(share.low, 'share.low'), mid: numOrNull(share.mid, 'share.mid'), high: numOrNull(share.high, 'share.high') }, source: text(data.source),
  };
  return { doc: errors.length ? null : doc, errors };
}

// ---- research notes: the 9-question checklist and the dated thesis, as Markdown ----

/** The research method of the guide: nine questions, in this order (the file keeps the English text as headings) */
export const RESEARCH_QUESTIONS: Array<{ en: string; ru: string }> = [
  { en: 'What does the company sell, and who pays for it?', ru: 'Что компания продаёт и кто за это платит?' },
  { en: 'How does it make money: margins, recurring revenue, pricing power?', ru: 'Как она зарабатывает: маржи, повторяющаяся выручка, власть над ценой?' },
  { en: 'What protects it from competitors (the moat), and who are they?', ru: 'Что защищает её от конкурентов (ров) и кто они?' },
  { en: 'How large is its market, how fast does it grow, what share can it take?', ru: 'Насколько велик её рынок, как быстро он растёт, какую долю она может взять?' },
  { en: 'Is the profit backed by cash: does operating cash flow follow net income, where does free cash flow go?', ru: 'Подкреплена ли прибыль деньгами: идёт ли операционный поток за чистой прибылью, куда уходит свободный поток?' },
  { en: 'Is the balance sheet safe: debt, maturities, interest coverage?', ru: 'Надёжен ли баланс: долг, сроки погашения, покрытие процентов?' },
  { en: 'Does management allocate capital well and keep its promises?', ru: 'Хорошо ли менеджмент распределяет капитал и держит ли обещания?' },
  { en: 'What are the main risks (10-K Item 1A), and what would break the thesis?', ru: 'Каковы главные риски (10-K Item 1A) и что сломает тезис?' },
  { en: 'What is it worth (DCF, multiples against peers and its own history), and what margin of safety does the price give?', ru: 'Сколько она стоит (DCF, мультипликаторы против пиров и своей истории) и какой запас прочности даёт цена?' },
];

export type NotesDoc = { ticker: string; thesisDate: string; thesis: string; answers: string[]; notes: string };

export function emptyNotes(ticker: string): NotesDoc {
  return { ticker, thesisDate: '', thesis: '', answers: RESEARCH_QUESTIONS.map(() => ''), notes: '' };
}

const trimBlock = (s: string): string => s.replace(/^\s*\n/, '').replace(/\s+$/, '');

/** The Markdown file: title, Thesis with its date, Checklist with the nine questions as headings, free Notes */
export function notesFileText(doc: NotesDoc): string {
  const parts = [`# ${doc.ticker} research notes`, '', '## Thesis', '', `Date: ${doc.thesisDate || ''}`.trimEnd(), ''];
  if (doc.thesis.trim()) parts.push(doc.thesis.trim(), '');
  parts.push('## Checklist', '');
  RESEARCH_QUESTIONS.forEach((q, i) => {
    parts.push(`### ${i + 1}. ${q.en}`, '');
    const answer = (doc.answers[i] || '').trim();
    if (answer) parts.push(answer, '');
  });
  parts.push('## Notes', '');
  if (doc.notes.trim()) parts.push(doc.notes.trim(), '');
  return `${parts.join('\n').replace(/\n+$/, '')}\n`;
}

/** Reads a notes file back; tolerant: a missing section stays empty, the questions are matched by their number */
export function parseNotes(md: string, ticker: string): NotesDoc {
  const doc = emptyNotes(ticker);
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  let section = '';
  let question = -1;
  const buffer: Record<string, string[]> = {};
  const push = (key: string, line: string) => { (buffer[key] || (buffer[key] = [])).push(line); };
  lines.forEach((line) => {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    const h3 = /^###\s+(\d+)\./.exec(line);
    if (h3 && section === 'checklist') { question = Number(h3[1]) - 1; return; }
    if (h2 && !/^###/.test(line)) { section = h2[1].toLowerCase(); question = -1; return; }
    if (/^#\s/.test(line)) return;
    if (section === 'thesis') {
      const date = /^Date:\s*(\d{4}-\d{2}-\d{2})?\s*$/.exec(line);
      if (date && !doc.thesisDate && !(buffer.thesis || []).some((l) => l.trim())) { doc.thesisDate = date[1] || ''; return; }
      push('thesis', line);
    } else if (section === 'checklist' && question >= 0 && question < RESEARCH_QUESTIONS.length) push(`q${question}`, line);
    else if (section === 'notes') push('notes', line);
  });
  doc.thesis = trimBlock((buffer.thesis || []).join('\n'));
  doc.answers = RESEARCH_QUESTIONS.map((_, i) => trimBlock((buffer[`q${i}`] || []).join('\n')));
  doc.notes = trimBlock((buffer.notes || []).join('\n'));
  return doc;
}

export const notesFilled = (doc: NotesDoc): number => doc.answers.filter((a) => a.trim()).length;

// ---- management promises ----

export type PromiseKind = 'guidance' | 'buyback' | 'capex' | 'other';
export const PROMISE_KINDS: PromiseKind[] = ['guidance', 'buyback', 'capex', 'other'];
export type PromiseStatus = 'open' | 'kept' | 'partial' | 'missed';
export const PROMISE_STATUSES: PromiseStatus[] = ['open', 'kept', 'partial', 'missed'];
export type PromiseItem = { kind: PromiseKind; text: string; announced: string; deadline: string; amount: number | null; status: PromiseStatus };
export type PromisesDoc = { schemaVersion: number; ticker: string; items: PromiseItem[] };

export function promisesFileText(doc: PromisesDoc): string {
  const items = doc.items.map((p) => ({ kind: p.kind, text: p.text, announced: p.announced, deadline: p.deadline, amount: p.amount, status: p.status }));
  return `${JSON.stringify({ schemaVersion: RESEARCH_SCHEMA_VERSION, ticker: doc.ticker, items }, null, 2)}\n`;
}

export function parsePromises(textIn: string, ticker: string): { doc: PromisesDoc | null; errors: string[] } {
  let data: any;
  try { data = JSON.parse(textIn); } catch (error) { return { doc: null, errors: [`not JSON: ${error instanceof Error ? error.message : String(error)}`] }; }
  const errors: string[] = [];
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return { doc: null, errors: ['promises file needs {"schemaVersion": 1, "ticker": "T", "items": [...]}'] };
  if (data.schemaVersion !== RESEARCH_SCHEMA_VERSION) errors.push(`schemaVersion must be ${RESEARCH_SCHEMA_VERSION}`);
  if (data.ticker !== ticker) errors.push(`the file is for ${String(data.ticker)}, not ${ticker}`);
  const items: PromiseItem[] = [];
  data.items.forEach((p: any, i: number) => {
    const where = `item ${i + 1}`;
    if (!p || typeof p !== 'object') { errors.push(`${where} is not an object`); return; }
    if (PROMISE_KINDS.indexOf(p.kind) < 0) errors.push(`${where}: kind must be one of ${PROMISE_KINDS.join(', ')}`);
    if (PROMISE_STATUSES.indexOf(p.status) < 0) errors.push(`${where}: status must be one of ${PROMISE_STATUSES.join(', ')}`);
    if (!isoDate(p.announced)) errors.push(`${where}: announced must be YYYY-MM-DD`);
    if (p.deadline !== '' && !isoDate(p.deadline)) errors.push(`${where}: deadline must be YYYY-MM-DD or empty`);
    if (p.amount !== null && !finite(p.amount)) errors.push(`${where}: amount must be a number or null`);
    items.push({ kind: p.kind, text: text(p.text), announced: p.announced, deadline: p.deadline, amount: finite(p.amount) ? p.amount : null, status: p.status });
  });
  return { doc: errors.length ? null : { schemaVersion: RESEARCH_SCHEMA_VERSION, ticker, items }, errors };
}

type Columns = Record<string, Array<number | string | null>>;
export type PromiseProgress = {
  /** quarters counted: ended after the announcement and on or before the deadline (or the latest quarter) */
  quarters: number;
  from: string | null;
  to: string | null;
  /** USD spent on buybacks or capex in those quarters (SEC quarters, amounts paid are positive) */
  spent: number | null;
  /** spent / amount, percent */
  done: number | null;
  /** buybacks: diluted shares of the last quarter before the announcement minus the latest counted quarter (positive = retired) */
  sharesRetired: number | null;
  sharesBefore: number | null;
  sharesAfter: number | null;
};

/**
 * What the SEC quarters say about a buyback or capex promise (`quarters` of meta.json fundamentals.sec, newest first, one
 * value per quarter). Guidance and other promises have no automatic check (null values)
 */
export function promiseProgress(item: PromiseItem, quarters: Columns | null): PromiseProgress {
  const none: PromiseProgress = { quarters: 0, from: null, to: null, spent: null, done: null, sharesRetired: null, sharesBefore: null, sharesAfter: null };
  if (!quarters || !Array.isArray(quarters.end) || (item.kind !== 'buyback' && item.kind !== 'capex')) return none;
  const ends = quarters.end as Array<string | null>;
  const field = item.kind === 'buyback' ? 'buybacks' : 'capex';
  const values = (quarters[field] || []) as Array<number | null>;
  const shares = (quarters.sharesDiluted || []) as Array<number | null>;
  const inWindow: number[] = [];
  ends.forEach((end, i) => { if (typeof end === 'string' && end > item.announced && (!item.deadline || end <= item.deadline)) inWindow.push(i); });
  if (!inWindow.length) return none;
  let spent: number | null = 0;
  inWindow.forEach((i) => { const v = values[i]; spent = spent === null || !finite(v) ? null : spent + v; });
  const before = ends.findIndex((end) => typeof end === 'string' && end <= item.announced);
  const sharesBefore = before >= 0 && finite(shares[before]) ? (shares[before] as number) : null;
  const latest = inWindow[0];
  const sharesAfter = finite(shares[latest]) ? (shares[latest] as number) : null;
  const done = spent !== null && finite(item.amount) && item.amount > 0 ? ((spent as number) / item.amount) * 100 : null;
  return {
    quarters: inWindow.length, from: ends[inWindow[inWindow.length - 1]], to: ends[latest], spent, done,
    sharesRetired: item.kind === 'buyback' && sharesBefore !== null && sharesAfter !== null ? sharesBefore - sharesAfter : null,
    sharesBefore: item.kind === 'buyback' ? sharesBefore : null, sharesAfter: item.kind === 'buyback' ? sharesAfter : null,
  };
}

/** The file list of a user-data folder index.json ({ schemaVersion, files }); anything else gives an empty list */
export function indexFiles(data: unknown): string[] {
  const files = data && typeof data === 'object' ? (data as { files?: unknown }).files : null;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [];
}
