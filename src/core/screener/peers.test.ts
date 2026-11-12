/// <reference types="bun" />
/// <reference types="node" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { changedGroups, createUniverse, deleteGroup, groupsOf, importGroups, mergePeers, parsePeersText, peersExported, peersFileText, peersKey, ScreenerRow, setGroup } from '.';

const row = (ticker: string, industry: string, pe: number): ScreenerRow => ({ ticker, type: 'stock', sector: 'S', industry, isMine: false, size: null, metrics: { pe } });

describe('peers', () => {
  test('user-data/peers.json parses without errors', () => {
    const text = readFileSync(join(__dirname, '..', '..', '..', 'user-data', 'peers.json'), 'utf8');
    expect(parsePeersText(text).errors).toEqual([]);
  });

  test('browser overlay wins, null deletes a repo group, names in order, export text round-trips', () => {
    const repo = { cards: ['V', 'MA'], banks: ['JPM'] };
    let overlay = setGroup({}, repo, 'cards', ['v', 'MA', 'AXP', 'ma', 'bad ticker']);
    overlay = setGroup(overlay, repo, 'chips', ['NVDA', 'AMD']);
    overlay = deleteGroup(overlay, repo, 'banks');
    const merged = mergePeers(repo, overlay);
    expect(merged).toEqual({ cards: ['V', 'MA', 'AXP'], chips: ['NVDA', 'AMD'] });
    expect(Object.keys(merged)).toEqual(['cards', 'chips']);
    expect(changedGroups(repo, overlay)).toEqual(['banks', 'cards', 'chips']);
    const text = peersFileText(merged);
    expect(text.endsWith('}\n')).toBe(true);
    expect(parsePeersText(text).groups).toEqual(merged);
    // a group set back to the repo copy leaves the overlay; deleting a browser-only group drops it
    expect(setGroup(overlay, repo, 'cards', ['V', 'MA'])).not.toHaveProperty('cards');
    expect(deleteGroup(overlay, repo, 'chips')).not.toHaveProperty('chips');
  });

  test('exported when equal to the repo or to the last export; import replaces groups of the same name', () => {
    const repo = { cards: ['V', 'MA'] };
    expect(peersExported(mergePeers(repo, {}), repo, '')).toBe(true);
    const merged = mergePeers(repo, setGroup({}, repo, 'cards', ['V', 'MA', 'AXP']));
    expect(peersExported(merged, repo, '')).toBe(false);
    expect(peersExported(merged, repo, peersKey(merged))).toBe(true);
    const imported = parsePeersText('{"schemaVersion":1,"groups":{"cards":["MA","V"],"oil":["XOM","cvx"]}}', ['MA', 'V', 'XOM']);
    expect(imported.errors).toEqual([]);
    expect(imported.warnings).toEqual(['oil: not in the stock feed: CVX']);
    expect(mergePeers(repo, importGroups({}, repo, imported.groups))).toEqual({ cards: ['MA', 'V'], oil: ['XOM', 'CVX'] });
    expect(groupsOf({ a: ['V'], b: ['MA', 'V'] }, 'v')).toEqual(['a', 'b']);
  });

  test('broken files: not JSON, wrong shape, wrong version, invalid tickers', () => {
    expect(parsePeersText('nope').errors[0]).toMatch(/^not JSON/);
    expect(parsePeersText('{"groups":[]}').errors).toEqual(['peers file needs {"schemaVersion": 1, "groups": {"name": ["TICKER"]}}']);
    const r = parsePeersText('{"schemaVersion":2,"groups":{"x":["V","1BAD"],"y":"MA"}}');
    expect(r.errors).toEqual(['schemaVersion must be 1', 'x: not a ticker: 1BAD', 'y: the group must be a list of tickers']);
    expect(r.groups).toEqual({ x: ['V'] });
  });

  test('the engine peers scope reads the merged groups, a ticker without a group compares with its industry', () => {
    const rows = ['A', 'B', 'C', 'D', 'E', 'F'].map((t, i) => row(t, 'ind', 10 + i));
    const merged = mergePeers({}, setGroup({}, {}, 'g', ['A', 'B', 'C', 'D', 'E']));
    const u = createUniverse(rows, { peers: merged });
    expect(u.peerGroupOf).toEqual(['g', 'g', 'g', 'g', 'g', null]);
  });
});
