/// <reference types="bun" />
/// <reference types="node" />
// usage: bun src/core/screener/bench.ts [rows=10000]  - speed of the engine on a synthetic universe (plan stage 3: percentile tables
// under 1 s, re-evaluation of every base preset after one condition change under 100 ms). Not a test: tests never assert time
import { isNumericMetric, METRICS } from '../metrics';
import { buildPercentileTables, createUniverse, evaluatePresets, Preset, ScreenerRow } from '.';
import { loadPresets } from './load-presets';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function syntheticRows(total: number, etfs: number): ScreenerRow[] {
  const rnd = lcg(42);
  const numericIds = METRICS.filter(isNumericMetric).map((m) => m.id);
  const sectors = Array.from({ length: 11 }, (_, i) => `Sector ${i}`);
  const rows: ScreenerRow[] = [];
  for (let i = 0; i < total; i += 1) {
    const etf = i >= total - etfs;
    const metrics: Record<string, unknown> = {};
    numericIds.forEach((id) => { metrics[id] = rnd() < 0.1 ? null : Math.round((rnd() * 200 - 50) * 100) / 100; });
    const sector = etf ? null : sectors[Math.floor(rnd() * sectors.length)];
    const industry = etf ? null : rnd() < 0.02 ? 'Gold' : `Industry ${Math.floor(rnd() * 140)}`;
    rows.push({ ticker: `${etf ? 'E' : 'S'}${i}`, type: etf ? 'etf' : 'stock', sector, industry, isMine: rnd() < 0.03, size: Math.round(rnd() * 5e11), metrics });
  }
  return rows;
}

const ms = (start: number) => Math.round((performance.now() - start) * 10) / 10;
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function main(): void {
  const total = Number(process.argv[2] || 10000);
  const rows = syntheticRows(total, Math.min(2552, Math.floor(total * 0.3)));
  const peers: Record<string, string[]> = {};
  for (let g = 0; g < 200; g += 1) peers[`group ${g}`] = Array.from({ length: 6 }, (_, k) => `S${g * 6 + k}`);
  const presets = loadPresets();

  let t = performance.now();
  const universe = createUniverse(rows, { peers });
  const createMs = ms(t);
  t = performance.now();
  const tables = buildPercentileTables(universe);
  const tablesMs = ms(t);
  t = performance.now();
  evaluatePresets(universe, presets);
  const coldMs = ms(t);

  // one condition changes (as in the editor): the other conditions come from the cache, every preset is recombined
  const warm: number[] = [];
  const full: number[] = [];
  for (let run = 0; run < 21; run += 1) {
    const edited: Preset[] = presets.map((p) => (p.id !== 'stable-dividend' ? p : { ...p, conditions: p.conditions.map((c, k) => (k === 0 ? { ...c, value: 2 + run / 10 } : c)) }));
    t = performance.now();
    evaluatePresets(universe, edited);
    warm.push(ms(t));
    universe.conditionCache = {};
    t = performance.now();
    evaluatePresets(universe, edited);
    full.push(ms(t));
  }
  const conditions = presets.reduce((n, p) => n + p.conditions.length, 0);
  console.log(`[ bench ] ${rows.length} rows (${rows.filter((r) => r.type === 'etf').length} ETFs), ${presets.length} base presets with ${conditions} conditions`);
  console.log(`[ bench ] createUniverse ${createMs} ms; percentile tables: ${tables} (metric, scope) tables in ${tablesMs} ms (goal < 1000 ms)`);
  console.log(`[ bench ] first evaluation of all presets ${coldMs} ms`);
  console.log(`[ bench ] re-evaluate all presets after one condition change: median ${median(warm)} ms, max ${Math.max(...warm)} ms (goal < 100 ms)`);
  console.log(`[ bench ] re-evaluate all presets with an empty condition cache: median ${median(full)} ms, max ${Math.max(...full)} ms`);
}

if (require.main === module) main();
