/**
 * Type for the copa (copy/paste) feed. Each item is a labelled snippet whose
 * contents can be copied to the clipboard with a single tap.
 *
 * The live data lives in the copa store (`@/store/copa-store`), which hydrates
 * from and persists changes to on-device SQLite (`@/lib/db`).
 */

export type CopaItem = {
  id: string;
  label: string;
  content: string;
  favorite?: boolean;
};
