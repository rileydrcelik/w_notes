import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type SidebarContextValue = {
  /** Whether the right-hand drawer is currently open. */
  open: boolean;
  /** Raw setter; supports functional updates for toggling. */
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  openSidebar: () => void;
  closeSidebar: () => void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

/**
 * Holds the open/closed state of the right-hand drawer. Lifted out of the
 * floating tab bar so the menu button, the drawer's backdrop, and the home
 * screen's left-swipe gesture can all drive the same drawer.
 */
export function SidebarProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const openSidebar = useCallback(() => setOpen(true), []);
  const closeSidebar = useCallback(() => setOpen(false), []);

  const value = useMemo<SidebarContextValue>(
    () => ({ open, setOpen, openSidebar, closeSidebar }),
    [open, openSidebar, closeSidebar],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar must be used within a SidebarProvider');
  return ctx;
}
