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

import { lerpPalette, type Palette } from '@/constants/theme';
import { db } from '@/lib/db';
import { migrateThemeKey, THEME_SETTING_KEY } from '@/lib/theme-migrate';
import { isThemeKey, resolveTheme, type Scheme, type ThemeKey } from '@/lib/theme-resolve';
import { requestSync, subscribeSynced } from '@/lib/sync/sync-engine';

/**
 * Key the chosen theme is persisted under, in the **synced** `user_settings`
 * table — so a theme is a property of the account and follows it onto every
 * device, rather than being re-picked on each one.
 */
const THEME_KEY = THEME_SETTING_KEY;

// The key union, its guard and the palette lookup live in lib/theme-resolve, so
// they can be unit-tested without dragging SQLite in. Re-exported here because
// this is where the rest of the app already imports them from.
export type { ThemeKey, Scheme } from '@/lib/theme-resolve';

/** How long a theme change takes to crossfade, in ms. */
const TRANSITION_MS = 320;

/**
 * Debounce before a theme change is pushed. Short, like copa's: a theme is a
 * one-tap change someone may well be watching land on a second device, so it
 * shouldn't wait out the typing-length default.
 */
const SYNC_DEBOUNCE_MS = 200;

/** Ease-in-out so the crossfade accelerates then settles. */
const easeInOut = (t: number): number =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

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
  //
  // Now that the theme is account-scoped this also has to run *downwards*: a
  // missing row means 'system', not "leave whatever is on screen". Sign-out and
  // account-switch clear the row and then emit exactly this refresh, so the
  // read-only-if-found version left the previous account's theme rendered until
  // something happened to overwrite it — the next person to sign in on the
  // device inherited a look that was never theirs.
  //
  // Retired keys are rewritten on the way in. `lib/db` already does this to the
  // stored row at open, but that only settles what *this* device wrote: the
  // theme is account-scoped, so a device still on an older build goes on pushing
  // `mocha`, and a pull lands it here long after open. Without the rewrite the
  // key would fail `isThemeKey` and read as 'system' — a phone quietly changing
  // theme because a laptop hasn't updated. Safe to apply on every hydrate now
  // that `migrateThemeKey` is idempotent; it was not, once (see theme-migrate).
  useEffect(() => {
    let cancelled = false;
    const hydrate = () => {
      db
        .getUserSetting(THEME_KEY)
        .then((saved) => {
          if (cancelled) return;
          const key = saved ? migrateThemeKey(saved) : null;
          setThemeKeyState(key && isThemeKey(key) ? key : 'system');
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

  // Update state immediately (optimistic), persist to SQLite, and nudge sync so
  // the choice reaches the account's other devices without waiting for the lazy
  // poll. A short debounce rather than none coalesces a burst of taps while
  // someone is trying themes on, pushing only where they settled.
  const setThemeKey = useCallback((key: ThemeKey) => {
    animateNext.current = true;
    setThemeKeyState(key);
    db.setUserSetting(THEME_KEY, key)
      .then(() => requestSync(SYNC_DEBOUNCE_MS))
      .catch((e) => console.warn('[theme] failed to save theme:', e));
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
