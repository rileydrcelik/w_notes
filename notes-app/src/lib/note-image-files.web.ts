/**
 * Web counterpart of the note-image capture helpers.
 *
 * There is no filesystem here. Bytes live in S3 and, for this page's lifetime,
 * behind an object URL — the same arrangement copa attachments use, including
 * the part where a reload mints new URLs and the old ones are cleared at
 * database open (`clearEphemeralFilePaths` in lib/db.ts).
 *
 * Downscaling is a canvas draw rather than a native module, but the policy is
 * the same one native applies, and deliberately so: the stored bytes have to be
 * the same whichever device pasted the screenshot.
 *
 * Exports must match `note-image-files.ts` name for name — see
 * `lib/__tests__/platform-parity.test.ts`.
 */

/** Longest edge an inserted image is stored at. */
export const MAX_IMAGE_DIMENSION = 2048;

/** Refuse anything above this outright, before decoding it. */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

export type CapturedImage = {
  localUri: string;
  mimeType: string;
  fileSize: number | null;
  width: number;
  height: number;
};

/** Decode a blob, which is the only way to learn its real dimensions. */
function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image decode failed'));
    image.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Re-encode a pasted or picked image down to a sane size and hand back an object
 * URL for it. `id` is unused here — an object URL is opaque and carries no name
 * — but native stores the bytes under it, and the pair has to take the same
 * arguments. Returns null if the source can't be decoded: capture is a user
 * gesture and a failure should leave the note untouched.
 */
export async function captureNoteImage(
  id: string,
  sourceUri: string,
): Promise<CapturedImage | null> {
  void id;
  try {
    const image = await load(sourceUri);
    const longest = Math.max(image.naturalWidth, image.naturalHeight);
    const scale = longest > MAX_IMAGE_DIMENSION ? MAX_IMAGE_DIMENSION / longest : 1;
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);

    const blob = await toBlob(canvas, 'image/jpeg', 0.85);
    if (!blob) return null;
    return {
      localUri: URL.createObjectURL(blob),
      mimeType: 'image/jpeg',
      fileSize: blob.size,
      width,
      height,
    };
  } catch {
    return null;
  }
}

/**
 * Ask the user for an image and return an object URL for it.
 *
 * A hidden `<input type="file">` clicked programmatically — the only way a page
 * can open a file dialog, and it has to happen inside the user gesture that
 * called this, which a keyboard shortcut handler is.
 */
export function pickNoteImage(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      if (file.size > MAX_IMAGE_BYTES) return finish(null);
      finish(URL.createObjectURL(file));
    };
    // A cancelled dialog fires `cancel` in modern browsers; without it the
    // promise would never settle and the caller would wait for ever.
    input.oncancel = () => finish(null);
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Native writes a downloaded image to a path named after its id; here the caller
 * mints an object URL from the bytes instead, so there is no destination to
 * prepare. Present because the pair must match name for name.
 */
export function noteImageDestination(id: string): null {
  void id;
  return null;
}

/** Release an object URL. The browser frees the bytes with it. */
export function removeNoteImageBytes(uri: string): void {
  try {
    if (uri.startsWith('blob:')) URL.revokeObjectURL(uri);
  } catch {
    // Already revoked, or a URL from a dead document — nothing to do.
  }
}

/**
 * An image's bytes as a `data:` URI, for an export that has to stand on its own.
 * Null when the bytes aren't in this session (an object URL from a page that has
 * since reloaded, or an image whose download hasn't happened yet).
 */
export async function readNoteImageDataUri(
  uri: string,
  mimeType: string | null,
): Promise<string | null> {
  try {
    const response = await fetch(uri);
    if (!response.ok) return null;
    const blob = await response.blob();
    const encoded = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
    if (!encoded) return null;
    // FileReader stamps the blob's own type, which for a revived object URL can
    // be empty; the row's mime type is the better answer where we have one.
    return mimeType ? encoded.replace(/^data:[^;]*;/, `data:${mimeType};`) : encoded;
  } catch {
    return null;
  }
}
