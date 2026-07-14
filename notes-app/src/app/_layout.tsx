import { BlurTargetView } from 'expo-blur';
import { DarkTheme, DefaultTheme, ThemeProvider, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { TopTabs } from 'expo-router/js-top-tabs';
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Platform, StyleSheet, type View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

// Side-effect import: initializes Sentry before anything renders (no-op until a
// DSN is set in EXPO_PUBLIC_SENTRY_DSN). `Sentry` is re-exported for the wrap.
import { Sentry } from '@/lib/sentry';
import { AuthProvider } from '@/lib/auth/auth-context';
import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { DbTabGuard } from '@/components/db-tab-guard';
import { FloatingTabBar } from '@/components/floating-tab-bar';
import { MarkdownHelp } from '@/components/markdown-help';
import { SelectionBackdrop } from '@/components/selection-backdrop';
import { SelectionDismissView } from '@/components/selection-dismiss-view';
import { CopaOptionsProvider, useCopaOptions } from '@/components/copa-options-modal';
import { ItemOptionsProvider } from '@/components/item-options-modal';
import { CopaProvider } from '@/store/copa-store';
import { NotesProvider } from '@/store/notes-store';
import { SidebarProvider, useSidebar } from '@/store/sidebar-store';
import { AutofixSelectionProvider } from '@/store/autofix-selection-store';
import { GithubSelectionProvider } from '@/store/github-selection-store';
import { IssuesProvider } from '@/store/issues-store';
import { TaskSelectionProvider } from '@/store/task-selection-store';
import { ItemSelectionProvider } from '@/store/item-selection-store';
import { EditorPrefsProvider, useEditorPrefs } from '@/store/editor-prefs-store';
import { CreateOptionsProvider } from '@/store/create-options-store';
import { AppThemeProvider, useThemePref } from '@/store/theme-store';
import { installSyncFlush } from '@/lib/sync/flush-on-hide';
import { installSyncPoll } from '@/lib/sync/poll';

// Top-level routes that the pager slides between. Everything else (a folder or
// note) lives inside the home group's stack, which keeps its own back-swipe.
const SWIPEABLE_PATHS = ['/', '/copa'];

function RootLayout() {
  // The theme provider must sit above everything that reads the theme.
  return (
    <GestureHandlerRootView style={styles.root}>
      <AppThemeProvider>
        <EditorPrefsProvider>
          <CreateOptionsProvider>
            <AppShell />
          </CreateOptionsProvider>
        </EditorPrefsProvider>
      </AppThemeProvider>
    </GestureHandlerRootView>
  );
}

// Sentry.wrap adds error boundary + touch/navigation breadcrumbs around the app.
// It's a no-op passthrough when Sentry isn't initialized.
export default Sentry.wrap(RootLayout);

/**
 * The tab pager. Kept as its own component inside the provider tree so it can
 * read which overlays are open and freeze its swipe accordingly.
 */
function Screens() {
  const pathname = usePathname();
  const { optionsOpen } = useCopaOptions();
  const { open: drawerOpen } = useSidebar();

  // The pager owns horizontal swipes only while on a top-level screen. On a
  // nested stack screen (folder/note) we hand the gesture back so the stack's
  // edge swipe takes the user back instead of flicking to the other tab. We also
  // freeze it while an overlay (copa options sheet, drawer) is open so a swipe
  // can't navigate out from under it.
  const swipeEnabled = SWIPEABLE_PATHS.includes(pathname) && !optionsOpen && !drawerOpen;

  return (
    <TopTabs
      // The floating bar is the only visible navigation, so hide the pager's
      // built-in tab bar; the screens fill the whole pager.
      tabBar={() => null}
      // Open on home; copa sits to its left so a swipe-right reveals it.
      initialRouteName="(home)"
      screenOptions={{ swipeEnabled }}>
      <TopTabs.Screen name="copa" />
      <TopTabs.Screen name="(home)" />
    </TopTabs>
  );
}

function AppShell() {
  const { scheme } = useThemePref();
  const { formattingHints } = useEditorPrefs();

  // Web: push pending local edits before the tab is hidden/closed so a quick
  // edit-then-leave isn't stranded until the next sync trigger (native no-op).
  useEffect(() => installSyncFlush(), []);

  // Periodically pull remote changes while the client is active so edits made on
  // another device (e.g. the web client) land without needing a local edit or an
  // app-foreground transition. Pauses when backgrounded/hidden.
  useEffect(() => installSyncPoll(), []);

  // Android backdrop blur is capture-based: the navbar's BlurView blurs the
  // content of a BlurTargetView, which must wrap the screens but NOT the navbar
  // (a BlurView inside its own target recurses and crashes the renderer). So we
  // host the target around the screens here and hand its ref to the navbar,
  // which renders as a sibling overlay. iOS blurs natively and skips all this.
  const [target, setTarget] = useState<View | null>(null);
  const blurTarget = useMemo<RefObject<View | null> | null>(
    () => (target ? { current: target } : null),
    [target],
  );

  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <AuthProvider>
      <NotesProvider>
        <IssuesProvider>
        <CopaProvider>
        <SidebarProvider>
        <AutofixSelectionProvider>
        <GithubSelectionProvider>
        <TaskSelectionProvider>
        <ItemSelectionProvider>
        <ItemOptionsProvider>
        <CopaOptionsProvider>
          <AnimatedSplashOverlay />
          {/* Tapping empty space (not a card, not the navbar) clears a card
              selection; cards claim their own taps so they still toggle. */}
          <SelectionDismissView style={styles.root}>
            {Platform.OS === 'android' ? (
              <BlurTargetView
                // Cast: expo-blur types `ref` as RefObject, but we need a callback
                // ref to push the node into state once it mounts.
                ref={setTarget as unknown as RefObject<View | null>}
                style={StyleSheet.absoluteFill}>
                <Screens />
              </BlurTargetView>
            ) : (
              <Screens />
            )}
          </SelectionDismissView>
          {/* Drops the selection when the route changes. */}
          <SelectionBackdrop />
          <FloatingTabBar blurTarget={blurTarget} />
          {/* Web-only markdown cheatsheet button, docked bottom-left on the
              note/copa editor screens. Native renders nothing regardless. */}
          {formattingHints && <MarkdownHelp />}
          {/* Web-only: covers extra browser tabs, which can't hold the SQLite
              database (OPFS is single-owner). Native renders nothing. */}
          <DbTabGuard />
        </CopaOptionsProvider>
        </ItemOptionsProvider>
        </ItemSelectionProvider>
        </TaskSelectionProvider>
        </GithubSelectionProvider>
        </AutofixSelectionProvider>
        </SidebarProvider>
        </CopaProvider>
        </IssuesProvider>
      </NotesProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
