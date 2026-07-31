/**
 * Names for cached PDFs, shared by both halves of `pdf-cache` so a file written
 * on one platform is looked up the same way on the other.
 *
 * A cache entry is identified by *what was compiled*, not by when: the name
 * carries a fingerprint of the LaTeX source, so a resume you haven't touched
 * hits its cached PDF forever, and one character of an edit misses and compiles.
 * That's the whole invalidation story — there is no expiry, because a stale
 * entry is impossible by construction.
 *
 * The note id is in the name too, so eviction can find every entry belonging to
 * one resume by prefix (a compile keeps only the newest). It's sanitised for use
 * as a filename and followed by a fingerprint of the raw id, so two ids that
 * sanitise alike still get separate entries.
 */

/**
 * cyrb53 — a 53-bit string hash. Not cryptographic, and it doesn't need to be:
 * the cost of a collision is one wrong preview, and at 2^53 buckets over the
 * handful of versions a resume ever has, it won't happen. Crypto digests are
 * async and platform-split (`crypto.subtle` on web, expo-crypto on native),
 * which would push async work into a hot render path for no real gain.
 */
function cyrb53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** A short, filename-safe fingerprint of a string. Length is folded in too. */
export function fingerprint(text: string): string {
  return `${cyrb53(text).toString(36)}${text.length.toString(36)}`;
}

/** Every cache entry for one resume starts with this. */
export function pdfCachePrefix(noteId: string): string {
  const safe = noteId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
  return `${safe}-${fingerprint(noteId)}-`;
}

/**
 * The entry holding the PDF compiled from exactly this source, by exactly this
 * engine.
 *
 * The engine is part of the identity because it is part of the output: the same
 * LaTeX under pdfLaTeX and XeLaTeX gives different fonts and a different page
 * count — that is the whole reason both are offered. Keyed on source alone,
 * switching engine would serve back the other one's PDF and look like the
 * switch had done nothing.
 */
export function pdfCacheName(noteId: string, engine: string, source: string): string {
  return `${pdfCachePrefix(noteId)}${engine}-${fingerprint(source)}`;
}
