/**
 * Building the .txt a note exports as. The filename logic is the sharp edge:
 * it has to survive titles containing characters the filesystem rejects, and
 * both the native share-sheet and web anchor-download paths depend on it
 * producing the same bytes.
 */
import { describe, expect, it } from 'vitest';

import type { Note } from '@/data/notes';
import { buildNoteText, noteFileName, noteFileTitle } from '@/lib/note-export';

/** A note with only the fields these functions read. */
const note = (title: string, body = ''): Note => ({ title, body }) as Note;

describe('noteFileTitle', () => {
  it('uses the title', () => {
    expect(noteFileTitle(note('Shopping list'))).toBe('Shopping list');
  });

  it('falls back for an empty or whitespace-only title', () => {
    expect(noteFileTitle(note(''))).toBe('Untitled note');
    expect(noteFileTitle(note('   '))).toBe('Untitled note');
  });
});

describe('noteFileName', () => {
  it('appends .txt', () => {
    expect(noteFileName(note('Recipes'))).toBe('Recipes.txt');
  });

  it('strips characters that are illegal in filenames', () => {
    // Windows rejects all of these; a path separator would be worse than a
    // rejection, since it would redirect the write somewhere unintended.
    expect(noteFileName(note('a/b\\c:d*e?f"g<h>i|j'))).toBe('abcdefghij.txt');
  });

  it('collapses whitespace left behind by stripping', () => {
    expect(noteFileName(note('a  /  b'))).toBe('a b.txt');
  });

  it('caps the length so the name stays writable', () => {
    const name = noteFileName(note('x'.repeat(200)));
    expect(name).toBe(`${'x'.repeat(80)}.txt`);
  });

  it('falls back when the title is nothing but illegal characters', () => {
    // Stripping leaves an empty string, which would otherwise produce ".txt" —
    // a hidden file on unix and an invalid name on Windows.
    expect(noteFileName(note('///'))).toBe('note.txt');
  });

  it('falls back for an untitled note', () => {
    expect(noteFileName(note(''))).toBe('Untitled note.txt');
  });
});

describe('buildNoteText', () => {
  it('puts the title first, then a blank line, then the flattened body', () => {
    expect(buildNoteText(note('Title', '<p>Body text</p>'))).toBe('Title\n\nBody text\n');
  });

  it('omits the blank line when there is no title', () => {
    expect(buildNoteText(note('', '<p>Body text</p>'))).toBe('Body text\n');
  });

  it('omits the body section when the note is empty', () => {
    expect(buildNoteText(note('Title', ''))).toBe('Title\n');
  });

  it('always ends with exactly one trailing newline', () => {
    for (const n of [note('T', '<p>B</p>'), note('', '<p>B</p>'), note('T', '')]) {
      expect(buildNoteText(n)).toMatch(/[^\n]\n$/);
    }
  });

  it('tolerates a null body', () => {
    // Rows synced from older clients can carry a null body.
    expect(buildNoteText({ title: 'T', body: null } as unknown as Note)).toBe('T\n');
  });
});
