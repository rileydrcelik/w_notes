import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BackHandler, Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { GlassSurface } from '@/components/glass-surface';
import { StatusChip } from '@/components/internship/status-chip';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useKeyboardPadding } from '@/hooks/use-keyboard-inset';
import { useTheme } from '@/hooks/use-theme';
import {
  closeApplicationDialog,
  getApplicationDialog,
  subscribeApplicationDialog,
  type ApplicationDialogRequest,
} from '@/lib/application-dialog';
import {
  DEFAULT_STATUS,
  INTERNSHIP_STATUSES,
  STATUS_LABEL,
  type InternshipStatus,
} from '@/lib/internship';
import { noFocusOutline } from '@/lib/web-style';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Add one application to the tracker: a name, and a status that starts at
 * Applied — where nearly every application starts. Opened by the tracker's (+)
 * through `lib/application-dialog.ts`; the tracker writes the line.
 */
export function AddApplicationDialog() {
  const request = useSyncExternalStore(subscribeApplicationDialog, getApplicationDialog, () => null);
  const keyboardPadding = useKeyboardPadding();
  return (
    <View style={styles.overlay} pointerEvents={request ? 'box-none' : 'none'}>
      {request && <Form key={request.key} request={request} padding={keyboardPadding} />}
    </View>
  );
}

function Form({
  request,
  padding,
}: {
  request: ApplicationDialogRequest;
  padding: ReturnType<typeof useKeyboardPadding>;
}) {
  const colors = useTheme();
  const [name, setName] = useState('');
  const [status, setStatus] = useState<InternshipStatus>(DEFAULT_STATUS);
  const ready = name.trim().length > 0;

  const onCancel = () => {
    Keyboard.dismiss();
    closeApplicationDialog();
  };
  const onAdd = () => {
    if (!ready) return;
    Keyboard.dismiss();
    closeApplicationDialog();
    request.onAdd(name, status);
  };

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

  return (
    <>
      <AnimatedPressable
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(180)}
        style={styles.backdrop}
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
      />
      <Animated.View style={[styles.keyboardLayer, padding]} pointerEvents="box-none">
        <View style={styles.dialogHost} pointerEvents="box-none">
          <Animated.View
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(140)}
            style={styles.dialogWidth}
          >
            <GlassSurface intensity={75} tintOpacity={0.9} style={styles.dialog}>
              <ThemedText style={styles.dialogTitle}>Add application</ThemedText>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Company or role"
                placeholderTextColor={colors.textSecondary}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={onAdd}
                onKeyPress={(e) => {
                  if (e.nativeEvent.key === 'Escape') onCancel();
                }}
                style={[
                  styles.input,
                  noFocusOutline,
                  { color: colors.text, backgroundColor: colors.backgroundElement },
                ]}
              />
              <View style={styles.statuses}>
                {INTERNSHIP_STATUSES.map((s) => (
                  <StatusChip
                    key={s}
                    status={s}
                    selected={s === status}
                    onPress={() => setStatus(s)}
                    accessibilityLabel={`Status: ${STATUS_LABEL[s]}`}
                  />
                ))}
              </View>
              <View style={styles.dialogActions}>
                <Pressable
                  onPress={onCancel}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                  style={({ pressed }) => [styles.dialogButton, pressed && styles.pressed]}
                >
                  <ThemedText style={[styles.dialogButtonText, { color: colors.textSecondary }]}>
                    Cancel
                  </ThemedText>
                </Pressable>
                <Pressable
                  onPress={onAdd}
                  disabled={!ready}
                  accessibilityRole="button"
                  accessibilityLabel="Add application"
                  accessibilityState={{ disabled: !ready }}
                  style={({ pressed }) => [
                    styles.dialogButton,
                    styles.dialogButtonPrimary,
                    { backgroundColor: colors.backgroundSelected },
                    !ready && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <ThemedText style={[styles.dialogButtonText, { color: colors.text }]}>Add</ThemedText>
                </Pressable>
              </View>
            </GlassSurface>
          </Animated.View>
        </View>
      </Animated.View>
    </>
  );
}

const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

const styles = StyleSheet.create({
  overlay: { ...fill },
  backdrop: { ...fill, backgroundColor: 'rgba(0,0,0,0.35)' },
  keyboardLayer: { ...fill },
  dialogHost: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  dialogWidth: { width: '100%', maxWidth: 360 },
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
  dialogTitle: { fontSize: 18, fontWeight: '700' },
  input: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    fontSize: 16,
  },
  statuses: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.two },
  dialogButton: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
  },
  dialogButtonPrimary: { minWidth: 80, alignItems: 'center' },
  dialogButtonText: { fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.55 },
});
