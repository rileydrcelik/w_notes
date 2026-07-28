/**
 * The little grid drawn on a finance note's card, standing in for the body
 * preview that text notes show.
 *
 * Drawn as bare rules rather than filled blocks — hairline cell borders, the
 * same construction as the real `FinanceGrid` — so it reads as a spreadsheet
 * instead of a chart or a block of swatches. Only the *interior* rules are
 * drawn: with no outline the lines run out to open edges, which keeps it a
 * glyph rather than a miniature table.
 *
 * It's decorative, not a thumbnail of the sheet: the spreadsheet lives in its
 * own synced row rather than `note.body`, so rendering real cells would mean
 * every card in a feed loading its own document just to draw four rows.
 *
 * Shared by `cards.tsx` and `cards.web.tsx` rather than written twice. Those two
 * are full duplicates and the platform-parity test only compares exported
 * *names*, so anything duplicated between them can silently drift on one
 * platform; a single component can't.
 */
import { StyleSheet, View } from 'react-native';

import { hexToRgba } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const ROWS = 6;
const COLS = 4;

export function SheetGlyph() {
  const theme = useTheme();
  const rule = hexToRgba(theme.textSecondary, 0.32);

  return (
    <View
      style={styles.host}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      {/* Stretches to the card's width rather than taking a fixed size, so the
          glyph stays proportionate across tile widths and screen sizes. */}
      <View style={styles.grid}>
        {Array.from({ length: ROWS }, (_, r) => (
          <View
            key={r}
            style={[
              styles.row,
              // Interior rules only — the last row and column draw nothing, so
              // the lines stop short of an outline and the sides stay open.
              r < ROWS - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: rule },
            ]}>
            {Array.from({ length: COLS }, (_, c) => (
              <View
                key={c}
                style={[
                  styles.cell,
                  c < COLS - 1 && {
                    borderRightWidth: StyleSheet.hairlineWidth,
                    borderRightColor: rule,
                  },
                ]}
              />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Fills the space under the title.
  host: { flex: 1, justifyContent: 'center' },
  // No outline and no radius: open on all four sides, so it reads as bare
  // gridlines rather than a boxed-in table.
  //
  // Rows share the available height rather than taking a fixed one. A tile is
  // `columnWidth / CARD_ASPECT_RATIO` tall and mobile lays out 2 columns to the
  // web's 5, so cards are far shorter on a phone — at any fixed row height that
  // fills a web card, six rows overflow a mobile one.
  grid: { alignSelf: 'stretch', flex: 1 },
  row: { flexDirection: 'row', flex: 1 },
  cell: { flex: 1 },
});
