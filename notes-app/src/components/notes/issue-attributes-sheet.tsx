/**
 * Bottom sheet to edit the selected issue(s), opened from the task-manager
 * selection menu. For a **single** issue it edits title, description, types, and
 * attribute values; for a **multi-select** it edits attribute values only
 * (bulk apply). Seeds from the passed initial values and applies the edited set
 * to every selected issue on save. Renders the shared {@link
 * IssueAttributeEditors}; the attribute *schema* is fixed here — it's managed on
 * the issue-creation screen.
 */
import Feather from '@expo/vector-icons/Feather';
import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';

import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { IssueAttributeEditors } from '@/components/notes/issue-attribute-editors';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import type { IssueAttrValue } from '@/data/notes';
import type { AttrDef } from '@/lib/project';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const ACCENT = '#16a394';

type Values = Record<string, IssueAttrValue>;

/** A selectable issue type in the sheet's Types picker. */
export type TypeOption = { id: string; title: string };

export function IssueAttributesSheet({
  open,
  count,
  attributes,
  repo,
  initial,
  types,
  initialTypeIds,
  initialTitle,
  initialDescription,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  attributes: AttrDef[];
  repo?: string;
  initial: Values;
  /** All the project's types; when provided (single-issue edit), the Types
   *  picker is shown so the issue's types can be changed here. */
  types?: TypeOption[];
  /** The edited issue's current effective type ids (seeds the Types picker). */
  initialTypeIds?: string[];
  /** The edited issue's title/description; when provided (single-issue edit),
   *  the Details fields are shown so the title/description can be edited here. */
  initialTitle?: string;
  initialDescription?: string;
  onClose: () => void;
  /** `single` is present only for a single-issue edit (title/description, and
   *  typeIds when the Types picker was shown). */
  onSubmit: (
    attrs: Values,
    single?: { title: string; description: string; typeIds?: string[] },
  ) => void;
}) {
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const [values, setValues] = useState<Values>(initial);
  const [typeIds, setTypeIds] = useState<string[]>(initialTypeIds ?? []);
  const [title, setTitle] = useState(initialTitle ?? '');
  const [description, setDescription] = useState(initialDescription ?? '');
  // Title/description editing (and the Types picker) only make sense for a
  // single issue; bulk edits touch attributes only.
  const single = count === 1;
  const showTypes = single && !!types && types.length > 0;

  // Reseed the working copy each time the sheet (re)opens with a new selection.
  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reseed on open */
    setValues(initial);
    setTypeIds(initialTypeIds ?? []);
    setTitle(initialTitle ?? '');
    setDescription(initialDescription ?? '');
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, initial, initialTypeIds, initialTitle, initialDescription]);

  const change = (attrId: string, value: IssueAttrValue | undefined) =>
    setValues((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[attrId];
      else next[attrId] = value;
      return next;
    });

  const toggleType = (id: string) =>
    setTypeIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));

  // Keep at least one type — disable Apply if the user cleared them all.
  const canApply = !showTypes || typeIds.length > 0;

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
                <ThemedText style={styles.title}>
                  {count === 1 ? 'Edit issue' : `Edit ${count} ${noun}`}
                </ThemedText>
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
                {single && (
                  <View style={styles.detailsSection}>
                    <ThemedText type="small" themeColor="textSecondary" style={styles.typesLabel}>
                      Details
                    </ThemedText>
                    <TextInput
                      value={title}
                      onChangeText={setTitle}
                      placeholder="Title"
                      placeholderTextColor={theme.textSecondary}
                      style={[styles.input, { color: theme.text, borderColor: hexToRgba(theme.text, 0.12) }]}
                    />
                    <TextInput
                      value={description}
                      onChangeText={setDescription}
                      placeholder="Description (optional)"
                      placeholderTextColor={theme.textSecondary}
                      multiline
                      style={[
                        styles.input,
                        styles.descInput,
                        { color: theme.text, borderColor: hexToRgba(theme.text, 0.12) },
                      ]}
                    />
                  </View>
                )}
                {showTypes && (
                  <View style={styles.typesSection}>
                    <ThemedText type="small" themeColor="textSecondary" style={styles.typesLabel}>
                      Types
                    </ThemedText>
                    <View style={styles.typeChips}>
                      {types!.map((t) => {
                        const selected = typeIds.includes(t.id);
                        return (
                          <Pressable
                            key={t.id}
                            onPress={() => toggleType(t.id)}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: selected }}
                            accessibilityLabel={`Type ${t.title}`}
                            style={({ pressed }) => [
                              styles.typeChip,
                              {
                                borderColor: selected ? ACCENT : hexToRgba(theme.text, 0.12),
                                backgroundColor: selected ? hexToRgba(ACCENT, 0.16) : 'transparent',
                              },
                              pressed && styles.pressed,
                            ]}>
                            {selected && (
                              <Feather name="check" size={12} color={ACCENT} style={styles.typeChipCheck} />
                            )}
                            <ThemedText type="small" numberOfLines={1}>
                              {t.title || 'Untitled'}
                            </ThemedText>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                )}
                <IssueAttributeEditors
                  attributes={attributes}
                  values={values}
                  onChange={change}
                  repo={repo}
                />
              </ScrollView>

              <Pressable
                onPress={() =>
                  onSubmit(
                    values,
                    single
                      ? { title, description, typeIds: showTypes ? typeIds : undefined }
                      : undefined,
                  )
                }
                disabled={!canApply}
                accessibilityRole="button"
                accessibilityLabel="Apply"
                accessibilityState={{ disabled: !canApply }}
                style={({ pressed }) => [
                  styles.cta,
                  !canApply && styles.ctaDisabled,
                  pressed && canApply && styles.pressed,
                ]}>
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
  ctaDisabled: { opacity: 0.4 },
  detailsSection: { gap: Spacing.two, marginBottom: Spacing.three },
  input: {
    borderWidth: 1.5,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 15,
  },
  descInput: { minHeight: 80, textAlignVertical: 'top' },
  typesSection: { gap: Spacing.two, marginBottom: Spacing.three },
  typesLabel: { textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 11 },
  typeChips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  typeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.two,
    borderWidth: 1.5,
  },
  typeChipCheck: { marginRight: Spacing.one },
  pressed: { opacity: 0.6 },
});
