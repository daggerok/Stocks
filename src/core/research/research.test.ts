/// <reference types="bun" />
/// <reference types="node" />
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  emptyNotes, emptyTam, indexFiles, notesFileText, notesFilled, parseNotes, parsePromises, parseTam, PromiseItem, promiseProgress, promisesFileText,
  recordState, RESEARCH_KINDS, RESEARCH_QUESTIONS, researchFileName, researchRepoPath, tamFileText, tamScenarios,
} from '.';

describe('research', () => {
  test('each user-data index.json lists exactly the files of its folder (the browser has no directory listing)', () => {
    RESEARCH_KINDS.forEach((kind) => {
      const dir = join(__dirname, '..', '..', '..', 'user-data', kind);
      const files = readdirSync(dir).filter((f) => f !== 'index.json' && !f.startsWith('.')).sort();
      expect(indexFiles(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))).slice().sort()).toEqual(files);
    });
    expect([researchFileName('notes', 'GOOGL'), researchRepoPath('tam', 'GOOGL'), researchRepoPath('promises', 'V')]).toEqual(['GOOGL.md', 'user-data/tam/GOOGL.json', 'user-data/promises/V.json']);
  });

  test('browser copy wins; exported when equal to the repo file or the last export', () => {
    expect(recordState(null, null, null)).toEqual({ text: null, source: 'none', exported: true });
    expect(recordState('a', null, null)).toEqual({ text: 'a', source: 'repo', exported: true });
    expect(recordState('a', 'b', null)).toEqual({ text: 'b', source: 'browser', exported: false });
    expect(recordState('a', 'b', 'b').exported).toBe(true);
    expect(recordState(null, 'a', null).exported).toBe(false);
  });

  test('TAM: scenarios by hand, file round trip, validation', () => {
    const doc = { ...emptyTam('GOOGL', '2026-11-12'), market: 'Digital advertising', size: 600e9, growth: 10, years: 2, share: { low: 30, mid: 40, high: 50 } };
    // TAM in 2 years = 600B x 1.1^2 = 726B; mid revenue = 726B x 40% = 290.4B; CAGR from 200B = sqrt(290.4 / 200) - 1 = 20.499%
    const r = tamScenarios(doc, 200e9);
    expect(r.tamAtHorizon).toBeCloseTo(726e9, 0);
    expect(r.mid.revenue).toBeCloseTo(290.4e9, 0);
    expect(r.mid.cagr).toBeCloseTo((Math.sqrt(1.452) - 1) * 100, 9);
    expect(r.low.revenue).toBeCloseTo(217.8e9, 0);
    expect(tamScenarios({ ...doc, size: null }, 200e9).high).toEqual({ revenue: null, cagr: null });
    const text = tamFileText(doc);
    expect(parseTam(text, 'GOOGL')).toEqual({ doc, errors: [] });
    expect(parseTam(text, 'V').errors).toEqual(['the file is for GOOGL, not V']);
    expect(parseTam('{"schemaVersion":1,"ticker":"V","asOf":"x","years":0,"size":"big"}', 'V').errors).toEqual(['years must be a whole number from 1 to 30', 'asOf must be YYYY-MM-DD', 'size must be a number or null']);
  });

  test('notes: Markdown with the dated thesis and the nine questions, round trip and a tolerant read', () => {
    expect(RESEARCH_QUESTIONS.length).toBe(9);
    const doc = { ...emptyNotes('V'), thesisDate: '2026-11-12', thesis: 'A toll road on card payments.\nSecond line.', notes: 'Watch the DOJ case.' };
    doc.answers[0] = 'Payment network services; banks and merchants pay.';
    doc.answers[8] = 'DCF base 280, price 330: no margin of safety.';
    const md = notesFileText(doc);
    expect(md.startsWith('# V research notes\n\n## Thesis\n\nDate: 2026-11-12\n\nA toll road on card payments.')).toBe(true);
    expect(md).toContain(`### 1. ${RESEARCH_QUESTIONS[0].en}\n\nPayment network services`);
    expect(md).toContain(`### 2. ${RESEARCH_QUESTIONS[1].en}\n\n### 3.`);
    expect(md.endsWith('## Notes\n\nWatch the DOJ case.\n')).toBe(true);
    expect(parseNotes(md, 'V')).toEqual(doc);
    expect(notesFilled(doc)).toBe(2);
    const loose = parseNotes('# x\n\n## Checklist\n\n### 3. anything\n\nmoat: network effects\n', 'V');
    expect(loose.answers[2]).toBe('moat: network effects');
    expect(loose.thesis).toBe('');
    expect(parseNotes(notesFileText(emptyNotes('V')), 'V')).toEqual(emptyNotes('V'));
  });

  test('promises: file round trip, validation, buyback and capex against the SEC quarters', () => {
    const buyback: PromiseItem = { kind: 'buyback', text: '$100 buyback', announced: '2025-04-20', deadline: '2025-12-31', amount: 100, status: 'open' };
    const doc = { schemaVersion: 1, ticker: 'V', items: [buyback, { kind: 'guidance' as const, text: 'FY revenue +10%', announced: '2025-01-30', deadline: '', amount: null, status: 'kept' as const }] };
    expect(parsePromises(promisesFileText(doc), 'V')).toEqual({ doc, errors: [] });
    expect(parsePromises('{"schemaVersion":1,"ticker":"V","items":[{"kind":"x","status":"y","announced":"z","deadline":"","amount":"1"}]}', 'V').errors)
      .toEqual(['item 1: kind must be one of guidance, buyback, capex, other', 'item 1: status must be one of open, kept, partial, missed', 'item 1: announced must be YYYY-MM-DD', 'item 1: amount must be a number or null']);
    // quarters newest first; window: ended after 2025-04-20 and on or before 2025-12-31 -> 2025-12-31, 2025-09-30, 2025-06-30
    const quarters = {
      end: ['2026-03-31', '2025-12-31', '2025-09-30', '2025-06-30', '2025-03-31'],
      buybacks: [50, 30, 25, 20, 10],
      capex: [9, 8, 7, 6, 5],
      sharesDiluted: [960, 970, 980, 990, 1000],
    };
    // spent 30 + 25 + 20 = 75 of 100 -> 75%; shares 1000 (2025-03-31, the last quarter before) -> 970 (2025-12-31): 30 retired
    expect(promiseProgress(buyback, quarters)).toEqual({ quarters: 3, from: '2025-06-30', to: '2025-12-31', spent: 75, done: 75, sharesRetired: 30, sharesBefore: 1000, sharesAfter: 970 });
    // capex without a deadline: every quarter after the announcement, 9 + 8 + 7 + 6 = 30 of 40 -> 75%, no share counts
    expect(promiseProgress({ ...buyback, kind: 'capex', deadline: '', amount: 40 }, quarters)).toMatchObject({ quarters: 4, spent: 30, done: 75, sharesRetired: null });
    expect(promiseProgress(doc.items[1], quarters).quarters).toBe(0);
    expect(promiseProgress(buyback, null).spent).toBeNull();
    // a missing quarter value makes the sum unknown, never a smaller number
    expect(promiseProgress(buyback, { ...quarters, buybacks: [50, 30, null, 20, 10] }).spent).toBeNull();
  });
});
