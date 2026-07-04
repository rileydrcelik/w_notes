import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type SelectionHandler = (ids: string[]) => void;

type AutofixSelectionValue = {
  /** Whether issue-selection mode is active (a long-press/right-click turned it on). */
  active: boolean;
  /** Ids of the currently selected issues. */
  selectedIds: string[];
  /** Convenience count of `selectedIds`. */
  count: number;
  isSelected: (id: string) => boolean;
  /** Toggle an issue; the first toggle also enters selection mode. */
  toggle: (id: string) => void;
  /** Exit selection mode and drop every selection. */
  clear: () => void;
  /** The Sentry screen registers what "Fix" does; pass null on unmount. */
  registerFixHandler: (fn: SelectionHandler | null) => void;
  /** The Sentry screen registers what "Ignore" does (resolve in Sentry); null on unmount. */
  registerIgnoreHandler: (fn: SelectionHandler | null) => void;
  /** Invoked by the navbar's Fix action — runs the registered fix handler on the selection. */
  requestFix: () => void;
  /** Invoked by the navbar's Ignore action — resolves the selected issues in Sentry. */
  requestIgnore: () => void;
};

const AutofixSelectionContext = createContext<AutofixSelectionValue | null>(null);

/**
 * Cross-tree state for the Sentry "select errors → Fix" flow. The Sentry issues
 * screen drives the selection (long-press/right-click), while the global floating
 * navbar reads it to swap its create (+) button for a Fix button. Lifting it here
 * (rather than into the screen) is what lets those two distant components talk —
 * same pattern as `sidebar-store`.
 *
 * Selection is intentionally ephemeral (in memory only): it never touches the
 * SQLite/sync path, matching how Sentry data is live/on-demand elsewhere.
 */
export function AutofixSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Selection mode is purely a function of whether anything is selected — so
  // deselecting the last issue automatically drops back to normal (tap-to-expand)
  // mode rather than getting stuck in an empty selection.
  const active = selectedIds.length > 0;
  // Refs so registering/replacing a handler never re-renders consumers, and so
  // `requestFix`/`requestIgnore` stay stable.
  const fixHandlerRef = useRef<SelectionHandler | null>(null);
  const ignoreHandlerRef = useRef<SelectionHandler | null>(null);
  // Mirror the selection into a ref so the request callbacks read the latest
  // without being recreated on every toggle.
  const selectedRef = useRef<string[]>(selectedIds);
  selectedRef.current = selectedIds;

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const clear = useCallback(() => setSelectedIds([]), []);

  const registerFixHandler = useCallback((fn: SelectionHandler | null) => {
    fixHandlerRef.current = fn;
  }, []);

  const registerIgnoreHandler = useCallback((fn: SelectionHandler | null) => {
    ignoreHandlerRef.current = fn;
  }, []);

  const requestFix = useCallback(() => {
    const ids = selectedRef.current;
    if (ids.length > 0) fixHandlerRef.current?.(ids);
  }, []);

  const requestIgnore = useCallback(() => {
    const ids = selectedRef.current;
    if (ids.length > 0) ignoreHandlerRef.current?.(ids);
  }, []);

  const isSelected = useCallback((id: string) => selectedIds.includes(id), [selectedIds]);

  const value = useMemo<AutofixSelectionValue>(
    () => ({
      active,
      selectedIds,
      count: selectedIds.length,
      isSelected,
      toggle,
      clear,
      registerFixHandler,
      registerIgnoreHandler,
      requestFix,
      requestIgnore,
    }),
    [
      active,
      selectedIds,
      isSelected,
      toggle,
      clear,
      registerFixHandler,
      registerIgnoreHandler,
      requestFix,
      requestIgnore,
    ],
  );

  return (
    <AutofixSelectionContext.Provider value={value}>{children}</AutofixSelectionContext.Provider>
  );
}

export function useAutofixSelection(): AutofixSelectionValue {
  const ctx = useContext(AutofixSelectionContext);
  if (!ctx) throw new Error('useAutofixSelection must be used within an AutofixSelectionProvider');
  return ctx;
}
