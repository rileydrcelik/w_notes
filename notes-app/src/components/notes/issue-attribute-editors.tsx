/**
 * Value editors for a project's issue attributes — shared by the issue-creation
 * screen and the "edit attributes" sheet. Renders one editor per `AttrDef`:
 *  - `select` → single-choice option chips
 *  - `stars`  → a 1–5 star rating
 *  - `people` → multi-select of the repo's GitHub assignees
 * It only edits *values*; the attribute *schema* (add/remove attributes) is
 * managed separately on the creation screen.
 */
import Feather from '@expo/vector-icons/Feather';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { apiFetch } from '@/lib/sync/api';
import type { IssueAttrValue } from '@/data/notes';
import type { AttrDef } from '@/lib/project';

const ACCENT = '#16a394';

type Values = Record<string, IssueAttrValue>;

/** A single tappable option/assignee chip. */
function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: selected ? ACCENT : hexToRgba(theme.text, 0.15),
          backgroundColor: selected ? hexToRgba(ACCENT, 0.16) : 'transparent',
        },
        pressed && styles.pressed,
      ]}>
      <ThemedText type="small" numberOfLines={1} style={styles.chipLabel}>
        {label}
      </ThemedText>
      {selected && <Feather name="check" size={12} color={ACCENT} />}
    </Pressable>
  );
}

/** A 1–5 star rating; tapping the current value clears it. */
function Stars({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const theme = useTheme();
  return (
    <View style={styles.stars}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Pressable
          key={n}
          onPress={() => onChange(n === value ? 0 : n)}
          accessibilityRole="button"
          accessibilityLabel={`${n} star${n === 1 ? '' : 's'}`}
          hitSlop={4}
          style={({ pressed }) => pressed && styles.pressed}>
          <Feather
            name="star"
            size={24}
            color={n <= value ? ACCENT : hexToRgba(theme.text, 0.25)}
          />
        </Pressable>
      ))}
    </View>
  );
}

export function IssueAttributeEditors({
  attributes,
  values,
  onChange,
  onRemoveAttr,
  onAddOption,
  repo,
}: {
  attributes: AttrDef[];
  values: Values;
  onChange: (attrId: string, value: IssueAttrValue | undefined) => void;
  /** When set, each attribute shows a remove (x) that edits the project schema. */
  onRemoveAttr?: (attrId: string) => void;
  /** When set, each `select` attribute shows a (+) to add another option. */
  onAddOption?: (attrId: string, option: string) => void;
  repo?: string;
}) {
  const theme = useTheme();
  // Assignee logins for the repo, loaded once when a people attribute is present.
  const [assignees, setAssignees] = useState<string[]>([]);
  const hasPeople = attributes.some((a) => a.type === 'people');
  // The select attribute (id) whose inline "add option" field is open, plus its draft.
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [optionDraft, setOptionDraft] = useState('');

  const submitOption = (attrId: string) => {
    onAddOption?.(attrId, optionDraft);
    setOptionDraft('');
    setAddingFor(null);
  };

  useEffect(() => {
    if (!hasPeople || !repo) return;
    let cancelled = false;
    apiFetch<{ assignees: { login: string }[] }>(
      `/github/assignees?repo=${encodeURIComponent(repo)}`,
    )
      .then((r) => {
        if (!cancelled) setAssignees((r.assignees ?? []).map((a) => a.login));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hasPeople, repo]);

  return (
    <View style={styles.container}>
      {attributes.map((attr) => (
        <View key={attr.id} style={styles.field}>
          <View style={styles.fieldLabelRow}>
            <ThemedText type="small" themeColor="textSecondary" style={styles.fieldLabel}>
              {attr.name}
            </ThemedText>
            {onRemoveAttr && (
              <Pressable
                onPress={() => onRemoveAttr(attr.id)}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${attr.name} attribute`}
                hitSlop={8}
                style={({ pressed }) => pressed && styles.pressed}>
                <Feather name="x" size={14} color={theme.textSecondary} />
              </Pressable>
            )}
          </View>

          {attr.type === 'stars' ? (
            <Stars
              value={typeof values[attr.id] === 'number' ? (values[attr.id] as number) : 0}
              onChange={(v) => onChange(attr.id, v === 0 ? undefined : v)}
            />
          ) : attr.type === 'people' ? (
            assignees.length > 0 ? (
              <View style={styles.chips}>
                {assignees.map((login) => {
                  const current = Array.isArray(values[attr.id]) ? (values[attr.id] as string[]) : [];
                  const selected = current.includes(login);
                  return (
                    <Chip
                      key={login}
                      label={login}
                      selected={selected}
                      onPress={() => {
                        const next = selected
                          ? current.filter((x) => x !== login)
                          : [...current, login];
                        onChange(attr.id, next.length ? next : undefined);
                      }}
                    />
                  );
                })}
              </View>
            ) : (
              <ThemedText type="small" themeColor="textSecondary">
                {repo ? 'No assignable users found.' : 'Set a repo to pick people.'}
              </ThemedText>
            )
          ) : (
            <View style={styles.chips}>
              {(attr.options ?? []).map((opt) => {
                const selected = values[attr.id] === opt;
                return (
                  <Chip
                    key={opt}
                    label={opt}
                    selected={selected}
                    onPress={() => onChange(attr.id, selected ? undefined : opt)}
                  />
                );
              })}
              {onAddOption &&
                (addingFor === attr.id ? (
                  <View style={[styles.addOptionField, { borderColor: hexToRgba(theme.text, 0.15) }]}>
                    <TextInput
                      value={optionDraft}
                      onChangeText={setOptionDraft}
                      onSubmitEditing={() => submitOption(attr.id)}
                      onBlur={() => submitOption(attr.id)}
                      placeholder="New option"
                      placeholderTextColor={theme.textSecondary}
                      autoFocus
                      returnKeyType="done"
                      style={[styles.addOptionInput, { color: theme.text }]}
                    />
                    <Pressable
                      onPress={() => submitOption(attr.id)}
                      accessibilityRole="button"
                      accessibilityLabel="Add option"
                      hitSlop={6}
                      style={({ pressed }) => pressed && styles.pressed}>
                      <Feather name="check" size={14} color={ACCENT} />
                    </Pressable>
                  </View>
                ) : (
                  <Pressable
                    onPress={() => {
                      setOptionDraft('');
                      setAddingFor(attr.id);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Add ${attr.name} option`}
                    style={({ pressed }) => [
                      styles.addOptionChip,
                      { borderColor: hexToRgba(theme.text, 0.15) },
                      pressed && styles.pressed,
                    ]}>
                    <Feather name="plus" size={13} color={theme.textSecondary} />
                  </Pressable>
                ))}
              {(attr.options ?? []).length === 0 && !onAddOption && (
                <ThemedText type="small" themeColor="textSecondary">
                  No options.
                </ThemedText>
              )}
            </View>
          )}
        </View>
      ))}
      {attributes.length === 0 && (
        <ThemedText type="small" themeColor="textSecondary" style={{ color: theme.textSecondary }}>
          No attributes.
        </ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: Spacing.three },
  field: { gap: Spacing.two },
  fieldLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fieldLabel: { textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 11 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.two,
    borderWidth: 1.5,
    maxWidth: '100%',
  },
  chipLabel: { flexShrink: 1 },
  addOptionChip: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.two,
    borderWidth: 1.5,
    borderStyle: 'dashed',
  },
  addOptionField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.half,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.two,
    borderWidth: 1.5,
  },
  addOptionInput: { minWidth: 90, fontSize: 13, paddingVertical: 0 },
  stars: { flexDirection: 'row', gap: Spacing.one },
  pressed: { opacity: 0.6 },
});
