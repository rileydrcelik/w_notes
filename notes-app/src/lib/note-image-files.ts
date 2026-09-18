/**
 * Getting a picture ready to live in a note, on a device.
 *
 * Capture normalizes before anything is stored: a phone screenshot is 1–4 MB,
 * and a note's images are uploaded one at a time by the sync pass, so a handful
 * of untouched screenshots turns every pass into a long transfer. Everything is
 * re-encoded to at most `MAX_IMAGE_DIMENSION` on its long edge.
 *
 * Bytes are named after the image's id, under their own directory, because the
 * body references an image by id alone — so the path is its own lookup table and
 * a device path never has to be written into a body that syncs. Note that copa's
 * equivalent (`copaDestination`) deletes whatever is already at the path: right
 * for a block that holds one file, wrong here, where one note holds several.
 *
 * Paired with `note-image-files.web.ts`, which must export the same names —
 * `lib/__tests__/platform-parity.test.ts` enforces that, and a missing native
 * stub once cost three days of a dead app on device.
 */
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

/** Longest edge an inserted image is stored at. Sharp on any screen the app
 *  runs on, including a desktop browser, without carrying a 12MP original. */
export const MAX_IMAGE_DIMENSION = 2048;

/** Refuse anything above this outright, before decoding it. */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

const IMAGE_DIR = 'note-images';

/** What capture hands the store: bytes on disk plus what the row needs. */
export type CapturedImage = {
  localUri: string;
  mimeType: string;
  fileSize: number | null;
  width: number;
  height: number;
};

function imageDirectory(): Directory {
  const dir = new Directory(Paths.document, IMAGE_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/** Where this image's bytes live on this device. Not exported: the web pair has
 *  no filesystem to match it with, and the two must export the same names. */
function noteImageFile(id: string): File {
  return new File(imageDirectory(), id);
}

/**
 * Re-encode a picked or pasted image down to a sane size and store it under
 * `id`. Returns null when the source can't be read at all — capture is a user
 * gesture, and a failure should leave the note untouched rather than throw
 * through the editor.
 */
export async function captureNoteImage(
  id: string,
  sourceUri: string,
): Promise<CapturedImage | null> {
  try {
    const context = ImageManipulator.manipulate(sourceUri);
    // One value only, so the aspect ratio is kept. Resizing *up* a small image
    // would cost bytes and add nothing, so the cap is applied by rendering once
    // and resizing only when it is actually over.
    const probe = await context.renderAsync();
    const longest = Math.max(probe.width, probe.height);
    const rendered =
      longest > MAX_IMAGE_DIMENSION
        ? await ImageManipulator.manipulate(sourceUri)
            .resize(
              probe.width >= probe.height
                ? { width: MAX_IMAGE_DIMENSION }
                : { height: MAX_IMAGE_DIMENSION },
            )
            .renderAsync()
        : probe;

    // JPEG at a high quality: a screenshot of text stays legible, and it avoids
    // PNG's habit of making a photo bigger than the original.
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
    const destination = noteImageFile(id);
    const source = new File(saved.uri);
    // `copy` rather than `move`: the manipulator's output lives in the cache
    // directory, which the OS may reclaim, and a copy leaves the original for it
    // to collect in its own time.
    source.copy(destination);
    return {
      localUri: destination.uri,
      mimeType: 'image/jpeg',
      fileSize: destination.size ?? null,
      width: saved.width,
      height: saved.height,
    };
  } catch {
    return null;
  }
}

/**
 * Ask the user for an image and return its source uri.
 *
 * `expo-document-picker` rather than `expo-image-picker`: it is already in the
 * binary, and it needs no photo-library permission on either platform because
 * the system picker is the thing granting access. The gallery is reachable from
 * it as a source.
 */
export async function pickNoteImage(): Promise<string | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'image/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  if (asset.size != null && asset.size > MAX_IMAGE_BYTES) return null;
  return asset.uri;
}

/** Where a downloaded image's bytes should be written. */
export function noteImageDestination(id: string): File {
  const file = noteImageFile(id);
  // A download replaces whatever is here: same id, same bytes, so an interrupted
  // earlier attempt is the only thing this can be standing on.
  if (file.exists) file.delete();
  return file;
}

/** Drop an image's bytes from disk. Best-effort — a missing file is the goal. */
export function removeNoteImageBytes(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Nothing to do: the bytes are gone either way.
  }
}

/**
 * An image's bytes as a `data:` URI, for an export that has to stand on its own.
 * Null when the bytes aren't on this device.
 */
export async function readNoteImageDataUri(
  uri: string,
  mimeType: string | null,
): Promise<string | null> {
  try {
    const file = new File(uri);
    if (!file.exists) return null;
    return `data:${mimeType || 'image/jpeg'};base64,${await file.base64()}`;
  } catch {
    return null;
  }
}
