/**
 * A folder's own colour: a `#rrggbb` accent on its tab and title glyph, or
 * nothing, in which case the folder wears the theme like every other surface.
 *
 * Kept as plain maths with no React so the picker, the card and the tests all
 * agree on what a stored value means. Anything that isn't a well-formed hex —
 * absent, empty, or garbage from a future or buggy client — reads as "no
 * colour" rather than throwing, because a card must always be able to render.
 */

/**
 * What a reset to the theme colour is stored as.
 *
 * Not NULL, on purpose: the server COALESCE-preserves a NULL folder colour so an
 * app version that predates the column can't wipe it (`_PRESERVE_IF_NULL` in
 * `backend/app/routers/sync.py`), which means a NULL reset would never land.
 * Not `''` either, because one stray `||` or `if (!color)` on a write path turns
 * an empty string back into NULL with no error. A token survives both.
 */
export const THEME_COLOR_TOKEN = 'theme';

/** The value to store for a picked colour, or for a reset when `color` is null. */
export function storedFolderColor(color: string | null): string {
  return normalizeHex(color) ?? THEME_COLOR_TOKEN;
}

/** The basic colours offered as one-tap swatches. */
export const FOLDER_SWATCHES: readonly { name: string; hex: string }[] = [
  { name: 'Red', hex: '#e5484d' },
  { name: 'Orange', hex: '#f76b15' },
  { name: 'Yellow', hex: '#f5b800' },
  { name: 'Green', hex: '#30a46c' },
  { name: 'Teal', hex: '#12a594' },
  { name: 'Blue', hex: '#0090ff' },
  { name: 'Indigo', hex: '#3e63dd' },
  { name: 'Purple', hex: '#8e4ec6' },
  { name: 'Pink', hex: '#d6409f' },
  { name: 'Grey', hex: '#8b8d98' },
];

/**
 * `#abc`, `abc`, `#aabbcc` or `aabbcc` (any case, surrounding space allowed) as
 * lowercase `#aabbcc`; null for anything else.
 */
export function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw
      .split('')
      .map((c) => c + c)
      .join('')
      .toLowerCase()}`;
  }
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
  return null;
}

/** The colour a folder should be drawn with, or null for the theme default. */
export function folderColor(folder: { color?: string | null }): string | null {
  return normalizeHex(folder.color);
}

/** Hue in degrees [0, 360), saturation and value in [0, 1]. */
export type Hsv = { h: number; s: number; v: number };

export function hexToHsv(hex: string): Hsv {
  const norm = normalizeHex(hex) ?? '#000000';
  const r = parseInt(norm.slice(1, 3), 16) / 255;
  const g = parseInt(norm.slice(3, 5), 16) / 255;
  const b = parseInt(norm.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(1, Math.max(0, s));
  const val = Math.min(1, Math.max(0, v));
  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
