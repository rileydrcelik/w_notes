/**
 * An internship tracker: a note whose body is a list, one internship per line,
 * read as a tracker — counts per status up top, then every internship grouped
 * by status (furthest along first) and alphabetical within a group.
 *
 * The read view is built from the stored body every render; it keeps no copy of
 * its own, so a change synced from another device just shows up. A status is
 * changed by tapping the row's chip, which rewrites that one line's tag and
 * nothing else (`setEntryStatus`).
 *
 * Adding, renaming, removing and reordering internships is editing the list,
 * and editing is the app-wide gesture: the navbar's pencil — or tapping a row —
 * opens the body in the ordinary editor, and the done check brings the tracker
 * back. That's also why this screen offers no (+): an internship is a line of
 * this document, not an object made somewhere else.
 */
import Feather from '@expo/vector-icons/Feather';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { EnrichedTextInputInstance, OnChangeStateEvent } from 'react-native-enriched';

import { FormattingToolbar } from '@/components/formatting-toolbar';
import { TopFade } from '@/components/edge-fade';
import { STATUS_COLOR } from '@/components/internship/status-style';
import { MarkdownEditor } from '@/components/markdown-editor';
import { ScrollToTopButton } from '@/components/scroll-to-top';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useEditAction } from '@/hooks/use-edit-action';
import { useSaveAction } from '@/hooks/use-save-action';
import { useScrollToTop } from '@/hooks/use-scroll-to-top';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import {
  countByStatus,
  groupEntries,
  INTERNSHIP_STATUSES,
  parseTracker,
  setEntryStatus,
  STATUS_LABEL,
  type InternshipStatus,
  type TrackerEntry,
} from '@/lib/internship';
import { saveNoteToDevice } from '@/lib/save-note';
import { noFocusOutline } from '@/lib/web-style';
import { useNotes } from '@/store/notes-store';

/** Matches the note body's debounce. */
const COMMIT_DEBOUNCE_MS = 350;

export default function InternshipTrackerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getNote, updateNote } = useNotes();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const { height } = useWindowDimensions();
  const { scrollProps, listRef, scrolled, scrollToTop } = useScrollToTop<ScrollView>();

  const note = getNote(id);
  const body = note?.body ?? '';

  const [title, setTitle] = useState(note?.title ?? '');
  const onChangeTitle = (next: string) => {
    setTitle(next);
    updateNote(id, { title: next });
  };

  // ── Editing the list ─────────────────────────────────────────────────────
  // The editor is mounted with the screen and seeded in the background, as the
  // note screen's is, and only *shown* while editing. Mounting it on demand
  // instead raced its asynchronous seed against the focus that opened it — lose
  // that race and the field opened empty, and the first thing typed replaced
  // the whole list — and unmounting it on blur threw away an image picked from
  // the toolbar, since presenting the picker is itself a blur.
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState(body);
  const [editorRev, setEditorRev] = useState(0);
  const editorRef = useRef<EnrichedTextInputInstance>(null);
  const [fmtState, setFmtState] = useState<OnChangeStateEvent | null>(null);
  // Set only by typing, never by seeding — so opening the editor and leaving
  // without a change writes nothing, and can't clobber a status another device
  // changed meanwhile with this device's older copy.
  const editedRef = useRef(false);
  // The body the mounted editor holds, and whether its seed has landed.
  const seededRef = useRef(body);
  const readyRef = useRef(false);
  const focusWhenReady = useRef(false);

  const snapshot = useRef({ id, draft, stored: note?.body, updateNote });
  useEffect(() => {
    snapshot.current = { id, draft, stored: note?.body, updateNote };
  });

  const flush = () => {
    const { id: sid, draft: d, stored, updateNote: update } = snapshot.current;
    if (!editedRef.current) return;
    editedRef.current = false;
    // The editor already holds this text; don't reseed it with its own words.
    seededRef.current = d;
    if (stored !== d) update(sid, { body: d });
  };

  // Keep the hidden editor current. A status tapped here, or an edit synced in,
  // changes the stored body; remount the editor on it so the next edit starts
  // from the list as it is now, not as it was when the screen opened. Never
  // while open, and never over an edit not yet committed.
  useEffect(() => {
    if (editorOpen || editedRef.current || body === seededRef.current) return;
    seededRef.current = body;
    readyRef.current = false;
    setDraft(body);
    setEditorRev((n) => n + 1);
  }, [body, editorOpen]);

  const focusEditor = () => {
    if (readyRef.current) editorRef.current?.focus();
    else focusWhenReady.current = true;
  };

  // The seed has landed. A focus asked for before it did waits a beat longer:
  // the seed's change event can trail the command that applied it, and one
  // arriving after focus would read as typing.
  const onSeeded = () => {
    readyRef.current = true;
    if (!focusWhenReady.current) return;
    focusWhenReady.current = false;
    setTimeout(() => editorRef.current?.focus(), 150);
  };

  const openEditor = () => {
    setEditorOpen(true);
    // After the frame that shows it: a hidden field can't take focus.
    requestAnimationFrame(focusEditor);
  };

  // The pencil; it becomes the done check once the editor takes focus.
  useEditAction(openEditor);

  const onChangeDraft = (html: string) => {
    editedRef.current = true;
    setDraft(html);
  };

  // Not gated on `editorOpen`: an image picked from the toolbar arrives after
  // the picker's blur has already put the editor away.
  useEffect(() => {
    if (!editedRef.current) return;
    const timer = setTimeout(() => {
      const { id: sid, stored, updateNote: update } = snapshot.current;
      if (stored !== draft) update(sid, { body: draft });
    }, COMMIT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  // Leaving the editor — the navbar's done check, a tap away, the keyboard
  // going down — is leaving edit mode: flush now rather than on the debounce,
  // so the tracker that comes back is built from what was just typed.
  //
  // Except when the whole window lost focus (web: another app, another tab, the
  // file dialog Ctrl+I opens). The browser blurs the field for that too, and
  // hands focus straight back when the window returns — still mid-edit.
  const onEditorFocus = (focused: boolean) => {
    if (focused) return;
    if (Platform.OS === 'web' && typeof document !== 'undefined' && !document.hasFocus()) return;
    flush();
    setEditorOpen(false);
  };

  // Leaving the screen mid-edit.
  useEffect(() => () => flush(), []);

  // ── Keeping the caret above the keyboard ────────────────────────────────
  // The note screen's approach, for the same editor: Android is edge-to-edge,
  // so the keyboard covers the frame instead of shrinking it, and the editor
  // doesn't scroll itself. When the body grows with the caret at its end, bring
  // the last line back into view.
  const keyboardInset = useRef(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      keyboardInset.current = e.endCoordinates.height;
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardInset.current = 0;
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const frameHeight = useRef(0);
  const caretAtEnd = useRef(true);
  const onEditorLayout = (e: LayoutChangeEvent) => {
    if (!editorOpen || !caretAtEnd.current) return;
    const visible = frameHeight.current - keyboardInset.current;
    if (visible <= 0) return;
    const y = e.nativeEvent.layout.height - visible + Spacing.six;
    if (y > 0) listRef.current?.scrollTo({ y, animated: true });
  };

  // ── Reading ──────────────────────────────────────────────────────────────
  const entries = useMemo(() => parseTracker(body), [body]);
  const groups = useMemo(() => groupEntries(entries), [entries]);
  const counts = useMemo(() => countByStatus(entries), [entries]);
  const [picking, setPicking] = useState<number | null>(null);

  const setStatus = (entry: TrackerEntry, status: InternshipStatus) => {
    setPicking(null);
    if (status === entry.status && entry.tagged) return;
    // Against the stored body as it is now, not as this render saw it.
    const current = getNote(id)?.body ?? '';
    const next = setEntryStatus(current, entry, status);
    if (next !== null && next !== current) updateNote(id, { body: next });
  };

  useSaveAction(
    note && !editorOpen && entries.length > 0
      ? {
          label: 'Save tracker to device',
          run: () => void saveNoteToDevice(note),
        }
      : null,
  );

  if (!note) {
    return (
      <ThemedView style={styles.centered}>
        <Stack.Screen options={{ title: 'Not found' }} />
        <ThemedText themeColor="textSecondary">This tracker could not be found.</ThemedText>
      </ThemedView>
    );
  }

  const hairline = hexToRgba(theme.text, 0.12);

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <KeyboardAvoidingView
          style={styles.container}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <TextInput
            value={title}
            onChangeText={onChangeTitle}
            placeholder="Internships"
            placeholderTextColor={theme.textSecondary}
            style={[
              styles.title,
              noFocusOutline,
              { color: theme.text, paddingTop: insets.top + Spacing.two },
            ]}
            multiline
          />
          <View style={styles.container}>
            <ScrollView
              {...scrollProps}
              onLayout={(e) => {
                frameHeight.current = e.nativeEvent.layout.height;
              }}
              contentContainerStyle={[
                styles.content,
                { paddingBottom: editorOpen ? height : tabBarInset },
              ]}
              keyboardShouldPersistTaps="handled"
            >
              {/* Mounted throughout, shown only while editing — see above. */}
              <View
                style={editorOpen ? undefined : styles.hidden}
                pointerEvents={editorOpen ? 'auto' : 'none'}
                onLayout={onEditorLayout}
              >
                <MarkdownEditor
                  key={`${id}:${editorRev}`}
                  value={draft}
                  onChangeText={onChangeDraft}
                  placeholder="One internship per line…"
                  editorRef={editorRef}
                  onFocusChange={onEditorFocus}
                  onStateChange={setFmtState}
                  onSelectionChange={(sel) => {
                    caretAtEnd.current = sel.atEnd;
                  }}
                  onSeeded={onSeeded}
                />
              </View>
              {editorOpen ? null : (
                <>
                  <View style={styles.stats}>
                    {INTERNSHIP_STATUSES.map((s) => (
                      <Stat
                        key={s}
                        label={STATUS_LABEL[s]}
                        value={counts[s]}
                        color={STATUS_COLOR[s]}
                      />
                    ))}
                    <Stat label="Total" value={counts.total} color={theme.text} />
                  </View>

                  {entries.length === 0 ? (
                    <Pressable onPress={openEditor} style={styles.empty}>
                      <ThemedText themeColor="textSecondary">No internships yet.</ThemedText>
                      <ThemedText type="small" themeColor="textSecondary">
                        Tap the pencil and add one per line.
                      </ThemedText>
                    </Pressable>
                  ) : (
                    groups.map((group) => (
                      <View key={group.status} style={styles.group}>
                        <View style={styles.groupHeader}>
                          <View
                            style={[styles.dot, { backgroundColor: STATUS_COLOR[group.status] }]}
                          />
                          <ThemedText type="smallBold">{STATUS_LABEL[group.status]}</ThemedText>
                          <ThemedText type="small" themeColor="textSecondary">
                            {group.entries.length}
                          </ThemedText>
                        </View>
                        {group.entries.map((entry) => (
                          <Animated.View
                            key={`${entry.index}:${entry.text}`}
                            layout={LinearTransition.duration(220)}
                            style={[
                              styles.row,
                              {
                                backgroundColor: theme.backgroundElement,
                                borderColor: hairline,
                              },
                            ]}
                          >
                            <View style={styles.rowMain}>
                              <Pressable onPress={openEditor} style={styles.rowText}>
                                <ThemedText>{entry.text}</ThemedText>
                                {entry.detail ? (
                                  <ThemedText type="small" themeColor="textSecondary">
                                    {entry.detail}
                                  </ThemedText>
                                ) : null}
                              </Pressable>
                              <StatusChip
                                status={entry.status}
                                selected
                                opens
                                onPress={() =>
                                  setPicking(picking === entry.index ? null : entry.index)
                                }
                                accessibilityLabel={`Status: ${STATUS_LABEL[entry.status]}. Change`}
                              />
                            </View>
                            {picking === entry.index && (
                              <Animated.View
                                entering={FadeIn.duration(150)}
                                exiting={FadeOut.duration(120)}
                                style={styles.picker}
                              >
                                {INTERNSHIP_STATUSES.map((s) => (
                                  <StatusChip
                                    key={s}
                                    status={s}
                                    selected={s === entry.status}
                                    onPress={() => setStatus(entry, s)}
                                    accessibilityLabel={`Mark ${entry.text} as ${STATUS_LABEL[s]}`}
                                  />
                                ))}
                              </Animated.View>
                            )}
                          </Animated.View>
                        ))}
                      </View>
                    ))
                  )}
                </>
              )}
            </ScrollView>
            {/* Rows dissolve into the title rather than cutting against it. */}
            <TopFade visible={scrolled} />
          </View>
        </KeyboardAvoidingView>
        <ScrollToTopButton visible={scrolled && !editorOpen} onPress={scrollToTop} />
        <FormattingToolbar editorRef={editorRef} state={fmtState} visible={editorOpen} />
      </ThemedView>
    </SwipeBackView>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.stat, { borderColor: hexToRgba(theme.text, 0.12) }]}>
      <ThemedText style={[styles.statValue, { color }]}>{value}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
        {label}
      </ThemedText>
    </View>
  );
}

/** A status as a bordered chip — the StateFilterBar control, per status colour. */
function StatusChip({
  status,
  selected,
  opens = false,
  onPress,
  accessibilityLabel,
}: {
  status: InternshipStatus;
  selected: boolean;
  /** The row's own chip, which opens the picker — marked with a chevron. */
  opens?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const theme = useTheme();
  const color = STATUS_COLOR[status];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? hexToRgba(color, 0.16) : 'transparent',
          borderColor: selected ? color : hexToRgba(theme.text, 0.12),
        },
        pressed && styles.pressed,
      ]}
    >
      <ThemedText
        type="small"
        style={[styles.chipText, { color: selected ? color : theme.textSecondary }]}
      >
        {STATUS_LABEL[status]}
      </ThemedText>
      {opens && <Feather name="chevron-down" size={12} color={color} style={styles.chevron} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Out of sight but still a live native view: the editor has to take its seed
  // while hidden, and a `display: none` subtree may not be mounted at all on
  // native. Web has no such problem, and there `none` also keeps the hidden
  // field out of the tab order.
  hidden: Platform.select({
    web: { display: 'none' as const },
    default: {
      position: 'absolute' as const,
      left: 0,
      right: 0,
      height: 0,
      opacity: 0,
      overflow: 'hidden' as const,
    },
  }),
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  title: {
    paddingHorizontal: Spacing.four,
    fontSize: 40,
    lineHeight: 46,
    fontWeight: '700',
  },
  content: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    gap: Spacing.four,
  },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  stat: {
    minWidth: 84,
    flexGrow: 1,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.half,
  },
  statValue: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
  empty: {
    gap: Spacing.one,
    paddingVertical: Spacing.four,
    alignItems: 'center',
  },
  group: { gap: Spacing.two },
  groupHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  dot: { width: 8, height: 8, borderRadius: Spacing.one },
  row: {
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  rowText: { flex: 1, gap: Spacing.half },
  picker: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.two,
    borderWidth: 1,
  },
  chipText: { fontWeight: '600' },
  chevron: { marginLeft: Spacing.half },
  pressed: { opacity: 0.6 },
});
