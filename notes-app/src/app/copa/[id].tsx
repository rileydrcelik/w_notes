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
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useCopa } from '@/store/copa-store';

export default function CopaBlockScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getCopa, updateCopa } = useCopa();
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  // Measured height of the sticky title block, so the fade gradient sits right
  // beneath it regardless of how many lines the title wraps to.
  const [titleHeight, setTitleHeight] = useState(0);

  const item = getCopa(id);
  const [label, setLabel] = useState(item?.label ?? '');
  const [content, setContent] = useState(item?.content ?? '');

  // Rich-editor handle + live state, so the floating toolbar can drive and
  // reflect formatting while the body is focused.
  const editorRef = useRef<EnrichedTextInputInstance>(null);
  const [editing, setEditing] = useState(false);
  const [fmtState, setFmtState] = useState<OnChangeStateEvent | null>(null);

  // Latest edit state, refreshed after each render so the unmount flush below
  // can read it without writing refs during render.
  const snapshot = useRef({ id, label, content, stored: item });
  useEffect(() => {
    snapshot.current = { id, label, content, stored: item };
  });

  // Load the block's text when navigating to a different block.
  useEffect(() => {
    const current = snapshot.current.stored;
    if (current) {
      setLabel(current.label);
      setContent(current.content);
    }
    // Re-run only on a different block, not on every keystroke.
  }, [id]);

  // Debounced commit so typing stays smooth and storage isn't hit per keystroke.
  useEffect(() => {
    if (!item || (item.label === label && item.content === content)) return;
    const timer = setTimeout(() => updateCopa(id, { label, content }), 350);
    return () => clearTimeout(timer);
  }, [label, content, id, item, updateCopa]);

  // Flush any pending edit when leaving the screen.
  useEffect(
    () => () => {
      const { id: sid, label: sl, content: sc, stored } = snapshot.current;
      if (stored && (stored.label !== sl || stored.content !== sc)) {
        updateCopa(sid, { label: sl, content: sc });
      }
    },
    [updateCopa],
  );

  if (!item) {
    return (
      <ThemedView style={styles.empty}>
        <Stack.Screen options={{ title: 'Not found' }} />
        <ThemedText themeColor="textSecondary">This copy block could not be found.</ThemedText>
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
          value={label}
          onChangeText={setLabel}
          onLayout={(e) => setTitleHeight(e.nativeEvent.layout.height)}
          placeholder="Title"
          placeholderTextColor={theme.textSecondary}
          style={[styles.title, { color: theme.text, paddingTop: insets.top + Spacing.two }]}
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
            value={content}
            onChangeText={setContent}
            placeholder="Contents to copy…"
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
