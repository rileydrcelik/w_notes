import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { db } from '@/lib/db';
import type { CopaItem } from '@/data/copa';

const rid = () => `copa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const syncFailed = (e: unknown) => console.warn('[copa] background sync failed:', e);

type CopaContextValue = {
  items: CopaItem[];
  getCopa: (id: string) => CopaItem | undefined;
  /** Creates an empty copy block and returns its id. */
  createCopa: () => string;
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

  useEffect(() => {
    let cancelled = false;
    db
      .listCopa()
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .catch((e) => console.warn('[copa] failed to load from API:', e));
    return () => {
      cancelled = true;
    };
  }, []);

  const createCopa = useCallback<CopaContextValue['createCopa']>(() => {
    const id = rid();
    // Prepend so the new block surfaces first in the feed.
    setItems((prev) => [{ id, label: '', content: '' }, ...prev]);
    db.createCopa({ id }).catch(syncFailed);
    return id;
  }, []);

  const updateCopa = useCallback<CopaContextValue['updateCopa']>((id, patch) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    db.updateCopa(id, patch).catch(syncFailed);
  }, []);

  const deleteCopa = useCallback<CopaContextValue['deleteCopa']>((id) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    db.deleteCopa(id).catch(syncFailed);
  }, []);

  const toggleFavorite = useCallback<CopaContextValue['toggleFavorite']>(
    (id) => {
      const next = !items.find((item) => item.id === id)?.favorite;
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, favorite: next } : item)),
      );
      db.updateCopa(id, { favorite: next }).catch(syncFailed);
    },
    [items],
  );

  const value = useMemo<CopaContextValue>(
    () => ({
      items,
      getCopa: (id) => items.find((item) => item.id === id),
      createCopa,
      updateCopa,
      deleteCopa,
      toggleFavorite,
    }),
    [items, createCopa, updateCopa, deleteCopa, toggleFavorite],
  );

  return <CopaContext.Provider value={value}>{children}</CopaContext.Provider>;
}

export function useCopa(): CopaContextValue {
  const ctx = useContext(CopaContext);
  if (!ctx) throw new Error('useCopa must be used within a CopaProvider');
  return ctx;
}
