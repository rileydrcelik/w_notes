import Feather from '@expo/vector-icons/Feather';
import { type Href, usePathname, useRouter } from 'expo-router';
import type { ComponentProps, RefObject } from 'react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
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
import { useNotes } from '@/store/notes-store';
import { useSidebar } from '@/store/sidebar-store';
import { useAutofixSelection } from '@/store/autofix-selection-store';

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
              Sentry issues are selected it becomes a "⋯" button that opens the
              actions menu (Fix / Dismiss / Copy). */}
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
  const { createNote, createSentryNote, createFolder, getNote } = useNotes();
  const { createCopa, createFileCopa } = useCopa();

  const onCopa = pathname === '/copa' || pathname.startsWith('/copa/');

  const onCreateNote = () => {
    onClose();
    const id = createNote(currentFolderId(pathname, getNote));
    router.push({ pathname: '/note/[id]', params: { id } });
  };

  const onCreateSentry = () => {
    onClose();
    // Default target for now; a per-note org/project picker comes later.
    const id = createSentryNote(
      { org: 'aiko-6q', project: 'w-notes-fastapi' },
      currentFolderId(pathname, getNote),
    );
    router.push({ pathname: '/sentry/[id]', params: { id } });
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

  const options: { key: string; label: string; icon: FeatherName; onPress: () => void }[] = onCopa
    ? [
        { key: 'block', label: 'New copy block', icon: 'clipboard', onPress: onCreateBlock },
        { key: 'file', label: 'Add file', icon: 'paperclip', onPress: () => void onAddFile() },
      ]
    : [
        { key: 'note', label: 'New note', icon: 'file-plus', onPress: onCreateNote },
        { key: 'folder', label: 'New folder', icon: 'folder-plus', onPress: onCreateFolder },
        { key: 'sentry', label: 'New Sentry view', icon: 'alert-triangle', onPress: onCreateSentry },
      ];

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
}: {
  count: number;
  blurTarget?: RefObject<View | null> | null;
  onPress: () => void;
  onCancel: () => void;
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
          <Feather name="more-horizontal" color="#7553FF" size={26} />
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
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  onFix: () => void;
  onDismiss: () => void;
  onCopy: () => void;
}) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const noun = count === 1 ? 'issue' : 'issues';

  const options: {
    key: string;
    label: string;
    icon: FeatherName;
    tint: string;
    onPress: () => void;
  }[] = [
    { key: 'fix', label: `Fix ${count} ${noun}`, icon: 'zap', tint: '#7553FF', onPress: onFix },
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
});
