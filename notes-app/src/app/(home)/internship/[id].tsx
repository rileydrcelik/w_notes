/**
 * An application tracker: a note whose body is a list, one application per
 * line, read as a tracker — counts per status up top, then every application
 * grouped by status (furthest along first) and alphabetical within a group.
 * (Code and storage still say "internship", the name it shipped under.)
 *
 * The read view is built from the stored body every render; it keeps no copy of
 * its own, so a change synced from another device just shows up. A status is
 * changed by tapping the row's chip, which rewrites that one line's tag and
 * nothing else (`setEntryStatus`).
 *
 * The navbar's (+) adds an application — a tracker has children, so it offers
 * create, not the pencil — through a small dialog that appends one line
 * (`appendEntry`). Renaming, removing and reordering are editing the list:
 * tapping a row opens the body in the ordinary editor, and the done check
 * brings the tracker back. Tapping a count at the top jumps to its group.
 */
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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
import { StatusChip } from '@/components/internship/status-chip';
import { useStatusColors } from '@/components/internship/status-style';
import { MarkdownEditor } from '@/components/markdown-editor';
import { ScrollToTopButton } from '@/components/scroll-to-top';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useCreateAction } from '@/hooks/use-create-action';
import { useSaveAction } from '@/hooks/use-save-action';
import { useScrollToTop } from '@/hooks/use-scroll-to-top';
import { useScrolled } from '@/hooks/use-scrolled';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { openApplicationDialog } from '@/lib/application-dialog';
import {
  appendEntry,
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

/** How wide the tracker reads on a wide window. A list this narrow scans
 *  faster than one stretched across a desktop screen. */
const MAX_WIDTH = 640;

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
  const editorOpenRef = useRef(editorOpen);
  useEffect(() => {
    snapshot.current = { id, draft, stored: note?.body, updateNote };
    editorOpenRef.current = editorOpen;
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

  // The (+) adds an application — to the body as it is when the dialog answers,
  // read from the snapshot (a `getNote` closure would be the render that
  // opened it, and would write back over anything synced in meanwhile). An
  // edit not yet committed is newer still, so it's the base when there is one,
  // and the add commits it along with the new line.
  const addApplication = () =>
    openApplicationDialog({
      onAdd: (name, status) => {
        const { id: sid, draft: d, stored, updateNote: update } = snapshot.current;
        const next = appendEntry(editedRef.current ? d : (stored ?? ''), name, status);
        if (next === null) return;
        editedRef.current = false;
        update(sid, { body: next });
      },
    });
  useCreateAction(note ? addApplication : null);

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
      // Committed with the editor already put away (the image-picker case):
      // nothing is pending any more, so stop holding back the reseed — or a
      // later flush would write this draft over whatever lands after it.
      if (!editorOpenRef.current) {
        editedRef.current = false;
        seededRef.current = draft;
      }
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

  // The counts up top jump to their group. Measured at the tap, not cached from
  // onLayout: on web that only fires when a group changes *size*, so one that
  // merely moved (a line added above it) would keep a stale offset.
  const groupRefs = useRef<Partial<Record<InternshipStatus, View | null>>>({});
  const frameRef = useRef<View>(null);
  const scrollY = useRef(0);
  const jumpTo = (status: InternshipStatus | 'total') => {
    const target = status === 'total' ? groups[0]?.status : status;
    const group = target ? groupRefs.current[target] : null;
    // The view around the ScrollView shares its top edge, and unlike the
    // ScrollView it's typed as measurable.
    const frame = frameRef.current;
    if (!group || !frame) return;
    group.measureInWindow((_gx, groupTop) => {
      frame.measureInWindow((_fx, frameTop) => {
        const y = scrollY.current + groupTop - frameTop - Spacing.three;
        listRef.current?.scrollTo({ y: Math.max(0, y), animated: true });
      });
    });
  };

  // The fade under the title shows as soon as the content has moved at all —
  // not at the back-to-top button's threshold, which is well down the list.
  const top = useScrolled();
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollProps.onScroll(e);
    top.scrollProps.onScroll(e);
    scrollY.current = e.nativeEvent.contentOffset.y;
  };
  const statusColors = useStatusColors();

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
            placeholder="Applications"
            placeholderTextColor={theme.textSecondary}
            style={[
              styles.title,
              styles.column,
              noFocusOutline,
              { color: theme.text, paddingTop: insets.top + Spacing.two },
            ]}
            multiline
          />
          <View ref={frameRef} style={styles.container}>
            <ScrollView
              {...scrollProps}
              onScroll={onScroll}
              onLayout={(e) => {
                frameHeight.current = e.nativeEvent.layout.height;
              }}
              contentContainerStyle={[
                styles.content,
                styles.column,
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
                  placeholder="One application per line…"
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
                        color={statusColors[s]}
                        onPress={() => jumpTo(s)}
                      />
                    ))}
                    <Stat
                      label="Total"
                      value={counts.total}
                      color={theme.text}
                      onPress={() => jumpTo('total')}
                    />
                  </View>

                  {entries.length === 0 ? (
                    // A body with no lines to read (only a heading, say) still
                    // has something to edit — and no pencil to get there.
                    <Pressable
                      onPress={body.trim() ? openEditor : addApplication}
                      style={styles.empty}
                    >
                      <ThemedText themeColor="textSecondary">No applications yet.</ThemedText>
                      <ThemedText type="small" themeColor="textSecondary">
                        Tap + to add one.
                      </ThemedText>
                    </Pressable>
                  ) : (
                    groups.map((group) => (
                      <View
                        key={group.status}
                        style={styles.group}
                        ref={(node) => {
                          groupRefs.current[group.status] = node;
                        }}
                      >
                        <View style={styles.groupHeader}>
                          <View
                            style={[styles.dot, { backgroundColor: statusColors[group.status] }]}
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
                            style={[styles.row, { borderColor: hairline }]}
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
            <TopFade visible={top.scrolled} />
          </View>
        </KeyboardAvoidingView>
        <ScrollToTopButton visible={scrolled && !editorOpen} onPress={scrollToTop} />
        <FormattingToolbar editorRef={editorRef} state={fmtState} visible={editorOpen} />
      </ThemedView>
    </SwipeBackView>
  );
}

function Stat({
  label,
  value,
  color,
  onPress,
}: {
  label: string;
  value: number;
  color: string;
  /** Jumps to the group; a zero has no group to jump to. */
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={value === 0}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}. Show in list`}
      style={({ pressed }) => [
        styles.stat,
        { borderColor: hexToRgba(theme.text, 0.12) },
        pressed && styles.pressed,
      ]}
    >
      <ThemedText style={[styles.statValue, { color }]}>{value}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Capped and centred on a wide window; a phone is narrower than the cap.
  column: { width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center' },
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
  pressed: { opacity: 0.6 },
});
