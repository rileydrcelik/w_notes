/**
 * The formula cheatsheet button for finance notes — a small glass button docked
 * bottom-left of the sheet screen, opening a modal of the syntax the engine
 * understands.
 *
 * Mirrors `markdown-help.web.tsx` in placement, shape and behaviour, but is
 * *not* web-only: markdown shortcuts only exist in the web editor, whereas
 * formulas are the same on every platform, so a single implementation serves
 * both and there's no `.web`/native pair to drift.
 *
 * Kept in step with `lib/finance/formula.ts` — every entry below is something
 * the parser actually accepts. An aspirational cheatsheet is worse than none.
 */
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { usePathname } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut } from 'react-native-reanimated';

import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { Spacing, TabBar } from '@/constants/theme';
import { useTabBarBottom } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';

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

/**
 * Rendered from the root layout so it sits above the floating tab bar, matching
 * how the markdown cheatsheet is mounted. Gated at the call site by the
 * `formattingHints` preference.
 */
export function SheetHelp() {
  const theme = useTheme();
  const pathname = usePathname();
  const bottom = useTabBarBottom();
  const [open, setOpen] = useState(false);

  const onSheet = /^\/finance\/[^/]+/.test(pathname);
  if (!onSheet) return null;

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
    <>
      <Animated.View
        entering={FadeIn.duration(200)}
        exiting={FadeOut.duration(150)}
        style={[styles.fabHost, { bottom, left: TabBar.margin }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Formula help"
          onPress={() => setOpen(true)}>
          <GlassSurface intensity={75} tintOpacity={0.5} style={styles.fab}>
            <MaterialCommunityIcons name="function-variant" size={24} color={theme.textSecondary} />
          </GlassSurface>
        </Pressable>
      </Animated.View>

      {open && (
        <View style={styles.overlay} pointerEvents="box-none">
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(160)}
            style={styles.backdrop}
            onPress={() => setOpen(false)}
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
                  onPress={() => setOpen(false)}
                  style={styles.close}>
                  <MaterialCommunityIcons name="close" size={20} color={theme.textSecondary} />
                </Pressable>
              </View>
              <ThemedText themeColor="textSecondary" style={styles.subtitle}>
                Start a cell with = to calculate. Columns are letters, rows are numbers,
                so B2 is the second column, second row.
              </ThemedText>

              <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
                {section('SYNTAX', FORMULAS)}
                {section('WHEN SOMETHING IS WRONG', ERRORS)}
              </ScrollView>
            </GlassSurface>
          </Animated.View>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  fabHost: {
    position: 'absolute',
  },
  fab: {
    width: TabBar.height,
    height: TabBar.height,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.three,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
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
