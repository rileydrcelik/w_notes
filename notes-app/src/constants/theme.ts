/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform, type TextStyle } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    backgroundElement: '#F0F0F3',
    backgroundElementAlt: '#E4E4E9',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
  },
  dark: {
    text: '#DDDDDD',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundElementAlt: '#1A1B1D',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
  },
  // Ethan Schoonover's Solarized Light. Warm paper base (base3/base2) with the
  // signature low-contrast blue-grey body text (base01/base00).
  solarizedLight: {
    text: '#586e75', // base01 — primary content
    background: '#fdf6e3', // base3 — paper
    backgroundElement: '#eee8d5', // base2 — raised surfaces
    backgroundElementAlt: '#e7e1cd', // a touch deeper, for alt cards
    backgroundSelected: '#dcd4bd', // selection / pressed
    textSecondary: '#657b83', // base00 — secondary content
  },
  // Catppuccin Mocha. A soft violet-tinted dark rather than a black one: the
  // base is #1e1e2e, so surfaces read as raised by getting *lighter*, the same
  // direction Solarized Dark works in. Element/selected come from the palette's
  // own surface ramp; only `backgroundElementAlt` is interpolated, since
  // Catppuccin defines no shade between base and surface0 and every other
  // palette here puts that step there.
  mocha: {
    text: '#cdd6f4', // text
    background: '#1e1e2e', // base
    backgroundElement: '#313244', // surface0 — raised surfaces
    backgroundElementAlt: '#282839', // midpoint of base and surface0, for alt cards
    backgroundSelected: '#45475a', // surface1 — selection / pressed
    textSecondary: '#a6adc8', // subtext0
  },
  // Solarized Dark — the canonical mirror of the light variant. Deep teal base
  // (base03/base02) with the brighter blue-grey body text (base1/base0).
  solarizedDark: {
    text: '#93a1a1', // base1 — primary content
    background: '#002b36', // base03 — deepest surface
    backgroundElement: '#073642', // base02 — raised surfaces
    backgroundElementAlt: '#052f38', // a touch deeper, for alt cards
    backgroundSelected: '#0a4452', // selection / pressed
    textSecondary: '#839496', // base0 — secondary content
  },
} as const;

/** The three palettes share the same keys; any of them is a full Palette. */
export type ThemeColor = keyof typeof Colors.light;
export type Palette = Record<ThemeColor, string>;

/**
 * The app's accent — the colour the navbar marks the current tab in.
 *
 * Deliberately **one value across all four palettes** rather than a per-theme
 * entry in `Colors`. The palettes are neutrals: they decide what "paper" and
 * "ink" mean for a theme, and an accent that changed with them would stop being
 * a recognisable colour and become a fifth shade of the background. This is the
 * one hue that stays put, which is what lets it mean "this one" wherever it
 * appears.
 *
 * Plugins that carry someone else's brand keep their own — GitHub purple in
 * `github/[id].tsx`, Sentry's in `sentry/[id].tsx` — because those say *whose*
 * thing you are looking at rather than *which* thing is selected.
 *
 * Contrast, measured: 3.44:1 on the light background and 3.19:1 on Solarized
 * Light, which clears the 3:1 that WCAG asks of icons, borders and other
 * non-text UI, and does not clear the 4.5:1 that small text wants. Use it for
 * icons, chips, borders and selected rows. For a **filled** control with a white
 * label, use `AccentFill` instead.
 */
export const Accent = '#7a89b8';

/**
 * The accent darkened for use as a **fill under white text**.
 *
 * White 14px text on `Accent` reaches only 3.44:1, under the 4.5:1 that size
 * needs; this shade clears it at 4.68:1 without shifting the hue enough to read
 * as a different colour. Any filled button whose label is white uses this one —
 * a rule that exists because the resume plugin once shipped white-on-accent at
 * 3.7:1 by reaching for the plain accent out of habit.
 */
export const AccentFill = '#66739b';

/** Hex (#rrggbb) -> rgba() string, for tints that need an alpha channel. */
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Parse a #rrggbb string into [r, g, b] (0-255). */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Linearly interpolate between two #rrggbb colors. t in [0, 1]. */
export function lerpColor(from: string, to: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(from);
  const [r2, g2, b2] = hexToRgb(to);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Interpolate every key of two palettes, producing an in-between palette. */
export function lerpPalette(from: Palette, to: Palette, t: number): Palette {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const out = {} as Palette;
  for (const key of Object.keys(from) as ThemeColor[]) {
    out[key] = lerpColor(from[key], to[key], t);
  }
  return out;
}

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

/**
 * Italic, in a form Android will actually honour. Use this instead of writing
 * `fontStyle: 'italic'` directly.
 *
 * `fontStyle` alone only asks for the italic *face of whatever family the text
 * inherits*, and React Native never fakes one on the span path: `CustomStyleSpan`
 * passes the request to `Typeface.create(base, weight, italic)` and draws
 * whatever comes back, so a family with no italic face renders upright with no
 * error and no warning. (`TextLayoutManager.updateTextPaint` does have a
 * `textSkewX` fallback, but it only covers text outside the spannable — never
 * the styled runs an app actually writes.) Since nothing here sets a
 * `fontFamily`, text inherits the device default, and plenty of Android
 * defaults ship no italic at all — Samsung's One UI font among them. That is
 * why italics worked on web, where the browser synthesises an oblique, and did
 * nothing on device.
 *
 * Naming `sans-serif` pins the lookup to Roboto, which carries both italic and
 * bold-italic, so this still composes with `fontWeight`. The cost is that on a
 * device with a substituted system font the italic text renders in Roboto while
 * its neighbours don't; the alternative is no italics at all.
 */
export const Italic = Platform.select<TextStyle>({
  android: { fontStyle: 'italic', fontFamily: 'sans-serif' },
  default: { fontStyle: 'italic' },
}) as TextStyle;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;

/** Floating bottom tab bar geometry, shared by the layout and content insets. */
export const TabBar = {
  width: 160,
  height: 48,
  margin: Spacing.three,
} as const;
