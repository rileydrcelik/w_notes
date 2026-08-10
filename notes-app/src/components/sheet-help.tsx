/**
 * The formula cheatsheet for finance notes — a modal listing the syntax the
 * engine understands.
 *
 * Unlike `markdown-help.web.tsx`, which is a button docked bottom-left of the
 * editor screen, this one has no dock of its own: at phone width that corner is
 * where the navbar's back button lives, and the two sat on top of each other.
 * It's opened from the sheet's formatting toolbar instead, which is where the
 * user already is when they're writing a formula.
 *
 * Kept in step with `lib/finance/formula.ts` — every entry below is something
 * the parser actually accepts. An aspirational cheatsheet is worse than none.
 */
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut } from 'react-native-reanimated';

import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { noScrollbar } from '@/lib/scroll-style';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Row = { syntax: string; label: string };

const FORMULAS: Row[] = [
  { syntax: '=B2+10', label: 'Reference a cell in a calculation' },
  { syntax: '=B2*C2', label: 'Multiply (also - and /)' },
  { syntax: '=(B2+B3)*2', label: 'Parentheses to group' },
  { syntax: '=SUM(B2:B5)', label: 'Total a range' },
  { syntax: '=AVERAGE(B2:B5)', label: 'Mean of a range' },
  { syntax: '=COUNT(B2:B5)', label: 'How many numbers in a range' },
  { syntax: '=MIN(B2:B5)', label: 'Smallest value (MAX for largest)' },
  { syntax: '=SUM(B:B)', label: 'Total a whole column' },
  { syntax: '=SUM(B2:B5, 10)', label: 'Mix ranges, cells and numbers' },
];

const ERRORS: Row[] = [
  { syntax: '#DIV/0!', label: 'Divided by zero or an empty cell' },
  { syntax: '#VALUE!', label: 'Text used where a number was needed' },
  { syntax: '#REF!', label: 'Points outside the sheet' },
  { syntax: '#CIRC!', label: 'A formula that refers back to itself' },
  { syntax: '#NAME?', label: 'Function not recognised' },
  { syntax: '#PARSE!', label: "Formula can't be read — check brackets" },
];

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * Controlled by the sheet screen, which also gates it on the `formattingHints`
 * preference. Rendering nothing when closed keeps the whole card — and its
 * backdrop — out of the tree between uses.
 */
export function SheetHelp({ open, onClose }: Props) {
  const theme = useTheme();

  if (!open) return null;

  const section = (title: string, rows: Row[]) => (
    <>
      <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
        {title}
      </ThemedText>
      {rows.map((row) => (
        <View key={row.syntax} style={styles.row}>
          <ThemedText
            type="code"
            style={[
              styles.syntax,
              { color: theme.text, backgroundColor: theme.backgroundElementAlt },
            ]}>
            {row.syntax}
          </ThemedText>
          <ThemedText themeColor="textSecondary" style={styles.label}>
            {row.label}
          </ThemedText>
        </View>
      ))}
    </>
  );

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <AnimatedPressable
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(160)}
        style={styles.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
      />
      <Animated.View
        entering={ZoomIn.duration(200)}
        exiting={ZoomOut.duration(150)}
        style={styles.cardWrap}
        pointerEvents="box-none">
        <GlassSurface intensity={90} tintOpacity={0.85} style={styles.card}>
          <View style={styles.header}>
            <ThemedText type="subtitle" style={styles.headerTitle}>
              Formulas
            </ThemedText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={styles.close}>
              <MaterialCommunityIcons name="close" size={20} color={theme.textSecondary} />
            </Pressable>
          </View>
          <ThemedText themeColor="textSecondary" style={styles.subtitle}>
            Start a cell with = to calculate. Columns are letters, rows are numbers,
            so B2 is the second column, second row.
          </ThemedText>

          <ScrollView style={styles.list} {...noScrollbar}>
            {section('SYNTAX', FORMULAS)}
            {section('WHEN SOMETHING IS WRONG', ERRORS)}
          </ScrollView>
        </GlassSurface>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    // Android orders siblings by elevation before document order, and the
    // toolbar that opens this sits at 16 — without a higher value here the
    // backdrop would fall behind the bar, leaving it lit and still tappable.
    elevation: 32,
    zIndex: 32,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  cardWrap: {
    width: '100%',
    maxWidth: 420,
  },
  card: {
    overflow: 'hidden',
    borderRadius: Spacing.four,
    padding: Spacing.four,
    maxHeight: 560,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: 24,
    lineHeight: 30,
  },
  close: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.two,
  },
  subtitle: {
    marginTop: Spacing.one,
    marginBottom: Spacing.three,
  },
  list: {
    flexGrow: 0,
  },
  sectionLabel: {
    marginTop: Spacing.two,
    marginBottom: Spacing.one,
    letterSpacing: 0.6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
  },
  syntax: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.two,
    minWidth: 130,
    overflow: 'hidden',
  },
  label: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
});
