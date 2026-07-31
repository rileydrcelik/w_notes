/**
 * Native side of the compiled-PDF cache: files under the app's cache directory.
 *
 * Compiling a resume is a network round trip and seconds of TeX, and reopening
 * one you haven't edited would otherwise pay for both every single time. So a
 * successful compile writes its PDF here, keyed by a fingerprint of the source
 * (see `pdf-cache-key.ts`), and opening a resume looks there first — the preview
 * and the navbar's download appear immediately, with no server involved.
 *
 * It lives in the *cache* directory on purpose: the bytes are derived data that
 * a compile can always reproduce, so the OS is welcome to reclaim them, and they
 * stay out of any backup. Nothing here touches the synced database — a PDF is an
 * output, not content, and syncing megabytes of it would be a bug.
 *
 * Every path swallows its own failures. A cache that can't be read or written is
 * a slow app, never a broken one.
 *
 * The web half (`pdf-cache.web.ts`) stores the same entries under the same names
 * in the Cache Storage API. Both files must export the same names — a missing
 * native counterpart is exactly the kind of thing that passes every test and
 * then fails to launch on a device.
 */
import { Directory, File, Paths } from 'expo-file-system';

import { pdfCacheName, pdfCachePrefix } from '@/lib/latex/pdf-cache-key';

/** Subdirectory under the cache dir holding compiled resumes. */
const CACHE_DIR = 'latex-pdf';

function cacheDir(): Directory {
  const dir = new Directory(Paths.cache, CACHE_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/** The PDF previously compiled from exactly this source, if it's still around. */
export async function readCachedPdf(
  noteId: string,
  engine: string,
  source: string,
): Promise<Uint8Array | null> {
  try {
    const file = new File(cacheDir(), `${pdfCacheName(noteId, engine, source)}.pdf`);
    if (!file.exists) return null;
    const bytes = await file.bytes();
    // A zero-length file means a write was interrupted; treat it as a miss.
    return bytes.length > 0 ? bytes : null;
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
  try {
    const dir = cacheDir();
    const name = `${pdfCacheName(noteId, engine, source)}.pdf`;
    // Only the current source is worth keeping — a resume's older PDFs are dead
    // weight the moment it's edited, so one entry per resume is the whole policy.
    const prefix = pdfCachePrefix(noteId);
    for (const entry of dir.list()) {
      if (entry instanceof File && entry.name.startsWith(prefix) && entry.name !== name) {
        entry.delete();
      }
    }

    const file = new File(dir, name);
    if (file.exists) file.delete();
    file.create();
    file.write(pdf);
  } catch (e) {
    console.warn('[pdf-cache] could not cache a compiled pdf:', e);
  }
}
