/**
 * Turning "the user produced an image" into a row and something an editor can
 * draw — the one path all four entry points share (paste on web, Ctrl+I on web,
 * paste on a phone, the formatting bar's insert button).
 *
 * The order matters. The row is written before the body that references it: an
 * image nothing points at is a leak the sweep collects, while a body pointing at
 * an image with no row is a picture that can never be resolved on any device.
 */
import { db } from '@/lib/db';
import { captureNoteImage } from '@/lib/note-image-files';
import type { NoteImageIndex } from '@/lib/note-images';
import { Sentry } from '@/lib/sentry';

/** A freshly inserted image, ready for the editor to place. */
export type InsertedImage = {
  id: string;
  /** This device's path to the bytes — what the editor is given to render. */
  uri: string;
  /** Intrinsic size after downscaling. */
  width: number;
  height: number;
};

function imageId(): string {
  // Same shape as the ids elsewhere in the app; it only has to be unique and
  // safe inside an attribute value, because it travels in the body's `src`.
  return `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Normalize, store and record one image, adding it to `index` so the editor's
 * next serialize can turn its path back into a reference.
 *
 * Returns null when the source can't be read or stored. Insertion is a user
 * gesture in the middle of typing: failing quietly and leaving the note exactly
 * as it was beats throwing through an editor's paste handler.
 */
export async function insertNoteImage(
  sourceUri: string,
  index: NoteImageIndex,
): Promise<InsertedImage | null> {
  const id = imageId();
  const captured = await captureNoteImage(id, sourceUri);
  if (!captured) return null;

  try {
    await db.createNoteImage({
      id,
      localUri: captured.localUri,
      mimeType: captured.mimeType,
      fileSize: captured.fileSize,
      width: captured.width,
      height: captured.height,
    });
  } catch (e) {
    // No row means nothing could ever resolve this picture, so don't put one in
    // the body: leave the note untouched rather than showing a broken image.
    Sentry.captureException(e, { tags: { source: 'note-image', op: 'create' } });
    return null;
  }

  index.set(id, { uri: captured.localUri, width: captured.width, height: captured.height });
  return { id, uri: captured.localUri, width: captured.width, height: captured.height };
}
