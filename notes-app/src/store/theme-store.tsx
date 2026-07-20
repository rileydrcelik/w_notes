import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useColorScheme as useDeviceColorScheme } from 'react-native';

import { Colors, lerpPalette, type Palette } from '@/constants/theme';
import { db } from '@/lib/db';
import { subscribeSynced } from '@/lib/sync/sync-engine';

/** What the user picked in Settings. 'system' follows the device. */
export type ThemeKey = 'system' | 'dark' | 'solarized' | 'solarizedDark';

/** Settings key the chosen theme is persisted under in SQLite. */
const THEME_KEY = 'themeKey';
const THEME_KEYS: ThemeKey[] = ['system', 'dark', 'solarized', 'solarizedDark'];
const isThemeKey = (value: string): value is ThemeKey =>
  (THEME_KEYS as string[]).includes(value);

/** The light/dark axis some chrome still branches on (blur tint, status bar). */
export type Scheme = 'light' | 'dark';

/** How long a theme change takes to crossfade, in ms. */
const TRANSITION_MS = 320;

/** Ease-in-out so the crossfade accelerates then settles. */
const easeInOut = (t: number): number =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

/** Resolve a chosen theme key (plus the device scheme) to a concrete look. */
function resolveTheme(themeKey: ThemeKey, device: Scheme): { scheme: Scheme; colors: Palette } {
  if (themeKey === 'solarized') return { scheme: 'light', colors: Colors.solarizedLight };
  if (themeKey === 'solarizedDark') return { scheme: 'dark', colors: Colors.solarizedDark };
  if (themeKey === 'dark') return { scheme: 'dark', colors: Colors.dark };
  return { scheme: device, colors: Colors[device] };
}

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
  const deviceRaw = useDeviceColorScheme();
  const device: Scheme = deviceRaw === 'dark' ? 'dark' : 'light';
  const [themeKey, setThemeKeyState] = useState<ThemeKey>('system');

  // The look we want to be showing, derived from the chosen key + device.
  const target = useMemo(() => resolveTheme(themeKey, device), [themeKey, device]);

  // The look currently on screen. Diverges from `target` mid-transition while
  // the palette crossfades, then converges on it.
  const [display, setDisplay] = useState(target);
  // Latest displayed look, readable from the rAF loop without re-subscribing.
  const displayRef = useRef(display);
  displayRef.current = display;
  const rafRef = useRef<number | null>(null);
  // Only user-initiated changes animate; hydration / device flips snap.
  const animateNext = useRef(false);

  // Hydrate the saved choice from SQLite; default stays 'system' if unset. Runs
  // on mount, and again on every data refresh — notably when a web tab takes the
  // DB over from another tab (see reopenDbAndRefresh) and can finally read the
  // setting that failed while it was a follower (which otherwise left the theme
  // stuck on the default). Re-reads snap (no animation) and are a no-op when the
  // value is unchanged, so this stays quiet during normal syncs.
  useEffect(() => {
    let cancelled = false;
    const hydrate = () => {
      db
        .getSetting(THEME_KEY)
        .then((saved) => {
          if (!cancelled && saved && isThemeKey(saved)) setThemeKeyState(saved);
        })
        .catch((e) => console.warn('[theme] failed to load saved theme:', e));
    };
    hydrate();
    const unsub = subscribeSynced(hydrate);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Drive the display toward the target whenever the target changes. A chosen
  // change crossfades; anything else snaps so launch never flashes a stray theme.
  useEffect(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);

    if (!animateNext.current) {
      setDisplay(target);
      return;
    }
    animateNext.current = false;

    const from = displayRef.current;
    let startTime: number | null = null;
    const tick = (now: number) => {
      if (startTime == null) startTime = now;
      const t = Math.min(1, (now - startTime) / TRANSITION_MS);
      const e = easeInOut(t);
      setDisplay({
        // Flip the light/dark chrome (blur tint, status bar) at the midpoint.
        scheme: e < 0.5 ? from.scheme : target.scheme,
        colors: lerpPalette(from.colors, target.colors, e),
      });
      rafRef.current = t < 1 ? requestAnimationFrame(tick) : null;
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [target]);

  // Update state immediately (optimistic) and persist through to SQLite.
  const setThemeKey = useCallback((key: ThemeKey) => {
    animateNext.current = true;
    setThemeKeyState(key);
    db.setSetting(THEME_KEY, key).catch((e) => console.warn('[theme] failed to save theme:', e));
  }, []);

  const value = useMemo<ThemePref>(
    () => ({ themeKey, setThemeKey, scheme: display.scheme, colors: display.colors }),
    [themeKey, setThemeKey, display],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemePref(): ThemePref {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useThemePref must be used within an AppThemeProvider');
  return ctx;
}
