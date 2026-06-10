import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, type NativeSyntheticEvent, type TextInputSelectionChangeEventData } from 'react-native';

import { MarkdownView } from '@/components/markdown-view';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { toggleCheckboxAt } from '@/lib/markdown';

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
};

/**
 * A body field that previews Markdown and edits raw text. Tapping a word in the
 * preview drops into a plain TextInput with the caret placed at that exact spot;
 * blurring returns to the rendered view. Checkbox taps toggle in place without
 * leaving the preview. Pass `key={id}` so the edit/preview state resets when
 * navigating between notes.
 */
export function MarkdownEditor({ value, onChangeText, placeholder }: Props) {
  const theme = useTheme();
  const [editing, setEditing] = useState(value.trim().length === 0);
  // Focus the field only when the user taps in, not on the initial empty state —
  // so opening a new note leaves the keyboard free for the title first.
  const [autoFocus, setAutoFocus] = useState(false);
  // The caret is *seeded* to the tapped offset, then released so typing stays
  // uncontrolled (a permanently controlled selection makes the caret lag).
  const [seed, setSeed] = useState<{ start: number; end: number }>();

  const startEditing = (offset: number) => {
    const at = Math.max(0, Math.min(offset, value.length));
    setSeed({ start: at, end: at });
    setAutoFocus(true);
    setEditing(true);
  };

  // Once the native view applies the seeded caret, hand control back.
  const onSelectionChange = (_e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    if (seed) setSeed(undefined);
  };

  if (editing) {
    return (
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onBlur={() => setEditing(false)}
        selection={seed}
        onSelectionChange={onSelectionChange}
        placeholder={placeholder}
        placeholderTextColor={theme.textSecondary}
        style={[styles.body, { color: theme.text }]}
        autoFocus={autoFocus}
        multiline
        textAlignVertical="top"
      />
    );
  }

  return (
    // Fallback: a tap that misses any word drops the caret at the end.
    <Pressable onPress={() => startEditing(value.length)} style={styles.preview}>
      {value.trim().length === 0 ? (
        <ThemedText themeColor="textSecondary" style={styles.body}>
          {placeholder}
        </ThemedText>
      ) : (
        <MarkdownView
          text={value}
          onPressAt={startEditing}
          onToggleCheckbox={(line) => onChangeText(toggleCheckboxAt(value, line))}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '500',
    minHeight: 300,
  },
  preview: {
    minHeight: 300,
  },
});
