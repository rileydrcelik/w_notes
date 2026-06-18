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
import { importPickedFile } from '@/lib/copa-files';
import { requestSync, subscribeSynced, syncNow } from '@/lib/sync/sync-engine';
import type { CopaItem } from '@/data/copa';

const rid = () => `copa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Reports a failed background persist without disturbing the optimistic UI. */
const syncFailed = (e: unknown) => {
  console.warn('[copa] background sync failed:', e);
  Sentry.captureException(e, { tags: { source: 'copa-store' } });
};

/** Persist a write optimistically + schedule a sync. Module-scoped (not a hook dep). */
const persist = (write: Promise<unknown>) => {
  write.catch(syncFailed);
  requestSync();
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
      updateCopa,
      deleteCopa,
      toggleFavorite,
    }),
    [items, createCopa, createFileCopa, updateCopa, deleteCopa, toggleFavorite],
  );

  return <CopaContext.Provider value={value}>{children}</CopaContext.Provider>;
}

export function useCopa(): CopaContextValue {
  const ctx = useContext(CopaContext);
  if (!ctx) throw new Error('useCopa must be used within a CopaProvider');
  return ctx;
}
