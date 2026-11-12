/// <reference lib="esnext" />
/** Texts of the signals in a given language (no DOM): one line per signal for the page, and the body of the weekly GitHub issue */
import { DICTIONARIES, format, type Locale, type Params, pick } from '../i18n';
import type { Text } from '../metrics/types';
import type { Preset } from '../screener/types';
import type { ScoreId, ScoringConfig } from '../scoring/types';
import { SIGNALS_CONFIG } from './config';
import { type Signal, SIGNAL_TYPES, type SignalsDoc, type SignalType } from './types';

const tr = (locale: Locale, key: string, params?: Params): string => format(DICTIONARIES[locale]?.[key] ?? DICTIONARIES.en[key] ?? key, params);

/** Names the texts need: preset titles by id and the scoring config (flags, archetypes, scores) */
export type SignalNames = { presets: Record<string, Text>; scoring: ScoringConfig | null };

export function signalNames(presets: Preset[], scoring: ScoringConfig | null): SignalNames {
  const out: Record<string, Text> = {};
  presets.forEach((p) => { if (p && typeof p.id === 'string' && p.title) out[p.id] = p.title; });
  return { presets: out, scoring };
}

export const signalTypeName = (type: SignalType, locale: Locale): string => tr(locale, `signals.type.${type}`);

function keyName(signal: Signal, names: SignalNames, locale: Locale): string {
  const key = String(signal.key ?? '');
  const scoring = names.scoring;
  if (signal.type === 'preset-enter' || signal.type === 'preset-exit') return names.presets[key] ? pick(names.presets[key], locale) : key;
  if (signal.type === 'flag-new' || signal.type === 'flag-removed') {
    const flag = scoring ? scoring.flags.find((f) => f.id === key) : undefined;
    return flag ? pick(flag.title, locale).replace(/\s*\{\w+\}/g, '') : key; // a title placeholder needs the row: left out here
  }
  if (signal.type === 'score') return scoring && scoring.scores[key as ScoreId] ? pick(scoring.scores[key as ScoreId].title, locale) : key;
  return key;
}

function valueName(signal: Signal, value: string | number | null, names: SignalNames, locale: Locale): string {
  if (value === null) return '-';
  if (signal.type === 'status') return tr(locale, `scoring.status.${value}`);
  if (signal.type === 'archetype') {
    const a = names.scoring ? names.scoring.archetypes[String(value)] : undefined;
    return a ? pick(a.title, locale) : String(value);
  }
  return String(value);
}

/** "entered Gold", "status Watch -> Buy zone", "Safety 52 -> 71", with "(restated past periods)" when marked */
export function signalText(signal: Signal, names: SignalNames, locale: Locale): string {
  const text = tr(locale, `signals.text.${signal.type}`, {
    name: keyName(signal, names, locale),
    from: valueName(signal, signal.from, names, locale),
    to: valueName(signal, signal.to, names, locale),
  });
  return signal.restated ? `${text} (${tr(locale, 'signals.restated')})` : text;
}

/** The distinct run dates, newest first */
export const signalDates = (doc: SignalsDoc | null): string[] => (doc ? doc.signals.map((s) => s.date).filter((d, i, all) => all.indexOf(d) === i).sort().reverse() : []);

export type SignalFilter = { date?: string; type?: string; ticker?: string };
export function filterSignals(signals: Signal[], filter: SignalFilter): Signal[] {
  const ticker = String(filter.ticker ?? '').trim().toUpperCase();
  return signals.filter((s) => (!filter.date || s.date === filter.date) && (!filter.type || s.type === filter.type) && (!ticker || s.ticker === ticker));
}

/** Link to the ticker page of the site */
export const tickerUrl = (siteUrl: string, ticker: string): string => `${siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`}#ticker=${encodeURIComponent(ticker)}`;

export const ISSUE_LINE_LIMIT = 400;

/**
 * Title and Markdown body of the weekly issue: the signals of the last `days` days (today included) grouped by type, each with a
 * link to the ticker page; count 0 means there is nothing to report. English: the issue is a notification, the page has both languages
 */
export function signalsIssue(doc: SignalsDoc | null, options: { now: Date; siteUrl: string; names: SignalNames; days?: number; limit?: number }): { title: string; body: string; count: number } {
  const days = options.days ?? SIGNALS_CONFIG.issueDays;
  const limit = options.limit ?? ISSUE_LINE_LIMIT;
  const to = options.now.toISOString().slice(0, 10);
  const from = new Date(options.now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const signals = (doc ? doc.signals : []).filter((s) => s.date >= from && s.date <= to);
  const title = `Signals for ${from} - ${to}`;
  const site = options.siteUrl.endsWith('/') ? options.siteUrl : `${options.siteUrl}/`;
  const lines: string[] = [`${signals.length} signals from ${from} to ${to}. All signals with filters: ${site}#signals`, ''];
  let shown = 0;
  SIGNAL_TYPES.forEach((type) => {
    const group = signals.filter((s) => s.type === type);
    if (!group.length) return;
    lines.push(`### ${signalTypeName(type, 'en')} (${group.length})`, '');
    group.forEach((s) => {
      if (shown >= limit) return;
      shown += 1;
      lines.push(`- ${s.date} [${s.ticker}](${tickerUrl(site, s.ticker)}) ${signalText(s, options.names, 'en')}`);
    });
    lines.push('');
  });
  if (shown < signals.length) lines.push(`${signals.length - shown} more on the site: ${site}#signals`, '');
  lines.push(`Generated by scripts/update-data.ts from api/stocks/signals.json`);
  return { title, body: `${lines.join('\n')}\n`, count: signals.length };
}
