/**
 * The resume toolbar's recompile control.
 *
 * Its own file because the toolbar is a `.web`/native pair and this button is
 * the same on both — duplicating it into each variant is exactly how a pair
 * drifts (see the header of `resume-toolbar.web.tsx`).
 *
 * It has three things to say and one place to say them:
 *
 * - **at rest** the PDF on screen was made from the source as it stands, so the
 *   button is quiet and pressing it would only redo work.
 * - **stale** the source has moved on and the preview hasn't. This is the state
 *   the button mostly exists for: with no compile-as-you-type, nothing else on
 *   screen would tell you the page is behind the text. It takes the accent.
 * - **compiling** TeX is running. The spinner replaces the icon in place so the
 *   bar doesn't resize, and the press is ignored rather than queueing a second
 *   run over the same document.
 */
import Feather from '@expo/vector-icons/Feather';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ACCENT } from '@/components/resume/accent';

/** The resume screen's accent, reused here for "this needs recompiling". */
/** Reserves the icon's footprint so swapping in the spinner doesn't shift the row. */
const ICON_SIZE = 18;

export function RecompileButton({
  onPress,
  stale,
  compiling,
  showLabel,
}: {
  onPress: () => void;
  stale: boolean;
  compiling: boolean;
  /** Hidden on a narrow bar, where the icon and its label carry the meaning. */
  showLabel: boolean;
}) {
  const theme = useTheme();

  // The label says what the button does, and says it the same way in every
  // state — only the tint changes, so the bar doesn't reflow a word at a time as
  // you type. "Compiling…" is the one exception, because there the button has
  // stopped being a thing you press and started being a progress report.
  const tint = stale && !compiling ? ACCENT : theme.textSecondary;
  const label = compiling ? 'Compiling…' : 'Recompile';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        compiling
          ? 'Compiling this resume'
          : stale
            ? 'Recompile — the preview is behind the source'
            : 'Recompile this resume'
      }
      accessibilityState={{ disabled: compiling, busy: compiling }}
      // Not `disabled`: a compile in flight is a reason to ignore the press, not
      // to grey the control out and make the bar flicker between two looks.
      onPress={() => {
        if (!compiling) onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        showLabel && styles.wide,
        pressed && !compiling && styles.pressed,
      ]}>
      <View style={styles.icon}>
        {compiling ? (
          <ActivityIndicator size="small" color={tint} />
        ) : (
          <Feather name="refresh-cw" size={ICON_SIZE} color={tint} />
        )}
      </View>
      {showLabel && (
        <ThemedText type="small" style={{ color: tint }}>
          {label}
        </ThemedText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 40,
    minWidth: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    borderRadius: Spacing.two,
  },
  wide: {
    paddingHorizontal: Spacing.three,
  },
  icon: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
});
