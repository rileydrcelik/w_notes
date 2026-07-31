/**
 * The resume plugin's accent, in the two forms it is actually used in.
 *
 * One module rather than a `const ACCENT` at the top of every resume component,
 * which is what this replaced: the screen, both sheets, the toolbar's recompile
 * button and the version list each had their own copy. They agreed, but only one
 * of them had the darkened fill — so the next sheet to want a filled button
 * reached for the plain accent and shipped white text at 3.7:1, which is exactly
 * how that happened.
 */

/**
 * Icon and label tint. Sits on a surface, where it has plenty of contrast.
 */
export const ACCENT = '#c2703c';

/**
 * The same accent, darkened for use as a **fill under white text**.
 *
 * Behind white 14px text `ACCENT` only reaches 3.7:1, under the 4.5:1 that size
 * needs; this shade clears it at 4.7:1 without changing the hue enough to read as
 * a different colour. Any filled button whose label is white uses this one.
 */
export const ACCENT_FILL = '#ac6030';
