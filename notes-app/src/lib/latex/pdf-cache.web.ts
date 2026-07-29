/**
 * Web side of the compiled-PDF cache — see `pdf-cache.ts` for why it exists and
 * what it guarantees. Same names, same entries, different store.
 *
 * The Cache Storage API is the right shelf for this: it holds Responses (bytes
 * plus a content type) keyed by URL, it survives a reload and a tab close, and
 * the browser may evict it under storage pressure — which is exactly the licence
 * derived data should give. OPFS would work too, but its main-thread write API
 * isn't dependable across browsers, and IndexedDB would mean a schema for what
 * is really just "these bytes, under this name".
 *
 * The keys are URLs on a domain that doesn't exist and is never fetched; `put`
 * stores the response we hand it rather than requesting anything. Cache Storage
 * needs a secure context, so `caches` can be missing (an insecure origin, some
 * private-browsing modes) — every path here degrades to "no cache", which just
 * means compiling again.
 */
import { pdfCacheName, pdfCachePrefix } from '@/lib/latex/pdf-cache-key';

const CACHE_NAME = 'w-notes-latex-pdf-v1';

/** Entry URL. The host is a placeholder — nothing ever resolves it. */
function entryUrl(name: string): string {
  return `https://latex-pdf.w-notes.invalid/${name}`;
}

async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open(CACHE_NAME);
  } catch (e) {
    console.warn('[pdf-cache] cache storage is unavailable:', e);
    return null;
  }
}

/** The PDF previously compiled from exactly this source, if it's still around. */
export async function readCachedPdf(
  noteId: string,
  engine: string,
  source: string,
): Promise<Uint8Array | null> {
  const cache = await openCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(entryUrl(`${pdfCacheName(noteId, engine, source)}.pdf`));
    if (!hit) return null;
    const buffer = await hit.arrayBuffer();
    return buffer.byteLength > 0 ? new Uint8Array(buffer) : null;
  } catch (e) {
    console.warn('[pdf-cache] could not read a cached pdf:', e);
    return null;
  }
}

/** Store a freshly compiled PDF, replacing whatever this resume cached before. */
export async function writeCachedPdf(
  noteId: string,
  engine: string,
  source: string,
  pdf: Uint8Array,
): Promise<void> {
  const cache = await openCache();
  if (!cache) return;
  try {
    const url = entryUrl(`${pdfCacheName(noteId, engine, source)}.pdf`);
    // Only the current source is worth keeping — a resume's older PDFs are dead
    // weight the moment it's edited, so one entry per resume is the whole policy.
    const prefix = entryUrl(pdfCachePrefix(noteId));
    for (const request of await cache.keys()) {
      if (request.url.startsWith(prefix) && request.url !== url) await cache.delete(request);
    }

    // Copy into a plain ArrayBuffer: the bytes may be a view into a larger
    // buffer, and Response would otherwise store the whole thing.
    const body = pdf.slice().buffer;
    await cache.put(url, new Response(body, { headers: { 'Content-Type': 'application/pdf' } }));
  } catch (e) {
    console.warn('[pdf-cache] could not cache a compiled pdf:', e);
  }
}
