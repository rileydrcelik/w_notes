import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { usePathname } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut } from 'react-native-reanimated';

import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { hexToRgba, Spacing, TabBar } from '@/constants/theme';
import { useTabBarBottom } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** The markdown keyboard shortcuts the web editor supports, each with a label. */
const CHEATSHEET: { syntax: string; label: string }[] = [
  { syntax: '# Heading', label: 'Heading (## and ### for smaller)' },
  { syntax: '**bold**', label: 'Bold' },
  { syntax: '*italic*', label: 'Italic' },
  { syntax: '~~strike~~', label: 'Strikethrough' },
  { syntax: '- item', label: 'Bulleted list' },
  { syntax: '1. item', label: 'Numbered list' },
  { syntax: '[ ] task', label: 'Checklist ([x] when done)' },
  { syntax: '> quote', label: 'Blockquote' },
  { syntax: '`code`', label: 'Inline code' },
];

/**
 * A small glass button docked at the bottom-left of the note/copa editor screens
 * (web only). The web editor is a rich TipTap editor with markdown-style keyboard
 * input; tapping this opens a modal cheatsheet of those shortcuts. Visibility is
 * gated by the `formattingHints` preference (toggled in Settings) at the call
 * site in `_layout.tsx`.
 */
export function MarkdownHelp() {
  const theme = useTheme();
  const pathname = usePathname();
  const bottom = useTabBarBottom();
  const [open, setOpen] = useState(false);

  // Only the body editors (note/copa detail screens) edit raw markdown.
  const onEditor = /^\/(note|copa)\/[^/]+/.test(pathname);
  if (!onEditor) return null;

  return (
    <>
      <Animated.View
        entering={FadeIn.duration(200)}
        exiting={FadeOut.duration(150)}
        style={[styles.fabHost, { bottom, left: TabBar.margin }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Markdown formatting help"
          onPress={() => setOpen(true)}>
          <GlassSurface intensity={75} tintOpacity={0.5} style={styles.fab}>
            <MaterialCommunityIcons name="language-markdown" size={24} color={theme.textSecondary} />
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
                  Markdown
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
                Type these in the body to format it.
              </ThemedText>

              <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
                {CHEATSHEET.map((row) => (
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
    minWidth: 120,
    overflow: 'hidden',
  },
  label: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
});
