/**
 * Bottom sheet to edit attribute values on the selected issue(s). Opened from the
 * task-manager selection menu's "Edit attributes". Seeds from the passed initial
 * values and applies the edited set to every selected issue on save. Renders the
 * shared {@link IssueAttributeEditors}; schema (which attributes exist) is fixed
 * here — it's managed on the issue-creation screen.
 */
import Feather from '@expo/vector-icons/Feather';
import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';

import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { IssueAttributeEditors } from '@/components/notes/issue-attribute-editors';
import { Spacing } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import type { IssueAttrValue } from '@/data/notes';
import type { AttrDef } from '@/lib/project';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const ACCENT = '#16a394';

type Values = Record<string, IssueAttrValue>;

export function IssueAttributesSheet({
  open,
  count,
  attributes,
  repo,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  attributes: AttrDef[];
  repo?: string;
  initial: Values;
  onClose: () => void;
  onSubmit: (attrs: Values) => void;
}) {
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const [values, setValues] = useState<Values>(initial);

  // Reseed the working copy each time the sheet (re)opens with a new selection.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reseed on open
    if (open) setValues(initial);
  }, [open, initial]);

  const change = (attrId: string, value: IssueAttrValue | undefined) =>
    setValues((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[attrId];
      else next[attrId] = value;
      return next;
    });

  const noun = count === 1 ? 'issue' : 'issues';

  return (
    <View style={styles.overlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.backdrop}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          />
          <Animated.View
            entering={SlideInDown.duration(260)}
            exiting={SlideOutDown.duration(220)}
            style={[styles.sheetHost, { paddingBottom: tabBarInset }]}>
            <GlassSurface intensity={75} tintOpacity={0.9} style={styles.sheet}>
              <View style={styles.headerRow}>
                <Feather name="sliders" size={18} color={ACCENT} />
                <ThemedText style={styles.title}>{`Edit ${count} ${noun}`}</ThemedText>
                <Pressable
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  hitSlop={8}
                  style={({ pressed }) => pressed && styles.pressed}>
                  <Feather name="x" size={20} color={theme.textSecondary} />
                </Pressable>
              </View>

              <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
                <IssueAttributeEditors
                  attributes={attributes}
                  values={values}
                  onChange={change}
                  repo={repo}
                />
              </ScrollView>

              <Pressable
                onPress={() => onSubmit(values)}
                accessibilityRole="button"
                accessibilityLabel="Apply"
                style={({ pressed }) => [styles.cta, pressed && styles.pressed]}>
                <ThemedText style={styles.ctaText}>Apply</ThemedText>
              </Pressable>
            </GlassSurface>
          </Animated.View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheetHost: {
    width: '100%',
    paddingHorizontal: Spacing.three,
    ...(Platform.OS === 'web' ? { maxWidth: 460, alignSelf: 'center' as const } : null),
  },
  sheet: {
    overflow: 'hidden',
    borderRadius: Spacing.four,
    padding: Spacing.three,
    gap: Spacing.three,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 24,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  title: { flex: 1, fontSize: 17, fontWeight: '700' },
  body: { maxHeight: 380 },
  cta: {
    backgroundColor: ACCENT,
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  ctaText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
  pressed: { opacity: 0.6 },
});
