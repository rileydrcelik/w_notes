import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useNotes } from '@/store/notes-store';

export default function NoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getNote, updateNote } = useNotes();
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();

  // Measured height of the sticky title block, so the fade gradient sits right
  // beneath it regardless of how many lines the title wraps to.
  const [titleHeight, setTitleHeight] = useState(0);

  const note = getNote(id);
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');

  // Latest edit state, refreshed after each render so the unmount flush below
  // can read it without writing refs during render.
  const snapshot = useRef({ id, title, body, stored: note });
  useEffect(() => {
    snapshot.current = { id, title, body, stored: note };
  });

  // Load the note's text when navigating to a different note.
  useEffect(() => {
    const current = snapshot.current.stored;
    if (current) {
      setTitle(current.title);
      setBody(current.body);
    }
    // Re-run only on a different note, not on every keystroke.
  }, [id]);

  // Debounced commit so typing stays smooth and storage isn't hit per keystroke.
  useEffect(() => {
    if (!note || (note.title === title && note.body === body)) return;
    const timer = setTimeout(() => updateNote(id, { title, body }), 350);
    return () => clearTimeout(timer);
  }, [title, body, id, note, updateNote]);

  // Flush any pending edit when leaving the screen.
  useEffect(
    () => () => {
      const { id: sid, title: st, body: sb, stored } = snapshot.current;
      if (stored && (stored.title !== st || stored.body !== sb)) {
        updateNote(sid, { title: st, body: sb });
      }
    },
    [updateNote],
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
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          onLayout={(e) => setTitleHeight(e.nativeEvent.layout.height)}
          placeholder="Title"
          placeholderTextColor={theme.textSecondary}
          style={[styles.title, { color: theme.text, paddingTop: insets.top + Spacing.two }]}
          multiline
        />
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: tabBarInset }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          <TextInput
            value={body}
            onChangeText={setBody}
            placeholder="Start typing…"
            placeholderTextColor={theme.textSecondary}
            style={[styles.body, { color: theme.text }]}
            multiline
            textAlignVertical="top"
          />
        </ScrollView>
        {/* Fades scrolling body text into the sticky title. */}
        <LinearGradient
          pointerEvents="none"
          colors={[theme.background, `${theme.background}00`]}
          style={[styles.fade, { top: titleHeight }]}
        />
      </KeyboardAvoidingView>
    </ThemedView>
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
  body: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '500',
    minHeight: 300,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
});
