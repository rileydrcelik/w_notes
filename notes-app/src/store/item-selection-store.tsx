import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/** A selected note or folder card. */
export type SelectedItem = { type: 'note' | 'folder'; id: string };

type ItemSelectionValue = {
  /** Every currently selected card (order of selection). */
  selected: SelectedItem[];
  /** Convenience count of `selected`. */
  count: number;
  /** True while anything is selected — selection mode is on. */
  active: boolean;
  /** Whether this exact card is in the selection. */
  isSelected: (type: SelectedItem['type'], id: string) => boolean;
  /** Add the card if absent, remove it if present. First toggle enters selection mode. */
  toggle: (item: SelectedItem) => void;
  /** Exit selection mode and drop every selection. */
  clear: () => void;
};

const ItemSelectionContext = createContext<ItemSelectionValue | null>(null);

/**
 * Cross-tree state for "select note/folder cards → act on them from the navbar".
 * A long-press/right-click enters selection mode; while it's on, tapping cards
 * toggles them, so several can be picked at once. The global floating navbar
 * reads the selection to surface a "⋯" button that opens the shared options
 * sheet for the whole set (favorite / move / share / delete N items). Lifting it
 * here (rather than into a screen) is what lets those distant components talk —
 * same pattern as `sidebar-store` / `autofix-selection-store`.
 *
 * Selection is intentionally ephemeral (in memory only): it never touches the
 * SQLite/sync path.
 */
export function ItemSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<SelectedItem[]>([]);

  const toggle = useCallback((item: SelectedItem) => {
    setSelected((prev) => {
      const exists = prev.some((s) => s.type === item.type && s.id === item.id);
      return exists
        ? prev.filter((s) => !(s.type === item.type && s.id === item.id))
        : [...prev, item];
    });
  }, []);

  const clear = useCallback(() => setSelected([]), []);
  const isSelected = useCallback(
    (type: SelectedItem['type'], id: string) =>
      selected.some((s) => s.type === type && s.id === id),
    [selected],
  );

  const value = useMemo<ItemSelectionValue>(
    () => ({
      selected,
      count: selected.length,
      active: selected.length > 0,
      isSelected,
      toggle,
      clear,
    }),
    [selected, isSelected, toggle, clear],
  );

  return <ItemSelectionContext.Provider value={value}>{children}</ItemSelectionContext.Provider>;
}

export function useItemSelection(): ItemSelectionValue {
  const ctx = useContext(ItemSelectionContext);
  if (!ctx) throw new Error('useItemSelection must be used within an ItemSelectionProvider');
  return ctx;
}
