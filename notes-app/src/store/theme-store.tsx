import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useColorScheme as useDeviceColorScheme } from 'react-native';

import { Colors, type Palette } from '@/constants/theme';
import { db } from '@/lib/db';

/** What the user picked in Settings. 'system' follows the device. */
export type ThemeKey = 'system' | 'dark' | 'solarized';

/** Settings key the chosen theme is persisted under in SQLite. */
const THEME_KEY = 'themeKey';
const isThemeKey = (value: string): value is ThemeKey =>
  value === 'system' || value === 'dark' || value === 'solarized';

/** The light/dark axis some chrome still branches on (blur tint, status bar). */
export type Scheme = 'light' | 'dark';

export type ThemePref = {
  themeKey: ThemeKey;
  setThemeKey: (key: ThemeKey) => void;
  /** Resolved light/dark, e.g. Solarized resolves to 'light'. */
  scheme: Scheme;
  /** The active color palette to render with. */
  colors: Palette;
};

const ThemeContext = createContext<ThemePref | null>(null);

/**
 * Holds the chosen theme and resolves it to a concrete palette + scheme. Wraps
 * the whole app so `useTheme()` and `useColorScheme()` reflect the user's
 * choice rather than the raw device setting. The choice is hydrated from
 * on-device SQLite on mount and written back through on every change.
 */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const device = useDeviceColorScheme();
  const [themeKey, setThemeKeyState] = useState<ThemeKey>('system');

  // Hydrate the saved choice once on mount; default stays 'system' if unset.
  useEffect(() => {
    let cancelled = false;
    db
      .getSetting(THEME_KEY)
      .then((saved) => {
        if (!cancelled && saved && isThemeKey(saved)) setThemeKeyState(saved);
      })
      .catch((e) => console.warn('[theme] failed to load saved theme:', e));
    return () => {
      cancelled = true;
    };
  }, []);

  // Update state immediately (optimistic) and persist through to SQLite.
  const setThemeKey = useCallback((key: ThemeKey) => {
    setThemeKeyState(key);
    db.setSetting(THEME_KEY, key).catch((e) => console.warn('[theme] failed to save theme:', e));
  }, []);

  const { scheme, colors } = useMemo<{ scheme: Scheme; colors: Palette }>(() => {
    if (themeKey === 'solarized') return { scheme: 'light', colors: Colors.solarizedLight };
    if (themeKey === 'dark') return { scheme: 'dark', colors: Colors.dark };
    const s: Scheme = device === 'dark' ? 'dark' : 'light';
    return { scheme: s, colors: Colors[s] };
  }, [themeKey, device]);

  const value = useMemo<ThemePref>(
    () => ({ themeKey, setThemeKey, scheme, colors }),
    [themeKey, scheme, colors],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemePref(): ThemePref {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useThemePref must be used within an AppThemeProvider');
  return ctx;
}
