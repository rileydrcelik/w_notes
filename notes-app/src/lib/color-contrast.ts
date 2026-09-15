/**
 * Picking an ink that stays readable on a colour the user chose.
 *
 * Any surface painted with an arbitrary colour has this problem: the theme's
 * text colour is right for the theme's backgrounds and nothing else. On a light
 * accent a near-white glyph is invisible, and on a dark one a near-black glyph
 * is. The answer can't be a lookup table of "light" and "dark" swatches either,
 * because the swatch lists change and a new entry would quietly pick the wrong
 * side. It has to be derived from the colour itself.
 *
 * Shared rather than owned by one feature: the finance sheet's cell highlights
 * and the folder colour swatches are the same problem, and a second copy of the
 * luminance maths is a second place for the threshold to drift.
 */

const DARK_INK = '#1A1A1A';
const LIGHT_INK = '#F5F5F5';

/**
 * The ink to draw on `background`, by WCAG relative luminance, so it stays
 * correct if a swatch list changes.
 *
 * Anything that isn't a hex colour reads as dark ink: a caller that has lost
 * track of its background is better off with the colour most surfaces here
 * want than with an exception.
 */
export function readableTextColor(background: string): string {
  const hex = background.replace('#', '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return DARK_INK;

  const channel = (offset: number) => {
    const v = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.45 ? DARK_INK : LIGHT_INK;
}
