/**
 * Web "save sheet to device". Builds the CSV as a blob and triggers a plain
 * anchor download, matching the note and copa web download flows.
 *
 * Must export the same names as `save-sheet.ts` — a variant pair that drifts is
 * how this app once shipped a build that crashed on launch for three days.
 */
import type { Note } from '@/data/notes';
import { db } from '@/lib/db';
import { buildNoteCsv, sheetFileName } from '@/lib/finance/csv';
import { flushPendingSheet } from '@/lib/finance/pending';

export async function saveSheetToDevice(note: Note): Promise<void> {
  // Matches the native path: land any debounced edit before reading storage.
  await flushPendingSheet();
  const csv = buildNoteCsv(await db.getFinanceSheet(note.id));
  if (csv.trim() === '') return;

  // A BOM so Excel opens UTF-8 accented labels correctly rather than as mojibake.
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sheetFileName(note);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
