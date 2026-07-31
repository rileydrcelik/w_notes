/**
 * What a change did to the LaTeX, as a diff.
 *
 * Shared by both sheets that put a model-written change in front of someone
 * before it lands: the tailor (a whole rewritten document) and the entry sheet's
 * edit mode (one quoted span becoming another). They were going to grow two
 * copies of this, and two diffs that disagree about how a removal is tinted is
 * exactly the kind of drift the accent constant already taught this folder.
 *
 * Long unchanged stretches collapse. A resume's preamble is thirty identical
 * lines, and scrolling past them to find the change is the opposite of reviewing
 * it.
 */
import { ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, hexToRgba, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  collapseUnchanged,
  describeDiff,
  diffLines,
  foldCommentToggles,
} from '@/lib/latex/diff';

/**
 * Tints for added and removed lines.
 *
 * Blue for added rather than the conventional green. Green-and-red is the pairing
 * most diffs use and the one most people are colour-blind to — red-green is by
 * far the commonest form — and this diff is the last thing between someone and
 * applying a rewritten resume, so which half is which has to be legible without
 * reading the `+`/`−`. Blue against red separates on lightness as well as hue.
 *
 * Fixed values rather than theme colours, at a low alpha so they sit *under* the
 * theme's own text in all four palettes; deriving them per-palette would make the
 * pairing mean something different in each.
 */
const ADDED = '#388bfd';
const REMOVED = '#f85149';
const TINT = 0.14;

export function DiffView({
  before,
  after,
  /** Rendered beside the added/removed counts — the tailor puts its page count here. */
  trailing,
  style,
  contentContainerStyle,
}: {
  before: string;
  after: string;
  trailing?: React.ReactNode;
  style?: React.ComponentProps<typeof ScrollView>['style'];
  contentContainerStyle?: React.ComponentProps<typeof ScrollView>['contentContainerStyle'];
}) {
  const theme = useTheme();
  // Folded before anything else looks at it: taking an entry off the page is one
  // change, not a line-for-line replacement of it with a commented copy.
  const lines = foldCommentToggles(diffLines(before, after));
  const rows = collapseUnchanged(lines);

  return (
    <>
      <View style={styles.header}>
        <ThemedText type="small" themeColor="textSecondary">
          {describeDiff(lines)}
        </ThemedText>
        {trailing}
      </View>
      <ScrollView
        style={style}
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={false}>
        {rows.map((row, index) =>
          row.kind === 'gap' ? (
            <ThemedText
              key={`gap-${index}`}
              type="small"
              themeColor="textSecondary"
              style={styles.gap}>
              {`⋯ ${row.count} unchanged line${row.count === 1 ? '' : 's'}`}
            </ThemedText>
          ) : (
            <View
              key={`${row.kind}-${index}`}
              style={[
                styles.row,
                row.kind === 'added' && { backgroundColor: hexToRgba(ADDED, TINT) },
                row.kind === 'uncommented' && { backgroundColor: hexToRgba(ADDED, TINT) },
                row.kind === 'removed' && { backgroundColor: hexToRgba(REMOVED, TINT) },
                row.kind === 'commented' && { backgroundColor: hexToRgba(REMOVED, TINT) },
              ]}>
              <ThemedText type="small" themeColor="textSecondary" style={styles.mark}>
                {row.kind === 'added' || row.kind === 'uncommented'
                  ? '+'
                  : row.kind === 'removed' || row.kind === 'commented'
                    ? '−'
                    : ' '}
              </ThemedText>
              <ThemedText
                type="small"
                style={[
                  styles.text,
                  { color: row.kind === 'same' ? theme.textSecondary : theme.text },
                ]}>
                {/* A blank line still needs a row, or a removed empty line
                    silently isn't shown as removed. */}
                {row.text || ' '}
              </ThemedText>
            </View>
          ),
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.three,
  },
  mark: {
    width: 14,
    fontFamily: Fonts.mono,
  },
  // Monospace, and small: LaTeX is column-sensitive, and a diff line that wraps
  // reads as two changes rather than one.
  text: {
    flex: 1,
    fontFamily: Fonts.mono,
    fontSize: 11,
    lineHeight: 17,
  },
  gap: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
});
