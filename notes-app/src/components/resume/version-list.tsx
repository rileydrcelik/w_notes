/**
 * A resume's version history: every snapshot, newest first, and tapping one
 * restores it.
 *
 * The same sheet the app uses everywhere it asks "pick one of these" — the engine
 * picker on this screen, the selection menus in `floating-tab-bar.tsx` — because
 * that is what this is. It is reached from the navbar's trailing button rather
 * than from a control on the screen (see `lib/version-action.ts`).
 *
 * Restoring is immediate and needs no confirmation, which is only true because
 * the screen snapshots what it is about to replace first: every restore is itself
 * an entry in this list, so there is nothing here you can do that this list can't
 * undo. A confirm dialog would be asking about a decision that isn't final.
 *
 * The list scrolls and is height-capped against the window, since history has no
 * upper bound — there is deliberately no automatic pruning, because two devices
 * pruning independently from different views of the history can between them
 * delete more than either intended.
 */
import Feather from '@expo/vector-icons/Feather';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import type { ResumeVersion } from '@/data/notes';
import { SHEET_MAX_WIDTH, SHEET_TOP_GAP } from '@/components/resume/sheet';
import { describeAge, matchesVersionSearch } from '@/lib/resume-versions';
import { noFocusOutline } from '@/lib/web-style';
import { noScrollbar } from '@/lib/scroll-style';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function VersionList({
  open,
  versions,
  /** Which version the editor is currently working in, so the list can mark it. */
  currentVersionId,
  onClose,
  onRestore,
  onDelete,
  readOnly = false,
}: {
  open: boolean;
  /** Newest first. */
  versions: ResumeVersion[];
  currentVersionId: string | null;
  onClose: () => void;
  onRestore: (version: ResumeVersion) => void;
  onDelete: (version: ResumeVersion) => void;
  /**
   * Show the history without offering to change it. Restoring swaps the
   * document's source and deleting drops a version for good — both are edits,
   * so on a screen that doesn't edit (the resume on mobile) the list still says
   * what exists and when, and stops there. The rows go inert rather than
   * disabled-looking: there's nothing broken about them, they just aren't
   * buttons here.
   */
  readOnly?: boolean;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const { height: windowHeight } = useWindowDimensions();
  const [search, setSearch] = useState('');

  // A pixel cap derived from the window, not a percentage: the host view is
  // auto-height, so a percentage would resolve against the sheet's own content
  // and let a long history run off the top of the screen.
  const maxSheetHeight = windowHeight - insets.top - SHEET_TOP_GAP - tabBarInset;

  // The oldest snapshot is "the original" — by position, not by a stored flag,
  // which sync could disagree with.
  const originalId = versions.length > 0 ? versions[versions.length - 1].id : null;

  // Filtered for display only — "the original" stays the oldest row overall, not
  // the oldest row still matching what you typed.
  const shown = useMemo(
    () => versions.filter((v) => matchesVersionSearch(v, search)),
    [versions, search],
  );

  return (
    <View style={styles.overlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.backdrop}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          />
          <Animated.View
            entering={SlideInDown.duration(260)}
            exiting={SlideOutDown.duration(220)}
            // `box-none`, so the empty space beside the sheet falls through to
            // the backdrop underneath. This wrapper is full-width and centres a
            // capped-width sheet, which on a wide window leaves large dead areas
            // either side of it — without this they swallow the click and the
            // sheet cannot be dismissed by clicking off it.
            pointerEvents="box-none"
            style={[styles.host, { paddingBottom: tabBarInset }]}>
            <GlassSurface
              intensity={75}
              tintOpacity={0.85}
              style={[styles.sheet, { maxHeight: maxSheetHeight }]}>
              <ThemedText type="smallBold" style={styles.title}>
                Versions
              </ThemedText>

              {/* Only worth the row once there are enough versions to lose one in. */}
              {versions.length > 3 && (
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search versions"
                  placeholderTextColor={theme.textSecondary}
                  style={[
                    styles.search,
                    noFocusOutline,
                    { color: theme.text, backgroundColor: theme.backgroundElementAlt },
                  ]}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                />
              )}

              {versions.length === 0 ? (
                <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
                  No versions yet. One is saved each time you add or edit an entry, so you can
                  always get back to what this looked like before.
                </ThemedText>
              ) : (
                <ScrollView
                  style={styles.scroll}
                  contentContainerStyle={styles.scrollContent}
                  {...noScrollbar}>
                  {shown.map((version) => {
                    // Marked rather than disabled: this is the document you're
                    // looking at, so restoring it is a no-op, but greying out the
                    // row you most want to recognise reads as an error.
                    const isCurrent = version.id === currentVersionId;
                    const isOriginal = version.id === originalId;
                    return (
                      <View key={version.id} style={styles.rowWrap}>
                      {/* Read-only rows are a plain View, not a disabled
                          Pressable. `disabled` writes through to
                          `accessibilityState`, so TalkBack and VoiceOver would
                          announce them as "dimmed" — telling a screen-reader
                          user something is broken or temporarily unavailable,
                          when it is neither. It is read-only content, and the
                          honest way to say that is to not be a control. */}
                      <RowShell
                        readOnly={readOnly}
                        label={version.label}
                        onPress={() => onRestore(version)}>
                        <View style={styles.rowText}>
                          <ThemedText numberOfLines={2}>{version.label}</ThemedText>
                          <View style={styles.metaRow}>
                            <ThemedText type="small" themeColor="textSecondary">
                              {describeAge(version.createdAt)}
                            </ThemedText>
                            {isOriginal && (
                              <ThemedText type="small" themeColor="textSecondary">
                                · original
                              </ThemedText>
                            )}
                          </View>
                        </View>
                        {isCurrent ? (
                          <View
                            style={[
                              styles.currentChip,
                              { borderColor: hexToRgba(theme.textSecondary, 0.35) },
                            ]}>
                            <ThemedText type="small" themeColor="textSecondary">
                              on screen
                            </ThemedText>
                          </View>
                        ) : (
                          // The restore arrow is the affordance, so it goes with
                          // the action rather than sitting there unexplained.
                          !readOnly && (
                            <Feather name="corner-up-left" size={16} color={theme.textSecondary} />
                          )
                        )}
                      </RowShell>
                      {/* Outside the row's Pressable, not inside it: nesting one
                          pressable in another makes which one you hit a matter of
                          a few pixels, and the two do very different things. The
                          version you are working in has no delete — it is the
                          document on screen, and removing it would leave the
                          editor holding text that belongs to nothing. */}
                      {!isCurrent && !readOnly && (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Delete version: ${version.label}`}
                          onPress={() => onDelete(version)}
                          hitSlop={8}
                          style={({ pressed }) => [styles.delete, pressed && styles.pressed]}>
                          <Feather name="trash-2" size={15} color={theme.textSecondary} />
                        </Pressable>
                      )}
                      </View>
                    );
                  })}
                </ScrollView>
              )}
            </GlassSurface>
          </Animated.View>
        </>
      )}
    </View>
  );
}

/**
 * One history row's container: a button where restoring is offered, and plain
 * content where it isn't. Two elements rather than one element with `disabled`,
 * because "you can't press this right now" and "this was never a button" read
 * identically on screen but differently to a screen reader — and only the second
 * is true here.
 */
function RowShell({
  readOnly,
  label,
  onPress,
  children,
}: {
  readOnly: boolean;
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  if (readOnly) return <View style={styles.row}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Restore: ${label}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  host: {
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
  },
  sheet: {
    width: '100%',
    maxWidth: SHEET_MAX_WIDTH,
    borderRadius: Spacing.four,
    paddingVertical: Spacing.two,
  },
  title: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.one,
  },
  // `flexShrink: 1` is load-bearing: React Native defaults it to 0 (unlike the
  // web), so without it the scroller keeps its full content height, ignores the
  // sheet's cap, and gets clipped by the glass surface's own overflow.
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  scrollContent: {
    paddingBottom: Spacing.one,
  },
  empty: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.one,
    paddingBottom: Spacing.three,
  },
  search: {
    marginHorizontal: Spacing.three,
    marginBottom: Spacing.one,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 15,
  },
  // The row and its delete button, side by side. The delete sits outside the
  // row's own Pressable so the two targets can't overlap.
  rowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: Spacing.two,
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingLeft: Spacing.three,
    paddingRight: Spacing.two,
    paddingVertical: Spacing.two,
  },
  // A 40px target, matching the app's other secondary icon buttons.
  delete: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.two,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  metaRow: {
    flexDirection: 'row',
    gap: Spacing.one,
  },
  // A bordered chip, matching the entry sheet's category chips and the filter
  // chips on the GitHub issues screen — same 0.35 border, squircle, not a pill.
  currentChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
  },
  pressed: {
    opacity: 0.6,
  },
});
