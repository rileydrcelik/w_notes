import { Platform, useWindowDimensions, type ViewStyle } from 'react-native';

import { Spacing } from '@/constants/theme';

/**
 * Cards per row in the note/folder grids on a phone. Fixed, because a phone
 * viewport barely varies; the web count is derived from the window instead
 * (see `useGridColumns`).
 */
const PHONE_COLUMNS = 2;

/**
 * The tile width the web grid aims for, and the range of column counts it will
 * use to get near it.
 *
 * The count is derived rather than fixed because the web viewport is not one
 * size: the grid used to ask for five columns at every width, which is right at
 * 1440 and absurd in a tall narrow window, where five columns plus the wide
 * desktop gutters consumed the entire viewport. At 390px that produced 14px
 * tiles, and at 320px the arithmetic reached exactly zero — a feed of invisible
 * cards.
 *
 * The floor of two is deliberate and does real work: it matches the phone
 * layout at phone-ish widths, keeps a note grid from becoming one giant tile
 * per row, and guarantees `columnWrapperStyle` is always valid (React Native
 * rejects a row wrapper on a single-column list). The ceiling of five preserves
 * the established desktop look — 1440 and up still resolve to five.
 */
const WEB_TARGET_TILE = 200;
const WEB_MIN_COLUMNS = 2;
const WEB_MAX_COLUMNS = 5;

/**
 * The copa feed's own target tile and column range.
 *
 * Wider than a note tile because a copy block is a paragraph of text or a file
 * row rather than a title and an excerpt, and it sits in a card of fixed height
 * — too narrow and the text runs out of the bottom of it. The floor is one, not
 * two: copa has always shown a single full-width column on phones, and at a
 * phone-width browser window that is the layout it should land on, which this
 * target produces on its own at ~414px and below.
 *
 * Four at 1280 and up, so the established desktop feed is unchanged.
 */
const WEB_COPA_TARGET_TILE = 280;
const WEB_COPA_MIN_COLUMNS = 1;
const WEB_COPA_MAX_COLUMNS = 4;

/** Gap between cards in a row (matches each grid's `row` columnWrapperStyle). */
const GRID_GAP = Spacing.three;

/**
 * Horizontal padding the grid reserves on each side, at the current width.
 *
 * The generous desktop gutter is what keeps a wide window from running the grid
 * edge to edge, but it was applied at every width, so on a narrow one it was
 * simply 256px of the viewport spent on nothing. It now steps down with the
 * window and lands on the phone value, which is why a narrow browser ends up
 * looking like the phone layout rather than a broken desktop one.
 */
function edgePaddingFor(width: number): number {
  if (Platform.OS !== 'web') return Spacing.three;
  if (width >= 1280) return Spacing.six * 2;
  if (width >= 960) return Spacing.six;
  if (width >= 720) return Spacing.five;
  return Spacing.three;
}

/** How many columns the grid shows at the current window width. */
export function useGridColumns(): number {
  const { width } = useWindowDimensions();
  return gridColumnsFor(width);
}

/**
 * Column count at a given width. Split out from the hook so it can be unit
 * tested without a renderer — the failure this module exists to prevent is
 * arithmetic, and arithmetic is worth asserting directly.
 */
export function gridColumnsFor(width: number): number {
  if (Platform.OS !== 'web') return PHONE_COLUMNS;
  return columnsForTarget(width, WEB_TARGET_TILE, WEB_MIN_COLUMNS, WEB_MAX_COLUMNS);
}

/** How many columns the copa feed shows at the current window width. */
export function useCopaColumns(): number {
  const { width } = useWindowDimensions();
  return copaColumnsFor(width);
}

/**
 * Copa's column count at a given width. One on a phone, where a full-width card
 * reads fine; derived on web, where it was a flat four at every width — so a
 * phone-width browser window quartered its 390px into ~77px cards, the same
 * failure the note grid had and a worse one, since a copy block is mostly text.
 */
export function copaColumnsFor(width: number): number {
  if (Platform.OS !== 'web') return 1;
  return columnsForTarget(width, WEB_COPA_TARGET_TILE, WEB_COPA_MIN_COLUMNS, WEB_COPA_MAX_COLUMNS);
}

/** Columns that come nearest a target tile width, within a range. */
function columnsForTarget(width: number, target: number, min: number, max: number): number {
  const available = width - edgePaddingFor(width) * 2;
  // Round rather than floor: at 1024 the exact fit is 4.2 columns, and flooring
  // would drop to three and stretch every tile ~40% past the target.
  const fit = Math.round((available + GRID_GAP) / (target + GRID_GAP));
  return Math.min(max, Math.max(min, fit));
}

/**
 * How many transparent spacer cells to append so the final row stays
 * left-aligned at single-card width instead of stretching its cards to fill the
 * row. Zero when the items already fill the last row exactly.
 *
 * Takes the column count rather than reading a constant, because on web that
 * count now depends on the window: computing spacers against a different number
 * than the list is rendering with leaves a partial row either short or padded
 * into a phantom extra row.
 */
export function trailingSpacers(count: number, columns: number): number {
  return (columns - (count % columns)) % columns;
}

/**
 * Extra left/right breathing room around the card grids. Spread into a grid's
 * `contentContainerStyle` after the base content style, which it overrides.
 */
export function useGridEdgePadding(): ViewStyle {
  const { width } = useWindowDimensions();
  return { paddingHorizontal: edgePaddingFor(width) };
}

/**
 * Target width:height ratio for a grid tile, used to derive the shared tile
 * height from the column width. Slightly landscape.
 */
export const CARD_ASPECT_RATIO = 1.2;

/**
 * Exact pixel width of one grid column at the current window size. Grid cells
 * use this as a fixed width with `flexGrow: 0` (see each screen's `cardCell`),
 * so a card can never grow past one column into the empty spacer space of a
 * partial last row — the cause of partial-row cards rendering too wide on web.
 */
export function useGridColumnWidth(): number {
  const { width } = useWindowDimensions();
  return gridColumnWidthFor(width);
}

/** Column width at a given width; see `gridColumnsFor` for why this is exported. */
export function gridColumnWidthFor(width: number): number {
  const columns = gridColumnsFor(width);
  const available = width - edgePaddingFor(width) * 2 - GRID_GAP * (columns - 1);
  // Never return a width a tile can't be drawn at. The old arithmetic could
  // reach zero and go negative in a narrow window, which is not a layout bug the
  // eye can diagnose — the cards are simply gone.
  return Math.max(1, Math.floor(available / columns));
}

/**
 * Shared, fixed pixel height for every note/folder grid tile — the column width
 * scaled by `CARD_ASPECT_RATIO`, so all tiles are the same size in every row
 * regardless of content and keep a consistent shape as the window resizes.
 */
export function useTileHeight(): number {
  return Math.round(useGridColumnWidth() / CARD_ASPECT_RATIO);
}

/**
 * Vertical space a note card spends before its preview text can start: two 2px
 * borders, top and bottom padding, the single-line title row, and the gap under
 * it. Mirrors the `card`/`titleRow` styles shared by `components/notes/cards.tsx`
 * and its `.web` twin; change either and this must follow.
 */
const CARD_TITLE_LINE_HEIGHT = 20; // ThemedText `smallBold`
const CARD_CHROME_HEIGHT = 2 * 2 + Spacing.three * 2 + CARD_TITLE_LINE_HEIGHT + Spacing.two;

/**
 * How many lines of preview text fit inside a tile of the given height.
 *
 * The tile is a fixed height derived from the column width, but the preview
 * inside it used to be a hard-coded line count, so the two stopped agreeing as
 * soon as the width did: four 20px lines need ~144px of tile, and a narrow
 * browser window now legitimately produces 113px. The cell clips
 * (`overflow: 'hidden'`), so the surplus was cut mid-line with no ellipsis —
 * the container truncating the text rather than the text truncating itself.
 *
 * `max` keeps the count from growing to fill a large tile: the established look
 * is a short excerpt with air under it, not a wall of text on a desktop tile.
 */
export function cardPreviewLines(
  tileHeight: number,
  fontSize: number,
  lineHeight: number,
  max: number,
): number {
  const available = tileHeight - CARD_CHROME_HEIGHT;
  // A line box is taller than its glyphs. The last line may overrun the content
  // box by its own bottom leading — empty space — without a descender being cut,
  // and forgiving exactly that much is what keeps the phone and desktop layouts
  // at the line counts they already had. Anything more generous clips glyphs.
  const leading = (lineHeight - fontSize) / 2;
  return Math.max(0, Math.min(max, Math.floor((available + leading) / lineHeight)));
}

/** `cardPreviewLines` at the current window size. Zero means "no room at all". */
export function useCardPreviewLines(fontSize: number, lineHeight: number, max: number): number {
  return cardPreviewLines(useTileHeight(), fontSize, lineHeight, max);
}
