/**
 * `worthKeepingInTrash` decides whether a trashed entry is listed in the Trash
 * UI. A bug here reads to the user as "my data vanished from Trash", so these
 * cases are deliberately exhaustive about what counts as blank.
 *
 * `TrashEntry` is only imported as a type — the runtime db module pulls in
 * expo-sqlite, which vitest can't load, so every entry below is a plain object
 * literal shaped like the real thing and cast.
 */
import { describe, expect, it } from 'vitest';

import type { TrashEntry } from '@/lib/db';
import { worthKeepingInTrash } from '@/lib/trash-visibility';

const note = (overrides: { title?: string; body?: string } = {}) => ({
  kind: 'note' as const,
  id: 'n1',
  deletedAt: 0,
  note: {
    id: 'n1',
    title: overrides.title ?? '',
    body: overrides.body ?? '',
    folderId: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
});

const folder = (overrides: {
  name?: string;
  folders?: unknown[];
  notes?: unknown[];
} = {}) => ({
  kind: 'folder' as const,
  id: 'f1',
  deletedAt: 0,
  folder: {
    id: 'f1',
    name: overrides.name ?? '',
    parentId: null,
  },
  folders: overrides.folders ?? [],
  notes: overrides.notes ?? [],
});

describe('worthKeepingInTrash — note entries', () => {
  it('keeps a note with a real title even if the body is blank', () => {
    expect(worthKeepingInTrash(note({ title: 'Groceries' }) as unknown as TrashEntry)).toBe(true);
  });

  it('keeps a note with a real body even if the title is blank', () => {
    expect(worthKeepingInTrash(note({ body: '<p>hello</p>' }) as unknown as TrashEntry)).toBe(true);
  });

  it('hides a note with both title and body blank', () => {
    expect(worthKeepingInTrash(note({ title: '', body: '' }) as unknown as TrashEntry)).toBe(false);
  });

  it('treats empty rich-text HTML as a blank body, run through htmlToPlainText', () => {
    expect(worthKeepingInTrash(note({ body: '<p></p>' }) as unknown as TrashEntry)).toBe(false);
    expect(worthKeepingInTrash(note({ body: '<p><br></p>' }) as unknown as TrashEntry)).toBe(false);
  });

  it('treats whitespace-only title or body as blank', () => {
    expect(worthKeepingInTrash(note({ title: '   ', body: '\n\t ' }) as unknown as TrashEntry)).toBe(false);
    expect(worthKeepingInTrash(note({ title: '  Real  ' }) as unknown as TrashEntry)).toBe(true);
  });
});

describe('worthKeepingInTrash — folder entries', () => {
  it('hides a blank-named folder with no trashed children', () => {
    expect(worthKeepingInTrash(folder({ name: '' }) as unknown as TrashEntry)).toBe(false);
    expect(worthKeepingInTrash(folder({ name: '   ' }) as unknown as TrashEntry)).toBe(false);
  });

  it('keeps a blank-named folder that took notes down with it', () => {
    expect(
      worthKeepingInTrash(
        folder({ name: '', notes: [{ id: 'n2' }] }) as unknown as TrashEntry,
      ),
    ).toBe(true);
  });

  it('keeps a blank-named folder that took subfolders down with it', () => {
    expect(
      worthKeepingInTrash(
        folder({ name: '', folders: [{ id: 'f2' }] }) as unknown as TrashEntry,
      ),
    ).toBe(true);
  });

  it('keeps a real-named folder even when it took nothing down', () => {
    expect(worthKeepingInTrash(folder({ name: 'Recipes' }) as unknown as TrashEntry)).toBe(true);
  });
});
