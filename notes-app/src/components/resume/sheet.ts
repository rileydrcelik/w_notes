/**
 * Geometry shared by every sheet the resume screen puts up — the entry adder,
 * the tailor, the version history, and the compiler picker.
 *
 * One module because these four appear in the same place, from the same two
 * bars, and often one after another. A width or a top gap that differs between
 * them reads as the sheet jumping size as you move between jobs on one screen.
 * They were separate copies of the same numbers, which is how the compiler picker
 * ended up as the one full-width sheet among four.
 */
import { Spacing } from '@/constants/theme';

/**
 * How wide a sheet is allowed to get.
 *
 * These sheets are read down a column — a form, or a list of options. Left to
 * stretch, the split layout's ≥900px window draws single-line fields a metre
 * wide and strands a row's label and its value at opposite ends of the screen.
 */
export const SHEET_MAX_WIDTH = 520;

/**
 * Clear space kept between the top of a sheet and the top of the window.
 *
 * A sheet is an addition to the document behind it, so some of that document has
 * to stay visible; one that reaches the status bar has stopped being a sheet and
 * become a screen.
 */
export const SHEET_TOP_GAP = Spacing.six;
