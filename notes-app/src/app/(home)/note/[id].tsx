import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
} from 'react-native';

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
      <Stack.Screen options={{ title: title || 'Note' }} />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: tabBarInset }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Title"
            placeholderTextColor={theme.textSecondary}
            style={[styles.title, { color: theme.text }]}
            multiline
          />
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
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: Spacing.four,
    gap: Spacing.three,
  },
  title: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '700',
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
