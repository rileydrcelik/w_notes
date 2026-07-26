import Feather from '@expo/vector-icons/Feather';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Full-screen cue shown while a file or selection is dragged over the copa feed
 * (web only — see `use-copa-paste-drop`). Purely decorative: the drop itself is
 * handled by window listeners, so this never takes pointer events, which also
 * keeps it from swallowing the dragleave/drop events underneath it.
 */
export function CopaDropOverlay({ visible }: { visible: boolean }) {
  const theme = useTheme();

  if (!visible) return null;

  return (
    <Animated.View
      entering={FadeIn.duration(140)}
      exiting={FadeOut.duration(140)}
      pointerEvents="none"
      style={[styles.overlay, { backgroundColor: hexToRgba(theme.background, 0.6) }]}>
      <GlassSurface intensity={60} tintOpacity={0.75} style={styles.panel}>
        <View style={[styles.dashed, { borderColor: hexToRgba(theme.textSecondary, 0.5) }]}>
          <Feather name="upload-cloud" size={36} color={theme.text} />
          <ThemedText style={styles.title}>Drop to add a block</ThemedText>
          <ThemedText themeColor="textSecondary" style={styles.hint}>
            Files become attachments · text becomes a copy block
          </ThemedText>
        </View>
      </GlassSurface>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  panel: {
    width: '100%',
    maxWidth: 420,
    overflow: 'hidden',
    borderRadius: Spacing.four,
    padding: Spacing.two,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 10 },
    elevation: 24,
  },
  // The dashed inner edge reads as "target" without needing a filled button.
  dashed: {
    alignItems: 'center',
    gap: Spacing.two,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderRadius: Spacing.three,
    paddingVertical: Spacing.five,
    paddingHorizontal: Spacing.four,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  hint: {
    fontSize: 13,
    textAlign: 'center',
  },
});
