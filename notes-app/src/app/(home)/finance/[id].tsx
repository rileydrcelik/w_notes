/**
 * A finance note: an interactive spreadsheet.
 *
 * The sheet lives in its own synced row rather than the note body (see
 * `lib/db.ts`), so it loads separately from the note and saves on its own
 * debounce. Every edit rewrites the whole document — that's the deliberate
 * trade-off behind one-row-per-sheet, and it means a bulk format across a
 * drag-selected range costs exactly one synced row.
 *
 * View vs edit mirrors an ordinary note: the grid is always interactive (as a
 * note's body always is), and what the mode changes is the chrome — touching a
 * cell reveals the formula bar's done check and the formatting toolbar, and the
 * navbar's "done" check clears the selection and puts them away again. That
 * check is driven by `active-editor`, the same bridge the rich-text editor uses.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { FinanceGrid } from '@/components/finance/finance-grid';
import { FinanceToolbar } from '@/components/finance/finance-toolbar';
import { SheetHelp } from '@/components/sheet-help';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing, hexToRgba } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { setActiveEditorDismiss } from '@/lib/active-editor';
import { db } from '@/lib/db';
import {
  applyStyle,
  clearFormatting,
  emptySheet,
  parseSheet,
  serializeSheet,
  type CellStyle,
  type Selection,
  type Sheet,
} from '@/lib/finance/sheet';
import { Sentry } from '@/lib/sentry';
import { registerSheetFlush } from '@/lib/finance/pending';
import { requestSync, subscribeSynced } from '@/lib/sync/sync-engine';
import { useEditorPrefs } from '@/store/editor-prefs-store';
import { useNotes } from '@/store/notes-store';

/** Matches the note body's debounce: long enough to batch a burst of edits. */
const SAVE_DEBOUNCE_MS = 600;

export default function FinanceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getNote, updateNote } = useNotes();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const { formattingHints } = useEditorPrefs();

  const note = getNote(id);
  const [title, setTitle] = useState(note?.title ?? '');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editing, setEditing] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Sheet | null>(null);
  // The newest sheet, readable from callbacks that fire between renders.
  const latestRef = useRef<Sheet | null>(null);

  // Load the stored document once per note. A note that has never been opened
  // has no row yet, which `parseSheet` renders as a fresh empty sheet.
  useEffect(() => {
    let cancelled = false;
    db.getFinanceSheet(id)
      .then((json) => {
        if (cancelled) return;
        const loaded = json ? parseSheet(json) : emptySheet();
        latestRef.current = loaded;
        setSheet(loaded);
      })
      .catch((e) => {
        console.warn('[finance] failed to load sheet:', e);
        if (cancelled) return;
        const blank = emptySheet();
        latestRef.current = blank;
        setSheet(blank);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const flush = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    return db
      .saveFinanceSheet(id, serializeSheet(pending))
      .then(() => requestSync())
      .catch((e) => {
        // Put the edit back rather than dropping it: clearing `pendingRef`
        // before the write settles means a rejection would otherwise lose the
        // change outright, with nothing left to retry from. Only restore if no
        // newer edit has arrived meanwhile.
        if (!pendingRef.current) pendingRef.current = pending;
        console.warn('[finance] failed to save sheet:', e);
        Sentry.captureException(e, { tags: { source: 'finance', op: 'save' } });
      });
  }, [id]);

  // Adopt a sheet that changed on another device. Without this the screen holds
  // whatever it loaded on open, and the next local edit serializes that stale
  // copy over the top of the remote one — silently reverting it. Skipped while a
  // write is pending so a sync can't clobber an edit that hasn't landed yet.
  useEffect(() => {
    const reload = () => {
      if (pendingRef.current) return;
      db.getFinanceSheet(id)
        .then((json) => {
          if (!json || pendingRef.current) return;
          const remote = parseSheet(json);
          latestRef.current = remote;
          setSheet(remote);
        })
        .catch((e) => console.warn('[finance] failed to reload sheet:', e));
    };
    return subscribeSynced(reload);
  }, [id]);

  // Flush on unmount so leaving the screen mid-debounce can't drop the last
  // edit, and expose the same flush to the CSV exporter, which reads storage
  // and would otherwise miss anything still inside the debounce window.
  useEffect(() => {
    registerSheetFlush(flush);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      flush();
      registerSheetFlush(null);
    };
  }, [flush]);

  const onChangeSheet = useCallback(
    (next: Sheet) => {
      setSheet(next);
      latestRef.current = next;
      pendingRef.current = next;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  /**
   * Applies a transform to the newest sheet, not the one this render closed
   * over. Tapping a toolbar button blurs the focused cell, which commits that
   * cell in a separate event; reading `sheet` from props here would use the
   * pre-commit copy and write the typed value straight back out.
   */
  const mutateSheet = useCallback(
    (fn: (current: Sheet) => Sheet) => {
      const current = latestRef.current;
      if (!current) return;
      const next = fn(current);
      // A transform that changed nothing shouldn't schedule a write.
      if (next === current) return;
      onChangeSheet(next);
    },
    [onChangeSheet],
  );

  const onChangeTitle = useCallback(
    (next: string) => {
      setTitle(next);
      updateNote(id, { title: next });
    },
    [id, updateNote],
  );

  const leaveEditMode = useCallback(() => {
    // Blur the open cell before anything else — that is what commits its draft,
    // via the input's `onBlur`. `editing` only gates the toolbar and this
    // button; the grid stays mounted either way, so without this the "done"
    // check tidies away the chrome and leaves the cell live with unsaved text
    // behind it. Walking back from there unmounts the input without ever firing
    // a blur, and the typing is gone. Same reason `showHelp` dismisses below.
    //
    // Web already blurs the editor on the navbar press before `onPress` runs,
    // so this is native's equivalent rather than a second dismissal.
    Keyboard.dismiss();
    setEditing(false);
    setSelection(null);
  }, []);

  // The cheatsheet is a full-screen card, and on a phone the keyboard covers
  // most of it. Dismissing also blurs the focused cell, which commits whatever
  // was being typed — the reference is for composing the *next* formula.
  const showHelp = useCallback(() => {
    Keyboard.dismiss();
    setHelpOpen(true);
  }, []);

  // Register with the navbar's "done" check while editing, so it can return this
  // screen to the read view exactly as it does for a focused text editor.
  useEffect(() => {
    if (!editing) return;
    setActiveEditorDismiss(leaveEditMode);
    return () => setActiveEditorDismiss(null);
  }, [editing, leaveEditMode]);

  const onApplyStyle = useCallback(
    (patch: CellStyle) => {
      if (!selection) return;
      mutateSheet((current) => applyStyle(current, selection, patch));
    },
    [selection, mutateSheet],
  );

  // The toolbar's eraser removes formatting only. Deleting content from a
  // formatting control would be unrecoverable — there's no undo behind it.
  const onClearFormatting = useCallback(() => {
    if (!selection) return;
    mutateSheet((current) => clearFormatting(current, selection));
  }, [selection, mutateSheet]);

  if (!note) {
    return (
      <ThemedView style={styles.centered}>
        <Stack.Screen options={{ title: 'Not found' }} />
        <ThemedText themeColor="textSecondary">This sheet could not be found.</ThemedText>
      </ThemedView>
    );
  }

  // `disableSwipes`: the grid scrolls horizontally, and a horizontal drag can
  // only mean one thing — left to both, scrolling sideways sometimes navigated
  // back or opened the drawer instead. Back stays available on the navbar.
  return (
    <SwipeBackView disableSwipes>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />

        {/* The done check rides the title row. It used to sit in a bar below,
            alongside an address chip and the selected cell's formula — a desktop
            spreadsheet's status line, which at phone width spent a whole row
            restating what the grid already shows. Folding the check up here
            gives that row back to the sheet. */}
        <View style={[styles.titleRow, { paddingTop: insets.top + Spacing.two }]}>
          <TextInput
            value={title}
            onChangeText={onChangeTitle}
            placeholder="Untitled sheet"
            placeholderTextColor={theme.textSecondary}
            style={[
              styles.title,
              { color: theme.text },
              Platform.OS === 'web' && ({ outlineStyle: 'none' } as never),
            ]}
          />
          {editing && (
            <Pressable
              onPress={leaveEditMode}
              accessibilityRole="button"
              accessibilityLabel="Done editing"
              style={({ pressed }) => [
                styles.done,
                { borderColor: hexToRgba(theme.textSecondary, 0.25) },
                pressed && styles.pressed,
              ]}>
              <Feather name="check" size={16} color={theme.text} />
            </Pressable>
          )}
        </View>

        {/* Cell inputs focus in place, so the sheet has to lift for the
            keyboard itself — Android is edge-to-edge and won't resize the
            window. Same reason note/copa wrap their editors. */}
        <KeyboardAvoidingView
          style={styles.gridHost}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.gridHost, { paddingBottom: tabBarInset }]}>
            {sheet && (
              <FinanceGrid
                sheet={sheet}
                onChange={mutateSheet}
                selection={selection}
                onSelectionChange={(next) => {
                  setSelection(next);
                  // Touching a cell is what enters edit mode, mirroring how a
                  // note becomes editable when you tap into its body.
                  if (next) setEditing(true);
                }}
              />
            )}
          </View>
        </KeyboardAvoidingView>

        {/* Positions itself against the bottom and rides the keyboard, exactly
            as the note editor's formatting toolbar does — hence no wrapper. */}
        {/* Hidden behind the cheatsheet: the card dims everything under it, and
            a formatting bar showing through the scrim read as an accident. The
            navbar stays — it's mounted above this screen, not inside it. */}
        {editing && selection && sheet && !helpOpen && (
          <FinanceToolbar
            sheet={sheet}
            selection={selection}
            onApply={onApplyStyle}
            onClear={onClearFormatting}
            onShowHelp={formattingHints ? showHelp : undefined}
          />
        )}

        {/* Last child, so the cheatsheet covers the toolbar that opened it. */}
        <SheetHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      </ThemedView>
    </SwipeBackView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.two,
  },
  title: {
    flex: 1,
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '700',
  },
  done: {
    width: 30,
    height: 30,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
  gridHost: { flex: 1, paddingLeft: Spacing.three },
});
