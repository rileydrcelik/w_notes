import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { Sentry } from '@/lib/sentry';
import { db } from '@/lib/db';
import { isDbLockedError } from '@/lib/web-db-lock';
import { importDroppedFile, importPickedFile, type DroppedFile } from '@/lib/copa-files';
import { plainTextToHtml } from '@/lib/html-text';
import { requestSync, subscribeSynced, syncNow } from '@/lib/sync/sync-engine';
import type { CopaItem } from '@/data/copa';

const rid = () => `copa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Label for a pasted text block: its first non-empty line, trimmed to something
 * that fits a card header. A single-line paste (a URL, a key) would only repeat
 * itself in the header, so that gets a generic label instead.
 */
const pastedLabel = (text: string): string => {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return 'Pasted text';
  return lines[0].length > 60 ? `${lines[0].slice(0, 59)}…` : lines[0];
};

/** Reports a failed background persist without disturbing the optimistic UI. */
const syncFailed = (e: unknown) => {
  console.warn('[copa] background sync failed:', e);
  Sentry.captureException(e, { tags: { source: 'copa-store' } });
};

/**
 * How soon a copa change kicks off a sync. Copa is a cross-device clipboard, so
 * it should reach other devices right away — far shorter than the notes typing
 * debounce, but non-zero so a burst still coalesces and the trailing edit lands.
 */
const COPA_SYNC_MS = 150;

/**
 * Persist a write optimistically, then sync as soon as it commits. Scheduling the
 * sync *after* the write (rather than firing it immediately, debounced) means the
 * dirty row is already in the DB when the push reads it — no waiting a full
 * debounce for the change to go out. Module-scoped (not a hook dep).
 */
const persist = (write: Promise<unknown>) => {
  write.then(() => requestSync(COPA_SYNC_MS)).catch(syncFailed);
};

type CopaContextValue = {
  items: CopaItem[];
  getCopa: (id: string) => CopaItem | undefined;
  /** Creates an empty copy block and returns its id. */
  createCopa: () => string;
  /**
   * Prompts to pick a file, imports it into a new file block, and returns the
   * new block's id — or `null` if the user cancelled the picker.
   */
  createFileCopa: () => Promise<string | null>;
  /**
   * Creates a text block already filled with `text` (a clipboard paste or a
   * dropped selection) and returns its id.
   */
  createTextCopa: (text: string) => string;
  /**
   * Creates a file block from a file the platform already handed over — a paste
   * or a drag-and-drop rather than the picker. Returns the new block's id, or
   * `null` if the file was rejected (over the size cap, or native).
   */
  createDroppedFileCopa: (file: DroppedFile) => Promise<string | null>;
  updateCopa: (id: string, patch: Partial<Pick<CopaItem, 'label' | 'content'>>) => void;
  /** Removes a copy block permanently. */
  deleteCopa: (id: string) => void;
  /** Flips the favorite flag on a copy block. */
  toggleFavorite: (id: string) => void;
};

const CopaContext = createContext<CopaContextValue | null>(null);

/**
 * Holds the live, editable copy blocks. Hydrates from on-device SQLite on mount,
 * then applies optimistic local updates while writing each change through to it.
 */
export function CopaProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CopaItem[]>([]);

  // Re-read the copa feed from SQLite (hydrate on mount + refresh after sync).
  const reload = useCallback(async () => {
    try {
      setItems(await db.listCopa());
    } catch (e) {
      // Follower tab without DB access (DbTabGuard covers this); not an error.
      if (isDbLockedError(e)) return;
      console.warn('[copa] failed to load from device:', e);
      Sentry.captureException(e, { tags: { source: 'copa-store', op: 'bootstrap' } });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async hydrate
    void reload().then(() => syncNow().catch(() => {}));
  }, [reload]);

  // Refresh when a sync applies remote changes, and sync on app foreground.
  useEffect(() => {
    const unsub = subscribeSynced(() => void reload());
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void syncNow().catch(() => {});
    });
    return () => {
      unsub();
      sub.remove();
    };
  }, [reload]);

  const createCopa = useCallback<CopaContextValue['createCopa']>(() => {
    const id = rid();
    // Prepend so the new block surfaces first in the feed.
    setItems((prev) => [{ id, label: '', content: '' }, ...prev]);
    persist(db.createCopa({ id }));
    return id;
  }, []);

  const createFileCopa = useCallback<CopaContextValue['createFileCopa']>(async () => {
    const id = rid();
    // Pick + copy the file into the document dir before touching state, so a
    // cancel (null) leaves no empty block behind.
    const file = await importPickedFile(id);
    if (!file) return null;
    const label = file.fileName ?? '';
    setItems((prev) => [{ id, label, content: '', ...file }, ...prev]);
    persist(db.createCopa({ id, label, file }));
    return id;
  }, []);

  const createTextCopa = useCallback<CopaContextValue['createTextCopa']>((text) => {
    const id = rid();
    const label = pastedLabel(text);
    // Bodies are rich-text HTML everywhere, so wrap the incoming plain text
    // rather than storing it raw (the editor would show escaped markup).
    const content = plainTextToHtml(text);
    setItems((prev) => [{ id, label, content }, ...prev]);
    persist(db.createCopa({ id, label, content }));
    return id;
  }, []);

  const createDroppedFileCopa = useCallback<CopaContextValue['createDroppedFileCopa']>(
    async (dropped) => {
      const id = rid();
      // Same shape as the picker path: import first, so a rejected file (over
      // the size cap) leaves no empty block behind.
      const file = await importDroppedFile(id, dropped);
      if (!file) return null;
      const label = file.fileName ?? '';
      setItems((prev) => [{ id, label, content: '', ...file }, ...prev]);
      persist(db.createCopa({ id, label, file }));
      return id;
    },
    [],
  );

  const updateCopa = useCallback<CopaContextValue['updateCopa']>((id, patch) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    persist(db.updateCopa(id, patch));
  }, []);

  const deleteCopa = useCallback<CopaContextValue['deleteCopa']>((id) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    persist(db.deleteCopa(id));
  }, []);

  const toggleFavorite = useCallback<CopaContextValue['toggleFavorite']>(
    (id) => {
      const next = !items.find((item) => item.id === id)?.favorite;
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, favorite: next } : item)),
      );
      persist(db.updateCopa(id, { favorite: next }));
    },
    [items],
  );

  const value = useMemo<CopaContextValue>(
    () => ({
      items,
      getCopa: (id) => items.find((item) => item.id === id),
      createCopa,
      createFileCopa,
      createTextCopa,
      createDroppedFileCopa,
      updateCopa,
      deleteCopa,
      toggleFavorite,
    }),
    [
      items,
      createCopa,
      createFileCopa,
      createTextCopa,
      createDroppedFileCopa,
      updateCopa,
      deleteCopa,
      toggleFavorite,
    ],
  );

  return <CopaContext.Provider value={value}>{children}</CopaContext.Provider>;
}

export function useCopa(): CopaContextValue {
  const ctx = useContext(CopaContext);
  if (!ctx) throw new Error('useCopa must be used within a CopaProvider');
  return ctx;
}
