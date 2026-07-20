/**
 * Bottom sheet to create a new GitHub issue in the note's repo. Opened from the
 * issues screen header. Loads the repo's labels / assignees / milestones (once
 * per open) for the pickers, POSTs to `/github/issues`, and hands the created
 * issue back so the screen can prepend it to the list.
 */
import Feather from '@expo/vector-icons/Feather';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { apiFetch } from '@/lib/sync/api';
import type { CreatedIssue, IssueLabel as Label } from '@/lib/github-note';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const ACCENT = '#8250df';

type SimpleUser = { login: string; avatar_url?: string | null };
type Milestone = { number: number; title: string; state?: string | null };

/** A tappable pill that toggles selection. Uses the label's own color when given. */
function Chip({
  label,
  selected,
  color,
  onPress,
}: {
  label: string;
  selected: boolean;
  color?: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const tint = color ?? ACCENT;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: selected ? tint : hexToRgba(theme.text, 0.15),
          backgroundColor: selected ? hexToRgba(tint, 0.16) : 'transparent',
        },
        pressed && styles.pressed,
      ]}>
      {color && <View style={[styles.chipDot, { backgroundColor: color }]} />}
      <ThemedText type="small" numberOfLines={1} style={styles.chipLabel}>
        {label}
      </ThemedText>
      {selected && <Feather name="check" size={12} color={tint} />}
    </Pressable>
  );
}

export function GithubIssueCompose({
  open,
  repo,
  onClose,
  onCreated,
}: {
  open: boolean;
  repo: string;
  onClose: () => void;
  onCreated: (issue: CreatedIssue) => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState<Label[]>([]);
  const [assignees, setAssignees] = useState<SimpleUser[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [selLabels, setSelLabels] = useState<string[]>([]);
  const [selAssignees, setSelAssignees] = useState<string[]>([]);
  const [selMilestone, setSelMilestone] = useState<number | null>(null);
  const [optionsLoaded, setOptionsLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setTitle('');
    setBody('');
    setSelLabels([]);
    setSelAssignees([]);
    setSelMilestone(null);
    setError(null);
  }, []);

  // Load the pickers' options the first time the sheet opens (per mount). Failure
  // is non-fatal — the user can still create an issue with just a title/body.
  useEffect(() => {
    if (!open || optionsLoaded) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- run-once guard
    setOptionsLoaded(true);
    const q = `repo=${encodeURIComponent(repo)}`;
    void apiFetch<{ labels: Label[] }>(`/github/labels?${q}`)
      .then((r) => setLabels(r.labels ?? []))
      .catch(() => {});
    void apiFetch<{ assignees: SimpleUser[] }>(`/github/assignees?${q}`)
      .then((r) => setAssignees(r.assignees ?? []))
      .catch(() => {});
    void apiFetch<{ milestones: Milestone[] }>(`/github/milestones?${q}`)
      .then((r) => setMilestones(r.milestones ?? []))
      .catch(() => {});
  }, [open, optionsLoaded, repo]);

  const toggleIn = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const canSubmit = title.trim().length > 0 && !submitting;

  const submit = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    apiFetch<CreatedIssue>(`/github/issues?repo=${encodeURIComponent(repo)}`, {
      method: 'POST',
      body: {
        title: title.trim(),
        ...(body.trim() ? { body: body.trim() } : {}),
        ...(selLabels.length ? { labels: selLabels } : {}),
        ...(selAssignees.length ? { assignees: selAssignees } : {}),
        ...(selMilestone != null ? { milestone: selMilestone } : {}),
      },
    })
      .then((issue) => {
        onCreated(issue);
        reset();
        onClose();
      })
      .catch(() => setError('Could not create the issue. Check the repo and token permissions.'))
      .finally(() => setSubmitting(false));
  };

  const dismiss = () => {
    if (submitting) return;
    onClose();
  };

  return (
    <View style={styles.overlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.backdrop}
            onPress={dismiss}
            accessibilityRole="button"
            accessibilityLabel="Cancel new issue"
          />
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.avoider}
            pointerEvents="box-none">
            <Animated.View
              entering={SlideInDown.duration(260)}
              exiting={SlideOutDown.duration(220)}
              style={[styles.sheetHost, { paddingBottom: insets.bottom + Spacing.three }]}>
              <GlassSurface intensity={75} tintOpacity={0.9} style={styles.sheet}>
                <View style={styles.headerRow}>
                  <Feather name="github" size={18} color={ACCENT} />
                  <ThemedText style={styles.sheetTitle}>New issue</ThemedText>
                  <Pressable
                    onPress={dismiss}
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                    hitSlop={8}
                    style={({ pressed }) => pressed && styles.pressed}>
                    <Feather name="x" size={20} color={theme.textSecondary} />
                  </Pressable>
                </View>

                <ScrollView
                  style={styles.form}
                  contentContainerStyle={styles.formContent}
                  keyboardShouldPersistTaps="handled">
                  <TextInput
                    value={title}
                    onChangeText={setTitle}
                    placeholder="Title"
                    placeholderTextColor={theme.textSecondary}
                    style={[
                      styles.input,
                      { color: theme.text, backgroundColor: theme.backgroundElement },
                    ]}
                  />
                  <TextInput
                    value={body}
                    onChangeText={setBody}
                    placeholder="Description (optional, Markdown)"
                    placeholderTextColor={theme.textSecondary}
                    multiline
                    style={[
                      styles.input,
                      styles.bodyInput,
                      { color: theme.text, backgroundColor: theme.backgroundElement },
                    ]}
                  />

                  {labels.length > 0 && (
                    <View style={styles.field}>
                      <ThemedText type="small" themeColor="textSecondary" style={styles.fieldLabel}>
                        Labels
                      </ThemedText>
                      <View style={styles.chips}>
                        {labels.map((l) => (
                          <Chip
                            key={l.name}
                            label={l.name}
                            color={l.color ? `#${l.color}` : undefined}
                            selected={selLabels.includes(l.name)}
                            onPress={() => setSelLabels((prev) => toggleIn(prev, l.name))}
                          />
                        ))}
                      </View>
                    </View>
                  )}

                  {assignees.length > 0 && (
                    <View style={styles.field}>
                      <ThemedText type="small" themeColor="textSecondary" style={styles.fieldLabel}>
                        Assignees
                      </ThemedText>
                      <View style={styles.chips}>
                        {assignees.map((a) => (
                          <Chip
                            key={a.login}
                            label={a.login}
                            selected={selAssignees.includes(a.login)}
                            onPress={() => setSelAssignees((prev) => toggleIn(prev, a.login))}
                          />
                        ))}
                      </View>
                    </View>
                  )}

                  {milestones.length > 0 && (
                    <View style={styles.field}>
                      <ThemedText type="small" themeColor="textSecondary" style={styles.fieldLabel}>
                        Milestone
                      </ThemedText>
                      <View style={styles.chips}>
                        {milestones.map((m) => (
                          <Chip
                            key={m.number}
                            label={m.title}
                            selected={selMilestone === m.number}
                            // Single-select: tapping the active one clears it.
                            onPress={() =>
                              setSelMilestone((prev) => (prev === m.number ? null : m.number))
                            }
                          />
                        ))}
                      </View>
                    </View>
                  )}

                  {!!error && (
                    <ThemedText type="small" style={styles.error}>
                      {error}
                    </ThemedText>
                  )}
                </ScrollView>

                <Pressable
                  onPress={submit}
                  disabled={!canSubmit}
                  accessibilityRole="button"
                  accessibilityLabel="Create issue"
                  accessibilityState={{ disabled: !canSubmit }}
                  style={({ pressed }) => [
                    styles.cta,
                    !canSubmit && styles.ctaDisabled,
                    pressed && canSubmit && styles.pressed,
                  ]}>
                  {submitting ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <ThemedText style={styles.ctaText}>Create issue</ThemedText>
                  )}
                </Pressable>
              </GlassSurface>
            </Animated.View>
          </KeyboardAvoidingView>
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
    justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  avoider: {
    width: '100%',
  },
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
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  sheetTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '700',
  },
  form: {
    maxHeight: 420,
  },
  formContent: {
    gap: Spacing.three,
  },
  input: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    fontSize: 15,
  },
  bodyInput: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  field: {
    gap: Spacing.two,
  },
  fieldLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontSize: 11,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
  },
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
  chipDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  chipLabel: {
    flexShrink: 1,
  },
  error: {
    color: '#f85149',
  },
  cta: {
    backgroundColor: ACCENT,
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  ctaDisabled: {
    opacity: 0.4,
  },
  ctaText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 15,
  },
  pressed: {
    opacity: 0.6,
  },
});
