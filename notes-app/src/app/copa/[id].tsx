import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  InteractionManager,
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
import { DRAFT_COPA_ID, isEmptyCopaBlock } from '@/lib/copa-block';
import {
  downloadCopaFile,
  fileIconFor,
  formatBytes,
  isImage,
  isVideo,
  openCopaFile,
} from '@/lib/copa-files';
import { useEditAction } from '@/hooks/use-edit-action';
import { useScreenFadeStyle } from '@/hooks/use-screen-fade';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { noFocusOutline } from '@/lib/web-style';
import { useCopa } from '@/store/copa-store';
import { noScrollbar } from '@/lib/scroll-style';

export default function CopaBlockScreen() {
  const { id: routeId } = useLocalSearchParams<{ id: string }>();
  const { getCopa, createCopa, updateCopa, deleteCopa } = useCopa();
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const fadeStyle = useScreenFadeStyle();

  // Measured height of the sticky title block, so the fade gradient sits right
  // beneath it regardless of how many lines the title wraps to.
  const [titleHeight, setTitleHeight] = useState(0);

  // A draft: (+) opened this screen without writing anything. The row appears on
  // the first keystroke (`promote` below), and its id is held here rather than
  // pushed into the URL — changing `routeId` mid-edit would remount the editor
  // and take the caret with it. So everything about *identity* keys off
  // `routeId`, and everything that reads or writes the store uses `id`.
  //
  // The URL keeps saying `/copa/new` after promotion, which is the deliberate
  // half of that trade: reloading it on web opens a fresh draft rather than the
  // block just written (which is safe in the feed, not lost). Putting the real
  // id in the URL would re-run the seed effect and remount the editor mid-edit,
  // and a caret lost on every first keystroke is the worse of the two.
  const isDraft = routeId === DRAFT_COPA_ID;
  const [draftId, setDraftId] = useState<string | null>(null);
  const id = draftId ?? routeId;

  const item = getCopa(id);
  const [label, setLabel] = useState(item?.label ?? '');
  const [content, setContent] = useState(item?.content ?? '');

  // True once the user has actually typed in this block. Commits are gated on it
  // so a *remote* update to an open block (from another device via sync) never
  // makes this screen re-push its own stale local copy — that echo, bouncing
  // between two open clients, is what made conflicting values flip back and
  // forth. Seeding on navigation does not set it; only the input handlers do.
  const editedRef = useRef(false);
  // What we last committed to (or seeded from) the store for this block. Local
  // state ahead of it is an uncommitted edit of ours; a *stored* block ahead of
  // it is a change that arrived from another device. Telling those apart is what
  // lets the screen adopt remote edits without ever eating a keystroke.
  const committedRef = useRef({ label: item?.label ?? '', content: item?.content ?? '' });
  // Bumped when a remote body is adopted, to remount the (uncontrolled) editor
  // so it reseeds — see MarkdownEditor, which freezes its initial value.
  const [contentRev, setContentRev] = useState(0);
  // Turn a draft into a real block on the first keystroke that leaves something
  // worth keeping. Created *with* the text rather than empty-then-updated, so
  // there is never an empty row to push to the other devices.
  //
  // The editor reports a change when it seeds itself as well as when you type,
  // so emptiness decides this, not the event. `isEmptyCopaBlock` is the same
  // rule the unmount sweep below uses.
  const promotedRef = useRef(false);
  const promote = (nextLabel: string, nextContent: string) => {
    if (!isDraft || promotedRef.current) return;
    if (isEmptyCopaBlock({}, nextLabel, nextContent)) return;
    promotedRef.current = true;
    // Record what was just committed. Without this, `committedRef` stays at the
    // mount value and the adopt effect below reads "local matches committed" the
    // moment you delete what you typed — then adopts the stored text back as
    // though another device had sent it, restoring the character you just
    // removed and leaving behind the very block this draft exists to avoid.
    committedRef.current = { label: nextLabel, content: nextContent };
    setDraftId(createCopa({ label: nextLabel, content: nextContent }));
  };

  const onChangeLabel = (t: string) => {
    editedRef.current = true;
    promote(t, content);
    setLabel(t);
  };
  const onChangeContent = (html: string) => {
    editedRef.current = true;
    promote(label, html);
    setContent(html);
  };

  // Rich-editor handle + live state, so the floating toolbar can drive and
  // reflect formatting while the body is focused.
  const editorRef = useRef<EnrichedTextInputInstance>(null);
  const [editing, setEditing] = useState(false);
  const [fmtState, setFmtState] = useState<OnChangeStateEvent | null>(null);

  // A copy block holds no children, so the navbar's (+) is a pencil that puts
  // the caret in the body. A file block has no editor at all — it keeps the
  // plain create button. Registration follows *focus*, which matters here more
  // than anywhere: the copa tab stays mounted while you're on other screens.
  useEditAction(item?.fileUri ? null : () => editorRef.current?.focus());

  // A draft has nothing to read, so it opens ready to type — the one screen that
  // does. Everywhere else you arrive in a read view and tap the content to edit;
  // a block you just asked for is empty by definition, and a pencil there only
  // asks you to confirm you meant it. Deferred past the stack's slide-in so the
  // focus can't race the transition or the editor's own imperative seed.
  useEffect(() => {
    if (!isDraft) return;
    const task = InteractionManager.runAfterInteractions(() => {
      // Someone who tapped the title and started typing during the transition
      // has already chosen where the caret goes; don't take it back.
      if (editedRef.current) return;
      editorRef.current?.focus();
    });
    return () => task.cancel();
  }, [isDraft]);

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
      committedRef.current = { label: current.label, content: current.content };
    }
    editedRef.current = false;
    // Re-run only on a different block, not on every keystroke — and never when
    // a draft is promoted, which changes `id` but not the block on screen.
  }, [routeId]);

  // Adopt an edit made to this block on another device. Without this the screen
  // kept rendering whatever it held when it opened, even though the change had
  // already landed in SQLite and in the copa list. Uncommitted local edits win
  // (they're newer and about to be committed), and nothing is reseeded while the
  // editor holds focus — `editing` is a dependency, so a deferred change lands
  // on blur. Same reasoning as the note screen.
  const storedLabel = item?.label;
  const storedContent = item?.content;
  useEffect(() => {
    if (storedLabel === undefined || storedContent === undefined) return;
    if (editing) return;
    const committed = committedRef.current;
    if (label !== committed.label || content !== committed.content) return;
    if (storedLabel === label && storedContent === content) return;
    committedRef.current = { label: storedLabel, content: storedContent };
    // See the note screen for why this can't come through a sync subscription:
    // the engine's event fires before the store has reloaded.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- adopt remote edit
    setLabel(storedLabel);
    if (storedContent !== content) {
      setContent(storedContent);
      setContentRev((n) => n + 1); // remount the editor so it reseeds
    }
  }, [storedLabel, storedContent, editing, label, content]);

  // Debounced commit so typing stays smooth and storage isn't hit per keystroke.
  // Driven only by user edits (via the local label/content state) — deliberately
  // NOT by `item`, so a remote sync landing while this block is open can't
  // trigger a write-back of our stale copy.
  useEffect(() => {
    if (!editedRef.current) return;
    // A draft that has only ever held whitespace has no row to update, and `id`
    // is still the sentinel.
    if (id === DRAFT_COPA_ID) return;
    const timer = setTimeout(() => {
      // Skip a no-op write (e.g. typed then reverted) so we don't needlessly
      // bump updated_at and re-trigger sync. Compares against the latest stored
      // value via the snapshot, avoiding an `item` dependency here.
      const stored = snapshot.current.stored;
      committedRef.current = { label, content };
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
  //
  // What counts as empty — and why a file block never does, even on a device
  // holding the row but not the bytes — is `isEmptyCopaBlock`. The rule lives
  // there, tested, rather than being re-derived here: this screen kept its own
  // copy of it, so those tests could not have caught the two drifting apart.
  useEffect(
    () => () => {
      const { id: sid, label: sl, content: sc, stored } = snapshot.current;
      if (!stored) return;
      if (isEmptyCopaBlock(stored, sl, sc)) {
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

  // A draft has no row by design, so "not found" is only about a real id — and
  // about a promoted draft whose row is momentarily missing from the store,
  // which must keep showing the text being typed into it.
  if (!item && !isDraft) {
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
          {...noScrollbar}>
          {item?.fileUri ? (
            <FilePreview item={item} />
          ) : (
            <MarkdownEditor
              key={`${routeId}:${contentRev}`}
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
      {!item?.fileUri && (
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

      {/* Every file type can be saved now — media into the library, anything
          else into a folder on Android or via the share sheet on iOS — so this
          no longer hides behind `isSaveableMedia`, which left PDFs with no
          save affordance at all. */}
      {!!item.fileUri && (
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
