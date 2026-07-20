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
import { subscribeSynced } from '@/lib/sync/sync-engine';

/**
 * Settings key the web formatting-hints toggle is persisted under in SQLite.
 * The hints (the bottom-left markdown cheatsheet button) are web-only, but the
 * preference is stored the same way everywhere so it round-trips if it's ever
 * surfaced on another surface.
 */
const HINTS_KEY = 'webFormattingHints';

export type EditorPrefs = {
  /** Show the web markdown formatting-hints button on the editor screens. */
  formattingHints: boolean;
  setFormattingHints: (show: boolean) => void;
};

const EditorPrefsContext = createContext<EditorPrefs | null>(null);

/**
 * Holds editor-related UI preferences (currently just the web formatting-hints
 * toggle). Hydrated from on-device SQLite on mount and written back on change,
 * mirroring the theme store. Defaults to on so the hints are visible until the
 * user opts out.
 */
export function EditorPrefsProvider({ children }: { children: ReactNode }) {
  const [formattingHints, setFormattingHintsState] = useState(true);

  // Hydrate the saved choice from SQLite; default stays on if unset. Runs on
  // mount and on every data refresh, so a web tab that just took the DB over from
  // another tab (see reopenDbAndRefresh) picks up the setting it couldn't read
  // while it was a follower.
  useEffect(() => {
    let cancelled = false;
    const hydrate = () => {
      db
        .getSetting(HINTS_KEY)
        .then((saved) => {
          if (!cancelled && saved != null) setFormattingHintsState(saved === 'true');
        })
        .catch((e) => console.warn('[editor-prefs] failed to load formatting hints:', e));
    };
    hydrate();
    const unsub = subscribeSynced(hydrate);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Update state immediately (optimistic) and persist through to SQLite.
  const setFormattingHints = useCallback((show: boolean) => {
    setFormattingHintsState(show);
    db
      .setSetting(HINTS_KEY, show ? 'true' : 'false')
      .catch((e) => console.warn('[editor-prefs] failed to save formatting hints:', e));
  }, []);

  const value = useMemo<EditorPrefs>(
    () => ({ formattingHints, setFormattingHints }),
    [formattingHints, setFormattingHints],
  );

  return <EditorPrefsContext.Provider value={value}>{children}</EditorPrefsContext.Provider>;
}

export function useEditorPrefs(): EditorPrefs {
  const ctx = useContext(EditorPrefsContext);
  if (!ctx) throw new Error('useEditorPrefs must be used within an EditorPrefsProvider');
  return ctx;
}
