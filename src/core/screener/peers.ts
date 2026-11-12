/// <reference lib="esnext" />
/**
 * Peer groups without a backend (plan stage 6): user-data/peers.json is the starting state, the browser keeps its own copy of
 * each group it changed (a deleted group is kept as null so a repo group can be removed too), the merged groups feed the
 * engine's peers scope. The export is the whole merged file, ready to replace user-data/peers.json; it counts as exported when
 * it equals the repo file or the text of the last export. Tickers are U.S.-listed symbols (foreign companies through their ADRs)
 */
import { normalizeTicker } from './rows';
import { PeerGroups } from './types';

export const PEERS_SCHEMA_VERSION = 1;
export const PEERS_FILE_NAME = 'peers.json';
export const PEERS_REPO_PATH = `user-data/${PEERS_FILE_NAME}`;
const TICKER = /^[A-Z][A-Z0-9-]{0,9}$/;
const MAX_NAME = 60;

/** Group name -> tickers the browser changed; null: the group was deleted in the browser */
export type PeersOverlay = Record<string, string[] | null>;

export const groupName = (name: unknown): string => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
export const isPeerTicker = (ticker: string): boolean => TICKER.test(ticker);

/** Tickers normalized (upper case, dots as hyphens), invalid and repeated ones dropped, order kept */
export function cleanTickers(list: readonly unknown[]): string[] {
  const out: string[] = [];
  list.forEach((t) => { const ticker = normalizeTicker(t); if (isPeerTicker(ticker) && out.indexOf(ticker) < 0) out.push(ticker); });
  return out;
}

/** Repo groups with the browser overlay on top; names in name order (the engine also reads them in name order) */
export function mergePeers(repo: PeerGroups, overlay: PeersOverlay): PeerGroups {
  const out: PeerGroups = {};
  const names = Object.keys(repo).concat(Object.keys(overlay)).filter((n, k, all) => all.indexOf(n) === k).sort();
  names.forEach((name) => {
    const own = Object.prototype.hasOwnProperty.call(overlay, name) ? overlay[name] : undefined;
    if (own === null) return;
    const tickers = own ?? repo[name];
    if (tickers) out[name] = cleanTickers(tickers);
  });
  return out;
}

/** The file text: groups in name order, pretty JSON with a final newline (the same text for the same groups) */
export function peersFileText(groups: PeerGroups): string {
  const sorted: PeerGroups = {};
  Object.keys(groups).sort().forEach((name) => { sorted[name] = cleanTickers(groups[name]); });
  return `${JSON.stringify({ schemaVersion: PEERS_SCHEMA_VERSION, groups: sorted }, null, 2)}\n`;
}

export const peersKey = (groups: PeerGroups): string => peersFileText(groups);

/** true when the merged groups equal the repo file or the last export (`lastExported` is the peersKey of that export) */
export function peersExported(merged: PeerGroups, repo: PeerGroups, lastExported: string): boolean {
  const key = peersKey(merged);
  return key === peersKey(repo) || key === lastExported;
}

/** Group names whose browser copy differs from the repo (changed, new or deleted there) */
export function changedGroups(repo: PeerGroups, overlay: PeersOverlay): string[] {
  return Object.keys(overlay).sort().filter((name) => {
    const own = overlay[name];
    if (own === null) return !!repo[name];
    return !repo[name] || cleanTickers(repo[name]).join(',') !== cleanTickers(own).join(',');
  });
}

/**
 * A peers.json text (export or repo file): groups with valid names and tickers. Invalid tickers are dropped with an error line;
 * `known` (optional, normalized stock tickers of the feed) only adds a warning for a ticker the feed does not list
 */
export function parsePeersText(text: string, known?: readonly string[]): { groups: PeerGroups; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let data: unknown;
  try { data = JSON.parse(text); } catch (error) { return { groups: {}, errors: [`not JSON: ${error instanceof Error ? error.message : String(error)}`], warnings }; }
  const doc = data as { schemaVersion?: unknown; groups?: unknown };
  if (!doc || typeof doc !== 'object' || !doc.groups || typeof doc.groups !== 'object' || Array.isArray(doc.groups)) return { groups: {}, errors: ['peers file needs {"schemaVersion": 1, "groups": {"name": ["TICKER"]}}'], warnings };
  if (doc.schemaVersion !== PEERS_SCHEMA_VERSION) errors.push(`schemaVersion must be ${PEERS_SCHEMA_VERSION}`);
  const groups: PeerGroups = {};
  const source = doc.groups as Record<string, unknown>;
  Object.keys(source).forEach((raw) => {
    const name = groupName(raw);
    const list = source[raw];
    if (!name) { errors.push('a group has an empty name'); return; }
    if (!Array.isArray(list)) { errors.push(`${name}: the group must be a list of tickers`); return; }
    const bad = list.filter((t) => !isPeerTicker(normalizeTicker(t)));
    if (bad.length) errors.push(`${name}: not a ticker: ${bad.map(String).join(', ')}`);
    const tickers = cleanTickers(list);
    if (known) {
      const unknown = tickers.filter((t) => known.indexOf(t) < 0);
      if (unknown.length) warnings.push(`${name}: not in the stock feed: ${unknown.join(', ')}`);
    }
    groups[name] = tickers;
  });
  return { groups, errors, warnings };
}

/** The overlay after setting a group to `tickers` (a group equal to the repo copy leaves the overlay) */
export function setGroup(overlay: PeersOverlay, repo: PeerGroups, name: string, tickers: readonly unknown[]): PeersOverlay {
  const next: PeersOverlay = { ...overlay };
  const clean = cleanTickers(tickers);
  if (repo[name] && cleanTickers(repo[name]).join(',') === clean.join(',')) delete next[name];
  else next[name] = clean;
  return next;
}

/** The overlay after deleting a group: a repo group is hidden with null, a browser-only group is dropped */
export function deleteGroup(overlay: PeersOverlay, repo: PeerGroups, name: string): PeersOverlay {
  const next: PeersOverlay = { ...overlay };
  if (repo[name]) next[name] = null;
  else delete next[name];
  return next;
}

/** The overlay after an import: every imported group replaces the group of the same name */
export function importGroups(overlay: PeersOverlay, repo: PeerGroups, groups: PeerGroups): PeersOverlay {
  let next = overlay;
  Object.keys(groups).forEach((name) => { next = setGroup(next, repo, name, groups[name]); });
  return next;
}

/** Peer group names that list the ticker, in name order */
export function groupsOf(groups: PeerGroups, ticker: string): string[] {
  const t = normalizeTicker(ticker);
  return Object.keys(groups).sort().filter((name) => groups[name].indexOf(t) >= 0);
}
