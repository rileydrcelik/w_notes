/**
 * Setup view for an unconfigured task-manager project folder. Collects the
 * project name and the GitHub repo it uses (a picker over `/github/repos`, plus
 * manual `owner/name` entry — the repo backs the People attribute and, later,
 * GitHub-connected issue types). On submit it hands the chosen name + repo up;
 * the project screen writes them into the folder's `config` and seeds the default
 * Bug/Feature issue types, after which the tracker renders.
 */
import Feather from '@expo/vector-icons/Feather';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { apiFetch } from '@/lib/sync/api';

const ACCENT = '#16a394';
const ERROR = '#f85149';
const GITHUB_ACCENT = '#8250df';

type Repo = { full_name: string; name: string; private: boolean; description?: string | null };
type RepoListResponse = { repos: Repo[] };

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function ProjectConfig({
  paddingTop,
  paddingBottom,
  onSubmit,
}: {
  paddingTop: number;
  paddingBottom: number;
  onSubmit: (input: { name: string; repo: string }) => void;
}) {
  const theme = useTheme();
  const [name, setName] = useState('');
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');

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

  const trimmedManual = manual.trim();
  const manualValid = REPO_RE.test(trimmedManual);
  const showManualError = trimmedManual.length > 0 && !manualValid;

  // Selecting a repo *is* the submit action — there's no separate confirm button.
  // The project name defaults to the repo's short name when left blank.
  const submitRepo = (fullName: string, shortName?: string) => {
    onSubmit({ name: name.trim() || shortName || fullName, repo: fullName });
  };
  const submitManual = () => {
    if (!manualValid) return;
    submitRepo(trimmedManual, trimmedManual.split('/')[1]);
  };

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingTop, paddingBottom }]}
      keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Feather name="columns" size={22} color={ACCENT} />
          <ThemedText type="subtitle" style={styles.headerTitle}>
            New task manager
          </ThemedText>
        </View>
        <ThemedText type="small" themeColor="textSecondary">
          Optionally name it, then tap the repo it tracks.
        </ThemedText>
      </View>

      <View style={[styles.infoCard, { borderColor: hexToRgba(GITHUB_ACCENT, 0.35) }]}>
        <View style={styles.infoHeader}>
          <Feather name="github" size={16} color={GITHUB_ACCENT} />
          <ThemedText type="smallBold" style={styles.infoTitle}>
            Issues sync to this repo
          </ThemedText>
        </View>
        <ThemedText type="small" themeColor="textSecondary" style={styles.infoBody}>
          Bug and Feature issues you create here open real GitHub issues in this repo, and marking
          them done closes them. That only works if:
        </ThemedText>
        <View style={styles.infoList}>
          <View style={styles.infoRow}>
            <Feather name="check" size={13} color={ACCENT} style={styles.infoCheck} />
            <ThemedText type="small" themeColor="textSecondary" style={styles.infoRowText}>
              The repo has Issues enabled (Settings → General → Features → Issues).
            </ThemedText>
          </View>
          <View style={styles.infoRow}>
            <Feather name="check" size={13} color={ACCENT} style={styles.infoCheck} />
            <View style={styles.infoRowText}>
              <ThemedText type="small" themeColor="textSecondary" style={styles.infoLine}>
                The server&apos;s GitHub token can write issues to this repo:
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.infoSub}>
                • Fine-grained token (github_pat_…): add this repo under Repository access, and set
                Issues → Read and write.
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.infoSub}>
                • Classic token (ghp_…): enable the repo scope (or public_repo for a public repo).
              </ThemedText>
            </View>
          </View>
        </View>
        <ThemedText type="small" themeColor="textSecondary" style={styles.infoFoot}>
          Otherwise issues are still tracked here — they just won&apos;t appear on GitHub.
        </ThemedText>
      </View>

      <View style={styles.block}>
        <ThemedText type="small" themeColor="textSecondary">
          Project name
        </ThemedText>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Mobile app"
          placeholderTextColor={theme.textSecondary}
          style={[styles.input, { color: theme.text, borderColor: hexToRgba(theme.text, 0.12) }]}
        />
      </View>

      <View style={styles.block}>
        <ThemedText type="small" themeColor="textSecondary">
          Repo
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
              styles.manualInput,
              { color: theme.text, borderColor: showManualError ? ERROR : hexToRgba(theme.text, 0.12) },
            ]}
          />
          {manualValid && (
            <Pressable
              onPress={submitManual}
              accessibilityRole="button"
              accessibilityLabel={`Use ${trimmedManual}`}
              style={({ pressed }) => [styles.manualGo, pressed && styles.pressed]}>
              <Feather name="arrow-right" size={20} color="#FFFFFF" />
            </Pressable>
          )}
        </View>
        {showManualError && (
          <ThemedText type="small" style={{ color: ERROR }}>
            Use the format owner/name.
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
      ) : (
        <View style={styles.list}>
          {repos.map((r) => (
            <Pressable
              key={r.full_name}
              onPress={() => submitRepo(r.full_name, r.name)}
              accessibilityRole="button"
              accessibilityLabel={`Use ${r.full_name}`}
              style={({ pressed }) => [styles.rowWrapper, pressed && styles.pressed]}>
              <ThemedView type="backgroundElementAlt" style={styles.row}>
                <View style={styles.rowText}>
                  <View style={styles.rowTitleRow}>
                    <ThemedText type="smallBold" numberOfLines={1} style={styles.rowTitle}>
                      {r.full_name}
                    </ThemedText>
                    {r.private && <Feather name="lock" size={12} color={theme.textSecondary} />}
                  </View>
                  {!!r.description && (
                    <ThemedText
                      type="small"
                      themeColor="textSecondary"
                      numberOfLines={2}
                      style={styles.rowDesc}>
                      {r.description}
                    </ThemedText>
                  )}
                </View>
                <Feather name="chevron-right" size={18} color={theme.textSecondary} />
              </ThemedView>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: Spacing.three, gap: Spacing.two },
  header: { gap: Spacing.one, marginBottom: Spacing.two },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  headerTitle: { flexShrink: 1 },
  infoCard: {
    gap: Spacing.two,
    borderRadius: Spacing.three,
    borderWidth: 1.5,
    padding: Spacing.three,
    marginBottom: Spacing.two,
  },
  infoHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  infoTitle: { flexShrink: 1 },
  infoBody: { lineHeight: 18 },
  infoList: { gap: Spacing.one },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.one },
  infoCheck: { marginTop: 2 },
  infoRowText: { flex: 1, gap: 2 },
  infoLine: { lineHeight: 18 },
  infoSub: { lineHeight: 18, marginLeft: Spacing.one },
  infoFoot: { fontStyle: 'italic', lineHeight: 18 },
  block: { gap: Spacing.two },
  input: {
    borderWidth: 1.5,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 15,
  },
  orLabel: { marginTop: Spacing.one },
  state: { textAlign: 'center', paddingVertical: Spacing.five },
  errorBlock: { gap: Spacing.two, alignItems: 'center' },
  manualRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  manualInput: { flex: 1 },
  manualGo: {
    backgroundColor: ACCENT,
    borderRadius: Spacing.three,
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { gap: Spacing.two },
  rowWrapper: { width: '100%' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  rowText: { flex: 1, gap: Spacing.half },
  rowTitleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  rowTitle: { flexShrink: 1 },
  rowDesc: { lineHeight: 18 },
  pressed: { opacity: 0.6 },
  retry: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  retryText: { color: ACCENT, fontSize: 13 },
});
