/// <reference types="bun" />
/// <reference types="node" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalPreset, changedConditions, decodePresetHash, encodePresetHash, ETF_BRANDS_URL, etfFeedUrl, mergeOwnPresets, ownCopy, parsePresetText,
  Preset, presetFileName, presetFileText, parseEtfBrands, presetKey, presetRepoPath, samePreset, uniqueId,
} from '.';
import { BASE_PRESET_DIR, loadPresets, PRESET_INDEX, presetFiles } from './load-presets';

const BASE = loadPresets();
const gold = BASE.filter((p) => p.id === 'gold')[0];
const own = (id: string, value = 1): Preset => ({ schemaVersion: 1, id, title: { en: 'Mine', ru: 'Моё' }, appliesTo: ['stock'], match: 'all', conditions: [{ metric: 'pe', op: '<', value }] });

describe('preset files', () => {
  test('each index.json lists exactly the preset files of its folder (the browser has no directory listing)', () => {
    const userDir = join(__dirname, '..', '..', '..', 'user-data', 'presets');
    [BASE_PRESET_DIR, userDir].forEach((dir) => {
      const index = JSON.parse(readFileSync(join(dir, PRESET_INDEX), 'utf8'));
      expect(index.schemaVersion).toBe(1);
      expect(index.files).toEqual(presetFiles(dir));
    });
    expect(presetFiles(BASE_PRESET_DIR)).not.toContain(PRESET_INDEX);
    expect(loadPresets(userDir).flatMap((p) => parsePresetText(JSON.stringify(p)).errors)).toEqual([]);
  });

  test('export then import gives the same preset; broken files are rejected with the reason', () => {
    const edited: Preset = { ...gold, conditions: gold.conditions.map((c, i) => (i === 1 ? { ...c, value: ['GLD', 'IAU'], enabled: true } : c)) };
    const text = presetFileText(edited);
    expect(text.endsWith('}\n')).toBe(true);
    expect([presetFileName(edited), presetRepoPath(edited)]).toEqual(['gold.json', 'user-data/presets/gold.json']);
    const back = parsePresetText(text);
    expect(back.errors).toEqual([]);
    expect(samePreset(back.presets[0], edited)).toBe(true);
    expect(presetFileText(back.presets[0])).toBe(text);
    expect(parsePresetText(`[${text},${presetFileText(own('x'))}]`).presets.map((p) => p.id)).toEqual(['gold', 'x']);
    expect(parsePresetText('{').errors[0]).toMatch(/^not JSON/);
    expect(parsePresetText(JSON.stringify({ ...own('x'), conditions: [{ metric: 'nope', op: '>', value: 1 }] })).errors).toEqual(['x condition 1 (nope): unknown metric nope']);
  });
});

describe('share link', () => {
  test('a preset survives the hash round trip, also with non-Latin text; other hashes and newer versions are refused', () => {
    const p = { ...own('my-ru'), title: { en: 'Gold & co', ru: 'Золото и ко' } };
    const hash = encodePresetHash(p);
    expect(hash).toMatch(/^preset=1\.[A-Za-z0-9_-]+$/);
    expect(presetKey(decodePresetHash(`#${hash}`).preset as Preset)).toBe(presetKey(p));
    expect(decodePresetHash(`#tab=x&${hash}`).preset?.title.ru).toBe('Золото и ко');
    expect(decodePresetHash('#something')).toEqual({ preset: null, errors: [] });
    expect(decodePresetHash(hash.replace('preset=1.', 'preset=2.')).errors[0]).toMatch(/schemaVersion 2/);
    expect(decodePresetHash('#preset=1.AAAA').errors.length).toBeGreaterThan(0);
  });
});

describe('own presets', () => {
  test('the browser copy wins over the repo copy and is "not exported" until it equals the repo copy or its last export', () => {
    const repo = [own('a', 1), own('b', 1)];
    const browser = [own('b', 2), own('c', 3)];
    const merged = mergeOwnPresets(repo, browser);
    expect(merged.map((e) => [e.preset.id, e.preset.conditions[0].value, e.inRepo, e.exported])).toEqual([['a', 1, true, true], ['b', 2, true, false], ['c', 3, false, false]]);
    const exported = mergeOwnPresets(repo, browser, { c: presetKey(own('c', 3)) });
    expect(exported.map((e) => e.exported)).toEqual([true, false, true]);
    expect(mergeOwnPresets(repo, [own('b', 1)])[1].exported).toBe(true);
  });

  test('changed conditions, unique ids and own copies', () => {
    const base = own('a', 1);
    const draft: Preset = { ...base, conditions: [{ metric: 'pe', op: '<', value: 1, scope: 'absolute', missing: 'fail', enabled: true }, { metric: 'roic', op: '>', value: 10 }] };
    expect(changedConditions(base, draft)).toEqual([false, true]);
    expect(changedConditions(base, { ...base, conditions: [{ ...base.conditions[0], enabled: false }] })).toEqual([true]);
    expect(uniqueId('My Gold!', ['my-gold'])).toBe('my-gold-2');
    const copy = ownCopy(gold, ['my-gold']);
    expect([copy.id, copy.title.en, copy.title.ru]).toEqual(['my-gold-2', 'Gold (mine)', 'Золото (моё)']);
    expect(copy.conditions).toEqual(canonicalPreset(gold).conditions);
  });
});

describe('etf brands', () => {
  test('the brand list of the ETFs hub brands.json, feed URLs on GitHub Pages', () => {
    expect(ETF_BRANDS_URL).toBe('https://daggerok.github.io/ETFs/brands.json');
    const { brands, errors } = parseEtfBrands([
      { repo: 'AAM', brand: 'AAM', slug: 'aam', issuerLabel: 'aamlive.com', issuerUrl: 'https://www.aamlive.com/ETF' },
      { repo: 'First-Trust', brand: 'First Trust', slug: 'firsttrust', issuerLabel: 'ftportfolios.com', issuerUrl: 'https://www.ftportfolios.com/' },
    ]);
    expect(errors).toEqual([]);
    expect(brands.map((b) => [b.repo, b.slug, b.brand])).toEqual([['AAM', 'aam', 'AAM'], ['First-Trust', 'firsttrust', 'First Trust']]);
    expect(etfFeedUrl(brands[0])).toBe('https://daggerok.github.io/AAM/api/aam/index.json');
    expect(etfFeedUrl(brands[1], 'http://localhost:1234/')).toBe('http://localhost:1234/First-Trust/api/firsttrust/index.json');
  });

  test('bad entries are left out and named, a payload that is not an array gives no brands', () => {
    const { brands, errors } = parseEtfBrands([
      { repo: 'Schwab', slug: 'schwab' }, null, { repo: '../x', slug: 'x' }, { repo: 'Y', slug: 'Bad Slug' }, { repo: 'Schwab', slug: 'schwab2' }, { repo: 'Z', slug: 'schwab' }, 'SPDR',
    ]);
    expect(brands).toEqual([{ repo: 'Schwab', slug: 'schwab', brand: 'Schwab', issuerLabel: '', issuerUrl: '' }]);
    expect(errors.length).toBe(6);
    expect(parseEtfBrands({ funds: [] })).toEqual({ brands: [], errors: ['brands.json is not an array'] });
    expect(parseEtfBrands([]).brands).toEqual([]);
  });
});
