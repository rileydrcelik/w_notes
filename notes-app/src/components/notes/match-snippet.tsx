import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AccentFill } from '@/constants/theme';
import type { SnippetPart } from '@/lib/search';

/**
 * The excerpt a search result shows instead of its usual preview: the words
 * around the match, with the match itself lit up.
 *
 * One file for both platforms rather than a `.tsx`/`.web.tsx` pair — nested
 * `<Text>` is the same everywhere, and a pair that drifts has cost this app a
 * broken launch before. It takes parts rather than a body and a query because
 * the decision to show it at all is the card's: `matchSnippet` returning `null`
 * means there is nothing true to show, and the card keeps its normal preview.
 */
export function MatchSnippet({
  parts,
  numberOfLines,
  style,
}: {
  parts: SnippetPart[];
  numberOfLines: number;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <ThemedText
      numberOfLines={numberOfLines}
      ellipsizeMode="tail"
      themeColor="textSecondary"
      style={style}>
      {parts.map((part, index) =>
        part.match ? (
          // Tinted rather than bold: the run is often mid-word ("tax" inside
          // "taxes"), and a weight change there breaks the word in two while a
          // wash of colour leaves it whole.
          <Text key={index} style={styles.hit}>
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  hit: {
    // Both colours fixed, neither from the palette — which is what makes this
    // legible on every theme at once. The obvious version, `Accent` at low alpha
    // over the card with the theme's own text on top, measures 3.18:1 on
    // Solarized Light: under the 4.5:1 that 14px text needs, and near enough to
    // the 3.40:1 of the ordinary preview text around it that the emphasis would
    // have bought nothing — a mark no easier to read than the words it was
    // marking. The accent's luminance sits between that palette's ink and paper,
    // so no alpha fixes it; lowering it only fades the mark away.
    //
    // A fixed pair sidesteps the palette entirely: white on `AccentFill` is
    // 4.68:1 everywhere, which is the pairing that constant exists for, and the
    // fill clears 3:1 against every card surface (3.09:1 at its closest, on
    // Midnight) so the mark is always visible as a shape too.
    //
    // No radius: Android ignores one on a nested Text, and a corner that rounds
    // on two platforms out of three is worse than a square one everywhere.
    backgroundColor: AccentFill,
    color: '#ffffff',
  },
});
