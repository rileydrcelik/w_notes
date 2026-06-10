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
