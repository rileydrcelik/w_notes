import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useColorScheme as useDeviceScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Accent, Colors, hexToRgba, Spacing, type Palette } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { fetchAiKeyState, forgetAiKey, saveAiKey, type AiKeyState } from '@/lib/ai-key';
import { useAuth } from '@/lib/auth/auth-context';
import type { CredentialProvider } from '@/lib/credentials';
import { db } from '@/lib/db';
import { ApiError, syncConfigured } from '@/lib/sync/api';
import { refreshFromDb } from '@/lib/sync/sync-engine';
import {
  useCreateOptions,
  type CreateCredentialKey,
  type CreateToggleKey,
} from '@/store/create-options-store';
import { useEditorPrefs } from '@/store/editor-prefs-store';
import { useThemePref, type ThemeKey } from '@/store/theme-store';
import { noScrollbar } from '@/lib/scroll-style';

// The shared app accent, imported rather than re-typed: a hand-copied hex here
// is identical until the day someone adjusts the real one and this screen
// quietly keeps the old value.
const ACCENT = Accent;

// The red the app already says "this failed" in — the same value confirm-dialog,
// item-options-modal and copa-options-modal use. One semantic deserves one
// colour; a second red for the same meaning reads as a different kind of wrong.
const DESTRUCTIVE = '#e5484d';

// Plain before tinted, light before dark — so the list reads as the two plain
// palettes and then the two that have a colour of their own.
const THEME_OPTIONS: { key: ThemeKey; label: string; description: string }[] = [
  { key: 'system', label: 'System', description: 'Match your device' },
  { key: 'light', label: 'Light', description: 'White background, dark text' },
  { key: 'dark', label: 'Dark', description: 'Dark background, light text' },
  { key: 'solarized', label: 'Solarized Light', description: 'Warm, low-contrast paper' },
  { key: 'midnight', label: 'Midnight', description: 'Catppuccin — soft violet dark' },
];

export default function SettingsScreen() {
  const { themeKey, setThemeKey } = useThemePref();
  const device = useDeviceScheme();
  const tabBarInset = useTabBarInset();

  // Each swatch previews the palette it applies; System resolves to the device.
  const previewPalette = (key: ThemeKey): Palette => {
    if (key === 'dark') return Colors.dark;
    if (key === 'light') return Colors.light;
    if (key === 'solarized') return Colors.solarizedLight;
    if (key === 'midnight') return Colors.midnight;
    return Colors[device === 'dark' ? 'dark' : 'light'];
  };

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <SafeAreaView style={styles.safeArea} edges={['top']}>
          <ScrollView
            {...noScrollbar}
            contentContainerStyle={[styles.content, { paddingBottom: tabBarInset }]}>
            {/* Centered, width-capped column so rows don't stretch edge-to-edge
                on web's wide viewport (a no-op on narrower phone screens). */}
            <View style={styles.inner}>
            <ThemedText type="subtitle" style={styles.title}>
              Settings
            </ThemedText>

            <AccountSection />

            <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
              THEME
            </ThemedText>

            <View style={styles.options}>
              {THEME_OPTIONS.map((option) => {
                const selected = themeKey === option.key;
                const preview = previewPalette(option.key);
                return (
                  <Pressable
                    key={option.key}
                    onPress={() => setThemeKey(option.key)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={option.label}
                    style={({ pressed }) => [pressed && styles.pressed]}>
                    <ThemedView
                      type="backgroundElement"
                      style={[styles.row, selected && { borderColor: ACCENT }]}>
                      {/* Mini preview of the theme's surface + text colors. */}
                      <View style={[styles.swatch, { backgroundColor: preview.background }]}>
                        <View style={[styles.swatchBar, { backgroundColor: preview.text }]} />
                        <View
                          style={[
                            styles.swatchBar,
                            styles.swatchBarShort,
                            { backgroundColor: preview.textSecondary },
                          ]}
                        />
                      </View>

                      <View style={styles.rowText}>
                        <ThemedText style={styles.optionLabel}>{option.label}</ThemedText>
                        <ThemedText type="small" themeColor="textSecondary">
                          {option.description}
                        </ThemedText>
                      </View>
                    </ThemedView>
                  </Pressable>
                );
              })}
            </View>

            {/* The resume's AI features run on Anthropic's API and are billed
                per call, so an account brings its own key. Above the plugin
                credentials because this one is not inert — it decides whether
                those features work at all. */}
            <AiSection />

            {/* Which plugin options appear in the navbar's create (+) menu, plus
                (inert) credential fields stored on-device. */}
            <CreateOptionsSection />

            {/* Web edits the body with a rich editor that accepts markdown-style
                keystrokes; the hints button reminds you of them. It's web-only,
                so the toggle is too. */}
            {Platform.OS === 'web' && <EditorSection />}

            {/* Local sample content. `__DEV__` is false in a release build, so
                this section doesn't exist in a shipped app. */}
            {__DEV__ && <DeveloperSection />}
            </View>
          </ScrollView>
        </SafeAreaView>
      </ThemedView>
    </SwipeBackView>
  );
}

/**
 * Account sign-in / sign-out. Signing in syncs notes across devices; signing out
 * clears the local copy on this device. Hidden behaviour (merge of anonymous
 * notes, account swap) lives in the sync layer.
 */
function AccountSection() {
  const { user, enabled, initializing, appleAvailable, signInWithGoogle, signInWithApple, signOut } =
    useAuth();
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch {
      Alert.alert('Something went wrong', 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
        ACCOUNT
      </ThemedText>
      <View style={styles.options}>
        {!enabled ? (
          <ThemedView type="backgroundElement" style={styles.accountRow}>
            <ThemedText type="small" themeColor="textSecondary">
              Sign-in isn’t configured yet.
            </ThemedText>
          </ThemedView>
        ) : initializing ? (
          <ThemedView type="backgroundElement" style={[styles.accountRow, styles.center]}>
            <ActivityIndicator color={ACCENT} />
          </ThemedView>
        ) : user ? (
          <>
            <ThemedView type="backgroundElement" style={styles.accountRow}>
              <View style={styles.rowText}>
                <ThemedText style={styles.optionLabel}>
                  {user.displayName ?? 'Signed in'}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {user.email ?? user.uid}
                </ThemedText>
              </View>
            </ThemedView>
            <Pressable
              disabled={busy}
              onPress={() => run(signOut)}
              accessibilityRole="button"
              accessibilityLabel="Sign out"
              style={({ pressed }) => [pressed && styles.pressed]}>
              <ThemedView type="backgroundElement" style={[styles.accountRow, styles.center]}>
                <ThemedText style={styles.optionLabel}>Sign out</ThemedText>
              </ThemedView>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              disabled={busy}
              onPress={() => run(signInWithGoogle)}
              accessibilityRole="button"
              accessibilityLabel="Continue with Google"
              style={({ pressed }) => [pressed && styles.pressed]}>
              <ThemedView
                type="backgroundElement"
                style={[styles.accountRow, styles.center, { borderColor: ACCENT }]}>
                <ThemedText style={styles.optionLabel}>Continue with Google</ThemedText>
              </ThemedView>
            </Pressable>
            {appleAvailable && (
              <Pressable
                disabled={busy}
                onPress={() => run(signInWithApple)}
                accessibilityRole="button"
                accessibilityLabel="Continue with Apple"
                style={({ pressed }) => [pressed && styles.pressed]}>
                <ThemedView type="backgroundElement" style={[styles.accountRow, styles.center]}>
                  <ThemedText style={styles.optionLabel}>Continue with Apple</ThemedText>
                </ThemedView>
              </Pressable>
            )}
            <ThemedText type="small" themeColor="textSecondary" style={styles.accountHint}>
              Sign in to sync your notes across devices.
            </ThemedText>
          </>
        )}
      </View>
    </>
  );
}

/**
 * Editor preferences. Currently just the web formatting-hints toggle — the
 * bottom-left cheatsheet button on the note/copa editor screens. Rendered only
 * on web (the caller gates it), since native has no such hint.
 */
function EditorSection() {
  const theme = useTheme();
  const { formattingHints, setFormattingHints } = useEditorPrefs();

  return (
    <>
      <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
        EDITOR
      </ThemedText>
      <View style={styles.options}>
        <Pressable
          onPress={() => setFormattingHints(!formattingHints)}
          accessibilityRole="switch"
          accessibilityState={{ checked: formattingHints }}
          accessibilityLabel="Show formatting hints"
          style={({ pressed }) => [pressed && styles.pressed]}>
          <ThemedView type="backgroundElement" style={styles.row}>
            <View style={styles.rowText}>
              <ThemedText style={styles.optionLabel}>Formatting hints</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                Show the markdown and formula cheatsheet buttons while editing
              </ThemedText>
            </View>
            {/* Squircle check indicator (not a pill switch) — accent-filled when
                on, hollow when off. */}
            <View
              style={[
                styles.check,
                formattingHints
                  ? { backgroundColor: ACCENT, borderColor: ACCENT }
                  : { borderColor: hexToRgba(theme.textSecondary, 0.4) },
              ]}>
              {formattingHints && (
                <MaterialCommunityIcons name="check" size={18} color={theme.background} />
              )}
            </View>
          </ThemedView>
        </Pressable>
      </View>
    </>
  );
}

/**
 * The note plugins available in the navbar's create (+) menu — Sentry views,
 * GitHub views, task managers, sheets, and resumes — each defaulting **off**.
 * Plugins are opt-in, so this section is the one place they're discoverable;
 * every one stays listed here whether or not it's on, and the choice persists.
 * Enabling one reveals its (currently inert) credential fields: they persist
 * on-device but aren't yet wired to auth, since the server holds the real tokens.
 *
 * The section is labelled "Plugins"; the underlying settings keys stay
 * `createOptions.*` so renaming the copy doesn't reset anyone's toggles.
 */
function CreateOptionsSection() {
  const theme = useTheme();
  const opts = useCreateOptions();

  const toggles: { key: CreateToggleKey; label: string; description: string }[] = [
    { key: 'sentryEnabled', label: 'Sentry views', description: 'Show “New Sentry view” in the create menu' },
    { key: 'githubEnabled', label: 'GitHub views', description: 'Show “New GitHub view” in the create menu' },
    { key: 'taskManagerEnabled', label: 'Task managers', description: 'Show “New task manager” in the create menu' },
    { key: 'financeEnabled', label: 'Sheets', description: 'Show “New sheet” in the create menu' },
    { key: 'resumeEnabled', label: 'Resumes', description: 'Show “New resume” in the create menu' },
  ];

  return (
    <>
      <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
        PLUGINS
      </ThemedText>
      <View style={styles.options}>
        {toggles.map((t) => {
          const on = opts[t.key];
          return (
            <View key={t.key} style={styles.optionGroup}>
              <Pressable
                onPress={() => opts.setEnabled(t.key, !on)}
                accessibilityRole="switch"
                accessibilityState={{ checked: on }}
                accessibilityLabel={t.label}
                style={({ pressed }) => [pressed && styles.pressed]}>
                <ThemedView type="backgroundElement" style={styles.row}>
                  <View style={styles.rowText}>
                    <ThemedText style={styles.optionLabel}>{t.label}</ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      {t.description}
                    </ThemedText>
                  </View>
                  <View
                    style={[
                      styles.check,
                      on
                        ? { backgroundColor: ACCENT, borderColor: ACCENT }
                        : { borderColor: hexToRgba(theme.textSecondary, 0.4) },
                    ]}>
                    {on && <MaterialCommunityIcons name="check" size={18} color={theme.background} />}
                  </View>
                </ThemedView>
              </Pressable>

              {t.key === 'sentryEnabled' && on && (
                <TokenField
                  provider="sentry"
                  label="Sentry API token"
                  help="Reads your own Sentry projects. Needs project:read."
                />
              )}
              {t.key === 'githubEnabled' && on && (
                <>
                  <TokenField
                    provider="github"
                    label="GitHub token"
                    help="Browses your own repos. Needs Issues: read and write."
                  />
                  <CredentialField
                    label="Default repo"
                    value={opts.githubRepo}
                    credKey="githubRepo"
                    placeholder="owner/name"
                  />
                </>
              )}
            </View>
          );
        })}
      </View>
    </>
  );
}

/**
 * Dev-only sample content: a couple of dozen notes, a folder tree, a sheet and a
 * resume (see `@/lib/dev-seed`). It is already seeded at every launch, so these
 * two buttons exist for the cases a relaunch doesn't cover — putting the content
 * back after a sign-out cleared the database, or taking it away to look at the
 * app empty. Neither row is reachable in a release build.
 */
function DeveloperSection() {
  // Which action is in flight, so that row alone shows the spinner. Both rows
  // are disabled meanwhile — seeding and clearing must not overlap.
  const [running, setRunning] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<void>) => {
    setRunning(label);
    try {
      await action();
      // These write straight to SQLite, under the stores rather than through
      // them, so nothing else would notice. This is the same signal a sync pull
      // emits, and every store already listens for it.
      refreshFromDb();
    } catch {
      Alert.alert('Something went wrong', 'Please try again.');
    } finally {
      setRunning(null);
    }
  };

  // One-shot actions, so they take the same shape as Sign out above rather than
  // the label-and-description rows the toggles use: a centered label, and the
  // explanation once underneath for the pair. The alternative was a trailing
  // icon, which would have been a third kind of row-ending on this screen and
  // sat ambiguously between decoration and "tap to drill in".
  const actions: { label: string; action: () => Promise<void> }[] = [
    { label: 'Seed sample content', action: () => db.seedDevContent() },
    { label: 'Clear sample content', action: () => db.clearDevContent() },
  ];

  return (
    <>
      <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
        DEVELOPER
      </ThemedText>
      <View style={styles.options}>
        {actions.map(({ label, action }) => (
          <Pressable
            key={label}
            disabled={running !== null}
            onPress={() => void run(label, action)}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => [pressed && styles.pressed]}>
            <ThemedView type="backgroundElement" style={[styles.accountRow, styles.center]}>
              {running === label ? (
                <ActivityIndicator color={ACCENT} />
              ) : (
                <ThemedText style={styles.optionLabel}>{label}</ThemedText>
              )}
            </ThemedView>
          </Pressable>
        ))}
        <ThemedText type="small" themeColor="textSecondary" style={styles.accountHint}>
          Sample notes, folders, a sheet and a resume. They’re seeded at every launch
          anyway; clearing them stops that until you seed again.
        </ThemedText>
      </View>
    </>
  );
}

/**
 * The account's Anthropic API key — the switch that turns the resume's AI
 * features on.
 *
 * Unlike the plugin credentials below it, this one leaves the device: it is sent
 * to the server, stored encrypted against the account, and never comes back. So
 * this section can only ever show the last four characters, and "replace" means
 * typing a whole key again rather than editing the one that's there. That is a
 * property of the design rather than a shortcoming of the screen — a key the app
 * could redisplay is a key the app is holding onto.
 *
 * Three states, and each says what to do next rather than only what is true:
 * the operator's own account rides the server's key and needs nothing; a server
 * with no encryption secret cannot accept a key at all, and says so instead of
 * offering a field that silently fails; everyone else gets a field.
 */
function AiSection() {
  const theme = useTheme();
  const [state, setState] = useState<AiKeyState | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Signed-out / offline-only builds have no server to ask. Failing quietly to
  // "no section" beats a row that reports an error nobody can act on.
  const [reachable, setReachable] = useState(syncConfigured);

  useEffect(() => {
    if (!syncConfigured) return;
    let cancelled = false;
    fetchAiKeyState()
      .then((next) => !cancelled && setState(next))
      .catch(() => !cancelled && setReachable(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!reachable) return null;

  const run = (work: () => Promise<AiKeyState>) => {
    setBusy(true);
    setError(null);
    work()
      .then((next) => {
        setState(next);
        setDraft('');
      })
      .catch((e) => setError(e instanceof ApiError && e.status === 400
        ? 'That doesn’t look like an Anthropic key — they start with “sk-ant-”.'
        : 'Could not save that key. Check your connection and try again.'))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
        AI
      </ThemedText>

      {/* Until the server answers, which of the three states applies is unknown
          — and the field is the wrong guess for two of them. An operator's
          account would watch a key box it must not use appear and then leave.
          A spinner claims nothing and holds the row's shape while we find out. */}
      {!state ? (
        <ThemedView type="backgroundElement" style={styles.row}>
          <View style={styles.rowText}>
            <ThemedText type="small" themeColor="textSecondary">
              Checking this account…
            </ThemedText>
          </View>
          <ActivityIndicator size="small" color={ACCENT} />
        </ThemedView>
      ) : state.owner ? (
        <ThemedView type="backgroundElement" style={styles.row}>
          <View style={styles.rowText}>
            <ThemedText>Using this server’s key</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              This account is the operator’s, so the resume’s AI features are already on.
            </ThemedText>
          </View>
        </ThemedView>
      ) : !state.canStore ? (
        <ThemedView type="backgroundElement" style={styles.row}>
          <View style={styles.rowText}>
            <ThemedText>Not available</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              This server isn’t set up to store API keys.
            </ThemedText>
          </View>
        </ThemedView>
      ) : (
        <ThemedView type="backgroundElement" style={styles.row}>
          <View style={styles.rowText}>
            <ThemedText>Anthropic API key</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {state?.hint
                ? `Saved, ending ${state.hint}. The resume’s writing, tailoring and hardening run on it — and are billed to it.`
                : 'The resume can draft, tailor and harden itself with Claude. Those calls are billed to whoever’s key runs them, so they run on yours.'}
            </ThemedText>

            <View style={styles.credFieldInline}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder={state?.hint ? 'Enter a new key to replace it' : 'sk-ant-…'}
                placeholderTextColor={theme.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                editable={!busy}
                onSubmitEditing={() => draft.trim() && run(() => saveAiKey(draft))}
                style={[
                  styles.credInput,
                  { color: theme.text, borderColor: hexToRgba(theme.text, 0.12) },
                ]}
              />
            </View>

            {error && (
              <ThemedText type="small" style={{ color: DESTRUCTIVE }}>
                {error}
              </ThemedText>
            )}

            <View style={styles.aiActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Save API key"
                disabled={busy || !draft.trim()}
                onPress={() => run(() => saveAiKey(draft))}
                style={({ pressed }) => [
                  styles.aiButton,
                  {
                    borderColor: draft.trim() ? ACCENT : hexToRgba(theme.text, 0.12),
                    opacity: busy || !draft.trim() ? 0.5 : 1,
                  },
                  pressed && styles.pressed,
                ]}>
                {busy ? (
                  <ActivityIndicator size="small" color={ACCENT} />
                ) : (
                  <ThemedText type="small">Save</ThemedText>
                )}
              </Pressable>

              {state?.hint && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Remove API key"
                  disabled={busy}
                  onPress={() => run(forgetAiKey)}
                  style={({ pressed }) => [
                    styles.aiButton,
                    { borderColor: hexToRgba(theme.text, 0.12), opacity: busy ? 0.5 : 1 },
                    pressed && styles.pressed,
                  ]}>
                  <ThemedText type="small" themeColor="textSecondary">
                    Remove
                  </ThemedText>
                </Pressable>
              )}
            </View>
          </View>
        </ThemedView>
      )}
    </>
  );
}

/**
 * One provider token, held by the server rather than this device.
 *
 * Write-only, because the API is: a token goes up and only its last four
 * characters come back. So there are two states rather than one editable value
 * — *saved* (shows `····ab12`, offers Replace and Remove) and *empty* (an input
 * plus Save). There is deliberately no way to read a stored token back; a
 * stolen session should not yield a reusable GitHub credential.
 */
function TokenField({
  provider,
  label,
  help,
}: {
  provider: CredentialProvider;
  label: string;
  help: string;
}) {
  const theme = useTheme();
  const { credentials, credentialsLoading, setToken, clearToken } = useCreateOptions();
  const status = credentials[provider];
  const [entry, setEntry] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showInput = editing || !status.saved;

  const save = async () => {
    const token = entry.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await setToken(provider, token);
      setEntry('');
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save token');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await clearToken(provider);
      setEntry('');
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove token');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.credField}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.credLabel}>
        {label}
      </ThemedText>

      {credentialsLoading ? (
        <ActivityIndicator size="small" color={theme.textSecondary} />
      ) : showInput ? (
        <>
          <TextInput
            value={entry}
            onChangeText={setEntry}
            placeholder="Paste your token"
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={!busy}
            onSubmitEditing={() => void save()}
            style={[
              styles.credInput,
              { color: theme.text, borderColor: hexToRgba(theme.text, 0.12) },
            ]}
          />
          <View style={styles.tokenActions}>
            <Pressable
              onPress={() => void save()}
              disabled={busy || !entry.trim()}
              accessibilityRole="button"
              accessibilityLabel={`Save ${label}`}
              style={({ pressed }) => [pressed && styles.pressed]}>
              <ThemedText
                type="small"
                style={{ color: entry.trim() && !busy ? ACCENT : theme.textSecondary }}>
                {busy ? 'Saving…' : 'Save'}
              </ThemedText>
            </Pressable>
            {status.saved && (
              <Pressable
                onPress={() => {
                  setEditing(false);
                  setEntry('');
                  setError(null);
                }}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                style={({ pressed }) => [pressed && styles.pressed]}>
                <ThemedText type="small" themeColor="textSecondary">
                  Cancel
                </ThemedText>
              </Pressable>
            )}
          </View>
        </>
      ) : (
        <View style={styles.tokenSaved}>
          <ThemedText type="small" themeColor="textSecondary">
            {`Saved ····${status.hint}`}
          </ThemedText>
          <View style={styles.tokenActions}>
            <Pressable
              onPress={() => setEditing(true)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Replace ${label}`}
              style={({ pressed }) => [pressed && styles.pressed]}>
              <ThemedText type="small" style={{ color: ACCENT }}>
                Replace
              </ThemedText>
            </Pressable>
            <Pressable
              onPress={() => void remove()}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${label}`}
              style={({ pressed }) => [pressed && styles.pressed]}>
              <ThemedText type="small" themeColor="textSecondary">
                {busy ? 'Removing…' : 'Remove'}
              </ThemedText>
            </Pressable>
          </View>
        </View>
      )}

      <ThemedText type="small" themeColor="textSecondary" style={styles.credHelp}>
        {error ?? help}
      </ThemedText>
    </View>
  );
}

/** A labelled text field for a stored (non-secret) create-option string. */
function CredentialField({
  label,
  value,
  credKey,
  placeholder,
  secure,
}: {
  label: string;
  value: string;
  credKey: CreateCredentialKey;
  placeholder?: string;
  secure?: boolean;
}) {
  const theme = useTheme();
  const { setCredential } = useCreateOptions();
  return (
    <View style={styles.credField}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.credLabel}>
        {label}
      </ThemedText>
      <TextInput
        value={value}
        onChangeText={(v) => setCredential(credKey, v)}
        placeholder={placeholder}
        placeholderTextColor={theme.textSecondary}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
        style={[styles.credInput, { color: theme.text, borderColor: hexToRgba(theme.text, 0.12) }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  check: {
    width: 28,
    height: 28,
    borderRadius: Spacing.two,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    borderRadius: Spacing.three,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  center: {
    justifyContent: 'center',
  },
  accountHint: {
    marginLeft: Spacing.one,
    marginTop: Spacing.half,
  },
  safeArea: {
    flex: 1,
  },
  content: {
    padding: Spacing.four,
    alignItems: 'center',
  },
  // The actual settings column: full width on phones, capped and centered on
  // wider screens so rows keep a sensible width.
  inner: {
    width: '100%',
    maxWidth: 600,
    gap: Spacing.two,
  },
  title: {
    marginBottom: Spacing.two,
  },
  sectionLabel: {
    letterSpacing: 1,
    marginLeft: Spacing.one,
    marginBottom: Spacing.one,
  },
  options: {
    gap: Spacing.two,
  },
  optionGroup: {
    gap: Spacing.two,
  },
  aiActions: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  // Squircle, not a pill, and the same 2px border the theme rows use — this
  // is the app's existing secondary-action shape, only wide enough for a word.
  aiButton: {
    minWidth: 88,
    height: 40,
    borderRadius: Spacing.two,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  credField: {
    gap: Spacing.half,
    marginLeft: Spacing.three,
  },
  // `credField` without its indent. That indent aligns a CredentialField with
  // the toggle row it hangs below; the AI key's field has no such row — it sits
  // inside `rowText`, already flush with the card's padding — so inheriting the
  // indent would jog the input right of its own label and buttons.
  credFieldInline: {
    gap: Spacing.half,
  },
  credLabel: {
    marginLeft: Spacing.one,
  },
  credInput: {
    borderWidth: 1.5,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 15,
  },
  credHelp: {
    marginLeft: Spacing.one,
  },
  // Saved state reads as one line: what's stored on the left, what you can do
  // about it on the right.
  tokenSaved: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 32,
    paddingLeft: Spacing.one,
  },
  tokenActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingLeft: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    padding: Spacing.three,
    borderRadius: Spacing.three,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  rowText: {
    flex: 1,
    gap: Spacing.half,
  },
  optionLabel: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '600',
  },
  swatch: {
    width: 44,
    height: 44,
    borderRadius: Spacing.two,
    padding: Spacing.two,
    justifyContent: 'center',
    gap: Spacing.half + 1,
    overflow: 'hidden',
  },
  swatchBar: {
    height: 4,
    borderRadius: 2,
    width: '100%',
  },
  swatchBarShort: {
    width: '60%',
  },
  pressed: {
    opacity: 0.6,
  },
});
