/// <reference lib="esnext" />
/**
 * Screener panel UI: the universe switch, the combine switch, preset chips with refinements and own presets, horizon variants,
 * chip pickers (benchmark, horizon, level: benchmark plan 4.2), the condition editor with the funnel, the status line, the peer group
 * editor, preset export, import and share links.
 * The ONE core module that touches the DOM (it renders into the host's panel element and reads its inputs); everything it
 * computes comes from the UI-free core (screener engine, presets, peers) and from the host through `ScreenerUiHost`.
 * Stocks mounts it over its table (src/main.tsx); the ETFs hub takes it as a git dependency (`stocks/src/core/screener-ui`)
 * with its own rows, storage prefix and universe switch. Styles: screener.css next to this file
 */
import { getLocale as coreGetLocale, pick as corePick, t as coreT } from '../i18n';
import { groupMetrics, isNumericMetric, REGISTRY } from '../metrics';
import {
  canonicalPreset, changedConditions, changedGroups, cleanTickers, Condition as ScreenerCondition, decodePresetHash, deleteGroup, encodePresetHash, evaluateExpression,
  evaluatePreset, evaluatePresets, Expression, FunnelStep, groupName, HISTORY_METRICS, importGroups, mergeOwnPresets, mergePeers, Missing, Op, ownCopy, OwnEntry,
  parsePeersText, parsePresetText, PeerGroups, PEERS_FILE_NAME, peersExported, peersFileText, peersKey, PeersOverlay, Preset, PRESET_SCHEMA_VERSION, presetFileName,
  presetFileText, presetKey, PresetResult, RELATIVE_SCOPES, samePreset, Scope, SCOPES, setGroup, uniqueId, Universe, validatePreset, withPickers, withVariant,
} from '../screener';

export type ChipMode = 'in' | 'out';
export type TypeFilter = 'stock' | 'etf' | 'all';
export type ScreenerState = {
  type: TypeFilter;
  any: boolean; // the chosen (non-refinement) presets combine with OR instead of AND
  chips: Record<string, ChipMode>;
  drafts: Record<string, Preset>; // edited copies by preset id; Reset drops one
  expanded: string | null; // the preset whose conditions are open in the editor
  base: Preset[]; // the base presets as the screener uses them: a preset with variants resolved to its chosen horizon
  raw: Preset[]; // the base preset files as published, variants included (the chip picker reads them)
  variants: Record<string, string>; // preset id -> chosen variant id
  pickers: Record<string, Record<string, string>>; // preset id -> picker id -> chosen option id
  repoOwn: Preset[]; // user-data/presets of the repo, the starting state
  browserOwn: Preset[]; // own presets saved in this browser (they win over the repo copies)
  lastExported: Record<string, string>; // id -> presetKey of the last export or import
  peers: PeerGroups; // the merged groups the engine uses: user-data/peers.json with the browser overlay on top
  peersRepo: PeerGroups; // user-data/peers.json as committed
  peersOverlay: PeersOverlay; // groups changed or deleted (null) in this browser
  peersExported: string; // peersKey of the last peers export or import
  peersOpen: boolean; // the peer group editor is shown
  peersMessage: string;
  status: 'loading' | 'ready' | 'failed';
  error: string;
  message: string;
  version: number; // moves with every change: part of the table caches' signatures
};

/** What the page that mounts the panel provides: its rows (as an engine universe), storage, i18n, files and the table render */
export type ScreenerUiHost = {
  /** localStorage keys `<prefix>-screener`, `<prefix>-screener-variants`, `<prefix>-own-presets`, `<prefix>-peers` (Stocks: `stocks`) */
  storagePrefix: string;
  /** id of the element the panel renders into */
  panelId: string;
  /** the universe switch, e.g. ['stock', 'etf', 'all']; one entry hides the switch (Stocks ['stock'], the ETFs hub ['etf']), the first one is the default; a stored type not in the list falls back to it */
  types: TypeFilter[];
  /** folders with index.json + preset files (base and own) and the committed peers.json; an empty ownPresetsUrl or peersUrl is not fetched (an app without committed own presets or peers) */
  presetsUrl: string;
  ownPresetsUrl: string;
  peersUrl: string;
  /** an HTML line under the head row (the ETFs hub: the market state line of SPY and QQQ), rendered with the panel; empty hides it */
  headNote?: () => string;
  /** false hides the Peers button and the peer group editor (an app without peer groups, the ETFs hub); default true */
  peers?: boolean;
  /** keeps only the base presets this app can match (Stocks: presets that apply to stocks, the ETFs hub: to ETFs); default every preset */
  presetFilter?: (preset: Preset) => boolean;
  t: typeof coreT;
  pick: typeof corePick;
  getLocale: typeof coreGetLocale;
  escapeHtml: (value: unknown) => string;
  /** never throws (blocked storage): the read parses JSON and gives `fallback` on any problem */
  storageGetJson: (key: string, fallback: any) => any;
  storageSet: (key: string, value: string) => void;
  fetchJson: (url: string) => Promise<any>;
  downloadText: (text: string, fileName: string, mime: string) => void;
  copyText: (text: string) => Promise<boolean>;
  /** the scored engine universe over the host rows, in table order (a result index is a table row id); null before the rows load */
  universe: () => Universe | null;
  /** moves whenever the rows change (part of the cache signatures) */
  rowsVersion: () => number;
  rowCount: () => number;
  /** scores provider: the result of a base preset from the precomputed scores sidecar, null to evaluate it in the browser */
  snapshotResult: (universe: Universe, preset: Preset) => PresetResult | null;
  /** tickers a peer group may hold (an unknown one is kept with a warning) */
  knownTickers: () => string[];
  /** the table renders again (every screener change) */
  rerender: () => void;
  /** a universe type was chosen (only with a switch) */
  typeChosen: (type: TypeFilter) => void;
  /** extra parts of the status line after the loading text */
  statusParts: () => string[];
  /** peer groups changed: before the panel and table render (drop the scored universe) and after them (dependent views) */
  peersChanging: () => void;
  peersChanged: () => void;
  /** the panel was collapsed or expanded (by its title or the host's toolbar button): the host updates its toggle button */
  onCollapse?: (collapsed: boolean) => void;
  /** the whole panel was hidden or shown (by the host's 🔍 toolbar button or Clear): the host updates that button */
  onHide?: (hidden: boolean) => void;
};

export type ScreenerUi = ReturnType<typeof createScreenerUi>;

const DASH = '–';
const SCREENER_OPS: Op[] = ['>', '>=', '<', '<=', '=', 'range', 'in'];
const MISSING_MODES: Missing[] = ['fail', 'skip'];

/** A number typed into an input ("1,5" is 1.5), null when empty or not a number */
export function numberInput(value: string): number | null {
  const text = String(value).trim().replace(',', '.');
  const n = Number(text);
  return text === '' || !isFinite(n) ? null : n;
}

/** A finite number from a number or a "$1,234.5" / "12%" text, null otherwise (never 0 for a missing value) */
export function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '' || value.trim() === '-') return null;
  const parsed = Number(value.replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** The localStorage keys of a panel: the screener choice, the horizons, the chip pickers, the collapsed and the shown panel are settings (the host's Clear resets them), own presets and peers are data */
export function screenerStorageKeys(prefix: string): { screener: string; variants: string; pickers: string; collapsed: string; shown: string; own: string; peers: string } {
  return { screener: `${prefix}-screener`, variants: `${prefix}-screener-variants`, pickers: `${prefix}-screener-pickers`, collapsed: `${prefix}-screener-collapsed`, shown: `${prefix}-screener-shown`, own: `${prefix}-own-presets`, peers: `${prefix}-peers` };
}

export function createScreenerUi(host: ScreenerUiHost) {
  const { t, pick, getLocale, escapeHtml, fetchJson, downloadText, copyText } = host;
  const lsSet = host.storageSet;
  const lsGetJson = host.storageGetJson;
  const keys = screenerStorageKeys(host.storagePrefix);
  const SCREENER_KEY = keys.screener; // chosen preset chips, edits, the universe type (a setting: Clear resets it)
  const SCREENER_VARIANTS_KEY = keys.variants; // chosen horizon per preset with variants (a setting: Clear resets it)
  const SCREENER_PICKERS_KEY = keys.pickers; // chosen option per chip picker (a setting: Clear resets it)
  const SCREENER_COLLAPSED_KEY = keys.collapsed; // the panel shows only its head row (a setting: Clear resets it; owner 2026-11-16)
  let collapsed = lsGetJson(SCREENER_COLLAPSED_KEY, false) === true;
  const SLIDE_MS = 200; // the body slides up and down (owner 2026-11-17: "lack of animations for screener effects for slide up slide down")
  let slideToken = 0; // a newer toggle wins over a slide still running
  // the whole panel hidden by the host's 🔍 button, the title only collapses it (owner 2026-11-17: "hide panel for screener in full as we
  // click on loop icon, and if I click on screener word (panel header) it should collapse/expand slideup and slide down"); a setting, hidden by default
  let panelHidden = lsGetJson(keys.shown, false) !== true; // hidden by default (owner 2026-11-17)
  let hideToken = 0;
  let panelSliding = false;
  // a class, not the hidden attribute: the host hides the panel on its own (the hub on Watchlist and detail tabs)
  { const panel = document.getElementById(host.panelId); if (panel) panel.classList.toggle('is-hidden', panelHidden); } // no flash before the first render
  const OWN_PRESETS_KEY = keys.own; // own presets of this browser (data: Clear keeps them)
  const PEERS_KEY = keys.peers; // peer groups changed in this browser over the committed peers.json (data: Clear keeps them)
  const TYPE_FILTERS = host.types;
  const peersShown = host.peers !== false;
  const scr: ScreenerState = {
    type: TYPE_FILTERS[0], any: false, chips: {}, drafts: {}, expanded: null, base: [], raw: [], variants: {}, pickers: {}, repoOwn: [], browserOwn: [], lastExported: {}, peers: {},
    peersRepo: {}, peersOverlay: {}, peersExported: '', peersOpen: false, peersMessage: '',
    status: 'loading', error: '', message: '', version: 0,
  };
  let resultsCache: { sig: string; results: Record<string, PresetResult> } | null = null;
  let maskCache: { sig: string; mask: Uint8Array | null } | null = null;
  let presetCountCache: { sig: string; counts: Float64Array } | null = null;
  let metricOptionsHtml = '';
  let metricOptionsLocale = '';

  /** Every preset's result; a base preset unchanged since the scores sidecar takes its pass bits from there (host.snapshotResult) */
  function evaluateAllPresets(universe: Universe, presets: Preset[]): Record<string, PresetResult> {
    const out: Record<string, PresetResult> = {};
    presets.forEach(p => {
      out[p.id] = host.snapshotResult(universe, p) || evaluatePresets(universe, [p])[p.id];
    });
    return out;
  }

  function ownEntries(): OwnEntry[] {
    const baseIds = scr.base.map(p => p.id);
    return mergeOwnPresets(scr.repoOwn.filter(p => baseIds.indexOf(p.id) < 0), scr.browserOwn.filter(p => baseIds.indexOf(p.id) < 0), scr.lastExported);
  }

  function ownEntry(id: string): OwnEntry | null {
    return ownEntries().filter(entry => entry.preset.id === id)[0] || null;
  }

  /** The preset as published (base) or saved (own), without the draft */
  function originalPreset(id: string): Preset | null {
    const base = scr.base.filter(p => p.id === id)[0];
    if (base) return base;
    const own = ownEntry(id);
    return own ? own.preset : null;
  }

  function effectivePreset(id: string): Preset | null {
    return scr.drafts[id] || originalPreset(id);
  }

  function allPresets(): Preset[] {
    return scr.base.concat(ownEntries().map(entry => entry.preset)).map(p => scr.drafts[p.id] || p);
  }

  function screenerSig(): string {
    return `${host.rowsVersion()}|${scr.version}`;
  }

  function presetResults(): Record<string, PresetResult> {
    const universe = host.universe();
    if (!universe) return {};
    const sig = screenerSig();
    if (resultsCache && resultsCache.sig === sig) return resultsCache.results;
    resultsCache = { sig, results: evaluateAllPresets(universe, allPresets()) };
    return resultsCache.results;
  }

  /** 1 for a store id the chosen chips keep, null when no chip is chosen: (all of | any of the chosen) and every refinement and not each excluded */
  function screenMask(): Uint8Array | null {
    const sig = screenerSig();
    if (maskCache && maskCache.sig === sig) return maskCache.mask;
    const universe = host.universe();
    const presets: Record<string, Preset> = {};
    allPresets().forEach(p => { presets[p.id] = p; });
    const chosen = Object.keys(scr.chips).filter(id => presets[id]);
    let mask: Uint8Array | null = null;
    if (universe && chosen.length) {
      const included = chosen.filter(id => scr.chips[id] === 'in' && !presets[id].refine);
      const parts: Expression[] = chosen.filter(id => scr.chips[id] === 'in' && presets[id].refine);
      chosen.filter(id => scr.chips[id] === 'out').forEach(id => parts.push({ not: id }));
      if (included.length) parts.unshift(scr.any ? { or: included } : { and: included });
      mask = evaluateExpression(universe, { and: parts }, presets, presetResults());
    }
    maskCache = { sig, mask };
    return mask;
  }

  /** Presets a row passes, refinements left out (the Presets column) */
  function passedPresets(id: number): Preset[] {
    const results = presetResults();
    return allPresets().filter(p => !p.refine && results[p.id] && results[p.id].pass[id] === 1);
  }

  function presetCountArray(): Float64Array {
    const sig = screenerSig();
    if (presetCountCache && presetCountCache.sig === sig) return presetCountCache.counts;
    const n = host.rowCount();
    const counts = new Float64Array(n);
    const results = presetResults();
    allPresets().filter(p => !p.refine && results[p.id]).forEach(p => { const pass = results[p.id].pass; for (let i = 0; i < n; i++) counts[i] += pass[i]; });
    presetCountCache = { sig, counts };
    return counts;
  }

  function presetBadgesHtml(id: number): string {
    return passedPresets(id).map(p => `<span class="scr-badge">${escapeHtml(pick(p.title))}</span>`).join('') || DASH;
  }

  // ---- persistence: the screener choice (a setting, reset by Clear) and own presets (data, never reset by Clear) ----

  function validPresetLike(value: any): boolean {
    return !!value && typeof value === 'object' && typeof value.id === 'string' && Array.isArray(value.conditions) && Array.isArray(value.appliesTo) && !!value.title;
  }

  function persistScreener(): void {
    lsSet(SCREENER_KEY, JSON.stringify({ type: scr.type, any: scr.any, chips: scr.chips, drafts: scr.drafts, expanded: scr.expanded }));
  }

  /** The base presets with each preset of variants resolved to its chosen horizon and each preset of pickers to its chosen options (defaults when none is chosen) */
  function resolvedBase(): Preset[] {
    return scr.raw.map(p => withPickers(withVariant(p, scr.variants[p.id]), scr.pickers[p.id]));
  }

  function persistPickers(): void {
    lsSet(SCREENER_PICKERS_KEY, JSON.stringify(scr.pickers));
  }

  /** A new option on a chip picker: the chip's edits belonged to the old choice and are dropped */
  function setPicker(id: string, picker: string, option: string): void {
    const raw = scr.raw.filter(p => p.id === id)[0];
    const def = raw && Array.isArray(raw.pickers) ? raw.pickers.filter(p => p.id === picker)[0] : undefined;
    if (!def || !def.options.some(o => o.id === option)) return;
    scr.pickers[id] = { ...(scr.pickers[id] || {}), [picker]: option };
    delete scr.drafts[id];
    scr.base = resolvedBase();
    persistPickers();
    screenerChanged();
  }

  function persistVariants(): void {
    lsSet(SCREENER_VARIANTS_KEY, JSON.stringify(scr.variants));
  }

  /** A new horizon for a preset with variants: its edits belonged to the old horizon and are dropped */
  function setVariant(id: string, variant: string): void {
    const raw = scr.raw.filter(p => p.id === id)[0];
    if (!raw || !Array.isArray(raw.variants) || !raw.variants.some(v => v.id === variant)) return;
    scr.variants[id] = variant;
    delete scr.drafts[id];
    scr.base = resolvedBase();
    persistVariants();
    screenerChanged();
  }

  function restoreScreener(): void {
    const variants = lsGetJson(SCREENER_VARIANTS_KEY, null);
    if (variants && typeof variants === 'object' && !Array.isArray(variants)) Object.keys(variants).forEach(id => { if (typeof variants[id] === 'string') scr.variants[id] = variants[id]; });
    const pickers = lsGetJson(SCREENER_PICKERS_KEY, null);
    if (pickers && typeof pickers === 'object' && !Array.isArray(pickers)) Object.keys(pickers).forEach(id => {
      const chosen = pickers[id];
      if (!chosen || typeof chosen !== 'object' || Array.isArray(chosen)) return;
      const out: Record<string, string> = {};
      Object.keys(chosen).forEach(k => { if (typeof chosen[k] === 'string') out[k] = chosen[k]; });
      scr.pickers[id] = out;
    });
    const saved = lsGetJson(SCREENER_KEY, null);
    if (saved && typeof saved === 'object') {
      if (TYPE_FILTERS.indexOf(saved.type) >= 0) scr.type = saved.type;
      scr.any = saved.any === true;
      if (saved.chips && typeof saved.chips === 'object') Object.keys(saved.chips).forEach(id => { if (saved.chips[id] === 'in' || saved.chips[id] === 'out') scr.chips[id] = saved.chips[id]; });
      if (saved.drafts && typeof saved.drafts === 'object') Object.keys(saved.drafts).forEach(id => { if (validPresetLike(saved.drafts[id])) scr.drafts[id] = saved.drafts[id]; });
      scr.expanded = typeof saved.expanded === 'string' ? saved.expanded : null;
    }
    const own = lsGetJson(OWN_PRESETS_KEY, null);
    if (own && typeof own === 'object') {
      scr.browserOwn = Array.isArray(own.presets) ? own.presets.filter(validPresetLike) : [];
      scr.lastExported = own.exported && typeof own.exported === 'object' ? own.exported : {};
    }
  }

  function restorePeers(): void {
    const saved = lsGetJson(PEERS_KEY, null);
    if (!saved || typeof saved !== 'object' || !saved.overlay || typeof saved.overlay !== 'object') return;
    const overlay: PeersOverlay = {};
    Object.keys(saved.overlay).forEach(name => {
      const list = saved.overlay[name];
      if (list === null) overlay[name] = null;
      else if (Array.isArray(list) && groupName(name)) overlay[groupName(name)] = cleanTickers(list);
    });
    scr.peersOverlay = overlay;
    scr.peersExported = typeof saved.exported === 'string' ? saved.exported : '';
    scr.peers = mergePeers(scr.peersRepo, overlay);
  }

  function persistPeers(): void {
    lsSet(PEERS_KEY, JSON.stringify({ schemaVersion: 1, overlay: scr.peersOverlay, exported: scr.peersExported }));
  }

  function persistOwn(): void {
    lsSet(OWN_PRESETS_KEY, JSON.stringify({ schemaVersion: PRESET_SCHEMA_VERSION, presets: scr.browserOwn, exported: scr.lastExported }));
  }

  function resetScreener(): void {
    scr.type = TYPE_FILTERS[0];
    scr.any = false;
    scr.chips = {};
    scr.drafts = {};
    scr.expanded = null;
    scr.message = '';
    scr.version += 1;
    renderScreener();
  }

  /** Every screener change: caches move with the version, the choice is saved, panel and table render at once (synchronously) */
  function screenerChanged(message = ''): void {
    scr.version += 1;
    scr.message = message;
    persistScreener();
    renderScreener();
    host.rerender();
  }

  async function fetchPresetFolder(base: string): Promise<Preset[]> {
    const index = await fetchJson(`${base}index.json`);
    const files: string[] = index && Array.isArray(index.files) ? index.files.filter((file: unknown) => typeof file === 'string') : [];
    const loaded = await Promise.all(files.map(file => fetchJson(`${base}${encodeURIComponent(file)}`).catch((error: unknown) => {
      console.warn(`Preset ${base}${file} unavailable:`, error);
      return null;
    })));
    const out: Preset[] = [];
    loaded.forEach((preset, i) => {
      if (!preset) return;
      const problems = validatePreset(preset);
      if (problems.length) console.warn(`Preset ${base}${files[i]} skipped: ${problems.join('; ')}`);
      else out.push(preset);
    });
    return out;
  }

  const peersLabel = host.peersUrl.replace(/^\.\//, '');

  /** the committed peers.json (Stocks: user-data/peers.json), merged with this browser's overlay */
  async function loadRepoPeers(): Promise<void> {
    if (!host.peersUrl) { scr.peers = mergePeers(scr.peersRepo, scr.peersOverlay); return; }
    try {
      const parsed = parsePeersText(JSON.stringify(await fetchJson(host.peersUrl)));
      if (parsed.errors.length) console.warn(`${peersLabel}: ${parsed.errors.join('; ')}`);
      scr.peersRepo = parsed.groups;
    } catch (error) { console.warn(`${peersLabel} unavailable:`, error); }
    scr.peers = mergePeers(scr.peersRepo, scr.peersOverlay);
  }

  // ---- actions ----

  function setType(type: TypeFilter): void {
    scr.type = type;
    host.typeChosen(type);
    screenerChanged();
  }

  function toggleChip(id: string, mode: ChipMode): void {
    if (scr.chips[id] === mode) delete scr.chips[id];
    else scr.chips[id] = mode;
    const p = effectivePreset(id);
    // a preset that also selects ETFs (Gold, Mine) brings them in: the table switches from Stocks to All
    if (scr.chips[id] === 'in' && p && !p.refine && p.appliesTo.indexOf('etf') >= 0 && scr.type === 'stock' && TYPE_FILTERS.indexOf('all') >= 0) {
      scr.type = 'all';
      host.typeChosen('all');
    }
    screenerChanged();
  }

  function draftFor(id: string): Preset | null {
    const current = effectivePreset(id);
    return current ? JSON.parse(JSON.stringify(current)) : null;
  }

  function commitDraft(id: string, draft: Preset): void {
    if (samePreset(draft, originalPreset(id))) delete scr.drafts[id];
    else scr.drafts[id] = draft;
    screenerChanged();
  }

  function editCondition(id: string, index: number, edit: (c: ScreenerCondition) => void): void {
    const draft = draftFor(id);
    if (!draft || !draft.conditions[index]) return;
    edit(draft.conditions[index]);
    commitDraft(id, draft);
  }

  function resetPreset(id: string): void {
    delete scr.drafts[id];
    screenerChanged();
  }

  function takenIds(): string[] {
    return scr.base.map(p => p.id).concat(ownEntries().map(entry => entry.preset.id));
  }

  function invalidMessage(p: Preset): string {
    const problems = validatePreset(p);
    return problems.length ? t('screener.invalid', { errors: problems.join('; ') }) : '';
  }

  /** Base preset: a new own copy; own preset: its browser copy takes the draft */
  function savePreset(id: string): void {
    const current = effectivePreset(id);
    if (!current) return;
    const invalid = invalidMessage(current);
    if (invalid) { scr.message = invalid; renderScreener(); return; }
    const isBase = scr.base.some(p => p.id === id);
    const saved = isBase ? ownCopy(current, takenIds()) : canonicalPreset(current);
    scr.browserOwn = scr.browserOwn.filter(p => p.id !== saved.id).concat([saved]);
    delete scr.drafts[id];
    if (isBase) {
      if (scr.chips[id]) { scr.chips[saved.id] = scr.chips[id]; delete scr.chips[id]; }
      if (scr.expanded === id) scr.expanded = saved.id;
    }
    persistOwn();
    screenerChanged(t('screener.saved', { title: pick(saved.title) }));
  }

  function deleteOwnPreset(id: string): void {
    scr.browserOwn = scr.browserOwn.filter(p => p.id !== id);
    delete scr.drafts[id];
    delete scr.lastExported[id];
    if (!originalPreset(id)) {
      delete scr.chips[id];
      if (scr.expanded === id) scr.expanded = null;
    }
    persistOwn();
    screenerChanged();
  }

  /** Downloads the preset as <id>.json (user-data/presets/<id>.json in the repo); returns what was downloaded */
  function exportPreset(id: string): { fileName: string; text: string } | null {
    const p = effectivePreset(id);
    if (!p) return null;
    const fileName = presetFileName(p);
    const text = presetFileText(p);
    downloadText(text, fileName, 'application/json');
    scr.lastExported[id] = presetKey(p);
    persistOwn();
    screenerChanged();
    return { fileName, text };
  }

  /** Adds the presets of an exported file to My presets; the id of a base preset gets a new id, an own one is replaced */
  function importPresetText(text: string): { ids: string[]; errors: string[] } {
    const parsed = parsePresetText(text);
    const ids: string[] = [];
    parsed.presets.forEach(p => {
      const preset = scr.base.some(b => b.id === p.id) ? { ...p, id: uniqueId(p.id, takenIds()) } : p;
      scr.browserOwn = scr.browserOwn.filter(own => own.id !== preset.id).concat([preset]);
      delete scr.drafts[preset.id];
      scr.lastExported[preset.id] = presetKey(preset);
      ids.push(preset.id);
    });
    persistOwn();
    const names = ids.map(id => { const p = effectivePreset(id); return p ? pick(p.title) : id; }).join(', ');
    screenerChanged(parsed.errors.length ? t('screener.import.failed', { errors: parsed.errors.join('; ') }) : t('screener.import.done', { names }));
    return { ids, errors: parsed.errors };
  }

  function presetShareUrl(id: string): string {
    const p = effectivePreset(id);
    return p ? `${location.origin}${location.pathname}${location.search}#${encodePresetHash(p)}` : '';
  }

  /** A preset link (#preset=...) adds its preset to My presets, chooses and opens it; the hash is removed afterwards */
  function applyHashPreset(): string {
    const decoded = decodePresetHash(location.hash);
    if (!decoded.preset && !decoded.errors.length) return '';
    try { history.replaceState(null, '', `${location.pathname}${location.search}`); } catch { /* keep the hash */ }
    if (!decoded.preset) return t('screener.shareFailed', { errors: decoded.errors.join('; ') });
    let preset = decoded.preset;
    const same = allPresets().filter(p => samePreset(p, decoded.preset))[0];
    if (same) preset = same;
    else {
      if (takenIds().indexOf(preset.id) >= 0) preset = { ...preset, id: uniqueId(preset.id, takenIds()) };
      scr.browserOwn = scr.browserOwn.concat([preset]);
      persistOwn();
    }
    scr.chips[preset.id] = 'in';
    scr.expanded = preset.id;
    if (preset.appliesTo.indexOf('etf') >= 0 && scr.type === 'stock' && TYPE_FILTERS.indexOf('all') >= 0) scr.type = 'all';
    return t('screener.shared', { title: pick(preset.title) });
  }


  // ---- the screener panel: type and combine switches, chips, the editor with the funnel ----

  function metricKind(metric: string): 'number' | 'category' | 'flag' {
    const def = REGISTRY.byId[metric];
    if (!def) return 'number';
    if (def.unit === 'flag') return 'flag';
    return isNumericMetric(def) ? 'number' : 'category';
  }

  function opsFor(metric: string): Op[] {
    const kind = metricKind(metric);
    return kind === 'number' ? SCREENER_OPS : kind === 'flag' ? ['='] : ['=', 'in'];
  }

  function scopesFor(metric: string): Scope[] {
    if (metricKind(metric) !== 'number') return ['absolute'];
    return SCOPES.filter(scope => scope !== 'history' || HISTORY_METRICS.indexOf(metric) >= 0);
  }

  function opLabel(op: Op): string {
    return op === 'range' ? t('op.range') : op === 'in' ? t('op.in') : op;
  }

  function optionHtml(value: string, label: string, selected: boolean): string {
    return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }

  function valueCellHtml(c: ScreenerCondition, index: number): string {
    const relative = RELATIVE_SCOPES.indexOf(c.scope || 'absolute') >= 0;
    const num = (field: string, value: unknown, placeholder: string) => `<input type="number" step="any" class="scr-input scr-num" data-field="${field}" data-ci="${index}" value="${escapeHtml(value === null || value === undefined ? '' : String(value))}" placeholder="${escapeHtml(placeholder || (relative ? t('screener.percentile') : ''))}" aria-label="${escapeHtml(t('screener.value'))}" />`;
    if (c.op === 'in') {
      const list = Array.isArray(c.value) ? c.value : [];
      return `<div class="scr-list">${list.map((item, li) => `<span class="scr-li">${escapeHtml(String(item))}<button type="button" data-act="list-remove" data-ci="${index}" data-li="${li}" title="${escapeHtml(t('screener.list.remove'))}" aria-label="${escapeHtml(`${t('screener.list.remove')} ${String(item)}`)}">✕</button></span>`).join('')}<input type="text" class="scr-input scr-list-add" data-field="list-add" data-ci="${index}" placeholder="${escapeHtml(t('screener.list.add'))}" aria-label="${escapeHtml(t('screener.list.add'))}" /></div>`;
    }
    if (c.op === 'range') {
      const pair = Array.isArray(c.value) ? c.value : [null, null];
      return `<div class="scr-range">${num('min', pair[0], t('screener.range.min'))}<span>…</span>${num('max', pair[1], t('screener.range.max'))}</div>`;
    }
    if (metricKind(c.metric) === 'flag') return `<select class="scr-input" data-field="flag" data-ci="${index}" aria-label="${escapeHtml(t('screener.value'))}">${optionHtml('true', t('bool.true'), c.value === true)}${optionHtml('false', t('bool.false'), c.value === false)}</select>`;
    if (metricKind(c.metric) === 'category') return `<input type="text" class="scr-input" data-field="text" data-ci="${index}" value="${escapeHtml(String(c.value ?? ''))}" aria-label="${escapeHtml(t('screener.value'))}" />`;
    return num('value', typeof c.value === 'number' ? c.value : '', '');
  }

  function editorHtml(id: string): string {
    const p = effectivePreset(id);
    if (!p) return '';
    const original = originalPreset(id);
    const own = scr.base.some(b => b.id === id) ? null : ownEntry(id);
    const universe = host.universe();
    const result = universe ? evaluatePreset(universe, p) : null;
    const changed = changedConditions(original, p);
    const stepByIndex: Record<number, FunnelStep> = {};
    if (result) result.funnel.forEach(step => { stepByIndex[step.index] = step; });
    const emptyAt = result ? result.funnel.filter(step => step.left === 0)[0] : undefined;
    const m = p.conditions.length;
    const matchOptions = [optionHtml('all', t('screener.match.all'), p.match === 'all')]
      .concat(Array.from({ length: m }, (_, k) => optionHtml(String(k + 1), t('screener.match.soft', { n: k + 1, m }), p.match === k + 1)));
    const rows = p.conditions.map((c, i) => {
      const step = stepByIndex[i];
      const def = REGISTRY.byId[c.metric];
      const off = c.enabled === false;
      const funnel = off ? `<span class="scr-muted">${escapeHtml(t('screener.funnel.off'))}</span>`
        : !step ? DASH
          : `${step.status === 'unavailable' ? `<span class="scr-warn">${escapeHtml(t('screener.notInFeed'))}</span> ` : ''}<span class="scr-left${step.left === 0 ? ' is-empty' : ''}">${escapeHtml(t('screener.funnel.left', { count: step.left.toLocaleString('en-US') }))}${emptyAt === step ? ` · ${escapeHtml(t('screener.funnel.empty'))}` : ''}</span>`;
      return `<tr class="scr-cond${changed[i] ? ' is-changed' : ''}${off ? ' is-off' : ''}" data-ci="${i}">
      <td><input type="checkbox" data-field="enabled" data-ci="${i}" ${off ? '' : 'checked'} title="${escapeHtml(t('screener.enabled.tip'))}" aria-label="${escapeHtml(t('screener.enabled'))}" /></td>
      <td><input type="text" list="scr-metric-list" class="scr-input scr-metric" data-field="metric" data-ci="${i}" value="${escapeHtml(c.metric)}" placeholder="${escapeHtml(t('screener.metricSearch'))}" aria-label="${escapeHtml(t('screener.metric'))}" title="${escapeHtml(def ? `${pick(def.name)}: ${pick(def.short)}` : c.metric)}" /><div class="scr-metric-name">${escapeHtml(def ? pick(def.name) : c.metric)}</div></td>
      <td><select class="scr-input" data-field="op" data-ci="${i}" aria-label="${escapeHtml(t('screener.op'))}">${opsFor(c.metric).map(op => optionHtml(op, opLabel(op), op === c.op)).join('')}</select></td>
      <td>${valueCellHtml(c, i)}</td>
      <td><select class="scr-input" data-field="scope" data-ci="${i}" aria-label="${escapeHtml(t('screener.scope'))}">${scopesFor(c.metric).map(scope => optionHtml(scope, t(`scope.${scope}`), scope === (c.scope || 'absolute'))).join('')}</select>${c.scope === 'benchmark' ? `<input type="text" class="scr-input scr-bench" data-field="benchmark" data-ci="${i}" value="${escapeHtml(c.benchmark || '')}" placeholder="SPY" title="${escapeHtml(t('screener.benchmark.tip'))}" aria-label="${escapeHtml(t('screener.benchmark'))}" />` : ''}</td>
      <td><select class="scr-input" data-field="missing" data-ci="${i}" aria-label="${escapeHtml(t('screener.missing'))}">${MISSING_MODES.map(mode => optionHtml(mode, t(`missing.${mode}`), mode === (c.missing || 'fail'))).join('')}</select></td>
      <td class="scr-funnel" data-funnel="${i}" title="${escapeHtml(t('screener.funnel.tip'))}">${funnel}</td>
      <td><button type="button" class="scr-x" data-act="delete-cond" data-ci="${i}" title="${escapeHtml(t('screener.delete'))}" aria-label="${escapeHtml(t('screener.delete'))}">✕</button></td>
    </tr>`;
    }).join('');
    const isDraft = !!scr.drafts[id];
    const invalid = invalidMessage(p);
    const head = own
      ? `<label class="scr-title-edit">${escapeHtml(t('screener.titleLabel'))} <input type="text" class="scr-input" data-field="title" value="${escapeHtml(pick(p.title))}" /></label>`
      : `<strong>${escapeHtml(pick(p.title))}</strong>`;
    const saveButton = own
      ? (isDraft ? `<button type="button" class="dd-act" data-act="save">${escapeHtml(t('screener.save'))}</button>` : '')
      : `<button type="button" class="dd-act" data-act="save">${escapeHtml(t('screener.saveAsOwn'))}</button>`;
    return `<div class="scr-editor" data-editor="${escapeHtml(id)}">
    <div class="scr-ed-head">
      ${head}
      ${own && !own.exported ? `<span class="scr-flag" title="${escapeHtml(t('screener.notExported.tip'))}">${escapeHtml(t('screener.notExported'))}</span>` : ''}
      <label class="scr-match">${escapeHtml(t('screener.match.label'))} <select class="scr-input" data-field="match">${matchOptions.join('')}</select></label>
      <span class="scr-start" data-funnel-total title="${escapeHtml(t('screener.start.tip'))}">${escapeHtml(t('screener.start', { count: result ? result.start.toLocaleString('en-US') : DASH }))} → ${escapeHtml(t('screener.funnel.left', { count: result ? result.count.toLocaleString('en-US') : DASH }))}</span>
      <span class="scr-ed-actions">
        ${isDraft ? `<button type="button" class="dd-act" data-act="reset">${escapeHtml(t('screener.reset'))}</button>` : ''}
        ${saveButton}
        <button type="button" class="dd-act" data-act="export" title="${escapeHtml(t('screener.export.tip', { file: presetFileName(p) }))}">${escapeHtml(t('screener.export'))}</button>
        <button type="button" class="dd-act" data-act="share" title="${escapeHtml(t('screener.share.tip'))}">${escapeHtml(t('screener.share'))}</button>
        ${own && scr.browserOwn.some(b => b.id === id) ? `<button type="button" class="dd-act" data-act="delete-preset" title="${escapeHtml(t('screener.deletePreset.tip'))}">${escapeHtml(t('screener.deletePreset'))}</button>` : ''}
      </span>
    </div>
    ${p.description ? `<p class="scr-desc">${escapeHtml(pick(p.description))}</p>` : ''}
    <div class="scr-table-wrap themed-scroll"><table class="scr-conds">
      <thead><tr><th>${escapeHtml(t('screener.enabled'))}</th><th>${escapeHtml(t('screener.metric'))}</th><th>${escapeHtml(t('screener.op'))}</th><th>${escapeHtml(t('screener.value'))}</th><th>${escapeHtml(t('screener.scope'))}</th><th>${escapeHtml(t('screener.missing'))}</th><th title="${escapeHtml(t('screener.funnel.tip'))}">${escapeHtml(t('screener.funnel'))}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="scr-ed-foot"><button type="button" class="dd-act" data-act="add-cond">${escapeHtml(t('screener.addMetric'))}</button>${invalid ? `<span class="scr-error">${escapeHtml(invalid)}</span>` : ''}</div>
  </div>`;
  }

  function chipHtml(p: Preset, results: Record<string, PresetResult>, own: OwnEntry | null): string {
    const mode = scr.chips[p.id];
    const count = results[p.id] ? results[p.id].count : null;
    const title = pick(p.title);
    const tip = t('screener.chip.tip', { title, count: count === null ? DASH : count.toLocaleString('en-US') });
    const open = scr.expanded === p.id;
    const raw = scr.raw.filter(r => r.id === p.id)[0];
    const pickerCount = raw && Array.isArray(raw.pickers) ? raw.pickers.length : 0;
    return `<span class="scr-chip${mode === 'in' ? ' is-in' : mode === 'out' ? ' is-out' : ''}${open ? ' is-open' : ''}${p.refine ? ' is-refine' : ''}${pickerCount ? ` has-pickers-${Math.min(pickerCount, 3)}` : ''}" data-chip="${escapeHtml(p.id)}">`
      + `<button type="button" class="scr-chip-main" data-act="chip" data-id="${escapeHtml(p.id)}" aria-pressed="${mode === 'in'}" title="${escapeHtml(tip)}"><span class="scr-chip-title">${p.refine ? `<span class="scr-chip-and" title="${escapeHtml(t('screener.refine.tip'))}">${escapeHtml(t('screener.refine'))}</span> ` : ''}${mode === 'out' ? '¬ ' : ''}${escapeHtml(title)}</span>${scr.drafts[p.id] ? `<span class="scr-edited" title="${escapeHtml(t('screener.chip.changed'))}">*</span>` : ''}${count === null ? '' : `<span class="scr-count">${count.toLocaleString('en-US')}</span>`}${own && !own.exported ? `<span class="scr-dot" title="${escapeHtml(t('screener.notExported.tip'))}"></span>` : ''}</button>`
      + variantPicker(p)
      + `<button type="button" class="scr-chip-btn" data-act="not" data-id="${escapeHtml(p.id)}" aria-pressed="${mode === 'out'}" title="${escapeHtml(t('screener.chip.exclude'))}" aria-label="${escapeHtml(`${t('screener.chip.exclude')}: ${title}`)}">¬</button>`
      + `<button type="button" class="scr-chip-btn" data-act="expand" data-id="${escapeHtml(p.id)}" aria-expanded="${open}" title="${escapeHtml(t(open ? 'screener.chip.hideEdit' : 'screener.chip.edit'))}" aria-label="${escapeHtml(`${t(open ? 'screener.chip.hideEdit' : 'screener.chip.edit')}: ${title}`)}">${open ? '▴' : '▾'}</button></span>`;
  }

  /**
   * The horizon picker of a base preset with variants (Stable growth: 1Y, 3Y, 5Y, 10Y), or one select per picker of a base preset with
   * pickers (benchmark plan 4.2: Benchmark, Horizon, Return ...), in picker order; empty for every other chip
   */
  function variantPicker(p: Preset): string {
    const raw = scr.raw.filter(r => r.id === p.id)[0];
    if (raw && Array.isArray(raw.pickers) && raw.pickers.length) {
      const picked = p.picked || {};
      return raw.pickers.map(picker => {
        const label = `${pick(p.title)}: ${pick(picker.title)}`;
        return `<select class="scr-chip-variant scr-chip-picker" data-picker-of="${escapeHtml(p.id)}" data-picker="${escapeHtml(picker.id)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">`
          + picker.options.map(o => `<option value="${escapeHtml(o.id)}"${o.id === picked[picker.id] ? ' selected' : ''}>${escapeHtml(pick(o.title))}</option>`).join('') + `</select>`;
      }).join('');
    }
    if (!raw || !Array.isArray(raw.variants) || !raw.variants.length) return '';
    const chosen = p.variant || '';
    const label = t('screener.variant.tip', { title: pick(p.title) });
    return `<select class="scr-chip-variant" data-variant-of="${escapeHtml(p.id)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">`
      + raw.variants.map(v => `<option value="${escapeHtml(v.id)}"${v.id === chosen ? " selected" : ""}>${escapeHtml(pick(v.title))}</option>`).join('') + `</select>`;
  }

  function screenerStatusText(): string {
    const parts: string[] = [];
    if (scr.status === 'loading') parts.push(t('screener.loading')); // on the title line, not in the chips (owner 2026-11-15)
    host.statusParts().forEach(part => parts.push(part));
    if (scr.message) parts.push(scr.message);
    return parts.join(' · ');
  }

  function activeNoteText(): string {
    const ids = Object.keys(scr.chips);
    if (!ids.length) return '';
    const names = ids.map(id => {
      const p = effectivePreset(id);
      const title = p ? pick(p.title) : id;
      return scr.chips[id] === 'out' ? t('screener.notChip', { title }) : title;
    });
    return t('screener.onCount', { count: ids.length, names: names.join(', ') });
  }

  function isCollapsed(): boolean {
    return collapsed;
  }

  /** Collapses or expands the panel (never changes the filtering), saves the choice and tells the host; the body slides up or down (owner 2026-11-17) */
  function setCollapsed(value: boolean): void {
    const next = value === true;
    const body = document.getElementById('scr-body');
    const wasShown = !!body && !body.hidden;
    collapsed = next;
    lsSet(SCREENER_COLLAPSED_KEY, JSON.stringify(collapsed));
    if (host.onCollapse) host.onCollapse(collapsed);
    const token = ++slideToken;
    if (collapsed && wasShown && body && canSlide(body)) {
      // the head row follows at once, the body slides up and the panel is rendered collapsed when it is gone
      const head = document.querySelector('#' + host.panelId + ' .scr-collapse');
      if (head) { head.setAttribute('aria-expanded', 'false'); const chev = head.querySelector('.scr-chev'); if (chev) chev.textContent = '▸'; }
      slide(body, body.offsetHeight, 0).onfinish = () => { if (token === slideToken) renderScreener(); };
      return;
    }
    renderScreener();
    const shown = document.getElementById('scr-body');
    if (!collapsed && !wasShown && shown && canSlide(shown)) slide(shown, 0, shown.offsetHeight);
  }

  /** The slide of the panel body: off when the user asks for reduced motion or the browser has no Web Animations */
  function canSlide(node: HTMLElement): boolean {
    if (typeof node.animate !== 'function') return false;
    return !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function slide(node: HTMLElement, from: number, to: number): Animation {
    node.style.overflow = 'hidden';
    const anim = node.animate([{ height: from + 'px', opacity: from ? 1 : 0 }, { height: to + 'px', opacity: to ? 1 : 0 }], { duration: SLIDE_MS, easing: 'ease-in-out' });
    anim.addEventListener('finish', () => { node.style.overflow = ''; });
    return anim;
  }

  function isHidden(): boolean {
    return panelHidden;
  }

  /**
   * Hides or shows the whole panel (never changes the filtering), saves the choice and tells the host (owner 2026-11-17: "it must not be visible
   * by default, only if I click on loop it must appear and expand", "disappearing must collapse and then disappear"): showing slides the head
   * row in and then the body down, hiding slides the body up and then the head row away
   */
  function setHidden(value: boolean): void {
    const next = value === true;
    const panel = document.getElementById(host.panelId);
    panelHidden = next;
    lsSet(keys.shown, JSON.stringify(!panelHidden));
    if (host.onHide) host.onHide(panelHidden);
    const token = ++hideToken;
    if (!panel) return;
    const animated = !panel.hidden && canSlide(panel);
    if (next) {
      const body = document.getElementById('scr-body');
      const bodyOpen = !!body && !body.hidden;
      if (!animated || panel.classList.contains('is-hidden')) { panelSliding = false; panel.classList.add('is-hidden'); return; }
      panelSliding = true;
      const away = () => {
        if (token !== hideToken) return;
        slideBox(panel, true).onfinish = () => { if (token !== hideToken) return; panelSliding = false; panel.classList.add('is-hidden'); };
      };
      if (bodyOpen) { setCollapsed(true); window.setTimeout(away, SLIDE_MS + 20); } else away();
      return;
    }
    panelSliding = false;
    const wasHidden = panel.classList.contains('is-hidden');
    if (wasHidden && animated) {
      // the head row slides in first (rendered collapsed), then the body slides down
      collapsed = true;
      renderScreener();
      panel.classList.remove('is-hidden');
      slideBox(panel, false).onfinish = () => { if (token === hideToken) setCollapsed(false); };
      return;
    }
    panel.classList.remove('is-hidden');
    setCollapsed(false);
  }

  /** The slide of a whole box (the panel, the condition editor): height, paddings, borders and margins go to 0 and back, so the page below follows smoothly */
  function slideBox(panel: HTMLElement, hide: boolean): Animation {
    const cs = getComputedStyle(panel);
    const full = { height: panel.offsetHeight + 'px', paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth, marginTop: cs.marginTop, marginBottom: cs.marginBottom, opacity: '1' };
    const none = { height: '0px', paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', marginTop: '0px', marginBottom: '0px', opacity: '0' };
    panel.style.overflow = 'hidden';
    const anim = panel.animate(hide ? [full, none] : [none, full], { duration: SLIDE_MS, easing: 'ease-in-out' });
    anim.addEventListener('finish', () => { panel.style.overflow = ''; });
    return anim;
  }

  function toggleHidden(): void {
    setHidden(!panelHidden);
  }

  /** Clear of the shown panel: hidden again, as by default */
  function resetHidden(): void {
    setHidden(true);
  }

  /** The label of the host's 🔍 button: hide or show, and while hidden the presets that still filter the table */
  function hideLabel(): string {
    const note = panelHidden ? activeNoteText() : '';
    return t(panelHidden ? 'screener.show' : 'screener.hide') + (note ? ' - ' + note : '');
  }

  /**
   * ▾ on a chip opens its condition editor with a slide down, ▴ closes it with a slide up (owner 2026-11-19: "show and edit the conditions should
   * be also expandable and collapsable when I click on arrow down/up"); ▾ on another chip while one is open switches the editor without a slide
   */
  function toggleEditor(id: string): void {
    const current = document.querySelector('#' + host.panelId + ' .scr-editor[data-editor]');
    if (scr.expanded === id) {
      if (current instanceof HTMLElement && canSlide(current)) {
        const button = document.querySelector('#' + host.panelId + ' .scr-chip[data-chip="' + id + '"] [data-act="expand"]');
        if (button) { button.textContent = '▾'; button.setAttribute('aria-expanded', 'false'); }
        slideBox(current, true).onfinish = () => { if (scr.expanded === id) { scr.expanded = null; screenerChanged(); } };
        return;
      }
      scr.expanded = null;
      screenerChanged();
      return;
    }
    const wasOpen = !!current;
    scr.expanded = id;
    screenerChanged();
    const next = document.querySelector('#' + host.panelId + ' .scr-editor[data-editor]');
    if (!wasOpen && next instanceof HTMLElement && canSlide(next)) slideBox(next, false);
  }

  function toggleCollapsed(): void {
    setCollapsed(!collapsed);
  }

  /** Clear of the collapsed panel: expanded again */
  function resetCollapsed(): void {
    setCollapsed(false);
  }

  function renderScreenerStatus(): void {
    const node = document.getElementById('scr-status');
    if (node) { node.textContent = screenerStatusText(); node.setAttribute('title', node.textContent); }
    const on = document.getElementById('scr-on');
    if (on) { on.textContent = activeNoteText(); on.setAttribute('title', on.textContent); }
  }

  function metricDatalistHtml(): string {
    if (metricOptionsLocale !== getLocale()) {
      metricOptionsLocale = getLocale();
      // only metrics of the row types this panel lists (Stocks: stock metrics, the ETFs hub: ETF metrics)
      const types: string[] = TYPE_FILTERS.indexOf('all') >= 0 ? ['stock', 'etf'] : TYPE_FILTERS;
      metricOptionsHtml = groupMetrics(REGISTRY.metrics.filter(m => m.appliesTo.some(a => types.indexOf(a) >= 0))).map(group => group.metrics.filter(m => m.unit !== 'text' && m.unit !== 'date')
        .map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(`${pick(m.name)} · ${pick(group.title)}${m.source === 'planned' ? ` · ${t('guide.planned')}` : ''}`)}</option>`).join('')).join('');
    }
    return `<datalist id="scr-metric-list">${metricOptionsHtml}</datalist>`;
  }

  function renderScreener(): void {
    const panel = document.getElementById(host.panelId);
    if (!panel) return;
    const results = presetResults();
    const owns = ownEntries();
    const seg = (items: Array<{ value: string; label: string; on: boolean; act: string; tip: string }>) => `<div class="scr-seg scr-seg-${items[0] ? items[0].act : ''}" role="group">${items.map(item => `<button type="button" data-act="${item.act}" data-value="${item.value}" aria-pressed="${item.on}" title="${escapeHtml(item.tip)}">${escapeHtml(item.label)}</button>`).join('')}</div>`;
    const typeSeg = TYPE_FILTERS.length < 2 ? '' : seg(TYPE_FILTERS.map(type => ({ value: type, label: t(type === 'stock' ? 'type.stocks' : type === 'etf' ? 'type.etfs' : 'type.all'), on: scr.type === type, act: 'type', tip: t('type.tip') })));
    const combineSeg = seg([false, true].map(any => ({ value: String(any), label: t(any ? 'screener.combine.any' : 'screener.combine.all'), on: scr.any === any, act: 'any', tip: t('screener.combine.tip') })));
    const main = scr.base.filter(p => !p.refine).map(p => chipHtml(scr.drafts[p.id] || p, results, null)).join('');
    const refine = scr.base.filter(p => p.refine).map(p => chipHtml(scr.drafts[p.id] || p, results, null)).join('');
    const own = owns.map(entry => chipHtml(scr.drafts[entry.preset.id] || entry.preset, results, entry)).join('');
    const loading = scr.status === 'failed' ? `<span class="scr-error">${escapeHtml(t('screener.unavailablePresets', { error: scr.error }))}</span>` : '';
    const chosen = Object.keys(scr.chips).length;
    const note = host.headNote ? host.headNote() : '';
    const activeNote = activeNoteText();
    // language-stable layout (owner 2026-11-14): a head row of fixed-width controls, then the chips in grids of equal cells, so EN and RU wrap the same.
    // Head row (owner 2026-11-15): the buttons left, the title in the middle of the row with the status right after it, the tools right;
    // both sides are equally wide so the title stays in the center whatever the status says (below 1280 px the title line wraps under the buttons)
    panel.innerHTML = `<div class="scr-bar">
      <span class="scr-side scr-side-left">${typeSeg}${combineSeg}</span>
      <span class="scr-center"><span class="scr-center-pad"></span><button type="button" class="scr-label scr-collapse" data-act="collapse" aria-expanded="${!collapsed}" aria-controls="scr-body" title="${escapeHtml(t(collapsed ? 'screener.expand' : 'screener.collapse'))}"><span class="scr-label-text">${escapeHtml(t('screener.title'))}</span><span class="scr-chev" aria-hidden="true">${collapsed ? '▸' : '▾'}</span></button><span class="scr-after">${collapsed && activeNote ? `<span id="scr-on" class="scr-on" title="${escapeHtml(activeNote)}">${escapeHtml(activeNote)}</span>` : ''}<span id="scr-status" class="scr-muted" aria-live="polite" title="${escapeHtml(screenerStatusText())}">${escapeHtml(screenerStatusText())}</span></span></span>
      <span class="scr-side scr-tools">
        ${chosen ? `<button type="button" class="dd-act" data-act="clear" title="${escapeHtml(t('screener.clear.tip'))}">${escapeHtml(t('screener.clear'))}</button>` : ''}
        ${peersShown ? `<button type="button" class="dd-act" data-act="peers" aria-expanded="${scr.peersOpen}" title="${escapeHtml(t('peers.button.tip'))}">${escapeHtml(t('peers.button'))} (${Object.keys(scr.peers).length})${peersAreExported() ? '' : '<span class="scr-dot"></span>'}</button>` : ''}
        <label class="dd-act scr-import" title="${escapeHtml(t('screener.import.tip'))}">${escapeHtml(t('screener.import'))}<input type="file" id="scr-import-input" accept=".json,application/json" multiple hidden /></label>
      </span>
    </div>
    <div id="scr-body" class="scr-body"${collapsed ? ' hidden' : ''}>
    ${note ? `<div class="scr-note" id="scr-note">${note}</div>` : ''}
    <div class="scr-chips">${loading}${main}</div>
    ${refine ? `<div class="scr-chips scr-chips-refine">${refine}</div>` : ''}
    ${own ? `<div class="scr-chips scr-chips-sep"><span class="scr-sep" title="${escapeHtml(t('screener.own'))}">${escapeHtml(t('screener.own'))}</span>${own}</div>` : ''}
    ${!chosen && !scr.expanded && scr.status === 'ready' ? `<p class="scr-hint" title="${escapeHtml(t('screener.none'))}">${escapeHtml(t('screener.none'))}</p>` : ''}
    ${peersShown && scr.peersOpen ? peersPanelHtml() : ''}
    ${scr.expanded && effectivePreset(scr.expanded) ? editorHtml(scr.expanded) + metricDatalistHtml() : ''}
    </div>`;
    panel.classList.toggle('is-collapsed', collapsed);
    if (!panelSliding) panel.classList.toggle('is-hidden', panelHidden);
    if (panelHidden && host.onHide) host.onHide(true); // the 🔍 label names the presets that still filter
  }

  /** A condition for a newly picked metric: keeps what still fits, else a sensible default for its kind */
  function conditionForMetric(c: ScreenerCondition, metric: string): ScreenerCondition {
    const kind = metricKind(metric);
    const next: ScreenerCondition = { ...c, metric };
    if (kind === 'flag') { next.op = '='; next.value = true; next.scope = 'absolute'; delete next.benchmark; }
    else if (kind === 'category') { next.op = 'in'; next.value = []; next.scope = 'absolute'; delete next.benchmark; }
    else {
      if (opsFor(metric).indexOf(next.op) < 0 || typeof next.value === 'boolean' || (next.op !== 'in' && next.op !== 'range' && typeof next.value !== 'number')) { next.op = '>'; next.value = 0; }
      if (next.scope === 'benchmark' && (next.op === '=' || next.op === 'in')) next.op = '>';
      if (scopesFor(metric).indexOf(next.scope || 'absolute') < 0) next.scope = 'absolute';
    }
    return next;
  }

  /** The value of a condition when its operator changes: a list for in, [min, max] for range, one value otherwise */
  function valueForOp(c: ScreenerCondition, op: Op): ScreenerCondition['value'] {
    if (op === 'in') return Array.isArray(c.value) ? c.value.filter(v => v !== null) : typeof c.value === 'number' || typeof c.value === 'string' ? [c.value] : [];
    if (op === 'range') return typeof c.value === 'number' ? [c.value, null] : c.op === 'range' && Array.isArray(c.value) ? c.value : [null, null];
    if (Array.isArray(c.value)) return metricKind(c.metric) === 'number' ? (numberOrNull(c.value[0]) ?? 0) : String(c.value[0] ?? '');
    return c.value;
  }

  function onScreenerChange(event: any): void {
    const target = event.target;
    if (!target || !target.dataset) return;
    if (target.id === 'scr-import-input') { void importFiles(target.files).finally(() => { target.value = ''; }); return; }
    if (target.id === 'scr-peers-import') { void importPeersFiles(target.files).finally(() => { target.value = ''; }); return; }
    if (target.dataset.variantOf) { setVariant(String(target.dataset.variantOf), String(target.value || '')); return; }
    if (target.dataset.pickerOf) { setPicker(String(target.dataset.pickerOf), String(target.dataset.picker || ''), String(target.value || '')); return; }
    const id = scr.expanded;
    const field = target.dataset.field;
    if (!id || !field || field === 'list-add') return; // a list value is added by Enter or by leaving the input
    const index = Number(target.dataset.ci);
    const value = String(target.value ?? '');
    if (field === 'match' || field === 'title') {
      const draft = draftFor(id);
      if (!draft) return;
      if (field === 'match') draft.match = value === 'all' ? 'all' : Number(value);
      else if (value.trim()) draft.title = { en: value.trim(), ru: value.trim() };
      commitDraft(id, draft);
      return;
    }
    editCondition(id, index, c => {
      if (field === 'enabled') { if (target.checked) delete c.enabled; else c.enabled = false; }
      else if (field === 'metric') { if (REGISTRY.byId[value.trim()]) Object.assign(c, conditionForMetric(c, value.trim())); }
      else if (field === 'op') {
        const op = SCREENER_OPS.filter(item => item === value)[0];
        if (op) { c.value = valueForOp(c, op); c.op = op; }
      } else if (field === 'value') { const n = numberInput(value); if (n !== null) c.value = n; }
      else if (field === 'min' || field === 'max') {
        const pair = Array.isArray(c.value) && c.value.length === 2 ? c.value.slice() : [null, null];
        pair[field === 'min' ? 0 : 1] = numberInput(value);
        c.value = pair;
      } else if (field === 'flag') c.value = value === 'true';
      else if (field === 'text') c.value = value.trim();
      else if (field === 'scope') {
        const scope = SCOPES.filter(item => item === value)[0];
        if (scope) c.scope = scope;
        if (scope === 'benchmark' && !c.benchmark) c.benchmark = 'SPY';
        if (scope && scope !== 'benchmark') delete c.benchmark;
      } else if (field === 'benchmark') { const ticker = value.trim().toUpperCase(); if (ticker) c.benchmark = ticker; }
      else if (field === 'missing') c.missing = value === 'skip' ? 'skip' : 'fail';
    });
  }

  function addListValue(index: number, text: string): void {
    const id = scr.expanded;
    const items = text.split(',').map(item => item.trim()).filter(Boolean);
    if (!id || !items.length) return;
    editCondition(id, index, c => {
      const list = Array.isArray(c.value) ? c.value.slice() : [];
      const numeric = metricKind(c.metric) === 'number';
      items.forEach(item => {
        const value = numeric ? numberInput(item) : c.metric === 'ticker' ? item.toUpperCase() : item;
        if (value !== null && list.indexOf(value) < 0) list.push(value);
      });
      c.value = list;
    });
  }

  function onScreenerKeydown(event: any): void {
    const target = event.target;
    if (target && target.dataset && event.key === 'Enter' && (target.dataset.field === 'peer-add' || target.dataset.field === 'peer-new-name' || target.dataset.field === 'peer-new-tickers')) {
      event.preventDefault();
      if (target.dataset.field === 'peer-add') addPeerTickers(String(target.dataset.group || ''), String(target.value || ''));
      else createPeerGroupFromInputs();
      return;
    }
    if (!target || !target.dataset || target.dataset.field !== 'list-add' || event.key !== 'Enter') return;
    event.preventDefault();
    addListValue(Number(target.dataset.ci), String(target.value || ''));
  }

  function onScreenerFocusOut(event: any): void {
    const target = event.target;
    if (target && target.dataset && target.dataset.field === 'list-add' && String(target.value || '').trim()) addListValue(Number(target.dataset.ci), String(target.value));
  }

  function onScreenerClick(event: any): void {
    const button = event.target && typeof event.target.closest === 'function' ? event.target.closest('button[data-act]') : null;
    if (!button) return;
    const act = button.dataset.act;
    const id = button.dataset.id || '';
    const editing = scr.expanded;
    if (act === 'type') setType(TYPE_FILTERS.filter(type => type === button.dataset.value)[0] || TYPE_FILTERS[0]);
    else if (act === 'any') { scr.any = button.dataset.value === 'true'; screenerChanged(); }
    else if (act === 'collapse') toggleCollapsed();
    else if (act === 'chip') toggleChip(id, 'in');
    else if (act === 'not') toggleChip(id, 'out');
    else if (act === 'expand') toggleEditor(id);
    else if (act === 'clear') { scr.chips = {}; screenerChanged(); }
    else if (act === 'peers') { scr.peersOpen = !scr.peersOpen; scr.peersMessage = ''; renderScreener(); }
    else if (act === 'peer-close') { scr.peersOpen = false; renderScreener(); }
    else if (act === 'peer-remove') removePeerTicker(String(button.dataset.group || ''), String(button.dataset.ticker || ''));
    else if (act === 'peer-delete') applyPeers(deleteGroup(scr.peersOverlay, scr.peersRepo, String(button.dataset.group || '')), '');
    else if (act === 'peer-create') createPeerGroupFromInputs();
    else if (act === 'peer-export') exportPeers();
    else if (!editing) return;
    else if (act === 'reset') resetPreset(editing);
    else if (act === 'save') savePreset(editing);
    else if (act === 'export') exportPreset(editing);
    else if (act === 'share') {
      const url = presetShareUrl(editing);
      void copyText(url).then(() => { scr.message = t('screener.shareCopied', { url }); renderScreenerStatus(); });
    } else if (act === 'delete-preset') deleteOwnPreset(editing);
    else if (act === 'add-cond') {
      const draft = draftFor(editing);
      if (!draft) return;
      draft.conditions.push({ metric: 'dividendYield', op: '>', value: 0, scope: 'absolute', missing: 'fail' });
      commitDraft(editing, draft);
    } else if (act === 'delete-cond') {
      const draft = draftFor(editing);
      if (!draft) return;
      draft.conditions.splice(Number(button.dataset.ci), 1);
      if (typeof draft.match === 'number' && draft.match > draft.conditions.length) draft.match = Math.max(1, draft.conditions.length);
      commitDraft(editing, draft);
    } else if (act === 'list-remove') {
      const li = Number(button.dataset.li);
      editCondition(editing, Number(button.dataset.ci), c => { if (Array.isArray(c.value)) c.value = c.value.filter((_, k) => k !== li); });
    }
  }

  async function importFiles(files: any): Promise<void> {
    const list: any[] = files ? Array.from(files) : [];
    for (const file of list) importPresetText(await file.text());
  }

  // ---- peer groups (plan stage 6): user-data/peers.json as the starting state, the browser overlay wins, export and import ----

  function peersAreExported(): boolean {
    return peersExported(scr.peers, scr.peersRepo, scr.peersExported);
  }

  function applyPeers(overlay: PeersOverlay, message: string): void {
    scr.peersOverlay = overlay;
    scr.peers = mergePeers(scr.peersRepo, overlay);
    scr.peersMessage = message;
    persistPeers();
    host.peersChanging();
    screenerChanged();
    host.peersChanged();
  }

  function peerWarnings(tickers: string[]): string {
    const known = host.knownTickers();
    const unknown = known.length ? tickers.filter(ticker => known.indexOf(ticker) < 0) : [];
    return unknown.length ? ` · ${t('peers.warn', { warnings: unknown.join(', ') })}` : '';
  }

  function addPeerTickers(name: string, text: string): void {
    const group = groupName(name);
    const tickers = cleanTickers(text.split(/[\s,;]+/));
    if (!group || !tickers.length) return;
    const next = cleanTickers((scr.peers[group] || []).concat(tickers));
    applyPeers(setGroup(scr.peersOverlay, scr.peersRepo, group, next), `${t('peers.created', { name: group, tickers: next.join(', ') })}${peerWarnings(tickers)}`);
  }

  function removePeerTicker(name: string, ticker: string): void {
    const list = scr.peers[name];
    if (!list) return;
    applyPeers(setGroup(scr.peersOverlay, scr.peersRepo, name, list.filter(item => item !== ticker)), '');
  }

  function createPeerGroupFromInputs(): void {
    const nameInput: any = document.getElementById('scr-peer-new-name');
    const tickersInput: any = document.getElementById('scr-peer-new-tickers');
    const name = groupName(nameInput ? nameInput.value : '');
    if (!name) { scr.peersMessage = t('peers.badName'); renderScreener(); return; }
    const tickers = cleanTickers(String(tickersInput ? tickersInput.value : '').split(/[\s,;]+/));
    const next = cleanTickers((scr.peers[name] || []).concat(tickers));
    applyPeers(setGroup(scr.peersOverlay, scr.peersRepo, name, next), `${t('peers.created', { name, tickers: next.join(', ') || DASH })}${peerWarnings(tickers)}`);
  }

  /** Downloads peers.json with every merged group (user-data/peers.json in the repo); returns what was downloaded */
  function exportPeers(): { fileName: string; text: string } {
    const text = peersFileText(scr.peers);
    downloadText(text, PEERS_FILE_NAME, 'application/json');
    scr.peersExported = peersKey(scr.peers);
    persistPeers();
    screenerChanged();
    return { fileName: PEERS_FILE_NAME, text };
  }

  function importPeersText(text: string): { names: string[]; errors: string[] } {
    const parsed = parsePeersText(text, host.knownTickers());
    const names = Object.keys(parsed.groups);
    if (!names.length) {
      scr.peersMessage = t('peers.importFailed', { errors: parsed.errors.join('; ') || 'no groups' });
      renderScreener();
      return { names, errors: parsed.errors };
    }
    const overlay = importGroups(scr.peersOverlay, scr.peersRepo, parsed.groups);
    const merged = mergePeers(scr.peersRepo, overlay);
    scr.peersExported = peersKey(merged);
    const notes = parsed.errors.concat(parsed.warnings);
    applyPeers(overlay, `${t('peers.imported', { names: names.join(', ') })}${notes.length ? ` · ${t('peers.warn', { warnings: notes.join('; ') })}` : ''}`);
    return { names, errors: parsed.errors };
  }

  async function importPeersFiles(files: any): Promise<void> {
    const list: any[] = files ? Array.from(files) : [];
    for (const file of list) importPeersText(await file.text());
  }

  function peersPanelHtml(): string {
    const names = Object.keys(scr.peers).sort();
    const changed = changedGroups(scr.peersRepo, scr.peersOverlay);
    const groups = names.map(name => `<div class="peer-group" data-group="${escapeHtml(name)}">
      <strong class="peer-name">${escapeHtml(name)}</strong>${changed.indexOf(name) >= 0 ? ` <span class="scr-muted">${escapeHtml(t('peers.changed'))}</span>` : ''}
      <div class="scr-list">${scr.peers[name].map(ticker => `<span class="scr-li">${escapeHtml(ticker)}<button type="button" data-act="peer-remove" data-group="${escapeHtml(name)}" data-ticker="${escapeHtml(ticker)}" title="${escapeHtml(t('peers.remove', { ticker }))}" aria-label="${escapeHtml(t('peers.remove', { ticker }))}">✕</button></span>`).join('')}
        <input type="text" class="scr-input scr-list-add" data-field="peer-add" data-group="${escapeHtml(name)}" placeholder="${escapeHtml(t('peers.add'))}" aria-label="${escapeHtml(`${t('peers.add')}: ${name}`)}" /></div>
      <button type="button" class="dd-act" data-act="peer-delete" data-group="${escapeHtml(name)}" title="${escapeHtml(t('peers.delete.tip'))}">${escapeHtml(t('peers.delete'))}</button>
    </div>`).join('');
    return `<div class="scr-editor peer-editor" id="peer-editor">
    <div class="scr-ed-head">
      <strong>${escapeHtml(t('peers.title'))}</strong>
      ${peersAreExported() ? '' : `<span class="scr-flag" title="${escapeHtml(t('peers.notExported.tip'))}">${escapeHtml(t('screener.notExported'))}</span>`}
      <span class="scr-ed-actions">
        <button type="button" class="dd-act" data-act="peer-export" title="${escapeHtml(t('peers.export.tip'))}">${escapeHtml(t('peers.export'))}</button>
        <label class="dd-act scr-import" title="${escapeHtml(t('peers.import.tip'))}">${escapeHtml(t('peers.import'))}<input type="file" id="scr-peers-import" accept=".json,application/json" hidden /></label>
        <button type="button" class="dd-act" data-act="peer-close">${escapeHtml(t('peers.close'))}</button>
      </span>
    </div>
    ${groups || `<p class="scr-hint">${escapeHtml(t('peers.empty'))}</p>`}
    <div class="scr-ed-foot">
      <input type="text" id="scr-peer-new-name" class="scr-input" data-field="peer-new-name" placeholder="${escapeHtml(t('peers.newName'))}" aria-label="${escapeHtml(t('peers.newName'))}" />
      <input type="text" id="scr-peer-new-tickers" class="scr-input" data-field="peer-new-tickers" placeholder="${escapeHtml(t('peers.newTickers'))}" aria-label="${escapeHtml(t('peers.newTickers'))}" />
      <button type="button" class="dd-act" data-act="peer-create">${escapeHtml(t('peers.create'))}</button>
      ${scr.peersMessage ? `<span class="scr-muted" id="peer-message">${escapeHtml(scr.peersMessage)}</span>` : ''}
    </div>
  </div>`;
  }
  /** The base presets (scr.raw, scr.base, scr.status) and the committed own presets; the host applies a #preset link after it */
  async function loadPresets(): Promise<void> {
    try {
      const keep = host.presetFilter;
      scr.raw = (await fetchPresetFolder(host.presetsUrl)).filter(p => !keep || keep(p));
      scr.base = resolvedBase();
      scr.status = 'ready';
    } catch (error) {
      scr.status = 'failed';
      scr.error = error instanceof Error ? error.message : String(error);
      console.warn(`Base presets unavailable: ${scr.error}`);
    }
    if (!host.ownPresetsUrl) return;
    try { scr.repoOwn = (await fetchPresetFolder(host.ownPresetsUrl)).map(p => withPickers(withVariant(p))); } catch (error) { console.warn(`${host.ownPresetsUrl.replace(/^\.\//, '').replace(/\/$/, '')} unavailable:`, error); }
  }

  /** Clear of the chip pickers: every preset with pickers back to its defaults */
  function resetPickers(): void {
    scr.pickers = {};
    scr.base = resolvedBase();
    scr.version += 1;
    renderScreener();
  }

  /** Clear of the horizons: every preset with variants back to its default */
  function resetVariants(): void {
    scr.variants = {};
    scr.base = resolvedBase();
    scr.version += 1;
    renderScreener();
  }

  /** The panel's own listeners (clicks, changes, Enter in list inputs, leaving a list input) */
  function bindPanel(panel: HTMLElement): void {
    panel.addEventListener('click', onScreenerClick);
    panel.addEventListener('change', onScreenerChange);
    panel.addEventListener('keydown', onScreenerKeydown);
    panel.addEventListener('focusout', onScreenerFocusOut);
  }

  /** The language changed: the metric list of the editor is built again */
  function languageChanged(): void {
    metricOptionsLocale = '';
  }

  return {
    scr, render: renderScreener, renderStatus: renderScreenerStatus, bindPanel, languageChanged, restore: restoreScreener, restorePeers, reset: resetScreener, resetVariants, resetPickers,
    isCollapsed, setCollapsed, toggleCollapsed, resetCollapsed, isHidden, setHidden, toggleHidden, resetHidden, hideLabel,
    changed: screenerChanged, loadPresets, loadRepoPeers, applyHashPreset, sig: screenerSig, presetResults, screenMask, passedPresets, presetCountArray, presetBadgesHtml,
    effectivePreset, takenIds, persistOwn, applyPeers, exportPreset, importPresetText, presetShareUrl, exportPeers, importPeersText, optionHtml,
  };
}
