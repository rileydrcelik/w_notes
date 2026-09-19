import Feather from '@expo/vector-icons/Feather';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BackHandler, Linking, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useKeyboardPadding } from '@/hooks/use-keyboard-inset';
import { useTheme } from '@/hooks/use-theme';
import {
  closeLinkDialog,
  getLinkDialog,
  subscribeLinkDialog,
  type LinkDialogRequest,
} from '@/lib/link-dialog';
import { isOpenableLinkUrl, normalizeLinkUrl } from '@/lib/link-url';
import { noFocusOutline } from '@/lib/web-style';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const DESTRUCTIVE = '#e5484d';

/**
 * Add, change or remove a link in the focused note editor.
 *
 * Opened by the editor — cmd/ctrl+K on web, the link button in the formatting
 * bar on a phone — through `lib/link-dialog.ts`, and mounted once at the root so
 * it stacks above the navbar rather than scrolling with the body. It never
 * touches the document itself: the editor that opened it knows the selection
 * and applies the result.
 */
export function LinkDialog() {
  const request = useSyncExternalStore(subscribeLinkDialog, getLinkDialog, () => null);
  const keyboardPadding = useKeyboardPadding();
  return (
    <View style={styles.overlay} pointerEvents={request ? 'box-none' : 'none'}>
      {/* Keyed so each opening starts from the request's own values. */}
      {request && <LinkForm key={request.key} request={request} padding={keyboardPadding} />}
    </View>
  );
}

function LinkForm({
  request,
  padding,
}: {
  request: LinkDialogRequest;
  padding: ReturnType<typeof useKeyboardPadding>;
}) {
  const colors = useTheme();
  const [url, setUrl] = useState(request.url);
  const [text, setText] = useState(request.text ?? '');
  const urlRef = useRef<TextInput>(null);
  const asksText = request.text !== null;
  const href = normalizeLinkUrl(url);
  const existing = request.url !== '';

  // No Keyboard.dismiss(): every outcome hands focus straight back to the
  // editor, which keeps the keyboard up — and a hide event arriving after that
  // refocus would read to the editor as "done editing".
  const finish = (then: () => void) => {
    closeLinkDialog();
    then();
  };
  const onCancel = () => finish(request.onCancel);
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    cancelRef.current = onCancel;
  });
  // Android's back closes the dialog rather than the screen behind it.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      cancelRef.current();
      return true;
    });
    return () => sub.remove();
  }, []);
  const onSave = () => {
    if (!href) return;
    finish(() => request.onApply(href, text.trim()));
  };
  const onRemove = request.onRemove && (() => finish(request.onRemove!));
  const onKeyPress = (e: { nativeEvent: { key: string } }) => {
    // Web only in practice — a phone keyboard has no Escape.
    if (e.nativeEvent.key === 'Escape') onCancel();
  };

  const inputStyle = [
    styles.input,
    noFocusOutline,
    { color: colors.text, backgroundColor: colors.backgroundElement },
  ];

  return (
    <>
      <AnimatedPressable
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(180)}
        style={styles.backdrop}
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel link"
      />
      {/* The keyboard inset on an outer layer, so it lifts the dialog without
          replacing the host's own padding. */}
      <Animated.View style={[styles.keyboardLayer, padding]} pointerEvents="box-none">
        <View style={styles.dialogHost} pointerEvents="box-none">
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)} style={styles.dialogWidth}>
          <GlassSurface intensity={75} tintOpacity={0.9} style={styles.dialog}>
            <View style={styles.titleRow}>
              <ThemedText style={styles.dialogTitle}>{existing ? 'Edit link' : 'Add link'}</ThemedText>
              {existing && isOpenableLinkUrl(request.url) && (
                <Pressable
                  onPress={() => void Linking.openURL(request.url)}
                  accessibilityRole="link"
                  accessibilityLabel="Open link"
                  style={({ pressed }) => [
                    styles.iconButton,
                    { backgroundColor: colors.backgroundElement },
                    pressed && styles.pressed,
                  ]}>
                  <Feather name="external-link" size={18} color={colors.text} />
                </Pressable>
              )}
            </View>
            {asksText && (
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="Text"
                placeholderTextColor={colors.textSecondary}
                autoFocus
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => urlRef.current?.focus()}
                onKeyPress={onKeyPress}
                style={inputStyle}
              />
            )}
            <TextInput
              ref={urlRef}
              value={url}
              onChangeText={setUrl}
              placeholder="Link"
              placeholderTextColor={colors.textSecondary}
              autoFocus={!asksText}
              selectTextOnFocus
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              inputMode="url"
              returnKeyType="done"
              onSubmitEditing={onSave}
              onKeyPress={onKeyPress}
              style={inputStyle}
            />
            <View style={styles.dialogActions}>
              {onRemove && (
                <Pressable
                  onPress={onRemove}
                  accessibilityRole="button"
                  accessibilityLabel="Remove link"
                  style={({ pressed }) => [styles.dialogButton, styles.leading, pressed && styles.pressed]}>
                  <ThemedText style={[styles.dialogButtonText, { color: DESTRUCTIVE }]}>Remove</ThemedText>
                </Pressable>
              )}
              <Pressable
                onPress={onCancel}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                style={({ pressed }) => [styles.dialogButton, pressed && styles.pressed]}>
                <ThemedText style={[styles.dialogButtonText, { color: colors.textSecondary }]}>
                  Cancel
                </ThemedText>
              </Pressable>
              <Pressable
                onPress={onSave}
                disabled={!href}
                accessibilityRole="button"
                accessibilityLabel="Save link"
                accessibilityState={{ disabled: !href }}
                style={({ pressed }) => [
                  styles.dialogButton,
                  styles.dialogButtonPrimary,
                  { backgroundColor: colors.backgroundSelected },
                  !href && styles.disabled,
                  pressed && styles.pressed,
                ]}>
                <ThemedText style={[styles.dialogButtonText, { color: colors.text }]}>Save</ThemedText>
              </Pressable>
            </View>
          </GlassSurface>
        </Animated.View>
        </View>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
  },
  backdrop: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  keyboardLayer: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
  },
  dialogHost: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  dialogWidth: {
    width: '100%',
    maxWidth: 360,
  },
  dialog: {
    overflow: 'hidden',
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.three,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 24,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 40,
  },
  dialogTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    fontSize: 16,
  },
  dialogActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.two,
  },
  dialogButton: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
  },
  leading: {
    marginRight: 'auto',
  },
  dialogButtonPrimary: {
    minWidth: 80,
    alignItems: 'center',
  },
  dialogButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.55,
  },
});
