import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { EnrichedTextInputInstance, OnChangeStateEvent } from 'react-native-enriched';

import { FormattingToolbar } from '@/components/formatting-toolbar';
import { MarkdownEditor } from '@/components/markdown-editor';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { type CopaItem } from '@/data/copa';
import {
  downloadCopaFile,
  fileIconFor,
  formatBytes,
  isImage,
  isSaveableMedia,
  isVideo,
  openCopaFile,
} from '@/lib/copa-files';
import { useScreenFadeStyle } from '@/hooks/use-screen-fade';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { htmlToPlainText } from '@/lib/html-text';
import { noFocusOutline } from '@/lib/web-style';
import { useCopa } from '@/store/copa-store';

export default function CopaBlockScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getCopa, updateCopa, deleteCopa } = useCopa();
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const fadeStyle = useScreenFadeStyle();

  // Measured height of the sticky title block, so the fade gradient sits right
  // beneath it regardless of how many lines the title wraps to.
  const [titleHeight, setTitleHeight] = useState(0);

  const item = getCopa(id);
  const [label, setLabel] = useState(item?.label ?? '');
  const [content, setContent] = useState(item?.content ?? '');

  // True once the user has actually typed in this block. Commits are gated on it
  // so a *remote* update to an open block (from another device via sync) never
  // makes this screen re-push its own stale local copy — that echo, bouncing
  // between two open clients, is what made conflicting values flip back and
  // forth. Seeding on navigation does not set it; only the input handlers do.
  const editedRef = useRef(false);
  const onChangeLabel = (t: string) => {
    editedRef.current = true;
    setLabel(t);
  };
  const onChangeContent = (html: string) => {
    editedRef.current = true;
    setContent(html);
  };

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

  // Load the block's text when navigating to a different block. Resets the edited
  // flag so the freshly-seeded values aren't mistaken for user input.
  useEffect(() => {
    const current = snapshot.current.stored;
    if (current) {
      setLabel(current.label);
      setContent(current.content);
    }
    editedRef.current = false;
    // Re-run only on a different block, not on every keystroke.
  }, [id]);

  // Debounced commit so typing stays smooth and storage isn't hit per keystroke.
  // Driven only by user edits (via the local label/content state) — deliberately
  // NOT by `item`, so a remote sync landing while this block is open can't
  // trigger a write-back of our stale copy.
  useEffect(() => {
    if (!editedRef.current) return;
    const timer = setTimeout(() => {
      // Skip a no-op write (e.g. typed then reverted) so we don't needlessly
      // bump updated_at and re-trigger sync. Compares against the latest stored
      // value via the snapshot, avoiding an `item` dependency here.
      const stored = snapshot.current.stored;
      if (stored && stored.label === label && stored.content === content) return;
      updateCopa(id, { label, content });
    }, 350);
    return () => clearTimeout(timer);
  }, [label, content, id, updateCopa]);

  // On leaving the screen: auto-delete a block left completely empty (no title,
  // no body text), otherwise flush any pending edit. File blocks carry a file by
  // design, so they're never treated as empty. Flushing stays gated on
  // `editedRef` so leaving a block that changed underneath us (remote) never
  // clobbers that remote change with our stale local copy.
  useEffect(
    () => () => {
      const { id: sid, label: sl, content: sc, stored } = snapshot.current;
      if (!stored) return;
      const isEmpty =
        !stored.fileUri && sl.trim().length === 0 && htmlToPlainText(sc).length === 0;
      if (isEmpty) {
        deleteCopa(sid);
        return;
      }
      if (!editedRef.current) return;
      if (stored.label !== sl || stored.content !== sc) {
        updateCopa(sid, { label: sl, content: sc });
      }
    },
    [updateCopa, deleteCopa],
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
    <Animated.View style={[styles.container, fadeStyle]}>
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TextInput
          value={label}
          onChangeText={onChangeLabel}
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
          {item.fileUri ? (
            <FilePreview item={item} />
          ) : (
            <MarkdownEditor
              key={id}
              value={content}
              onChangeText={onChangeContent}
              placeholder="Contents to copy…"
              editorRef={editorRef}
              onFocusChange={setEditing}
              onStateChange={setFmtState}
            />
          )}
        </ScrollView>
        {/* Fades scrolling body text into the sticky title. */}
        <LinearGradient
          pointerEvents="none"
          colors={[theme.background, `${theme.background}00`]}
          style={[styles.fade, { top: titleHeight }]}
        />
      </KeyboardAvoidingView>
      {/* Outside the KeyboardAvoidingView: it rides the keyboard inset itself.
          File blocks have no rich body, so the toolbar never applies to them. */}
      {!item.fileUri && (
        <FormattingToolbar editorRef={editorRef} state={fmtState} visible={editing} />
      )}
    </ThemedView>
    </Animated.View>
  );
}

/**
 * Read-only preview for a file block: a large thumbnail (image/video) or a
 * file-type icon, the file's metadata, and an Open button that hands the file to
 * the OS share/open sheet.
 */
function FilePreview({ item }: { item: CopaItem }) {
  const theme = useTheme();
  const showImage = isImage(item.mimeType) && !!item.fileUri;
  const showVideo = isVideo(item.mimeType) && !!item.thumbUri;

  return (
    <View style={styles.preview}>
      <View style={[styles.previewThumb, { backgroundColor: theme.backgroundElement }]}>
        {showImage ? (
          <Image source={{ uri: item.fileUri }} style={styles.previewImage} contentFit="contain" />
        ) : showVideo ? (
          <>
            <Image source={{ uri: item.thumbUri }} style={styles.previewImage} contentFit="contain" />
            <View style={styles.previewPlayBadge}>
              <Feather name="play" size={28} color="#fff" />
            </View>
          </>
        ) : (
          <Feather name={fileIconFor(item.mimeType)} size={72} color={theme.textSecondary} />
        )}
      </View>

      <ThemedText numberOfLines={2} style={styles.previewName}>
        {item.fileName}
      </ThemedText>
      <ThemedText themeColor="textSecondary" style={styles.previewMeta}>
        {[item.mimeType, formatBytes(item.fileSize)].filter(Boolean).join('  ·  ')}
      </ThemedText>

      {isSaveableMedia(item.mimeType) && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save to device"
          onPress={() => void downloadCopaFile(item)}
          style={({ pressed }) => [
            styles.openButton,
            { backgroundColor: theme.backgroundElement },
            pressed && styles.openButtonPressed,
          ]}>
          <Feather name="download" size={18} color={theme.text} />
          <ThemedText style={styles.openLabel}>Save to device</ThemedText>
        </Pressable>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open file"
        onPress={() => void openCopaFile(item)}
        style={({ pressed }) => [
          styles.openButton,
          { backgroundColor: theme.backgroundElement },
          pressed && styles.openButtonPressed,
        ]}>
        <Feather name="external-link" size={18} color={theme.text} />
        <ThemedText style={styles.openLabel}>Open</ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  preview: {
    gap: Spacing.two,
  },
  previewThumb: {
    height: 260,
    borderRadius: Spacing.three,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  previewPlayBadge: {
    position: 'absolute',
    width: 60,
    height: 60,
    borderRadius: Spacing.four,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  previewName: {
    fontSize: 18,
    fontWeight: '600',
  },
  previewMeta: {
    fontSize: 14,
  },
  openButton: {
    marginTop: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three,
    borderRadius: Spacing.three,
  },
  openButtonPressed: {
    opacity: 0.6,
  },
  openLabel: {
    fontSize: 16,
    fontWeight: '600',
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
