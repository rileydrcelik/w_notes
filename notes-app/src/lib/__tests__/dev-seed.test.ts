/**
 * The dev-only seed data (`lib/dev-seed.ts`) never touches SQLite in this
 * suite — there's no node harness for expo-sqlite here, and `runDevSeed`/
 * `getDirty` are deliberately out of scope. What's covered instead is the
 * data itself, because every guarantee `runDevSeed` and `db.getDirty()` lean
 * on is really a property of the `SEED_FOLDERS`/`SEED_NOTES` arrays and
 * `buildBudgetSheet()`'s output:
 *
 *  - every id carries `DEV_SEED_PREFIX`, or `getDirty()`'s exclusion misses
 *    it and it uploads to a real account;
 *  - every `folderId`/`parentId` resolves to a real seed folder, and parents
 *    are seeded before the children that reference them, since `runDevSeed`
 *    inserts the array in order with no second pass;
 *  - the finance sheet parses and its formulas actually evaluate, not just
 *    "is non-empty";
 *  - each note's body matches what its reader expects (LaTeX for the resume
 *    plugin, empty for the finance plugin, rich-text HTML otherwise).
 */
import { describe, expect, it } from 'vitest';

import { DEV_SEED_PREFIX, SEED_FOLDERS, SEED_NOTES, buildBudgetSheet } from '@/lib/dev-seed';
import { cellKey } from '@/lib/finance/formula';
import { evaluateSheet, getCell, parseSheet } from '@/lib/finance/sheet';

describe('the prefix contract', () => {
  it('gives every seed folder and note id the DEV_SEED_PREFIX', () => {
    const ids = [...SEED_FOLDERS.map((f) => f.id), ...SEED_NOTES.map((n) => n.id)];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id.startsWith(DEV_SEED_PREFIX)).toBe(true);
    }
  });

  it('keeps every id unique across folders and notes', () => {
    const ids = [...SEED_FOLDERS.map((f) => f.id), ...SEED_NOTES.map((n) => n.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('referential integrity', () => {
  const folderIds = new Set(SEED_FOLDERS.map((f) => f.id));

  it('points every note folderId at a real seed folder, or null', () => {
    for (const n of SEED_NOTES) {
      if (n.folderId !== null) {
        expect(folderIds.has(n.folderId)).toBe(true);
      }
    }
  });

  it('points every folder parentId at a real seed folder, or null', () => {
    for (const f of SEED_FOLDERS) {
      if (f.parentId !== null) {
        expect(folderIds.has(f.parentId)).toBe(true);
      }
    }
  });

  it('seeds a parent folder before any child that references it', () => {
    // Not a database constraint: `folders.parent_id` has no REFERENCES, so
    // SQLite would take a child inserted ahead of its parent without
    // complaint, and the tree is resolved at read time regardless. This holds
    // the array to reading as the tree it builds — which is also what makes
    // `runDevSeed`'s single in-order pass safe to keep, rather than something
    // that has to grow a second pass the first time the list is reordered.
    const seen = new Set<string>();
    for (const f of SEED_FOLDERS) {
      if (f.parentId !== null) {
        expect(seen.has(f.parentId)).toBe(true);
      }
      seen.add(f.id);
    }
  });
});

describe('buildBudgetSheet', () => {
  it('produces JSON that parseSheet reads back with the seeded cells intact', () => {
    const sheet = parseSheet(buildBudgetSheet());
    expect(sheet.rows).toBeGreaterThanOrEqual(8);
    expect(sheet.cols).toBeGreaterThanOrEqual(4);
    expect(getCell(sheet, 1, 0)?.raw).toBe('Rent');
    expect(getCell(sheet, 7, 1)?.raw).toBe('=SUM(B2:B7)');
  });

  it('evaluates the Total row SUM formula to the correct number', () => {
    const sheet = parseSheet(buildBudgetSheet());
    const computed = evaluateSheet(sheet);
    // Row 7 (0-based) / col 1 is the "Total" row's "Budget" column, i.e. B8
    // in A1 notation: =SUM(B2:B7) over Rent/Groceries/Transport/Coffee/
    // Utilities/Fun = 1450 + 400 + 120 + 60 + 180 + 200.
    expect(computed.get(cellKey(7, 1))).toBe(2410);
  });
});

describe('body format', () => {
  it('gives the resume-plugin note a LaTeX body', () => {
    const resume = SEED_NOTES.find((n) => n.pluginType === 'resume');
    expect(resume).toBeDefined();
    expect(resume!.body.startsWith('\\documentclass')).toBe(true);
  });

  it('gives the finance-plugin note an empty body', () => {
    const finance = SEED_NOTES.find((n) => n.pluginType === 'finance');
    expect(finance).toBeDefined();
    expect(finance!.body).toBe('');
  });

  it('gives every non-plugin note a rich-text HTML body', () => {
    const plain = SEED_NOTES.filter((n) => !n.pluginType);
    expect(plain.length).toBeGreaterThan(0);
    for (const n of plain) {
      expect(n.body.trim().startsWith('<')).toBe(true);
    }
  });
});
