/**
 * Configuration view for an unconfigured Sentry note. Fetches the projects the
 * server token can see (`/sentry/projects`), lets the user pick one, and
 * optionally name the GitHub repo autofix should target. On confirm it hands the
 * chosen `SentryTarget` up; the screen writes it into the note's pluginConfig,
 * after which `sentryTarget()` resolves and the screen swaps to the live issues.
 */
import Feather from '@expo/vector-icons/Feather';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { apiFetch } from '@/lib/sync/api';
import type { SentryTarget } from '@/lib/sentry-note';

const ACCENT = '#7553FF';
const ERROR = '#f55459';

type Project = {
  slug: string;
  name: string;
  platform?: string | null;
  organization: string;
};
type ProjectListResponse = { projects: Project[] };

const projectKey = (p: Project) => `${p.organization}/${p.slug}`;

// A GitHub "owner/name" slug — mirrors the backend's `_REPO_RE`.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function SentryConfig({
  paddingTop,
  paddingBottom,
  onSubmit,
}: {
  paddingTop: number;
  paddingBottom: number;
  onSubmit: (config: SentryTarget) => void;
}) {
  const theme = useTheme();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Project | null>(null);
  const [repo, setRepo] = useState('');

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<ProjectListResponse>('/sentry/projects');
      setProjects(res.projects ?? []);
    } catch {
      setError('Could not load your Sentry projects. Check the backend is reachable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch
    void loadProjects();
  }, [loadProjects]);

  // The autofix repo is required: Fix dispatches to it, and a blank one used to
  // silently fall back to the server default (wrong-repo PRs). Gate submit on a
  // valid owner/name.
  const trimmedRepo = repo.trim();
  const repoValid = REPO_RE.test(trimmedRepo);
  const showRepoError = trimmedRepo.length > 0 && !repoValid;
  const canSubmit = selected != null && repoValid;

  const confirm = () => {
    if (!selected || !repoValid) return;
    onSubmit({
      org: selected.organization,
      project: selected.slug,
      projectName: selected.name || selected.slug,
      repo: trimmedRepo,
    });
  };

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingTop, paddingBottom }]}
      keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Feather name="alert-triangle" size={22} color={ACCENT} />
          <ThemedText type="subtitle" style={styles.headerTitle}>
            Configure Sentry view
          </ThemedText>
        </View>
        <ThemedText type="small" themeColor="textSecondary">
          Pick a project to watch its live issues.
        </ThemedText>
      </View>

      {loading ? (
        <ActivityIndicator style={styles.state} color={theme.textSecondary} />
      ) : error ? (
        <View style={styles.errorBlock}>
          <ThemedText themeColor="textSecondary" style={styles.state}>
            {error}
          </ThemedText>
          <Pressable
            onPress={() => void loadProjects()}
            accessibilityRole="button"
            accessibilityLabel="Retry loading projects"
            style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
            <Feather name="refresh-cw" size={15} color={ACCENT} />
            <ThemedText style={styles.retryText}>Retry</ThemedText>
          </Pressable>
        </View>
      ) : projects.length === 0 ? (
        <ThemedText themeColor="textSecondary" style={styles.state}>
          No Sentry projects available to this token.
        </ThemedText>
      ) : (
        <View style={styles.list}>
          {projects.map((p) => {
            const isSelected = selected != null && projectKey(selected) === projectKey(p);
            return (
              <Pressable
                key={projectKey(p)}
                onPress={() => setSelected(p)}
                accessibilityRole="button"
                accessibilityLabel={`Select ${p.name || p.slug}`}
                style={({ pressed }) => [styles.rowWrapper, pressed && styles.pressed]}>
                <ThemedView
                  type="backgroundElementAlt"
                  style={[styles.row, isSelected && styles.rowSelected]}>
                  <View style={styles.rowText}>
                    <ThemedText type="smallBold" numberOfLines={1}>
                      {p.name || p.slug}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                      {p.organization} · {p.slug}
                    </ThemedText>
                  </View>
                  {isSelected && <Feather name="check" size={18} color={ACCENT} />}
                </ThemedView>
              </Pressable>
            );
          })}
        </View>
      )}

      {selected && (
        <View style={styles.footer}>
          <ThemedText type="small" themeColor="textSecondary">
            Autofix repo (required)
          </ThemedText>
          <TextInput
            value={repo}
            onChangeText={setRepo}
            placeholder="owner/name"
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              styles.input,
              {
                color: theme.text,
                borderColor: showRepoError ? ERROR : hexToRgba(theme.text, 0.12),
              },
            ]}
          />
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={[styles.repoHint, showRepoError && { color: ERROR }]}>
            {showRepoError
              ? 'Use the format owner/name (e.g. rileydrcelik/w_notes).'
              : 'Where Fix opens pull requests. Must be set up for autofix.'}
          </ThemedText>
          <Pressable
            onPress={confirm}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityLabel="Show issues"
            accessibilityState={{ disabled: !canSubmit }}
            style={({ pressed }) => [
              styles.cta,
              !canSubmit && styles.ctaDisabled,
              pressed && canSubmit && styles.pressed,
            ]}>
            <ThemedText style={styles.ctaText}>Show issues</ThemedText>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  header: {
    gap: Spacing.one,
    marginBottom: Spacing.three,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  headerTitle: {
    flexShrink: 1,
  },
  state: {
    textAlign: 'center',
    paddingVertical: Spacing.five,
  },
  errorBlock: {
    gap: Spacing.two,
    alignItems: 'center',
  },
  list: {
    gap: Spacing.two,
  },
  rowWrapper: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  rowSelected: {
    borderColor: ACCENT,
    backgroundColor: hexToRgba(ACCENT, 0.1),
  },
  rowText: {
    flex: 1,
    gap: Spacing.half,
  },
  pressed: {
    opacity: 0.6,
  },
  retry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  retryText: {
    color: ACCENT,
    fontSize: 13,
  },
  footer: {
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  input: {
    borderWidth: 1.5,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 15,
  },
  repoHint: {
    lineHeight: 18,
  },
  cta: {
    backgroundColor: ACCENT,
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.one,
  },
  ctaDisabled: {
    opacity: 0.4,
  },
  ctaText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 15,
  },
});
