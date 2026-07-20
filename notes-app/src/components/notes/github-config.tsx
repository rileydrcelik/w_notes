/**
 * Configuration view for an unconfigured GitHub note. Fetches the repos the
 * server token can see (`/github/repos`) for a picker, and also accepts a manual
 * `owner/name` entry, so any reachable repo can be watched. Selecting a repo (a
 * tap on a row, or submitting the manual field) hands the chosen `GithubTarget`
 * straight up — no separate confirm step; the screen writes it into the note's
 * pluginConfig, after which `githubTarget()` resolves and the screen swaps to the
 * live issues.
 */
import Feather from '@expo/vector-icons/Feather';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { apiFetch } from '@/lib/sync/api';
import type { GithubTarget } from '@/lib/github-note';

const ACCENT = '#8250df';
const ERROR = '#f85149';

type Repo = {
  full_name: string;
  name: string;
  owner: string;
  private: boolean;
  description?: string | null;
};
type RepoListResponse = { repos: Repo[] };

// A GitHub "owner/name" slug — mirrors the backend's `_REPO_RE`.
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Short name from an "owner/name" slug, for the note's label. */
const shortName = (fullName: string) => fullName.split('/')[1] || fullName;

export function GithubConfig({
  paddingTop,
  paddingBottom,
  onSubmit,
}: {
  paddingTop: number;
  paddingBottom: number;
  onSubmit: (config: GithubTarget) => void;
}) {
  const theme = useTheme();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  // Accurate open-issue counts (excluding PRs), filled in lazily per repo — the
  // repo list's own count lumps issues and PRs together, so it isn't shown.
  const [counts, setCounts] = useState<Record<string, number>>({});

  const loadRepos = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<RepoListResponse>('/github/repos');
      setRepos(res.repos ?? []);
    } catch {
      setError('Could not load your GitHub repos. Check the backend is reachable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch
    void loadRepos();
  }, [loadRepos]);

  // Pull each repo's true open-issue count once the list is in. Failures are
  // silent (the row just shows its description instead); GitHub's search API is
  // rate-limited, so this is best-effort enrichment, not load-bearing.
  useEffect(() => {
    if (repos.length === 0) return;
    let cancelled = false;
    for (const r of repos) {
      apiFetch<{ count: number }>(`/github/issue-count?repo=${encodeURIComponent(r.full_name)}`)
        .then((res) => {
          if (!cancelled) setCounts((prev) => ({ ...prev, [r.full_name]: res.count }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [repos]);

  const trimmedManual = manual.trim();
  const manualValid = REPO_RE.test(trimmedManual);
  const showManualError = trimmedManual.length > 0 && !manualValid;

  // Selecting a repo is the whole action — hand it up immediately.
  const select = (repo: string, repoName?: string) => onSubmit({ repo, repoName });
  const submitManual = () => {
    if (manualValid) select(trimmedManual, shortName(trimmedManual));
  };

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingTop, paddingBottom }]}
      keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Feather name="github" size={22} color={ACCENT} />
          <ThemedText type="subtitle" style={styles.headerTitle}>
            Configure GitHub view
          </ThemedText>
        </View>
        <ThemedText type="small" themeColor="textSecondary">
          Tap a repo to watch its issues, or enter any owner/name.
        </ThemedText>
      </View>

      {/* Manual entry — always available, works even if the list is empty. */}
      <View style={styles.manualBlock}>
        <ThemedText type="small" themeColor="textSecondary">
          Enter a repo
        </ThemedText>
        <View style={styles.manualRow}>
          <TextInput
            value={manual}
            onChangeText={setManual}
            onSubmitEditing={submitManual}
            placeholder="owner/name"
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            style={[
              styles.input,
              {
                color: theme.text,
                borderColor: showManualError ? ERROR : hexToRgba(theme.text, 0.12),
              },
            ]}
          />
          <Pressable
            onPress={submitManual}
            disabled={!manualValid}
            accessibilityRole="button"
            accessibilityLabel="Show issues for entered repo"
            accessibilityState={{ disabled: !manualValid }}
            style={({ pressed }) => [
              styles.submitButton,
              !manualValid && styles.submitButtonDisabled,
              pressed && manualValid && styles.pressed,
            ]}>
            <Feather name="arrow-right" size={20} color="#FFFFFF" />
          </Pressable>
        </View>
        {showManualError && (
          <ThemedText type="small" style={{ color: ERROR }}>
            Use the format owner/name (e.g. rileydrcelik/w_notes).
          </ThemedText>
        )}
      </View>

      <ThemedText type="small" themeColor="textSecondary" style={styles.orLabel}>
        or pick from your repos
      </ThemedText>

      {loading ? (
        <ActivityIndicator style={styles.state} color={theme.textSecondary} />
      ) : error ? (
        <View style={styles.errorBlock}>
          <ThemedText themeColor="textSecondary" style={styles.state}>
            {error}
          </ThemedText>
          <Pressable
            onPress={() => void loadRepos()}
            accessibilityRole="button"
            accessibilityLabel="Retry loading repos"
            style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
            <Feather name="refresh-cw" size={15} color={ACCENT} />
            <ThemedText style={styles.retryText}>Retry</ThemedText>
          </Pressable>
        </View>
      ) : repos.length === 0 ? (
        <ThemedText themeColor="textSecondary" style={styles.state}>
          No repos available to this token. Enter one above.
        </ThemedText>
      ) : (
        <View style={styles.list}>
          {repos.map((r) => {
            const count = counts[r.full_name];
            const subtitle =
              count != null
                ? `${count} open issue${count === 1 ? '' : 's'}`
                : r.description || (r.private ? 'Private' : 'Public');
            return (
              <Pressable
                key={r.full_name}
                onPress={() => select(r.full_name, r.name || shortName(r.full_name))}
                accessibilityRole="button"
                accessibilityLabel={`Show issues for ${r.full_name}`}
                style={({ pressed }) => [styles.rowWrapper, pressed && styles.pressed]}>
                <ThemedView type="backgroundElementAlt" style={styles.row}>
                  <View style={styles.rowText}>
                    <View style={styles.rowTitleRow}>
                      <ThemedText type="smallBold" numberOfLines={1} style={styles.rowTitle}>
                        {r.full_name}
                      </ThemedText>
                      {r.private && <Feather name="lock" size={12} color={theme.textSecondary} />}
                    </View>
                    <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                      {subtitle}
                    </ThemedText>
                  </View>
                  <Feather name="chevron-right" size={18} color={theme.textSecondary} />
                </ThemedView>
              </Pressable>
            );
          })}
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
    marginBottom: Spacing.two,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  headerTitle: {
    flexShrink: 1,
  },
  manualBlock: {
    gap: Spacing.two,
  },
  manualRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  input: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 15,
  },
  submitButton: {
    width: 44,
    height: 44,
    borderRadius: Spacing.three,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonDisabled: {
    opacity: 0.4,
  },
  orLabel: {
    marginTop: Spacing.one,
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
  rowText: {
    flex: 1,
    gap: Spacing.half,
  },
  rowTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  rowTitle: {
    flexShrink: 1,
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
});
