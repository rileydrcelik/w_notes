/**
 * The decision logic in native `save-note-pdf.ts` — refusal rules, the printer
 * timeout, the single-flight guard, and the cleanup of the staged `exports/`
 * copy. Not the platform's printer or filesystem, which are all mocked out.
 *
 * `expo-print`, `expo-sharing` and `expo-file-system` are native modules with no
 * Node implementation (see the header comment on `vitest.config.ts`), so every
 * test here runs against a small fake filesystem rather than a real one.
 *
 * `FakeNode`'s one rule is modelled on how the real `File`/`Directory` classes
 * behave, because two of the behaviours under test hinge on it: a node built
 * from a single, already-known uri (the printer's own temp file) exists on disk
 * from the moment it's wrapped; one built by joining a directory and a name (an
 * export destination nothing has written yet) does not, until `create()` or
 * `copy()` makes it so. Get that backwards and "the staged copy is deleted" and
 * "the staged copy is NOT deleted" stop being distinguishable at all — both
 * would look identical to `discard()`, which only ever checks `.exists`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Note } from '@/data/notes';

/** Recreated in `beforeEach`; read and pushed to by `FakeNode.delete`. */
let deletedUris: string[] = [];

class FakeNode {
  readonly uri: string;
  exists: boolean;

  constructor(...parts: (string | FakeNode)[]) {
    this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
    // See the header comment: a bare-uri wrap already exists; a directory+name
    // join is a destination that doesn't, yet.
    this.exists = parts.length === 1;
  }

  create(): void {
    this.exists = true;
  }

  delete(): void {
    this.exists = false;
    deletedUris.push(this.uri);
  }

  copy(dest: FakeNode): Promise<void> {
    dest.exists = true;
    return Promise.resolve();
  }
}

vi.mock('expo-file-system', () => ({
  File: FakeNode,
  Directory: FakeNode,
  Paths: {
    get cache() {
      return new FakeNode('file://cache');
    },
  },
}));

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
}));

vi.mock('@/lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('expo-print', () => ({
  printToFileAsync: vi.fn(),
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

// Resolving a note's images to bytes reads the database, which is expo-sqlite
// and unloadable here. These tests are about the printer's decision logic, so
// the note passes through as it is.
vi.mock('@/lib/note-image-export', () => ({
  noteForExport: async (note: Note) => note,
}));

vi.mock('@/lib/save-file', () => ({
  canSaveToDevice: vi.fn(),
  saveFileToDevice: vi.fn(),
}));

const { Alert } = await import('react-native');
const { Sentry } = await import('@/lib/sentry');
const Print = await import('expo-print');
const Sharing = await import('expo-sharing');
const SaveFile = await import('@/lib/save-file');
const { saveNotePdfToDevice } = await import('@/lib/save-note-pdf');

/** A note with only the fields these functions read. */
const note = (title: string, body = ''): Note => ({ title, body }) as Note;

/**
 * Mirrors the private constants of the same name in `save-note-pdf.ts` — not
 * imported, since the module doesn't export them.
 */
const PRINT_TIMEOUT_MS = 60_000;
const MAX_DOCUMENT_CHARS = 8_000_000;

/** What the printer mock resolves to unless a test overrides it. */
const PRINTED_URI = 'file://cache/printer-tmp.pdf';

/** True for the staged `exports/` copy's uri, false for the printer's temp file. */
const isStagedUri = (uri: string) => uri.includes('/exports/');

beforeEach(() => {
  deletedUris = [];
  vi.mocked(Print.printToFileAsync).mockReset().mockResolvedValue({ uri: PRINTED_URI } as never);
  vi.mocked(Sharing.isAvailableAsync).mockReset().mockResolvedValue(true);
  vi.mocked(Sharing.shareAsync).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(SaveFile.canSaveToDevice).mockReset().mockReturnValue(false);
  vi.mocked(SaveFile.saveFileToDevice).mockReset().mockResolvedValue({ status: 'unsupported' });
  vi.mocked(Alert.alert).mockReset();
  vi.mocked(Sentry.captureException).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an empty note', () => {
  it('is refused without ever reaching the printer', async () => {
    await saveNotePdfToDevice(note('', ''));

    expect(Alert.alert).toHaveBeenCalledWith('Nothing to export', 'This note is empty.');
    expect(Print.printToFileAsync).not.toHaveBeenCalled();
  });
});

describe('a document over the character cap', () => {
  it('is refused without ever reaching the printer', async () => {
    // Comfortably over MAX_DOCUMENT_CHARS once the boilerplate document wrapper
    // is added around it.
    const big = note('', `<p>${'a'.repeat(MAX_DOCUMENT_CHARS)}</p>`);

    await saveNotePdfToDevice(big);

    expect(Alert.alert).toHaveBeenCalledWith(
      'Too long for a PDF',
      'This note is too large to print. Download it as a web page instead — it keeps the same formatting.',
    );
    expect(Print.printToFileAsync).not.toHaveBeenCalled();
  });
});

describe('a printer that never settles', () => {
  it('gives up after the timeout and reports it, instead of hanging forever', async () => {
    vi.useFakeTimers();
    vi.mocked(Print.printToFileAsync).mockReturnValue(new Promise(() => {}));

    const pending = saveNotePdfToDevice(note('Title', '<p>Body</p>'));
    await vi.advanceTimersByTimeAsync(PRINT_TIMEOUT_MS);
    await pending;

    expect(Alert.alert).toHaveBeenCalledWith('Could not save', 'Something went wrong making this PDF.');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('single-flight', () => {
  it('joins an in-flight export instead of starting a second one, and releases the guard after', async () => {
    let resolvePrint!: (v: { uri: string; numberOfPages: number }) => void;
    vi.mocked(Print.printToFileAsync).mockReturnValue(
      new Promise((resolve) => {
        resolvePrint = resolve;
      }),
    );

    const n = note('Title', '<p>Body</p>');
    const first = saveNotePdfToDevice(n);
    const second = saveNotePdfToDevice(n);

    // The second call gets the first's own promise back, not a new one. The
    // guard is taken synchronously, which is what makes that true even though
    // the export now awaits the note's images before it reaches the printer.
    expect(second).toBe(first);
    // Let those awaits settle, so "printed once" is about single-flight rather
    // than about the printer not having been reached yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(Print.printToFileAsync).toHaveBeenCalledTimes(1);

    resolvePrint({ uri: PRINTED_URI, numberOfPages: 1 });
    await Promise.all([first, second]);

    // Only one export ran to completion, not two.
    expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);

    // The guard released: a later call prints again rather than replaying the
    // finished one.
    vi.mocked(Print.printToFileAsync).mockResolvedValue({ uri: PRINTED_URI, numberOfPages: 1 });
    await saveNotePdfToDevice(n);
    expect(Print.printToFileAsync).toHaveBeenCalledTimes(2);
  });
});

describe('cleanup of the staged exports/ copy', () => {
  it('deletes the staged copy and the printer temp file when the folder pick is cancelled, and never falls through to sharing', async () => {
    vi.mocked(SaveFile.canSaveToDevice).mockReturnValue(true);
    vi.mocked(SaveFile.saveFileToDevice).mockResolvedValue({ status: 'cancelled' });

    await saveNotePdfToDevice(note('Title', '<p>Body</p>'));

    expect(deletedUris).toContain(PRINTED_URI);
    expect(deletedUris.some(isStagedUri)).toBe(true);
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });

  it('deletes the staged copy and the printer temp file once the file is saved', async () => {
    vi.mocked(SaveFile.canSaveToDevice).mockReturnValue(true);
    vi.mocked(SaveFile.saveFileToDevice).mockResolvedValue({
      status: 'saved',
      folder: 'Download/w_notes',
    });

    await saveNotePdfToDevice(note('Title', '<p>Body</p>'));

    expect(Alert.alert).toHaveBeenCalledWith('Saved', 'The note was saved to Download/w_notes.');
    expect(deletedUris).toContain(PRINTED_URI);
    expect(deletedUris.some(isStagedUri)).toBe(true);
  });

  it('deletes the staged copy and the printer temp file when something throws', async () => {
    // canSaveToDevice stays false (the default), so this falls through to
    // sharing — which is made to fail.
    vi.mocked(Sharing.shareAsync).mockRejectedValue(new Error('share failed'));

    await saveNotePdfToDevice(note('Title', '<p>Body</p>'));

    expect(Alert.alert).toHaveBeenCalledWith('Could not save', 'Something went wrong making this PDF.');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(deletedUris).toContain(PRINTED_URI);
    expect(deletedUris.some(isStagedUri)).toBe(true);
  });

  it('leaves the staged copy alone once it has been handed to the share sheet', async () => {
    // canSaveToDevice stays false (the default), so this reaches Sharing.
    await saveNotePdfToDevice(note('Title', '<p>Body</p>'));

    expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
    // The printer's own temp file is still cleaned up either way.
    expect(deletedUris).toContain(PRINTED_URI);
    // But the receiving app reads the staged file's uri after shareAsync
    // resolves, so deleting it here would break a save that looked successful.
    expect(deletedUris.some(isStagedUri)).toBe(false);
  });
});
