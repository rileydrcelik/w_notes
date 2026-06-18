/**
 * Type for the copa (copy/paste) feed. Each item is either a labelled text
 * snippet whose contents copy to the clipboard with a single tap, or a file
 * attachment (any format) that opens/shares on tap.
 *
 * The live data lives in the copa store (`@/store/copa-store`), which hydrates
 * from and persists changes to on-device SQLite (`@/lib/db`).
 *
 * A block is a *file block* when `fileUri` is set. File bytes are stored locally
 * in the app's document directory (`@/lib/copa-files`) and are not synced — only
 * the row's label/favorite travel between devices.
 */

export type CopaItem = {
  id: string;
  label: string;
  content: string;
  favorite?: boolean;
  /** Persistent on-device uri of the attached file (file blocks only). */
  fileUri?: string;
  /** Original file name, including extension. */
  fileName?: string;
  /** File MIME type, e.g. `application/pdf` (may be absent on some pickers). */
  mimeType?: string;
  /** File size in bytes. */
  fileSize?: number;
  /**
   * Generated thumbnail uri for video files. Images reuse `fileUri` directly;
   * other types fall back to a file-type icon, so this stays undefined.
   */
  thumbUri?: string;
};
