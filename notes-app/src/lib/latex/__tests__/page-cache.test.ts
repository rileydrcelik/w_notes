/**
 * The cached page images for a compiled resume's native preview.
 *
 * Two failure modes matter more than the rest. First, a half-written set —
 * manifest missing, a page missing, or a page written as zero bytes — must
 * read back as a full miss, never as a document that quietly lost its last
 * page: `readCachedPages` is written manifest-last for exactly this reason,
 * and this is the test that would catch someone "simplifying" that ordering
 * away. Second, width is part of this cache's identity in a way it isn't for
 * the PDF cache (`pdf-cache-key.test.ts` already covers note id / engine /
 * source there) — a phone and a rotated phone must not read back each other's
 * pages.
 *
 * `expo-file-system`'s synchronous `Directory`/`File`/`Paths` API is a native
 * module with no Node implementation, so it's replaced here with an in-memory
 * filesystem that implements the handful of members `page-cache.ts` actually
 * calls. The double is intentionally dumb — a `Map` keyed by URI — so that a
 * test failure means the module under test misbehaved, not the double.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RenderedPage } from '@/lib/latex/types';

type StoreEntry = { type: 'dir' } | { type: 'file'; bytes: Uint8Array };

// Exposed so tests can both reset it between runs and, for the "nothing is
// written" assertion, inspect it directly rather than through the module
// under test (which would make that assertion unable to fail independently).
const store = new Map<string, StoreEntry>();

vi.mock('expo-file-system', () => {
  function join(base: string, name: string): string {
    return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
  }
  function nameOf(uri: string): string {
    const segs = uri.split('/').filter(Boolean);
    return segs[segs.length - 1] ?? '';
  }

  class Directory {
    uri: string;
    name: string;
    constructor(parent: Directory | string, name?: string) {
      const parentUri = typeof parent === 'string' ? parent : parent.uri;
      this.uri = name !== undefined ? join(parentUri, name) : parentUri;
      this.name = nameOf(this.uri);
    }
    get exists(): boolean {
      return store.get(this.uri)?.type === 'dir';
    }
    create(): void {
      // Mirrors `{ intermediates: true }`: every ancestor becomes a dir too.
      const segs = this.uri.split('/').filter(Boolean);
      let cur = '';
      for (const seg of segs) {
        cur = `${cur}/${seg}`;
        if (!store.has(cur)) store.set(cur, { type: 'dir' });
      }
    }
    delete(): void {
      const prefix = this.uri.endsWith('/') ? this.uri : `${this.uri}/`;
      for (const key of Array.from(store.keys())) {
        if (key === this.uri || key.startsWith(prefix)) store.delete(key);
      }
    }
    list(): (Directory | File)[] {
      const prefix = this.uri.endsWith('/') ? this.uri : `${this.uri}/`;
      const names = new Set<string>();
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (rest) names.add(rest.split('/')[0]);
        }
      }
      return Array.from(names).map((name) => {
        const childUri = `${prefix}${name}`;
        const entry = store.get(childUri);
        const child = entry?.type === 'dir' ? new Directory(childUri) : new File(childUri);
        return child;
      });
    }
  }

  class File {
    uri: string;
    name: string;
    constructor(parent: Directory | string, name?: string) {
      const parentUri = typeof parent === 'string' ? parent : parent.uri;
      this.uri = name !== undefined ? join(parentUri, name) : parentUri;
      this.name = nameOf(this.uri);
    }
    get exists(): boolean {
      return store.get(this.uri)?.type === 'file';
    }
    create(): void {
      store.set(this.uri, { type: 'file', bytes: new Uint8Array(0) });
    }
    write(data: Uint8Array | string): void {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      store.set(this.uri, { type: 'file', bytes });
    }
    delete(): void {
      store.delete(this.uri);
    }
    bytes(): Uint8Array {
      const e = store.get(this.uri);
      if (!e || e.type !== 'file') throw new Error(`ENOENT: ${this.uri}`);
      return e.bytes;
    }
    text(): string {
      return new TextDecoder().decode(this.bytes());
    }
  }

  return { Directory, File, Paths: { cache: '/mock-cache' } };
});

const PAGES: RenderedPage[] = [
  { width: 480, height: 620, png: new Uint8Array([1, 2, 3]) },
  { width: 480, height: 620, png: new Uint8Array([4, 5, 6]) },
];

beforeEach(() => {
  store.clear();
});

describe('writeCachedPages / readCachedPages round trip', () => {
  it('writes cleanly and reads back exactly what was written', async () => {
    const { writeCachedPages, readCachedPages } = await import('@/lib/latex/page-cache');

    const ok = await writeCachedPages('note-1', 'pdflatex', 'src', 480, PAGES);
    expect(ok).toBe(true);

    const read = await readCachedPages('note-1', 'pdflatex', 'src', 480);
    expect(read).toEqual(PAGES);
  });

  it('is a miss for a source that has never been cached', async () => {
    const { readCachedPages } = await import('@/lib/latex/page-cache');
    expect(await readCachedPages('note-1', 'pdflatex', 'src', 480)).toBeNull();
  });
});

describe('the manifest-last invariant', () => {
  it('is a full miss, not a short document, when the manifest is missing', async () => {
    const { writeCachedPages, readCachedPages } = await import('@/lib/latex/page-cache');
    const { File } = await import('expo-file-system');

    await writeCachedPages('note-1', 'pdflatex', 'src', 480, PAGES);
    // Simulate a write interrupted right before the manifest landed: both
    // page files are on disk, but pages.json never was.
    const { pdfCacheName } = await import('@/lib/latex/pdf-cache-key');
    const dirUri = `/mock-cache/latex-pages/${pdfCacheName('note-1', 'pdflatex', 'src')}-w480`;
    new File(dirUri, 'pages.json').delete();

    expect(await readCachedPages('note-1', 'pdflatex', 'src', 480)).toBeNull();
  });

  it('is a full miss, not a one-page document, when a page file is missing', async () => {
    const { writeCachedPages, readCachedPages } = await import('@/lib/latex/page-cache');
    const { File } = await import('expo-file-system');
    const { pdfCacheName } = await import('@/lib/latex/pdf-cache-key');

    await writeCachedPages('note-1', 'pdflatex', 'src', 480, PAGES);
    const dirUri = `/mock-cache/latex-pages/${pdfCacheName('note-1', 'pdflatex', 'src')}-w480`;
    // Delete the *last* page — the one a length-truncated read would hide.
    new File(dirUri, '1.png').delete();

    expect(await readCachedPages('note-1', 'pdflatex', 'src', 480)).toBeNull();
  });

  it('is a full miss when a page file exists but is zero bytes', async () => {
    const { writeCachedPages, readCachedPages } = await import('@/lib/latex/page-cache');
    const { File } = await import('expo-file-system');
    const { pdfCacheName } = await import('@/lib/latex/pdf-cache-key');

    await writeCachedPages('note-1', 'pdflatex', 'src', 480, PAGES);
    const dirUri = `/mock-cache/latex-pages/${pdfCacheName('note-1', 'pdflatex', 'src')}-w480`;
    const truncated = new File(dirUri, '0.png');
    truncated.write(new Uint8Array(0));

    expect(await readCachedPages('note-1', 'pdflatex', 'src', 480)).toBeNull();
  });
});

describe('key completeness', () => {
  it('does not read pages back at a different width', async () => {
    const { writeCachedPages, readCachedPages } = await import('@/lib/latex/page-cache');
    await writeCachedPages('note-1', 'pdflatex', 'src', 480, PAGES);
    expect(await readCachedPages('note-1', 'pdflatex', 'src', 560)).toBeNull();
  });

  it('does not read pages back for a different source', async () => {
    const { writeCachedPages, readCachedPages } = await import('@/lib/latex/page-cache');
    await writeCachedPages('note-1', 'pdflatex', 'src-a', 480, PAGES);
    expect(await readCachedPages('note-1', 'pdflatex', 'src-b', 480)).toBeNull();
  });

  it('does not read pages back for a different engine', async () => {
    const { writeCachedPages, readCachedPages } = await import('@/lib/latex/page-cache');
    await writeCachedPages('note-1', 'pdflatex', 'src', 480, PAGES);
    expect(await readCachedPages('note-1', 'xelatex', 'src', 480)).toBeNull();
  });

  it('does not read pages back for a different note id', async () => {
    const { writeCachedPages, readCachedPages } = await import('@/lib/latex/page-cache');
    await writeCachedPages('note-1', 'pdflatex', 'src', 480, PAGES);
    expect(await readCachedPages('note-2', 'pdflatex', 'src', 480)).toBeNull();
  });
});

describe('writeCachedPages failure reporting', () => {
  it('returns false when the write throws partway through', async () => {
    const { writeCachedPages, readCachedPages } = await import('@/lib/latex/page-cache');
    const { File } = await import('expo-file-system');

    // Fails while writing the second page — after some bytes have already
    // landed, which is the case the caller actually needs to know about.
    let calls = 0;
    const spy = vi.spyOn(File.prototype, 'write').mockImplementation(function (
      this: InstanceType<typeof File>,
      data: Uint8Array | string,
    ) {
      calls++;
      if (calls === 2) throw new Error('disk full');
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      store.set(this.uri, { type: 'file', bytes });
    });

    const ok = await writeCachedPages('note-1', 'pdflatex', 'src', 480, PAGES);
    expect(ok).toBe(false);

    spy.mockRestore();
    // The half-written set must not be readable either.
    expect(await readCachedPages('note-1', 'pdflatex', 'src', 480)).toBeNull();
  });
});

describe('writeCachedPagesError / readCachedPagesError round trip', () => {
  it("round-trips the server's own sentence", async () => {
    const { writeCachedPagesError, readCachedPagesError } = await import('@/lib/latex/page-cache');
    await writeCachedPagesError('note-1', 'pdflatex', 'src', 480, '40 pages is too long to preview.');
    expect(await readCachedPagesError('note-1', 'pdflatex', 'src', 480)).toBe(
      '40 pages is too long to preview.',
    );
  });

  it('does not store an empty or whitespace-only reason', async () => {
    const { writeCachedPagesError } = await import('@/lib/latex/page-cache');
    const before = store.size;
    await writeCachedPagesError('note-1', 'pdflatex', 'src', 480, '   ');
    // Nothing at all should have been created for it — not even the entry
    // directory — so this can't pass by accident of the read side also
    // guarding against a blank reason.
    expect(store.size).toBe(before);
  });

  it('is null for a source that has never refused', async () => {
    const { readCachedPagesError } = await import('@/lib/latex/page-cache');
    expect(await readCachedPagesError('note-1', 'pdflatex', 'src', 480)).toBeNull();
  });

  it('does not read a refusal written for a different source', async () => {
    const { writeCachedPagesError, readCachedPagesError } = await import('@/lib/latex/page-cache');
    await writeCachedPagesError('note-1', 'pdflatex', 'src-a', 480, 'too long');
    expect(await readCachedPagesError('note-1', 'pdflatex', 'src-b', 480)).toBeNull();
  });
});
