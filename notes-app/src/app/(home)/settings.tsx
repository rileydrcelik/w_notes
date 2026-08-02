import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Stack } from 'expo-router';
import { useState } from 'react';
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
import { Colors, hexToRgba, Spacing, type Palette } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth/auth-context';
import type { CredentialProvider } from '@/lib/credentials';
import {
  useCreateOptions,
  type CreateCredentialKey,
  type CreateToggleKey,
} from '@/store/create-options-store';
import { useEditorPrefs } from '@/store/editor-prefs-store';
import { useThemePref, type ThemeKey } from '@/store/theme-store';

const ACCENT = '#7a89b8';

// Plain before tinted, light before dark within each pair — so the list reads as
// two families rather than four unrelated choices.
const THEME_OPTIONS: { key: ThemeKey; label: string; description: string }[] = [
  { key: 'system', label: 'System', description: 'Match your device' },
  { key: 'light', label: 'Light', description: 'White background, dark text' },
  { key: 'dark', label: 'Dark', description: 'Dark background, light text' },
  { key: 'solarized', label: 'Solarized Light', description: 'Warm, low-contrast paper' },
  { key: 'solarizedDark', label: 'Solarized Dark', description: 'Deep teal, low-contrast' },
  { key: 'mocha', label: 'Mocha', description: 'Catppuccin — soft violet dark' },
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
    if (key === 'solarizedDark') return Colors.solarizedDark;
    if (key === 'mocha') return Colors.mocha;
    return Colors[device === 'dark' ? 'dark' : 'light'];
  };

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <SafeAreaView style={styles.safeArea} edges={['top']}>
          <ScrollView contentContainerStyle={[styles.content, { paddingBottom: tabBarInset }]}>
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

            {/* Which plugin options appear in the navbar's create (+) menu, plus
                (inert) credential fields stored on-device. */}
            <CreateOptionsSection />

            {/* Web edits the body with a rich editor that accepts markdown-style
                keystrokes; the hints button reminds you of them. It's web-only,
                so the toggle is too. */}
            {Platform.OS === 'web' && <EditorSection />}
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
  credField: {
    gap: Spacing.half,
    marginLeft: Spacing.three,
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
