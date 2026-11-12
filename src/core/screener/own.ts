/// <reference lib="esnext" />
/**
 * Own presets without a backend (plan stage 4): one canonical JSON form for comparing, exporting and sharing, the export file
 * name that matches user-data/presets/, import with validation, a preset inside a URL hash and the merge of the repo copies
 * (user-data/presets, read by the site as the starting state) with the browser copies: on a conflict the browser copy wins and
 * is marked "not exported" until the same text is exported or lands in the repo
 */
import { Condition, Preset, PRESET_SCHEMA_VERSION } from './types';
import { validatePreset } from './validate';

/** A condition with the defaults written out and the editor-only `enabled: true` dropped, keys in schema order */
function canonicalCondition(c: Condition): Condition {
  const out: Condition = { metric: c.metric, op: c.op, value: c.value, scope: c.scope ?? 'absolute', missing: c.missing ?? 'fail' };
  if (c.enabled === false) out.enabled = false;
  if (c.help) out.help = c.help;
  return out;
}

/** The preset in schema key order (plan section 6); two presets are the same when their canonical forms are equal */
export function canonicalPreset(p: Preset): Preset {
  return {
    schemaVersion: p.schemaVersion, id: p.id, title: p.title, ...(p.description ? { description: p.description } : {}),
    appliesTo: p.appliesTo.slice(), match: p.match, ...(p.refine ? { refine: true } : {}), conditions: p.conditions.map(canonicalCondition),
  };
}

export const presetKey = (p: Preset): string => JSON.stringify(canonicalPreset(p));
export const samePreset = (a: Preset | null | undefined, b: Preset | null | undefined): boolean => !!a && !!b && presetKey(a) === presetKey(b);

/** The export file: pretty JSON with a final newline, ready to be committed as user-data/presets/<id>.json */
export const presetFileText = (p: Preset): string => `${JSON.stringify(canonicalPreset(p), null, 2)}\n`;
export const presetFileName = (p: Preset): string => `${p.id}.json`;
export const presetRepoPath = (p: Preset): string => `user-data/presets/${presetFileName(p)}`;

/** One preset or a list of presets from an imported file; every preset is validated against the schema and the registry */
export function parsePresetText(text: string): { presets: Preset[]; errors: string[] } {
  let data: unknown;
  try { data = JSON.parse(text); } catch (error) { return { presets: [], errors: [`not JSON: ${error instanceof Error ? error.message : String(error)}`] }; }
  const list: unknown[] = Array.isArray(data) ? data : [data];
  const presets: Preset[] = [];
  const errors: string[] = [];
  list.forEach((item) => {
    const preset = item as Preset;
    const problems = item && typeof item === 'object' ? validatePreset(preset) : ['preset is not an object'];
    if (problems.length) errors.push(...problems);
    else presets.push(canonicalPreset(preset));
  });
  return { presets, errors };
}

// ---- a preset inside a link: #preset=<schemaVersion>.<base64url of the canonical JSON> ----

export const HASH_KEY = 'preset';

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(data: string): string {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((data.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The hash part of a share link, without the leading # */
export const encodePresetHash = (p: Preset): string => `${HASH_KEY}=${PRESET_SCHEMA_VERSION}.${toBase64Url(JSON.stringify(canonicalPreset(p)))}`;

/** The preset of a hash (with or without #); null when the hash holds no preset, errors when it holds a broken or newer one */
export function decodePresetHash(hash: string): { preset: Preset | null; errors: string[] } {
  const match = /(?:^|[#&])preset=(\d+)\.([A-Za-z0-9_-]+)/.exec(hash || '');
  if (!match) return { preset: null, errors: [] };
  if (Number(match[1]) !== PRESET_SCHEMA_VERSION) return { preset: null, errors: [`the link holds schemaVersion ${match[1]}, this site reads ${PRESET_SCHEMA_VERSION}`] };
  let text = '';
  try { text = fromBase64Url(match[2]); } catch { return { preset: null, errors: ['the link is damaged'] }; }
  const parsed = parsePresetText(text);
  return parsed.errors.length ? { preset: null, errors: parsed.errors } : { preset: parsed.presets[0], errors: [] };
}

// ---- repo copies and browser copies ----

export type OwnEntry = {
  preset: Preset;
  /** the repo has a preset with this id (user-data/presets) */
  inRepo: boolean;
  /** false: the browser copy differs from the repo copy and from the last export */
  exported: boolean;
};

/**
 * Own presets in display order (repo order first, then presets only the browser has). The browser copy wins over the repo copy
 * of the same id; it counts as exported when it equals the repo copy or the text of its last export (`lastExported`: id -> presetKey)
 */
export function mergeOwnPresets(repo: Preset[], browser: Preset[], lastExported: Record<string, string> = {}): OwnEntry[] {
  const browserById: Record<string, Preset> = {};
  browser.forEach((p) => { browserById[p.id] = p; });
  const out: OwnEntry[] = [];
  const seen: Record<string, boolean> = {};
  const add = (preset: Preset, repoCopy: Preset | null) => {
    seen[preset.id] = true;
    const exported = samePreset(preset, repoCopy) || lastExported[preset.id] === presetKey(preset);
    out.push({ preset, inRepo: !!repoCopy, exported });
  };
  repo.forEach((p) => { if (!seen[p.id]) add(browserById[p.id] ?? p, p); });
  browser.forEach((p) => { if (!seen[p.id]) add(p, null); });
  return out;
}

/** Per condition of the draft: true when it differs from the condition at the same position of the original (or is new) */
export function changedConditions(original: Preset | null, draft: Preset): boolean[] {
  return draft.conditions.map((c, i) => {
    const before = original ? original.conditions[i] : undefined;
    return !before || JSON.stringify(canonicalCondition(before)) !== JSON.stringify(canonicalCondition(c));
  });
}

/** Lowercase letters, digits and hyphens (the preset id rule), never empty */
export function slugify(text: string): string {
  const slug = String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'preset';
}

/** base, else base-2, base-3 ... whichever is not taken */
export function uniqueId(base: string, taken: readonly string[]): string {
  const id = slugify(base);
  if (taken.indexOf(id) < 0) return id;
  for (let n = 2; ; n += 1) if (taken.indexOf(`${id}-${n}`) < 0) return `${id}-${n}`;
}

/** A copy of a preset as an own preset: new id, "(mine)" title, everything else kept */
export function ownCopy(p: Preset, taken: readonly string[]): Preset {
  const copy = canonicalPreset(JSON.parse(JSON.stringify(p)) as Preset);
  copy.id = uniqueId(`my-${p.id.replace(/^my-/, '')}`, taken);
  copy.title = { en: `${p.title.en.replace(/ \(mine\)$/, '')} (mine)`, ru: `${(p.title.ru || p.title.en).replace(/ \(моё\)$/, '')} (моё)` };
  return copy;
}
