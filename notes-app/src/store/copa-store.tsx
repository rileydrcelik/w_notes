import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { seedCopaItems, type CopaItem } from '@/data/copa';

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
 * Holds the live, editable copy blocks, seeded from `@/data/copa`. State lives
 * in memory for the session; durable persistence will be backed by SQL later.
 */
export function CopaProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CopaItem[]>(seedCopaItems);

  const createCopa = useCallback<CopaContextValue['createCopa']>(() => {
    const id = `copa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Prepend so the new block surfaces first in the feed.
    setItems((prev) => [{ id, label: '', content: '' }, ...prev]);
    return id;
  }, []);

  const updateCopa = useCallback<CopaContextValue['updateCopa']>((id, patch) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const deleteCopa = useCallback<CopaContextValue['deleteCopa']>((id) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const toggleFavorite = useCallback<CopaContextValue['toggleFavorite']>((id) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, favorite: !item.favorite } : item)),
    );
  }, []);

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
