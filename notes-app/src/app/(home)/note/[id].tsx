import { Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { getNote } from '@/data/notes';

export default function NoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const note = getNote(id);

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
      <Stack.Screen options={{ title: note.title }} />
      <ScrollView contentContainerStyle={styles.content}>
        <ThemedText type="title" style={styles.title}>
          {note.title}
        </ThemedText>
        <ThemedText type="default">{note.body}</ThemedText>
      </ScrollView>
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
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
});
