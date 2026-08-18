/**
 * Cached page images for a compiled resume — the native preview's equivalent of
 * `pdf-cache.ts`.
 *
 * A phone can't draw a PDF, so the server draws it and sends one PNG per page.
 * Those images cost a compile and a few hundred KB over the wire, and reopening
 * an unedited resume would otherwise pay for both every time. So they're kept
 * beside the PDF cache, under the same fingerprinting.
 *
 * Two differences from `pdf-cache.ts`, and both are the reason this is its own
 * module rather than more fields on that one:
 *
 * - **Width is part of the identity.** A PDF is a PDF, but a page image is only
 *   right for the width it was drawn at. Sharing a key with the PDF would serve
 *   a phone the tablet's pages, or hand back yesterday's narrow ones after a
 *   rotation, at a size nothing would look right at.
 * - **There is no web half, so there is no pair.** `platform-parity.test.ts`
 *   checks `.ts`/`.web.ts` siblings export the same names; an unsuffixed module
 *   with no sibling isn't a pair and needs no counterpart. Web renders the PDF
 *   with pdf.js and never asks for pages, so a web implementation would be dead
 *   code — and a stub that exists only to satisfy a test is how the *last*
 *   platform-pair incident started.
 *
 * Same posture as the PDF cache otherwise: the OS cache directory, because the
 * bytes are derived and reproducible; nothing here touches the synced database;
 * and every path swallows its own failures, because a cache that can't be read
 * makes a slow app, never a broken one.
 */
import { Directory, File, Paths } from 'expo-file-system';

import { pdfCacheName, pdfCachePrefix } from '@/lib/latex/pdf-cache-key';
import type { RenderedPage } from '@/lib/latex/types';

/** Subdirectory under the cache dir holding rendered pages. */
const CACHE_DIR = 'latex-pages';

/**
 * One resume's pages, at one width, are a *set* — so they live in their own
 * directory and are read back whole. A half-written set is indistinguishable
 * from a short document otherwise, and would render as a resume that lost its
 * last page.
 */
function entryDir(noteId: string, engine: string, source: string, width: number): Directory {
  return new Directory(
    new Directory(Paths.cache, CACHE_DIR),
    `${pdfCacheName(noteId, engine, source)}-w${width}`,
  );
}

/** How many pages a complete set claims to have, written last, as a marker. */
const MANIFEST = 'pages.json';

/**
 * Why this source has no pages, when the answer is "it never will".
 *
 * A missing set normally means nobody has fetched it yet, and the fix is to
 * compile. But the server also refuses outright for documents it won't
 * rasterise — one too long for `_MAX_RASTER_PAGES`, say — and that refusal is
 * deterministic: the same source asked again gets the same no, after a full TeX
 * run. Without somewhere to write that down, "no pages cached" is
 * indistinguishable from "not fetched yet", and every open of such a resume pays
 * for a compile to be told the same thing.
 *
 * So the refusal is cached like a result, because it is one. It is keyed by
 * source like everything else here, so editing the resume — shortening the very
 * document that was too long — asks again with a clean slate.
 */
const PAGES_ERROR = 'pages-error.txt';

/**
 * The pages previously rendered for exactly this source at exactly this width.
 * `null` for a miss, including a set that was interrupted mid-write.
 */
export async function readCachedPages(
  noteId: string,
  engine: string,
  source: string,
  width: number,
): Promise<RenderedPage[] | null> {
  try {
    const dir = entryDir(noteId, engine, source, width);
    if (!dir.exists) return null;
    const manifest = new File(dir, MANIFEST);
    // Written last, so its absence means the set never finished.
    if (!manifest.exists) return null;
    const meta = JSON.parse(await manifest.text()) as { width: number; height: number }[];
    if (!Array.isArray(meta) || meta.length === 0) return null;

    const pages: RenderedPage[] = [];
    for (let i = 0; i < meta.length; i++) {
      const file = new File(dir, `${i}.png`);
      if (!file.exists) return null; // incomplete set — recompile rather than show a gap
      const png = await file.bytes();
      if (png.length === 0) return null;
      pages.push({ width: meta[i].width, height: meta[i].height, png });
    }
    return pages;
  } catch (e) {
    console.warn('[page-cache] could not read cached pages:', e);
    return null;
  }
}

/**
 * Store a freshly rendered set, replacing whatever this resume cached before.
 *
 * Returns whether the set actually landed. The caller needs that answer rather
 * than a fire-and-forget promise, because the preview is handed `file://` URIs
 * into this directory — if the write died halfway, those URIs name files that
 * aren't there, and the screen draws blank sheets for a resume it could have
 * simply offered to download. A cache that can't be written should make the app
 * slower, never emptier.
 */
export async function writeCachedPages(
  noteId: string,
  engine: string,
  source: string,
  width: number,
  pages: RenderedPage[],
): Promise<boolean> {
  if (pages.length === 0) return false;
  try {
    const root = new Directory(Paths.cache, CACHE_DIR);
    if (!root.exists) root.create({ intermediates: true });

    // One set per resume, like the PDF cache: older sources and older widths are
    // dead weight the moment either changes.
    const dir = entryDir(noteId, engine, source, width);
    const prefix = pdfCachePrefix(noteId);
    for (const entry of root.list()) {
      if (entry instanceof Directory && entry.name.startsWith(prefix) && entry.name !== dir.name) {
        entry.delete();
      }
    }

    if (dir.exists) dir.delete();
    dir.create({ intermediates: true });
    pages.forEach((page, i) => {
      const file = new File(dir, `${i}.png`);
      file.create();
      file.write(page.png);
    });
    // Last, so a set is only ever readable once every page is on disk.
    const manifest = new File(dir, MANIFEST);
    manifest.create();
    manifest.write(JSON.stringify(pages.map((p) => ({ width: p.width, height: p.height }))));
    return true;
  } catch (e) {
    console.warn('[page-cache] could not cache rendered pages:', e);
    return false;
  }
}

/**
 * Record that the server won't draw pages for this source, and why.
 *
 * The reason is the server's own sentence, kept verbatim: it is what the screen
 * shows, and it explains the resume in hand ("40 pages is too long to preview")
 * far better than anything this side could reconstruct from an empty list.
 */
export async function writeCachedPagesError(
  noteId: string,
  engine: string,
  source: string,
  width: number,
  reason: string,
): Promise<void> {
  if (!reason.trim()) return;
  try {
    const root = new Directory(Paths.cache, CACHE_DIR);
    if (!root.exists) root.create({ intermediates: true });
    const dir = entryDir(noteId, engine, source, width);
    if (!dir.exists) dir.create({ intermediates: true });
    const file = new File(dir, PAGES_ERROR);
    if (file.exists) file.delete();
    file.create();
    file.write(reason);
  } catch (e) {
    console.warn('[page-cache] could not cache the page-render refusal:', e);
  }
}

/**
 * The server's stated reason this source has no pages, or `null` if it has
 * never refused — including the ordinary case of a resume nobody has rendered
 * yet, which is a reason to compile rather than to give up.
 */
export async function readCachedPagesError(
  noteId: string,
  engine: string,
  source: string,
  width: number,
): Promise<string | null> {
  try {
    const dir = entryDir(noteId, engine, source, width);
    if (!dir.exists) return null;
    const file = new File(dir, PAGES_ERROR);
    if (!file.exists) return null;
    const reason = (await file.text()).trim();
    return reason.length > 0 ? reason : null;
  } catch (e) {
    console.warn('[page-cache] could not read the page-render refusal:', e);
    return null;
  }
}

/**
 * A `file://` URI per page, for handing to `expo-image`.
 *
 * Images go to the component as file paths rather than as base64 data URIs: a
 * data URI of a full-page PNG is a megabyte-ish string that has to be decoded on
 * the JS thread every render, where a file path is decoded natively and cached
 * by the image loader.
 */
export function cachedPageUris(
  noteId: string,
  engine: string,
  source: string,
  width: number,
  count: number,
): string[] {
  const dir = entryDir(noteId, engine, source, width);
  return Array.from({ length: count }, (_, i) => new File(dir, `${i}.png`).uri);
}
