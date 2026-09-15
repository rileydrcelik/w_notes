import { Pressable, StyleSheet, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useDbUnreachable } from '@/lib/db-tabs';
import { requestDbTakeover } from '@/lib/web-db-lock';
import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';

/**
 * Full-screen guard for a tab that can't get at its notes.
 *
 * Extra tabs are ordinary tabs now: the database can still only be held by one
 * of them (OPFS exclusive lock — see lib/web-db-lock.ts), but the others route
 * their calls to whichever tab holds it, so they show real content and can edit
 * it. This is what's left over — the case where that routing has nothing to
 * answer it, because the browser froze or discarded the owning tab, or because
 * there is no BroadcastChannel to route over at all.
 *
 * It says so rather than blaming the other tab, and "Use here" now means "take
 * the database, since whoever had it isn't answering".
 *
 * Renders nothing on native, on the owning tab, or in a tab that is simply
 * using another tab's database quite happily.
 */
export function DbTabGuard() {
  const unreachable = useDbUnreachable();
  const colors = useTheme();

  if (!unreachable) return null;

  return (
    <View style={[styles.overlay, { backgroundColor: colors.background }]}>
      <GlassSurface intensity={75} tintOpacity={0.9} style={styles.card}>
        <ThemedText style={styles.title}>Can&apos;t reach your notes</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.body}>
          The w_notes tab holding your notes isn&apos;t responding — the browser
          may have paused it. Take over here to carry on.
        </ThemedText>
        <Pressable
          onPress={requestDbTakeover}
          accessibilityRole="button"
          accessibilityLabel="Take over in this tab"
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
