import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { EnrichedTextInputInstance, OnChangeStateEvent } from 'react-native-enriched';

import { FormattingToolbar } from '@/components/formatting-toolbar';
import { MarkdownEditor } from '@/components/markdown-editor';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { htmlToPlainText } from '@/lib/html-text';
import { noFocusOutline } from '@/lib/web-style';
import { useNotes } from '@/store/notes-store';

export default function NoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getNote, updateNote, deleteNote } = useNotes();
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  // Measured height of the sticky title block, so the fade gradient sits right
  // beneath it regardless of how many lines the title wraps to.
  const [titleHeight, setTitleHeight] = useState(0);

  const note = getNote(id);
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');

  // True once the user has actually typed in this note. Commits are gated on it
  // so a *remote* update to an open note (from another device via sync) never
  // makes this screen re-push its own stale local copy — that echo, bouncing
  // between two open clients, is what made conflicting titles flip back and
  // forth. Seeding on navigation does not set it; only the input handlers do.
  const editedRef = useRef(false);
  const onChangeTitle = (t: string) => {
    editedRef.current = true;
    setTitle(t);
  };
  const onChangeBody = (html: string) => {
    editedRef.current = true;
    setBody(html);
  };

  // Rich-editor handle + live state, so the floating toolbar can drive and
  // reflect formatting while the body is focused.
  const editorRef = useRef<EnrichedTextInputInstance>(null);
  const [editing, setEditing] = useState(false);
  const [fmtState, setFmtState] = useState<OnChangeStateEvent | null>(null);

  // Latest edit state, refreshed after each render so the unmount flush below
  // can read it without writing refs during render. The store handlers ride
  // along too: `deleteNote` isn't referentially stable (it closes over `notes`),
  // so the unmount effect reads it from here and keeps empty deps — otherwise its
  // cleanup would fire on every notes change, not just on a real unmount.
  const snapshot = useRef({ id, title, body, stored: note, updateNote, deleteNote });
  useEffect(() => {
    snapshot.current = { id, title, body, stored: note, updateNote, deleteNote };
  });

  // Load the note's text when navigating to a different note. Resets the edited
  // flag so the freshly-seeded values aren't mistaken for user input.
  useEffect(() => {
    const current = snapshot.current.stored;
    if (current) {
      setTitle(current.title);
      setBody(current.body);
    }
    editedRef.current = false;
    // Re-run only on a different note, not on every keystroke.
  }, [id]);

  // Debounced commit so typing stays smooth and storage isn't hit per keystroke.
  // Driven only by user edits (via the local title/body state) — deliberately
  // NOT by `note`, so a remote sync landing while this note is open can't trigger
  // a write-back of our stale copy.
  useEffect(() => {
    if (!editedRef.current) return;
    const timer = setTimeout(() => {
      // Skip a no-op write (e.g. typed then reverted) so we don't needlessly
      // bump updated_at and re-trigger sync. Compares against the latest stored
      // value via the snapshot, avoiding a `note` dependency here.
      const stored = snapshot.current.stored;
      if (stored && stored.title === title && stored.body === body) return;
      updateNote(id, { title, body });
    }, 350);
    return () => clearTimeout(timer);
  }, [title, body, id, updateNote]);

  // On leaving the screen: auto-delete a note left completely empty (no title
  // and no text content), otherwise flush any pending edit. A title with an
  // empty body is kept — only "nothing at all" is discarded. Plugin notes (e.g.
  // Sentry) carry no body by design, so they're never treated as empty.
  // Flushing is still gated on `editedRef` so leaving a note that changed
  // underneath us (remote) never clobbers that change with our stale local copy.
  useEffect(
    () => () => {
      const { id: sid, title: st, body: sb, stored, updateNote: update, deleteNote: remove } =
        snapshot.current;
      if (!stored) return;
      const isEmpty =
        !stored.pluginType && st.trim().length === 0 && htmlToPlainText(sb).length === 0;
      if (isEmpty) {
        remove(sid);
        return;
      }
      if (!editedRef.current) return;
      if (stored.title !== st || stored.body !== sb) {
        update(sid, { title: st, body: sb });
      }
    },
    [],
  );

  if (!note) {
    return (
      <ThemedView style={styles.empty}>
        <Stack.Screen options={{ title: 'Not found' }} />
        <ThemedText themeColor="textSecondary">This note could not be found.</ThemedText>
      </ThemedView>
    );
  }

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <KeyboardAvoidingView
          style={styles.container}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <TextInput
            value={title}
            onChangeText={onChangeTitle}
            onLayout={(e) => setTitleHeight(e.nativeEvent.layout.height)}
            placeholder="Title"
            placeholderTextColor={theme.textSecondary}
            style={[
              styles.title,
              noFocusOutline,
              { color: theme.text, paddingTop: insets.top + Spacing.two },
            ]}
            multiline
          />
          <ScrollView
            contentContainerStyle={[
              styles.content,
              // While editing, pad a full screen below so the body scrolls well
              // clear of the keyboard and into blank space (Android is
              // edge-to-edge, so the keyboard doesn't shrink the scroll frame).
              // Collapse it in view mode.
              { paddingBottom: editing ? height : tabBarInset },
            ]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <MarkdownEditor
              key={id}
              value={body}
              onChangeText={onChangeBody}
              placeholder="Start typing…"
              editorRef={editorRef}
              onFocusChange={setEditing}
              onStateChange={setFmtState}
            />
          </ScrollView>
          {/* Fades scrolling body text into the sticky title. */}
          <LinearGradient
            pointerEvents="none"
            colors={[theme.background, `${theme.background}00`]}
            style={[styles.fade, { top: titleHeight }]}
          />
        </KeyboardAvoidingView>
        {/* Outside the KeyboardAvoidingView: it rides the keyboard inset itself. */}
        <FormattingToolbar editorRef={editorRef} state={fmtState} visible={editing} />
      </ThemedView>
    </SwipeBackView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    gap: Spacing.three,
  },
  title: {
    paddingHorizontal: Spacing.four,
    fontSize: 40,
    lineHeight: 46,
    fontWeight: '700',
  },
  fade: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: Spacing.five,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
});
