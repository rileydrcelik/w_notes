import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const DESTRUCTIVE = '#e5484d';

/**
 * Centred yes/no confirmation dialog, shared by the long-press option sheets to
 * guard destructive actions. Always mounted by the host; `open` drives the
 * slide/fade so the exit animation can play out after `onConfirm`/`onCancel`.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  destructive = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const colors = useTheme();
  const confirmTint = destructive ? DESTRUCTIVE : colors.text;

  return (
    <View style={styles.overlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.backdrop}
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          />

          <View style={styles.host} pointerEvents="box-none">
            <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)}>
              <GlassSurface intensity={75} tintOpacity={0.9} style={styles.dialog}>
                <ThemedText style={styles.title}>{title}</ThemedText>
                {message ? (
                  <ThemedText themeColor="textSecondary" style={styles.message}>
                    {message}
                  </ThemedText>
                ) : null}
                <View style={styles.actions}>
                  <Pressable
                    onPress={onCancel}
                    accessibilityRole="button"
                    accessibilityLabel={cancelLabel}
                    style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
                    <ThemedText style={[styles.buttonText, { color: colors.textSecondary }]}>
                      {cancelLabel}
                    </ThemedText>
                  </Pressable>
                  <Pressable
                    onPress={onConfirm}
                    accessibilityRole="button"
                    accessibilityLabel={confirmLabel}
                    style={({ pressed }) => [
                      styles.button,
                      styles.confirmButton,
                      pressed && styles.pressed,
                    ]}>
                    <ThemedText style={[styles.buttonText, { color: confirmTint }]}>
                      {confirmLabel}
                    </ThemedText>
                  </Pressable>
                </View>
              </GlassSurface>
            </Animated.View>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  host: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  dialog: {
    width: '100%',
    maxWidth: 360,
    overflow: 'hidden',
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.two,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 24,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  message: {
    fontSize: 15,
    lineHeight: 21,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  button: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
    minWidth: 80,
    alignItems: 'center',
  },
  confirmButton: {
    alignItems: 'center',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.55,
  },
});
