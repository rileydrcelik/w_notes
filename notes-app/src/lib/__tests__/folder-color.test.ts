import { describe, expect, it } from 'vitest';

import {
  FOLDER_SWATCHES,
  folderColor,
  hexToHsv,
  hsvToHex,
  normalizeHex,
  storedFolderColor,
  THEME_COLOR_TOKEN,
} from '@/lib/folder-color';

describe('normalizeHex', () => {
  it('accepts a 3-digit hex with a leading #', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc');
  });

  it('accepts a 3-digit hex with no #', () => {
    expect(normalizeHex('abc')).toBe('#aabbcc');
  });

  it('accepts a 6-digit hex and lowercases it', () => {
    expect(normalizeHex('#AABBCC')).toBe('#aabbcc');
  });

  it('accepts a 6-digit hex with no # and trims surrounding space', () => {
    expect(normalizeHex('  aabbcc  ')).toBe('#aabbcc');
  });

  it('rejects the theme token', () => {
    expect(normalizeHex(THEME_COLOR_TOKEN)).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(normalizeHex('')).toBeNull();
  });

  it('rejects null', () => {
    expect(normalizeHex(null)).toBeNull();
  });

  it('rejects undefined', () => {
    expect(normalizeHex(undefined)).toBeNull();
  });

  it('rejects a 4-digit hex', () => {
    expect(normalizeHex('#abcd')).toBeNull();
  });

  it('rejects a hex with an out-of-range digit', () => {
    expect(normalizeHex('#gggggg')).toBeNull();
  });
});

describe('storedFolderColor', () => {
  it('stores the theme token for null, never null or empty', () => {
    // The load-bearing rule: the server COALESCE-preserves a NULL folder colour
    // so a reset has to be written as something else, or it would never land.
    const stored = storedFolderColor(null);
    expect(stored).toBe('theme');
    expect(stored).not.toBeNull();
    expect(stored).not.toBe('');
  });

  it('normalizes a shorthand hex on the way in', () => {
    expect(storedFolderColor('#ABC')).toBe('#aabbcc');
  });

  it('stores a well-formed 6-digit hex as-is (lowercased)', () => {
    expect(storedFolderColor('#0090FF')).toBe('#0090ff');
  });

  it('falls back to the theme token for garbage input', () => {
    expect(storedFolderColor('not-a-color')).toBe('theme');
  });
});

describe('folderColor', () => {
  it('returns null for the theme token', () => {
    expect(folderColor({ color: THEME_COLOR_TOKEN })).toBeNull();
  });

  it('returns null when color is absent', () => {
    expect(folderColor({})).toBeNull();
  });

  it('returns null when color is null', () => {
    expect(folderColor({ color: null })).toBeNull();
  });

  it('returns the normalized hex for a real colour', () => {
    expect(folderColor({ color: '#ABC' })).toBe('#aabbcc');
  });
});

describe('hexToHsv / hsvToHex round trip', () => {
  const swatches = [
    '#e5484d',
    '#f76b15',
    '#f5b800',
    '#30a46c',
    '#12a594',
    '#0090ff',
    '#3e63dd',
    '#8e4ec6',
    '#d6409f',
    '#8b8d98',
  ];

  it.each(swatches)('round-trips swatch %s', (hex) => {
    expect(hsvToHex(hexToHsv(hex))).toBe(hex);
  });

  it('round-trips black', () => {
    expect(hsvToHex(hexToHsv('#000000'))).toBe('#000000');
  });

  it('round-trips white', () => {
    expect(hsvToHex(hexToHsv('#ffffff'))).toBe('#ffffff');
  });

  it('round-trips grey', () => {
    expect(hsvToHex(hexToHsv('#808080'))).toBe('#808080');
  });

  it('gives black zero saturation and value', () => {
    expect(hexToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 });
  });

  it('gives white zero saturation and full value', () => {
    const { s, v } = hexToHsv('#ffffff');
    expect(s).toBe(0);
    expect(v).toBe(1);
  });

  it('gives pure red a hue of 0', () => {
    expect(hexToHsv('#ff0000').h).toBe(0);
  });

  it('gives pure green a hue of 120', () => {
    expect(hexToHsv('#00ff00').h).toBe(120);
  });

  it('gives pure blue a hue of 240', () => {
    expect(hexToHsv('#0000ff').h).toBe(240);
  });

  it('round-trips a colour in the 60-120 hue sector', () => {
    // None of the swatches or the axis colours above land in this band; a
    // hue-sector bug here would slip past every other case in this file.
    expect(hsvToHex(hexToHsv('#80ff00'))).toBe('#80ff00');
  });
});

describe('FOLDER_SWATCHES', () => {
  // The dialog marks the current swatch with `swatch.hex === draft`, where the
  // draft is always `normalizeHex` output. A swatch written any other way — a
  // 3-digit hex, an uppercase one — would store a value that never matches the
  // entry it came from, so tapping it would leave nothing checked and open the
  // custom picker instead.
  it('is written in the same normalized form the picker stores', () => {
    for (const swatch of FOLDER_SWATCHES) {
      expect(normalizeHex(swatch.hex)).toBe(swatch.hex);
    }
  });
});
