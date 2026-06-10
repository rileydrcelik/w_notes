/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

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
