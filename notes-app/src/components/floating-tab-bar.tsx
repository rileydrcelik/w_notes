import Feather from '@expo/vector-icons/Feather';
import { type Href, usePathname, useRouter } from 'expo-router';
import type { ComponentProps, RefObject } from 'react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  SlideInDown,
  SlideOutDown,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSurface } from '@/components/glass-surface';
import { RightSidebar } from '@/components/right-sidebar';
import { ThemedText } from '@/components/themed-text';
import { useItemOptions } from '@/components/item-options-modal';
import { GithubIssueCompose } from '@/components/notes/github-issue-compose';
import type { Note } from '@/data/notes';
import {
  dismissActiveEditor,
  editorJustDismissed,
  isEditorActive,
  subscribeActiveEditor,
} from '@/lib/active-editor';
import { Spacing, TabBar } from '@/constants/theme';
import { useContextMenu } from '@/hooks/use-context-menu';
import { useTabBarBottom } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { saveNoteToDevice } from '@/lib/save-note';
import { useCopa } from '@/store/copa-store';
import { useCreateOptions } from '@/store/create-options-store';
import { useNotes } from '@/store/notes-store';
import { useSidebar } from '@/store/sidebar-store';
import { useAutofixSelection } from '@/store/autofix-selection-store';
import { useGithubSelection, type CloseReason } from '@/store/github-selection-store';
import { useTaskSelection } from '@/store/task-selection-store';
import { useItemSelection } from '@/store/item-selection-store';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Tracks on-screen keyboard visibility so the bar can move out of its way. */
function useKeyboardVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => setVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

/** Tracks whether a body editor is in edit mode (web has no keyboard to watch). */
function useEditorActive() {
  return useSyncExternalStore(subscribeActiveEditor, isEditorActive, () => false);
}

type FeatherName = ComponentProps<typeof Feather>['name'];

/** On-screen rect of the create button, so the menu can anchor above it. */
type Anchor = { x: number; y: number; width: number; height: number };

type FloatingTabBarProps = {
  /** Android blur target (ref to the screens' BlurTargetView); null elsewhere. */
  blurTarget?: RefObject<View | null> | null;
};

export function FloatingTabBar({ blurTarget }: FloatingTabBarProps) {
  const colors = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const bottom = useTabBarBottom();
  const { getNote } = useNotes();
  // The create menu. `null` is closed; an `anchor` rect renders it as a popover
  // above the + button (copa tab), while `null` anchor falls back to the bottom
  // sheet (note/folder picker from a long-press elsewhere).
  const [createMenu, setCreateMenu] = useState<{ anchor: Anchor | null } | null>(null);
  // The menu tab opens a side drawer instead of navigating to a screen. Its
  // open state is shared (via context) so the home screen's left-swipe can open
  // the same drawer.
  const { open: menuOpen, setOpen: setMenuOpen } = useSidebar();
  // While the Sentry screen has issues selected, the trailing (+) slot becomes a
  // "⋯" button that opens a menu of actions — Fix, Dismiss, Copy error message.
  const {
    active: selecting,
    count: selectedCount,
    requestFix,
    requestIgnore,
    requestCopy,
    clear: clearSelection,
  } = useAutofixSelection();
  const fixMode = selecting && selectedCount > 0;
  // The selection actions menu (opened by the "⋯" button while selecting).
  const [selectionMenuOpen, setSelectionMenuOpen] = useState(false);
  // Reset it when selection ends so it can't auto-open on the next selection.
  if (!fixMode && selectionMenuOpen) setSelectionMenuOpen(false);
  // Same pattern for the GitHub issues screen: while issues are selected there,
  // the (+) slot becomes a "⋯" button opening Close / Reopen / Comment / Copy.
  const {
    active: ghSelecting,
    count: ghSelectedCount,
    requestClose: requestGhClose,
    requestReopen: requestGhReopen,
    requestComment: requestGhComment,
    requestCopy: requestGhCopy,
    clear: clearGhSelection,
    composeRepo: ghComposeRepo,
    emitCreated: emitGhCreated,
  } = useGithubSelection();
  // Sentry's selection takes precedence if both somehow coexist.
  const ghMode = !fixMode && ghSelecting && ghSelectedCount > 0;
  const [ghMenuOpen, setGhMenuOpen] = useState(false);
  if (!ghMode && ghMenuOpen) setGhMenuOpen(false);
  // The comment composer opened by the GitHub menu's "Comment" action.
  const [ghCommentOpen, setGhCommentOpen] = useState(false);
  if (!ghMode && ghCommentOpen) setGhCommentOpen(false);
  // On a configured GitHub issues screen the (+) button composes a new issue
  // instead of opening the new-note menu. The composer is rendered here (in the
  // navbar) so it stacks above the bar rather than under it.
  const [ghComposeOpen, setGhComposeOpen] = useState(false);
  if (!ghComposeRepo && ghComposeOpen) setGhComposeOpen(false);
  // Same story for task-manager projects: while issues are selected the (+) slot
  // becomes a "⋯" actions menu; otherwise it routes to the issue-creation screen.
  const {
    active: taskSelecting,
    count: taskSelectedCount,
    requestMarkDone,
    requestEditAttrs,
    requestDelete,
    clear: clearTaskSelection,
    composeProjectId,
    composeTypeId,
    githubUrl: taskGithubUrl,
  } = useTaskSelection();
  const taskMode = !fixMode && !ghMode && taskSelecting && taskSelectedCount > 0;
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  if (!taskMode && taskMenuOpen) setTaskMenuOpen(false);
  // The autofix setup instructions, opened by the "?" next to the Fix action.
  const [autofixHelpOpen, setAutofixHelpOpen] = useState(false);
  // Long-pressed/right-clicked note/folder cards. While any are selected the
  // trailing (+) slot becomes a "⋯" button that opens the bulk options sheet for
  // the whole selection. Sentry's fix selection takes precedence when both coexist.
  const {
    selected: selectedItems,
    count: selectedItemCount,
    active: itemSelectionActive,
    clear: clearItemSelection,
  } = useItemSelection();
  const { openOptions } = useItemOptions();
  const itemSelected = itemSelectionActive && !fixMode && !ghMode && !taskMode;
  // The (+) becomes a "compose issue" button on a configured GitHub screen, when
  // nothing is selected.
  const ghComposeMode = !!ghComposeRepo && !fixMode && !ghMode && !taskMode && !itemSelected;
  // …and routes to the issue-creation screen on a configured task-manager project.
  const taskComposeMode =
    !!composeProjectId && !fixMode && !ghMode && !taskMode && !itemSelected && !ghComposeMode;
  // Copa is the only sibling tab; everything else lives under the home group.
  // Its editor lives at /copa/[id], so match the whole copa stack.
  const onCopa = pathname === '/copa' || pathname.startsWith('/copa/');
  // While the keyboard is up, the bar relocates to the top-right and stacks
  // vertically so it never sits over the keyboard.
  const vertical = useKeyboardVisible();
  // The trailing button becomes a "done" check while editing. On native that's
  // driven by the keyboard; web has no on-screen keyboard, so an active editor
  // surfaces the same check (tapping it returns to the read view).
  const editorActive = useEditorActive();
  const doneMode = vertical || (Platform.OS === 'web' && editorActive);
  // Show back on every page except the home screen (which lives at "/").
  const showBack = pathname !== '/';
  // The current note being viewed, if any. When one is open and we're in *view*
  // mode (not editing — no keyboard/active editor), a "save to device" button
  // appears in the navbar, expanding it. Plugin notes (e.g. Sentry) carry no
  // body to export, so they're excluded.
  const noteMatch = pathname.match(/^\/note\/([^/]+)/);
  const currentNote = noteMatch ? getNote(decodeURIComponent(noteMatch[1])) : undefined;
  const showSave = !!currentNote && !currentNote.pluginType && !doneMode;

  const goBack = () => {
    dismissActiveEditor();
    Keyboard.dismiss();
    if (router.canGoBack()) router.back();
    else router.replace('/' as Href);
  };

  // The bar's icons. The save-to-device action slots in between home and menu
  // while a note is open in view mode, growing the pill to fit it.
  const items: { key: string; icon: FeatherName; path?: Href }[] = [
    { key: 'copa', icon: 'clipboard', path: '/copa' as Href },
    { key: 'home', icon: 'home', path: '/' as Href },
    ...(showSave ? [{ key: 'save', icon: 'download' as FeatherName }] : []),
    { key: 'menu', icon: 'menu' },
  ];

  // When docked at the top-right the slots reserve height; otherwise width.
  const slotStyle = vertical ? { height: TabBar.height } : { width: TabBar.height };
  // The pill sizes to its icons (each a square TabBar.height wide) plus padding,
  // so adding/removing the save icon grows/shrinks it. Its main-axis length is
  // animated via the wrapper's LinearTransition below.
  const barLen = items.length * TabBar.height + Spacing.two * 2;
  const barWrapStyle = vertical
    ? { width: TabBar.height, height: barLen, marginVertical: Spacing.two }
    : { width: barLen, height: TabBar.height, marginHorizontal: Spacing.two };
  const hostPlacement = vertical
    ? { top: insets.top + TabBar.margin, right: TabBar.margin, alignItems: 'flex-end' as const }
    : { bottom, left: 0, right: 0, alignItems: 'center' as const };

  return (
    <>
      {/* Rendered before the cluster so the navbar always stacks above the drawer. */}
      <RightSidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      {/* The navbar steps aside while the drawer is open. */}
      {!menuOpen && (
      <Animated.View
        pointerEvents="box-none"
        entering={FadeIn.duration(200)}
        exiting={FadeOut.duration(150)}
        layout={LinearTransition.duration(220)}
        style={[styles.host, hostPlacement]}>
        <View style={[styles.cluster, vertical && styles.clusterVertical]}>
          {/* Leading slot: reserves space so the bar stays centered whether or not back shows. */}
          <Animated.View
            layout={LinearTransition.duration(220)}
            pointerEvents="box-none"
            style={[styles.sideSlot, slotStyle]}>
            {showBack && (
              <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)}>
                <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={goBack}>
                  <GlassSurface
                    intensity={75}
                    tintOpacity={0.5}
                    blurTarget={blurTarget}
                    style={[styles.backButton, { width: TabBar.height, height: TabBar.height }]}>
                    <Feather name="chevron-left" color={colors.textSecondary} size={26} />
                  </GlassSurface>
                </Pressable>
              </Animated.View>
            )}
          </Animated.View>

          {/* The pill grows/shrinks as items change; LinearTransition animates
              its length and slides the side slots along with it. */}
          <Animated.View layout={LinearTransition.duration(220)} style={barWrapStyle}>
          <GlassSurface
            intensity={75}
            tintOpacity={0.5}
            blurTarget={blurTarget}
            style={[styles.bar, vertical && styles.barVertical, styles.barFill]}>
            {items.map((tab) => {
              // The menu tab reflects the drawer's open state, copa is active on
              // its own route, home on everything else; save is a plain action.
              const focused =
                tab.key === 'menu'
                  ? menuOpen
                  : tab.key === 'copa'
                    ? onCopa
                    : tab.key === 'home'
                      ? !onCopa
                      : false;

              const onPress = () => {
                // Any navbar press dismisses the keyboard before acting.
                Keyboard.dismiss();
                if (tab.key === 'menu') {
                  setMenuOpen((prev) => !prev);
                  return;
                }
                if (tab.key === 'save') {
                  if (currentNote) void saveNoteToDevice(currentNote);
                  return;
                }
                if (tab.path) router.navigate(tab.path);
              };

              return (
                <Pressable
                  key={tab.key}
                  accessibilityRole="button"
                  accessibilityLabel={tab.key === 'save' ? 'Save note to device' : undefined}
                  accessibilityState={focused ? { selected: true } : {}}
                  onPress={onPress}
                  style={styles.item}>
                  <Animated.View
                    entering={tab.key === 'save' ? FadeIn.duration(200) : undefined}>
                    <Feather
                      name={tab.icon}
                      color={focused ? '#7a89b8' : colors.textSecondary}
                      size={tab.key === 'save' ? 24 : 28}
                    />
                  </Animated.View>
                </Pressable>
              );
            })}
          </GlassSurface>
          </Animated.View>

          {/* Trailing slot: the create button, mirroring the back button. While
              Sentry issues are selected it becomes a "⋯" actions button, and
              while a note/folder card is selected it becomes a "⋯" options
              button for that item. */}
          <Animated.View
            layout={LinearTransition.duration(220)}
            pointerEvents="box-none"
            style={[styles.sideSlot, slotStyle]}>
            {fixMode ? (
              <Animated.View
                key="selection"
                entering={FadeIn.duration(160)}
                exiting={FadeOut.duration(140)}>
                <SelectionMenuButton
                  count={selectedCount}
                  blurTarget={blurTarget}
                  onPress={() => setSelectionMenuOpen(true)}
                  onCancel={clearSelection}
                />
              </Animated.View>
            ) : ghMode ? (
              <Animated.View
                key="gh-selection"
                entering={FadeIn.duration(160)}
                exiting={FadeOut.duration(140)}>
                <SelectionMenuButton
                  count={ghSelectedCount}
                  blurTarget={blurTarget}
                  tint="#8250df"
                  onPress={() => setGhMenuOpen(true)}
                  onCancel={clearGhSelection}
                />
              </Animated.View>
            ) : taskMode ? (
              <Animated.View
                key="task-selection"
                entering={FadeIn.duration(160)}
                exiting={FadeOut.duration(140)}>
                <SelectionMenuButton
                  count={taskSelectedCount}
                  blurTarget={blurTarget}
                  tint="#16a394"
                  onPress={() => setTaskMenuOpen(true)}
                  onCancel={clearTaskSelection}
                />
              </Animated.View>
            ) : itemSelected ? (
              <Animated.View
                key="item-options"
                entering={FadeIn.duration(160)}
                exiting={FadeOut.duration(140)}>
                <ItemOptionsButton
                  count={selectedItemCount}
                  iconColor={colors.text}
                  blurTarget={blurTarget}
                  onPress={() => {
                    if (selectedItems.length > 0) openOptions(selectedItems);
                    clearItemSelection();
                  }}
                  onCancel={clearItemSelection}
                />
              </Animated.View>
            ) : ghComposeMode ? (
              <Animated.View
                key="gh-compose"
                entering={FadeIn.duration(160)}
                exiting={FadeOut.duration(140)}>
                <ComposeButton blurTarget={blurTarget} onPress={() => setGhComposeOpen(true)} />
              </Animated.View>
            ) : taskComposeMode ? (
              <Animated.View
                key="task-compose"
                entering={FadeIn.duration(160)}
                exiting={FadeOut.duration(140)}>
                <ComposeButton
                  blurTarget={blurTarget}
                  tint="#16a394"
                  onPress={() =>
                    composeProjectId &&
                    router.push({
                      pathname: '/project/[id]/new',
                      params: {
                        id: composeProjectId,
                        ...(composeTypeId ? { typeId: composeTypeId } : {}),
                      },
                    })
                  }
                />
              </Animated.View>
            ) : (
              <Animated.View key="create" entering={FadeIn.duration(160)} exiting={FadeOut.duration(140)}>
                <CreateButton
                  iconColor={colors.textSecondary}
                  keyboardVisible={doneMode}
                  blurTarget={blurTarget}
                  onOpenMenu={(anchor) => setCreateMenu({ anchor })}
                />
              </Animated.View>
            )}
          </Animated.View>
        </View>
      </Animated.View>
      )}
      {/* Create picker: a popover above the + button on copa, a bottom sheet
          (note/folder) from a long-press elsewhere. */}
      <CreateMenu
        open={createMenu !== null}
        anchor={createMenu?.anchor ?? null}
        onClose={() => setCreateMenu(null)}
      />
      {/* Actions for the selected Sentry issues, opened by the "⋯" button. */}
      <SelectionMenu
        open={selectionMenuOpen && fixMode}
        count={selectedCount}
        onClose={() => setSelectionMenuOpen(false)}
        onFix={requestFix}
        onDismiss={requestIgnore}
        onCopy={requestCopy}
        onHelp={() => {
          // Swap the actions sheet for the setup instructions.
          setSelectionMenuOpen(false);
          setAutofixHelpOpen(true);
        }}
      />
      {/* How to make a repo autofix-ready — opened by the "?" next to Fix. */}
      <AutofixHelp open={autofixHelpOpen} onClose={() => setAutofixHelpOpen(false)} />
      {/* Actions for the selected GitHub issues, opened by the "⋯" button. */}
      <GithubSelectionMenu
        open={ghMenuOpen && ghMode}
        count={ghSelectedCount}
        onClose={() => setGhMenuOpen(false)}
        onCloseIssues={requestGhClose}
        onReopen={requestGhReopen}
        onCopy={requestGhCopy}
        onComment={() => {
          // Swap the actions sheet for the comment composer (selection persists).
          setGhMenuOpen(false);
          setGhCommentOpen(true);
        }}
      />
      {/* Compose a comment applied to the selected GitHub issues. */}
      <CommentSheet
        open={ghCommentOpen && ghMode}
        count={ghSelectedCount}
        onClose={() => setGhCommentOpen(false)}
        onSubmit={(body) => {
          requestGhComment(body);
          setGhCommentOpen(false);
        }}
      />
      {/* Create a new GitHub issue — opened by the (+) on a GitHub issues screen.
          Rendered here so it stacks above the navbar; the created issue is handed
          back to the screen via the shared store. */}
      <GithubIssueCompose
        open={ghComposeOpen && !!ghComposeRepo}
        repo={ghComposeRepo ?? ''}
        onClose={() => setGhComposeOpen(false)}
        onCreated={emitGhCreated}
      />
      {/* Actions for the selected task-manager issues, opened by the "⋯" button. */}
      <TaskSelectionMenu
        open={taskMenuOpen && taskMode}
        count={taskSelectedCount}
        onClose={() => setTaskMenuOpen(false)}
        onMarkDone={() => requestMarkDone(true)}
        onMarkNotDone={() => requestMarkDone(false)}
        onEditAttrs={requestEditAttrs}
        onOpenGithub={taskGithubUrl ? () => void Linking.openURL(taskGithubUrl) : undefined}
        onDelete={requestDelete}
      />
    </>
  );
}

/**
 * Create picker. When `anchor` is set (copa tab), it renders as a small popover
 * floating just above the + button and offers a new copy block or a file block.
 * Without an anchor it's the bottom sheet used elsewhere to pick a new note or
 * folder (created in the current folder, or the root). Every choice opens its
 * editor straight away.
 */
function CreateMenu({
  open,
  anchor,
  onClose,
}: {
  open: boolean;
  anchor: Anchor | null;
  onClose: () => void;
}) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const { width: winW, height: winH } = useWindowDimensions();
  const { createNote, createSentryNote, createGithubNote, createProject, createFolder, getNote } =
    useNotes();
  const { createCopa, createFileCopa } = useCopa();
  const { sentryEnabled, githubEnabled, taskManagerEnabled } = useCreateOptions();

  const onCopa = pathname === '/copa' || pathname.startsWith('/copa/');

  const onCreateNote = () => {
    onClose();
    const id = createNote(currentFolderId(pathname, getNote));
    router.push({ pathname: '/note/[id]', params: { id } });
  };

  const onCreateSentry = () => {
    onClose();
    // Create it unconfigured — the Sentry screen shows a project picker and
    // writes the org/project (and optional repo) into the note in place.
    const id = createSentryNote(currentFolderId(pathname, getNote));
    router.push({ pathname: '/sentry/[id]', params: { id } });
  };

  const onCreateGithub = () => {
    onClose();
    // Create it unconfigured — the GitHub screen shows a repo picker and writes
    // the repo into the note in place.
    const id = createGithubNote(currentFolderId(pathname, getNote));
    router.push({ pathname: '/github/[id]', params: { id } });
  };

  const onCreateProject = () => {
    onClose();
    // Create it unconfigured — the project screen collects name + repo and seeds
    // the default issue types in place.
    const id = createProject(currentFolderId(pathname, getNote));
    router.push({ pathname: '/project/[id]', params: { id } });
  };

  const onCreateFolder = () => {
    onClose();
    const id = createFolder(currentFolderId(pathname, getNote));
    router.push({ pathname: '/folder/[id]', params: { id } });
  };

  const onCreateBlock = () => {
    onClose();
    const id = createCopa();
    router.push({ pathname: '/copa/[id]', params: { id } });
  };

  const onAddFile = async () => {
    onClose();
    const id = await createFileCopa();
    // A cancelled picker returns null — leave the user where they were.
    if (id) router.push({ pathname: '/copa/[id]', params: { id } });
  };

  // Plugin create-options can be hidden from Settings; note/folder are always on.
  const pluginEnabled: Record<string, boolean> = {
    sentry: sentryEnabled,
    github: githubEnabled,
    project: taskManagerEnabled,
  };
  const allOptions: { key: string; label: string; icon: FeatherName; onPress: () => void }[] = onCopa
    ? [
        { key: 'block', label: 'New copy block', icon: 'clipboard', onPress: onCreateBlock },
        { key: 'file', label: 'Add file', icon: 'paperclip', onPress: () => void onAddFile() },
      ]
    : [
        { key: 'note', label: 'New note', icon: 'file-plus', onPress: onCreateNote },
        { key: 'folder', label: 'New folder', icon: 'folder-plus', onPress: onCreateFolder },
        { key: 'sentry', label: 'New Sentry view', icon: 'alert-triangle', onPress: onCreateSentry },
        { key: 'github', label: 'New GitHub view', icon: 'github', onPress: onCreateGithub },
        { key: 'project', label: 'New task manager', icon: 'columns', onPress: onCreateProject },
      ];
  const options = allOptions.filter((o) => pluginEnabled[o.key] ?? true);

  const card = (
    <GlassSurface
      intensity={75}
      tintOpacity={0.85}
      style={[styles.menuSheet, anchor && styles.menuSheetAnchored]}>
      {options.map((option) => (
        <Pressable
          key={option.key}
          onPress={option.onPress}
          accessibilityRole="button"
          accessibilityLabel={option.label}
          style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}>
          <Feather name={option.icon} size={20} color={colors.text} style={styles.menuIcon} />
          <ThemedText style={[styles.menuLabel, { color: colors.text }]}>{option.label}</ThemedText>
        </Pressable>
      ))}
    </GlassSurface>
  );

  return (
    <View style={styles.menuOverlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.menuBackdrop}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          />
          {anchor ? (
            // Popover anchored to the + button: its bottom-right corner sits a
            // hair above the button's top-right corner.
            <Animated.View
              entering={FadeIn.duration(160)}
              exiting={FadeOut.duration(140)}
              style={[
                styles.menuAnchored,
                {
                  bottom: winH - anchor.y + Spacing.two,
                  right: Math.max(Spacing.three, winW - (anchor.x + anchor.width)),
                },
              ]}>
              {card}
            </Animated.View>
          ) : (
            <Animated.View
              entering={SlideInDown.duration(260)}
              exiting={SlideOutDown.duration(220)}
              style={[styles.menuHost, { paddingBottom: insets.bottom + Spacing.three }]}>
              {card}
            </Animated.View>
          )}
        </>
      )}
    </View>
  );
}

/**
 * Resolve the folder a new item should land in from the current route: a folder
 * screen creates inside that folder, a note screen alongside its siblings, and
 * everywhere else (e.g. home) at the root.
 */
function currentFolderId(pathname: string, getNote: (id: string) => Note | undefined): string | null {
  const folderMatch = pathname.match(/^\/folder\/([^/]+)/);
  if (folderMatch) return decodeURIComponent(folderMatch[1]);
  const noteMatch = pathname.match(/^\/note\/([^/]+)/);
  if (noteMatch) return getNote(decodeURIComponent(noteMatch[1]))?.folderId ?? null;
  return null;
}

/**
 * Trailing action button. With the keyboard up it becomes a "done" affordance —
 * a check that dismisses the keyboard. Otherwise it's the create (+) button: on
 * the copa tab a tap opens the create menu anchored above it (copy block vs
 * file); elsewhere a tap adds a note in the current location and a long-press
 * opens the note/folder menu. The button reports its on-screen rect so the menu
 * can anchor to it.
 */
function CreateButton({
  iconColor,
  keyboardVisible,
  blurTarget,
  onOpenMenu,
}: {
  iconColor: string;
  keyboardVisible: boolean;
  blurTarget?: RefObject<View | null> | null;
  onOpenMenu: (anchor: Anchor | null) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { createNote, getNote } = useNotes();
  const buttonRef = useRef<View | null>(null);
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const onCopa = pathname === '/copa' || pathname.startsWith('/copa/');

  // Open the menu anchored to this button's measured screen position.
  const openAnchoredMenu = () => {
    const node = buttonRef.current;
    if (node) node.measureInWindow((x, y, width, height) => onOpenMenu({ x, y, width, height }));
    else onOpenMenu(null);
  };

  const onPress = () => {
    // Blur the native rich editor (Keyboard.dismiss can't) before dismissing.
    const dismissed = dismissActiveEditor();
    Keyboard.dismiss();
    // This button just confirms/dismisses while editing — whether the keyboard is
    // up (native) or an editor was active when the press began. On web the press
    // blurs the editor first, so `dismissActiveEditor` is already a no-op by now;
    // `editorJustDismissed` catches that so we don't fall through to "create".
    if (keyboardVisible || dismissed || editorJustDismissed()) return;
    // On the copa tab a tap opens the anchored menu; elsewhere it creates a note.
    if (onCopa) {
      openAnchoredMenu();
      return;
    }
    const id = createNote(currentFolderId(pathname, getNote));
    router.push({ pathname: '/note/[id]', params: { id } });
  };

  const handleLongPress = () => {
    // The button is a "done" key while the keyboard is up — only offer the menu
    // when plainly creating. Copa drives the menu from a tap, so long-press there
    // just opens the same anchored menu; elsewhere it's the note/folder sheet.
    if (keyboardVisible) return;
    dismissActiveEditor();
    Keyboard.dismiss();
    if (onCopa) openAnchoredMenu();
    else onOpenMenu(null);
  };

  // Web: right-clicking the button opens the same create menu that a long-press
  // opens on mobile (no-op on native). Compose it with `buttonRef` — which the
  // anchored menu measures against — so a single ref both measures and listens.
  const contextMenuRef = useContextMenu(handleLongPress);
  const setButtonRef = useCallback(
    (node: View | null) => {
      buttonRef.current = node;
      contextMenuRef?.(node);
    },
    [contextMenuRef],
  );

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        ref={setButtonRef}
        accessibilityRole="button"
        accessibilityLabel={keyboardVisible ? 'Done' : 'Create'}
        onPressIn={() => {
          scale.value = withTiming(0.92, { duration: 80 });
        }}
        onPressOut={() => {
          scale.value = withTiming(1, { duration: 120 });
        }}
        onPress={onPress}
        onLongPress={handleLongPress}>
        <GlassSurface
          intensity={75}
          tintOpacity={0.85}
          blurTarget={blurTarget}
          style={[styles.createButton, { width: TabBar.height, height: TabBar.height }]}>
          <Feather
            name={keyboardVisible ? 'check' : 'plus'}
            color={iconColor}
            size={26}
          />
        </GlassSurface>
      </Pressable>
    </Animated.View>
  );
}

/**
 * Trailing (+) on a configured GitHub issues screen: sits where the create button
 * normally does, but a tap opens the new-issue composer for that repo (its accent
 * colour marks it as a GitHub action) instead of the note/folder menu.
 */
function ComposeButton({
  blurTarget,
  onPress,
  tint = '#8250df',
}: {
  blurTarget?: RefObject<View | null> | null;
  onPress: () => void;
  /** Icon accent — GitHub purple by default; the task manager passes its own. */
  tint?: string;
}) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New issue"
        onPressIn={() => {
          scale.value = withTiming(0.92, { duration: 80 });
        }}
        onPressOut={() => {
          scale.value = withTiming(1, { duration: 120 });
        }}
        onPress={onPress}>
        <GlassSurface
          intensity={75}
          tintOpacity={0.85}
          blurTarget={blurTarget}
          style={[styles.createButton, { width: TabBar.height, height: TabBar.height }]}>
          <Feather name="plus" color={tint} size={28} />
        </GlassSurface>
      </Pressable>
    </Animated.View>
  );
}

/**
 * Trailing action while a note/folder card is selected: sits exactly where the
 * create (+) button normally does. A tap opens that item's options sheet; a
 * long-press (or right-click on web) cancels the selection.
 */
function ItemOptionsButton({
  count,
  iconColor,
  blurTarget,
  onPress,
  onCancel,
}: {
  count: number;
  iconColor: string;
  blurTarget?: RefObject<View | null> | null;
  onPress: () => void;
  onCancel: () => void;
}) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  // Right-click cancels the selection on web, matching the long-press affordance.
  const contextMenuRef = useContextMenu(onCancel);

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        ref={contextMenuRef}
        accessibilityRole="button"
        accessibilityLabel={`Options for ${count} selected ${count === 1 ? 'item' : 'items'}`}
        onPressIn={() => {
          scale.value = withTiming(0.92, { duration: 80 });
        }}
        onPressOut={() => {
          scale.value = withTiming(1, { duration: 120 });
        }}
        onPress={onPress}
        onLongPress={onCancel}>
        <GlassSurface
          intensity={75}
          tintOpacity={0.85}
          blurTarget={blurTarget}
          style={[styles.createButton, { width: TabBar.height, height: TabBar.height }]}>
          <Feather name="more-horizontal" color={iconColor} size={26} />
          {count > 1 && (
            <View style={styles.fixBadge}>
              <ThemedText style={styles.fixBadgeText}>{count}</ThemedText>
            </View>
          )}
        </GlassSurface>
      </Pressable>
    </Animated.View>
  );
}

/**
 * Trailing action while Sentry issues are selected: sits exactly where the create
 * (+) button normally does. A tap opens the actions menu (Fix / Dismiss / Copy); a
 * long-press (or right-click on web) cancels the selection. A small badge shows how
 * many issues are picked.
 */
function SelectionMenuButton({
  count,
  blurTarget,
  onPress,
  onCancel,
  tint = '#7553FF',
}: {
  count: number;
  blurTarget?: RefObject<View | null> | null;
  onPress: () => void;
  onCancel: () => void;
  /** Icon/badge accent — Sentry purple by default; GitHub passes its own. */
  tint?: string;
}) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  // Right-click cancels selection on web, matching the long-press affordance.
  const contextMenuRef = useContextMenu(onCancel);

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        ref={contextMenuRef}
        accessibilityRole="button"
        accessibilityLabel={`Actions for ${count} selected ${count === 1 ? 'issue' : 'issues'}`}
        onPressIn={() => {
          scale.value = withTiming(0.92, { duration: 80 });
        }}
        onPressOut={() => {
          scale.value = withTiming(1, { duration: 120 });
        }}
        onPress={onPress}
        onLongPress={onCancel}>
        <GlassSurface
          intensity={75}
          tintOpacity={0.85}
          blurTarget={blurTarget}
          style={[styles.createButton, { width: TabBar.height, height: TabBar.height }]}>
          <Feather name="more-horizontal" color={tint} size={26} />
          <View style={styles.fixBadge}>
            <ThemedText style={styles.fixBadgeText}>{count}</ThemedText>
          </View>
        </GlassSurface>
      </Pressable>
    </Animated.View>
  );
}

/**
 * Bottom sheet of actions for the selected Sentry issues, opened from the "⋯"
 * button. Mirrors the app's other option sheets (glass surface, slide-in, a
 * backdrop tap to dismiss). Each row runs its action and closes the sheet; the
 * Fix/Dismiss/Copy handlers themselves clear the selection.
 */
function SelectionMenu({
  open,
  count,
  onClose,
  onFix,
  onDismiss,
  onCopy,
  onHelp,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  onFix: () => void;
  onDismiss: () => void;
  onCopy: () => void;
  onHelp: () => void;
}) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const noun = count === 1 ? 'issue' : 'issues';

  // `onHelp` marks the row that gets a trailing "?" (setup instructions). Only
  // Fix depends on repo config, so only it carries the affordance.
  const options: {
    key: string;
    label: string;
    icon: FeatherName;
    tint: string;
    onPress: () => void;
    onHelp?: () => void;
  }[] = [
    { key: 'fix', label: `Fix ${count} ${noun}`, icon: 'zap', tint: '#7553FF', onPress: onFix, onHelp },
    { key: 'dismiss', label: `Dismiss ${count} ${noun}`, icon: 'check', tint: colors.text, onPress: onDismiss },
    { key: 'copy', label: 'Copy error message', icon: 'copy', tint: colors.text, onPress: onCopy },
  ];

  return (
    <View style={styles.menuOverlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.menuBackdrop}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Dismiss actions"
          />
          <Animated.View
            entering={SlideInDown.duration(260)}
            exiting={SlideOutDown.duration(220)}
            style={[styles.menuHost, { paddingBottom: insets.bottom + Spacing.three }]}>
            <GlassSurface intensity={75} tintOpacity={0.85} style={styles.menuSheet}>
              {options.map((option) => (
                <View key={option.key} style={styles.menuRowWrap}>
                  <Pressable
                    onPress={() => {
                      option.onPress();
                      onClose();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={option.label}
                    style={({ pressed }) => [
                      styles.menuRow,
                      styles.menuRowFlex,
                      pressed && styles.menuRowPressed,
                    ]}>
                    <Feather name={option.icon} size={20} color={option.tint} style={styles.menuIcon} />
                    <ThemedText style={[styles.menuLabel, { color: option.tint }]}>
                      {option.label}
                    </ThemedText>
                  </Pressable>
                  {option.onHelp && (
                    <Pressable
                      onPress={option.onHelp}
                      accessibilityRole="button"
                      accessibilityLabel="How to set up autofix for a repo"
                      hitSlop={8}
                      style={({ pressed }) => [styles.menuHelp, pressed && styles.menuRowPressed]}>
                      <Feather name="help-circle" size={20} color={colors.textSecondary} />
                    </Pressable>
                  )}
                </View>
              ))}
            </GlassSurface>
          </Animated.View>
        </>
      )}
    </View>
  );
}

/**
 * Bottom sheet of actions for the selected GitHub issues, opened from the "⋯"
 * button on the GitHub issues screen. Mirrors {@link SelectionMenu}. Close offers
 * two reasons (completed / not planned); the close/reopen/comment/copy handlers
 * themselves clear the selection (except Comment, which first opens a composer).
 */
function GithubSelectionMenu({
  open,
  count,
  onClose,
  onCloseIssues,
  onReopen,
  onComment,
  onCopy,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  onCloseIssues: (reason: CloseReason) => void;
  onReopen: () => void;
  onComment: () => void;
  onCopy: () => void;
}) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const noun = count === 1 ? 'issue' : 'issues';

  const options: { key: string; label: string; icon: FeatherName; tint: string; onPress: () => void }[] = [
    { key: 'complete', label: `Close ${count} ${noun} as completed`, icon: 'check-circle', tint: '#3fb950', onPress: () => onCloseIssues('completed') },
    { key: 'notplanned', label: `Close ${count} ${noun} as not planned`, icon: 'slash', tint: colors.textSecondary, onPress: () => onCloseIssues('not_planned') },
    { key: 'reopen', label: `Reopen ${count} ${noun}`, icon: 'rotate-ccw', tint: '#8250df', onPress: onReopen },
    { key: 'comment', label: 'Add a comment', icon: 'message-square', tint: colors.text, onPress: onComment },
    { key: 'copy', label: 'Copy issue details', icon: 'copy', tint: colors.text, onPress: onCopy },
  ];

  return (
    <View style={styles.menuOverlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.menuBackdrop}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Dismiss actions"
          />
          <Animated.View
            entering={SlideInDown.duration(260)}
            exiting={SlideOutDown.duration(220)}
            style={[styles.menuHost, { paddingBottom: insets.bottom + Spacing.three }]}>
            <GlassSurface intensity={75} tintOpacity={0.85} style={styles.menuSheet}>
              {options.map((option) => (
                <Pressable
                  key={option.key}
                  onPress={() => {
                    option.onPress();
                    onClose();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={option.label}
                  style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}>
                  <Feather name={option.icon} size={20} color={option.tint} style={styles.menuIcon} />
                  <ThemedText style={[styles.menuLabel, { color: option.tint }]}>
                    {option.label}
                  </ThemedText>
                </Pressable>
              ))}
            </GlassSurface>
          </Animated.View>
        </>
      )}
    </View>
  );
}

/**
 * Bottom sheet of actions for the selected task-manager issues, opened from the
 * "⋯" button on a project screen. Mirrors {@link GithubSelectionMenu}. The
 * mark-done / edit / delete handlers themselves clear the selection.
 */
function TaskSelectionMenu({
  open,
  count,
  onClose,
  onMarkDone,
  onMarkNotDone,
  onEditAttrs,
  onOpenGithub,
  onDelete,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  onMarkDone: () => void;
  onMarkNotDone: () => void;
  onEditAttrs: () => void;
  /** Present only when a single GitHub-mirrored issue is selected. */
  onOpenGithub?: () => void;
  onDelete: () => void;
}) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const noun = count === 1 ? 'issue' : 'issues';

  const options: { key: string; label: string; icon: FeatherName; tint: string; onPress: () => void }[] = [
    { key: 'done', label: `Mark ${count} done`, icon: 'check-circle', tint: '#3fb950', onPress: onMarkDone },
    { key: 'notdone', label: `Mark ${count} not done`, icon: 'circle', tint: colors.text, onPress: onMarkNotDone },
    { key: 'attrs', label: `Edit attributes`, icon: 'sliders', tint: colors.text, onPress: onEditAttrs },
    ...(onOpenGithub
      ? [
          {
            key: 'github',
            label: 'Open on GitHub',
            icon: 'github' as FeatherName,
            tint: '#8250df',
            onPress: onOpenGithub,
          },
        ]
      : []),
    { key: 'delete', label: `Delete ${count} ${noun}`, icon: 'trash-2', tint: '#e5484d', onPress: onDelete },
  ];

  return (
    <View style={styles.menuOverlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.menuBackdrop}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Dismiss actions"
          />
          <Animated.View
            entering={SlideInDown.duration(260)}
            exiting={SlideOutDown.duration(220)}
            style={[styles.menuHost, { paddingBottom: insets.bottom + Spacing.three }]}>
            <GlassSurface intensity={75} tintOpacity={0.85} style={styles.menuSheet}>
              {options.map((option) => (
                <Pressable
                  key={option.key}
                  onPress={() => {
                    option.onPress();
                    onClose();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={option.label}
                  style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}>
                  <Feather name={option.icon} size={20} color={option.tint} style={styles.menuIcon} />
                  <ThemedText style={[styles.menuLabel, { color: option.tint }]}>
                    {option.label}
                  </ThemedText>
                </Pressable>
              ))}
            </GlassSurface>
          </Animated.View>
        </>
      )}
    </View>
  );
}

/**
 * Bottom sheet with a single multiline field to comment on the selected GitHub
 * issues. Opened from the GitHub actions menu's "Add a comment" row; submitting
 * posts the same body to every selected issue.
 */
function CommentSheet({
  open,
  count,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  onSubmit: (body: string) => void;
}) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const noun = count === 1 ? 'issue' : 'issues';

  // Clear the field whenever the sheet closes so it opens empty next time.
  if (!open && text) setText('');

  const submit = () => {
    const body = text.trim();
    if (!body) return;
    Keyboard.dismiss();
    onSubmit(body);
  };

  return (
    <View style={styles.menuOverlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.menuBackdrop}
            onPress={() => {
              Keyboard.dismiss();
              onClose();
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel comment"
          />
          <Animated.View
            entering={SlideInDown.duration(260)}
            exiting={SlideOutDown.duration(220)}
            style={[styles.menuHost, { paddingBottom: insets.bottom + Spacing.three }]}>
            <GlassSurface intensity={75} tintOpacity={0.9} style={styles.commentSheet}>
              <ThemedText style={styles.commentTitle}>{`Comment on ${count} ${noun}`}</ThemedText>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="Write a comment…"
                placeholderTextColor={colors.textSecondary}
                autoFocus
                multiline
                style={[
                  styles.commentInput,
                  { color: colors.text, backgroundColor: colors.backgroundElement },
                ]}
              />
              <Pressable
                onPress={submit}
                disabled={!text.trim()}
                accessibilityRole="button"
                accessibilityLabel="Post comment"
                accessibilityState={{ disabled: !text.trim() }}
                style={({ pressed }) => [
                  styles.commentCta,
                  !text.trim() && styles.commentCtaDisabled,
                  pressed && text.trim() && styles.menuRowPressed,
                ]}>
                <ThemedText style={styles.commentCtaText}>Comment</ThemedText>
              </Pressable>
            </GlassSurface>
          </Animated.View>
        </>
      )}
    </View>
  );
}

/**
 * Bottom sheet explaining how to make a repo autofix-ready. Autofix dispatches a
 * GitHub Actions agent that opens a PR, so the target repo (a note's `repo`, or
 * the server default) needs a one-time setup that can't be automated from here —
 * this lists the steps. Opened by the "?" next to the Fix action.
 */
function AutofixHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const colors = useTheme();

  const steps: { title: string; body: string }[] = [
    {
      title: 'Add the workflow',
      body: 'Copy .github/workflows/sentry-autofix.yml into the repo on its default branch.',
    },
    {
      title: 'Add repo secrets',
      body: 'ANTHROPIC_API_KEY (required). SENTRY_API_TOKEN with event:write (optional — resolves the issue on PR).',
    },
    {
      title: 'Allow PR creation',
      body: 'Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests."',
    },
    {
      title: 'Scope the server token',
      body: "The backend's GitHub token must cover this repo (Contents R/W, Pull requests R, Actions R/W).",
    },
  ];

  return (
    <View style={styles.menuOverlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.menuBackdrop}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          />
          <Animated.View
            entering={SlideInDown.duration(260)}
            exiting={SlideOutDown.duration(220)}
            // Sit lower than the other sheets — a small fixed bottom gap that
            // ignores the safe-area inset so it hugs the bottom of the screen.
            style={[styles.menuHost, { paddingBottom: Spacing.two }]}>
            <GlassSurface intensity={75} tintOpacity={0.85} style={styles.helpSheet}>
              <View style={styles.helpHeader}>
                <Feather name="zap" size={20} color="#7553FF" />
                <ThemedText type="subtitle" style={styles.helpTitle}>
                  Set up autofix for a repo
                </ThemedText>
              </View>
              <ThemedText type="small" themeColor="textSecondary" style={styles.helpIntro}>
                Fix sends the selected issues to a GitHub agent that opens a PR on the repo you set
                for the note. That repo needs a one-time setup:
              </ThemedText>
              <ScrollView
                style={styles.helpScroll}
                contentContainerStyle={styles.helpSteps}
                showsVerticalScrollIndicator={false}>
                {steps.map((step, i) => (
                  <View key={step.title} style={styles.helpStep}>
                    <View style={styles.helpStepNum}>
                      <ThemedText style={styles.helpStepNumText}>{i + 1}</ThemedText>
                    </View>
                    <View style={styles.helpStepText}>
                      <ThemedText style={[styles.helpStepTitle, { color: colors.text }]}>
                        {step.title}
                      </ThemedText>
                      <ThemedText type="small" themeColor="textSecondary" style={styles.helpStepBody}>
                        {step.body}
                      </ThemedText>
                    </View>
                  </View>
                ))}
              </ScrollView>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={({ pressed }) => [styles.helpDone, pressed && styles.menuRowPressed]}>
                <ThemedText style={styles.helpDoneText}>Got it</ThemedText>
              </Pressable>
            </GlassSurface>
          </Animated.View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
  },
  /** A centered row: [leading slot][bar][trailing slot]; equal slots keep the bar centered. */
  cluster: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  /** Top-right docked layout: the same cluster stacked vertically. */
  clusterVertical: {
    flexDirection: 'column',
  },
  sideSlot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderTopLeftRadius: Spacing.three * 2,
    borderTopRightRadius: Spacing.three,
    borderBottomLeftRadius: Spacing.three,
    borderBottomRightRadius: Spacing.three,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  createButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderTopLeftRadius: Spacing.three,
    borderTopRightRadius: Spacing.three,
    borderBottomLeftRadius: Spacing.three,
    borderBottomRightRadius: Spacing.three * 2,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  // Count pill on the Fix button's top-right, showing how many issues are selected.
  fixBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: Spacing.one,
    backgroundColor: '#7553FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fixBadgeText: {
    color: '#fff',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.two,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  // The pill fills its animated wrapper so LinearTransition can grow/shrink it.
  barFill: {
    width: '100%',
    height: '100%',
  },
  barVertical: {
    flexDirection: 'column',
    paddingHorizontal: 0,
    paddingVertical: Spacing.two,
  },
  item: {
    flex: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Long-press create menu: a backdrop with a bottom sheet, mirroring the
  // shared options sheet's glass treatment.
  menuOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  menuBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  menuHost: {
    // Cap the sheet's width and center it so it doesn't span a wide (web) window;
    // on a phone `width: '100%'` keeps it near-full-width under the cap.
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
  },
  // Popover anchored above the + button; bottom/right are set inline from the
  // measured button rect.
  menuAnchored: {
    position: 'absolute',
  },
  menuSheet: {
    overflow: 'hidden',
    borderRadius: Spacing.four,
    padding: Spacing.two,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 24,
  },
  // The comment composer sheet: same surface as menuSheet with roomier padding.
  commentSheet: {
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
  commentTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  commentInput: {
    minHeight: 96,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  commentCta: {
    backgroundColor: '#8250df',
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  commentCtaDisabled: {
    opacity: 0.4,
  },
  commentCtaText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 15,
  },
  // The anchored popover sizes to its content, so give the rows room to breathe.
  menuSheetAnchored: {
    minWidth: 220,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.three,
  },
  menuRowPressed: {
    opacity: 0.55,
  },
  menuIcon: {
    width: 24,
    textAlign: 'center',
  },
  menuLabel: {
    flex: 1,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
  },
  // A menu row that carries a trailing "?" — the tappable action fills, the help
  // button sits at the right edge.
  menuRowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  menuRowFlex: {
    flex: 1,
  },
  menuHelp: {
    padding: Spacing.two,
    marginRight: Spacing.one,
    borderRadius: Spacing.two,
  },
  // Autofix setup instructions sheet.
  helpSheet: {
    overflow: 'hidden',
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.four,
    maxHeight: '80%',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
    elevation: 24,
  },
  helpHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  helpTitle: {
    flexShrink: 1,
  },
  helpIntro: {
    lineHeight: 20,
  },
  // Shrinks (and scrolls) only when the steps don't all fit.
  helpScroll: {
    flexShrink: 1,
  },
  helpSteps: {
    gap: Spacing.four,
    paddingRight: Spacing.one,
  },
  helpStep: {
    flexDirection: 'row',
    gap: Spacing.three,
    alignItems: 'flex-start',
  },
  helpStepNum: {
    width: 24,
    height: 24,
    borderRadius: Spacing.two,
    backgroundColor: '#7553FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  helpStepNumText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 16,
  },
  helpStepText: {
    flex: 1,
    gap: Spacing.half,
  },
  helpStepTitle: {
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 20,
  },
  helpStepBody: {
    lineHeight: 19,
  },
  helpDone: {
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    backgroundColor: '#7553FF',
  },
  helpDoneText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
