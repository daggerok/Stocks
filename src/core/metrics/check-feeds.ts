/// <reference types="bun" />
/// <reference types="node" />
// usage: bun src/core/metrics/check-feeds.ts <api-dir>...  - reads every <dir>/index.json and <dir>/*/index.json (Stocks `companies`,
// ETF brand `funds`) and lists the `metrics` keys that have no registry entry; exit 1 when one is missing. Not a test: it reads live feeds
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REGISTRY } from '.';

function indexFiles(dir: string): string[] {
  const own = join(dir, 'index.json');
  if (existsSync(own)) return [own];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir).sort().map((d) => join(dir, d, 'index.json')).filter((f) => existsSync(f));
}

function main(): void {
  const dirs = process.argv.slice(2);
  if (!dirs.length) { console.error('usage: bun src/core/metrics/check-feeds.ts <api-dir>...'); process.exitCode = 2; return; }
  const missing: Record<string, string[]> = {};
  let files = 0, rows = 0;
  const keys: Record<string, boolean> = {};
  dirs.forEach((dir) => {
    const found = indexFiles(dir);
    if (!found.length) console.log(`[ warn  ] no index.json under ${dir}`);
    found.forEach((file) => {
      files += 1;
      const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const list = (Array.isArray(doc.companies) ? doc.companies : Array.isArray(doc.funds) ? doc.funds : []) as Array<Record<string, unknown>>;
      list.forEach((row) => {
        rows += 1;
        const metrics = row && typeof row.metrics === 'object' && row.metrics ? (row.metrics as Record<string, unknown>) : {};
        Object.keys(metrics).forEach((k) => {
          keys[k] = true;
          if (!REGISTRY.byId[k]) (missing[k] = missing[k] || []).indexOf(file) < 0 && missing[k].push(file);
        });
      });
    });
  });
  const unregistered = Object.keys(missing).sort();
  console.log(`[ feeds ] ${files} index files, ${rows} rows, ${Object.keys(keys).length} distinct metrics keys, ${REGISTRY.metrics.length} registry entries`);
  if (!unregistered.length) { console.log('[ ok    ] every metrics key has a registry entry'); return; }
  unregistered.forEach((k) => console.log(`[ MISS  ] ${k} (${missing[k].length} feeds, e.g. ${missing[k][0]})`));
  process.exitCode = 1;
}

if (require.main === module) main();
