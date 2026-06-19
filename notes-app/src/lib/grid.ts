import { Platform, type ViewStyle } from 'react-native';

import { Spacing } from '@/constants/theme';

/**
 * Cards per row in the note/folder grids. Phones show two columns; the web
 * viewport is far wider, so cards there would stretch awkwardly at two — fit
 * five across instead.
 */
export const GRID_COLUMNS = Platform.OS === 'web' ? 5 : 2;

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
