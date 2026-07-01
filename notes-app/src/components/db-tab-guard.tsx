import { Pressable, StyleSheet, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { requestDbTakeover, useDbTabRole } from '@/lib/web-db-lock';
import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';

/**
 * Full-screen guard for the extra browser tab. The web database can only be held
 * by one tab at a time (OPFS exclusive lock — see lib/web-db-lock.ts), so a
 * second tab would otherwise show the right account but no content. Instead we
 * render this over everything and offer a one-tap handoff.
 *
 * Renders nothing on native and on the owning ("leader") tab.
 */
export function DbTabGuard() {
  const role = useDbTabRole();
  const colors = useTheme();

  if (role === 'leader') return null;

  return (
    <View style={[styles.overlay, { backgroundColor: colors.background }]}>
      <GlassSurface intensity={75} tintOpacity={0.9} style={styles.card}>
        <ThemedText style={styles.title}>Open in another tab</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.body}>
          w_notes is already open in another tab of this browser. Your notes can
          only be edited in one tab at a time.
        </ThemedText>
        <Pressable
          onPress={requestDbTakeover}
          accessibilityRole="button"
          accessibilityLabel="Use w_notes in this tab"
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: colors.backgroundSelected },
            pressed && styles.pressed,
          ]}>
          <ThemedText style={[styles.buttonText, { color: colors.text }]}>Use here</ThemedText>
        </Pressable>
      </GlassSurface>
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
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    // Above every screen and the floating tab bar.
    zIndex: 2000,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    overflow: 'hidden',
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.three,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  body: {
    textAlign: 'center',
  },
  button: {
    marginTop: Spacing.one,
    minWidth: 120,
    alignItems: 'center',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two + Spacing.half,
    borderRadius: Spacing.three,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.55,
  },
});
