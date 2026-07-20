import { Platform, useWindowDimensions, type ViewStyle } from 'react-native';

import { Spacing } from '@/constants/theme';

/**
 * Cards per row in the note/folder grids. Phones show two columns; the web
 * viewport is far wider, so cards there would stretch awkwardly at two — fit
 * five across instead.
 */
export const GRID_COLUMNS = Platform.OS === 'web' ? 5 : 2;

/**
 * Target width:height ratio for a grid tile, used to derive the shared tile
 * height from the column width. Slightly landscape.
 */
export const CARD_ASPECT_RATIO = 1.2;

/**
 * How many transparent spacer cells to append so the final row stays
 * left-aligned at single-card width instead of stretching its cards to fill the
 * row. Zero when the items already fill the last row exactly.
 */
export function trailingSpacers(count: number): number {
  return (GRID_COLUMNS - (count % GRID_COLUMNS)) % GRID_COLUMNS;
}

/**
 * Extra left/right breathing room around the card grids on web, where the grid
 * would otherwise run edge-to-edge across a wide window. Spread into a grid's
 * `contentContainerStyle` (after the base content style) — it overrides the
 * base horizontal padding on web and is a no-op on phones.
 */
export const gridEdgePadding: ViewStyle =
  Platform.OS === 'web' ? { paddingHorizontal: Spacing.six * 2 } : {};

/** Horizontal padding the grids reserve on each side (matches `gridEdgePadding`). */
const GRID_EDGE_PADDING = Platform.OS === 'web' ? Spacing.six * 2 : Spacing.three;
/** Gap between cards in a row (matches each grid's `row` columnWrapperStyle). */
const GRID_GAP = Spacing.three;

/**
 * Exact pixel width of one grid column at the current window size. Grid cells
 * use this as a fixed width with `flexGrow: 0` (see each screen's `cardCell`),
 * so a card can never grow past one column into the empty spacer space of a
 * partial last row — the cause of partial-row cards rendering too wide on web.
 */
export function useGridColumnWidth(): number {
  const { width } = useWindowDimensions();
  return Math.floor((width - GRID_EDGE_PADDING * 2 - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS);
}

/**
 * Shared, fixed pixel height for every note/folder grid tile — the column width
 * scaled by `CARD_ASPECT_RATIO`, so all tiles are the same size in every row
 * regardless of content and keep a consistent shape as the window resizes.
 */
export function useTileHeight(): number {
  return Math.round(useGridColumnWidth() / CARD_ASPECT_RATIO);
}
