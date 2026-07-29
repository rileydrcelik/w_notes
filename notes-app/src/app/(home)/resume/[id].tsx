/**
 * The resume screen: a LaTeX source editor and a compiled preview of the same
 * note.
 *
 * Downloading the compiled PDF is a navbar action, not a control on this screen —
 * exporting lives in the floating bar everywhere it exists (a note in view mode
 * puts the same download icon there), so the screen registers its exporter with
 * `lib/save-action.ts` and the bar grows an icon while there's a PDF to save.
 *
 * It edits the way every other note does, and for the same reason — there is one
 * app-wide gesture for "I'm done editing". Opening a written resume shows the
 * compiled preview (its read view); tapping the preview drops into the source
 * and the floating navbar's create button becomes a "done" check; pressing that
 * check leaves the source and recompiles. No mode toggle of its own — see
 * `lib/active-editor.ts`, which the source editor registers with.
 *
 * The body is LaTeX source, persisted with the same debounce-and-adopt-remote-
 * edits rules as an ordinary note, so a resume open on two devices behaves like
 * everything else. Compiling happens on leaving the editor, not per keystroke: a
 * TeX run takes seconds and reads the whole document.
 *
 * And it happens once per version of the source, ever. The compiled PDF is kept
 * on the device against a fingerprint of the LaTeX that produced it (see
 * `lib/latex/pdf-cache.ts`), so opening a resume you haven't edited shows it
 * immediately, offline and without troubling the server.
 */
import Feather from '@expo/vector-icons/Feather';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

import { TopFade } from '@/components/edge-fade';
import { GlassSurface } from '@/components/glass-surface';
import { LatexSourceEditor } from '@/components/resume/latex-source-editor';
import { ResumePreview } from '@/components/resume/resume-preview';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useEditAction } from '@/hooks/use-edit-action';
import { useSaveAction } from '@/hooks/use-save-action';
import { useScrolled } from '@/hooks/use-scrolled';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { compileLatex, isLatexCompileSupported } from '@/lib/latex/engine';
import { readCachedPdf, writeCachedPdf } from '@/lib/latex/pdf-cache';
import { isPdfPreviewSupported } from '@/lib/latex/pdf-render';
import {
  fontSubstitutions,
  summarizeDiagnostics,
  summarizeFontSubstitutions,
} from '@/lib/latex/log';
import { detectEngine, engineLabel, resolveEngine } from '@/lib/latex/engine-choice';
import type { CompileDiagnostic, CompileStage, LatexEngine } from '@/lib/latex/types';
import {
  resumeConfigWithEngine,
  resumeEnginePreference,
  resumePdfFileName,
  STARTER_RESUME,
} from '@/lib/resume-note';
import { savePdfToDevice } from '@/lib/save-pdf';
import { noFocusOutline } from '@/lib/web-style';
import { useNotes } from '@/store/notes-store';

const ACCENT = '#c2703c';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Mode = 'edit' | 'view';

/**
 * What the preview pane is doing right now. A finished result remembers the
 * source *and the engine* it came from, because both decide what's on screen:
 * the same LaTeX under the other engine is a different document.
 */
type Compilation =
  | { state: 'idle' }
  | { state: 'running'; stage: CompileStage }
  // `warnings` are the fonts the compile silently substituted. Only a live
  // compile has them: the cache stores the PDF, not the log, so reopening a
  // resume shows no chip. That's the right trade — the moment this matters is
  // when you paste a document and first see it — but it is a trade.
  | { state: 'ok'; pdf: Uint8Array; source: string; engine: LatexEngine; warnings: string[] }
  | {
      state: 'failed';
      diagnostics: CompileDiagnostic[];
      log: string;
      source: string;
      engine: LatexEngine;
    };

export default function ResumeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getNote, updateNote, deleteNote } = useNotes();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();

  const note = getNote(id);
  const [title, setTitle] = useState(note?.title ?? '');
  const [source, setSource] = useState(note?.body ?? '');
  // A written resume opens in its read view (the preview), a blank one in the
  // editor — same as opening a note that has body text versus a new empty one.
  const [mode, setMode] = useState<Mode>((note?.body ?? '').trim() ? 'view' : 'edit');
  const [compilation, setCompilation] = useState<Compilation>({ state: 'idle' });
  const [editing, setEditing] = useState(false);
  const [enginePickerOpen, setEnginePickerOpen] = useState(false);
  // The source and the preview scroll independently, so each tracks its own
  // position; the fade belongs to whichever one is on screen.
  const editorScroll = useScrolled();
  const previewScroll = useScrolled();
  const sourceRef = useRef<TextInput>(null);

  // Compiling happens on the server, so it works everywhere the API does.
  // Drawing the PDF is still web-only, so native can compile and download a
  // resume but not preview it yet.
  const supported = isLatexCompileSupported() && isPdfPreviewSupported();

  // Mirrors note/[id].tsx: `edited` gates every commit so a remote change landing
  // in an open resume can't be overwritten by our stale copy, and `committed`
  // tells an uncommitted local edit apart from one that arrived from sync.
  const editedRef = useRef(false);
  const committedRef = useRef({ title: note?.title ?? '', body: note?.body ?? '' });

  const onChangeTitle = (t: string) => {
    editedRef.current = true;
    setTitle(t);
  };
  const onChangeSource = (text: string) => {
    editedRef.current = true;
    setSource(text);
  };

  const snapshot = useRef({ id, title, source, stored: note, updateNote, deleteNote });
  useEffect(() => {
    snapshot.current = { id, title, source, stored: note, updateNote, deleteNote };
  });

  // Seed from storage when navigating to a different resume.
  useEffect(() => {
    const current = snapshot.current.stored;
    if (current) {
      setTitle(current.title);
      setSource(current.body);
      committedRef.current = { title: current.title, body: current.body };
    }
    editedRef.current = false;
    setCompilation({ state: 'idle' });
    setMode((current?.body ?? '').trim() ? 'view' : 'edit');
  }, [id]);

  // Adopt an edit made on another device, unless we're mid-edit ourselves.
  const storedTitle = note?.title;
  const storedBody = note?.body;
  useEffect(() => {
    if (storedTitle === undefined || storedBody === undefined) return;
    if (editing) return;
    const committed = committedRef.current;
    if (title !== committed.title || source !== committed.body) return;
    if (storedTitle === title && storedBody === source) return;
    committedRef.current = { title: storedTitle, body: storedBody };
    // Same reasoning as note/[id].tsx: sync's own event fires before the store
    // finishes reloading, so the store value is the only trustworthy signal.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- adopt remote edit
    setTitle(storedTitle);
    setSource(storedBody);
  }, [storedTitle, storedBody, editing, title, source]);

  // Debounced commit, driven only by our own edits.
  useEffect(() => {
    if (!editedRef.current) return;
    const timer = setTimeout(() => {
      const stored = snapshot.current.stored;
      committedRef.current = { title, body: source };
      if (stored && stored.title === title && stored.body === source) return;
      updateNote(id, { title, body: source });
    }, 350);
    return () => clearTimeout(timer);
  }, [title, source, id, updateNote]);

  // On leaving: discard a resume that was never written in, otherwise flush.
  useEffect(
    () => () => {
      const { id: sid, title: st, source: ss, stored, updateNote: update, deleteNote: remove } =
        snapshot.current;
      if (!stored) return;
      if (st.trim().length === 0 && ss.trim().length === 0) {
        remove(sid);
        return;
      }
      if (!editedRef.current) return;
      if (stored.title !== st || stored.body !== ss) update(sid, { title: st, body: ss });
    },
    [],
  );

  // Which engine this resume compiles with: its own choice, or the one its
  // source implies. Overleaf makes the author pick; we only ask when the guess
  // would be wrong. See `lib/latex/engine-choice.ts`.
  const preference = note ? resumeEnginePreference(note) : null;
  const engine = resolveEngine(source, preference);

  // A result produced by the *other* engine is not a result for this one: the
  // same LaTeX renders differently under each, which is the whole point of
  // offering both. Derived rather than reset in an effect, so switching engine
  // takes effect in the same render instead of flashing the stale document —
  // everything below reads `shown`, and only the load effect sees `idle` and
  // goes to fetch the new pairing. A remote change to the choice lands here too.
  const shown: Compilation = useMemo(
    () =>
      (compilation.state === 'ok' || compilation.state === 'failed') &&
      (compilation.engine !== engine || compilation.source !== source)
        ? { state: 'idle' }
        : compilation,
    // Memoised so the fresh `idle` object on a mismatch doesn't re-key the
    // callbacks that depend on it every render.
    [compilation, engine, source],
  );

  // What the screen is asking for right now, readable from inside an async
  // compile that started some seconds ago. A result is worth applying when it
  // answers the *current* question — not when the effect that asked it happens
  // to still be alive, which it never is: setting `running` re-runs that effect
  // immediately.
  const wanted = useRef({ id, engine, source });
  useEffect(() => {
    wanted.current = { id, engine, source };
  });
  const isCurrent = useCallback(
    (forId: string, forEngine: LatexEngine, forSource: string) =>
      wanted.current.id === forId &&
      wanted.current.engine === forEngine &&
      wanted.current.source === forSource,
    [],
  );

  // Runs TeX, unconditionally. A success is cached against the source *and the
  // engine* that produced it, so this is the only place a resume costs a compile.
  const runCompile = useCallback(
    // `shouldApply` drops a result the screen has moved on from — another
    // resume, another source, another engine. It must be about *what was
    // asked for*, never about "the effect that started me has re-run": that
    // effect re-runs the instant this sets `running`, so an effect-lifetime
    // flag cancels the very compile it just started and the preview spins for
    // ever. See `isCurrent` below.
    async (text: string, shouldApply: () => boolean = () => true) => {
      if (text.trim().length === 0) {
        setCompilation({ state: 'idle' });
        return;
      }
      setCompilation({ state: 'running', stage: 'starting' });
      const result = await compileLatex(text, {
        engine,
        onProgress: (stage) => setCompilation((prev) =>
          prev.state === 'running' ? { state: 'running', stage } : prev,
        ),
      });
      // Cached even when superseded: the PDF is a correct result for this
      // (resume, engine, source), so whoever asks for that pairing next gets it
      // for free rather than paying for TeX again.
      if (result.ok) void writeCachedPdf(id, engine, text, result.pdf);
      if (!shouldApply()) {
        // Drop the answer, but hand the screen back to `idle` so the effect can
        // go and get the one it now wants. Leaving it `running` is a preview
        // that loads for ever with nothing on the way.
        setCompilation({ state: 'idle' });
        return;
      }
      setCompilation(
        result.ok
          ? {
              state: 'ok',
              pdf: result.pdf,
              source: text,
              engine,
              warnings: fontSubstitutions(result.log),
            }
          : {
              state: 'failed',
              diagnostics: result.diagnostics,
              log: result.log,
              source: text,
              engine,
            },
      );
    },
    [id, engine],
  );

  // The one path from "the read view has no result" to "here is the PDF", and
  // the only thing that ever reaches for the cache. `idle` means exactly that —
  // no result yet — so this fires once per source and stands down the moment it
  // sets one. A resume you haven't edited is a cache hit and never compiles;
  // one you edited and undid back is a hit too, since the key is the source.
  useEffect(() => {
    if (!supported || mode !== 'view' || shown.state !== 'idle') return;
    if (source.trim().length === 0) return;
    void (async () => {
      const cached = await readCachedPdf(id, engine, source);
      if (!isCurrent(id, engine, source)) return;
      if (cached) {
        setCompilation({ state: 'ok', pdf: cached, source, engine, warnings: [] });
        return;
      }
      await runCompile(source, () => isCurrent(id, engine, source));
    })();
  }, [supported, mode, shown.state, source, id, engine, isCurrent, runCompile]);

  // Leaving the editor just leaves it. Whether the result on screen is still
  // the right one is `shown`'s question, not this one's: it reads as `idle` the
  // moment the source or engine moves on, and the effect above takes it from
  // there. Two places deciding that was how a remotely-edited resume kept
  // showing its old PDF.
  const showPreview = useCallback(() => {
    setEditing(false);
    setMode('view');
  }, []);

  // Tapping the preview drops into the source, the way tapping a note's body
  // puts a caret in it.
  const editSource = () => {
    setMode('edit');
    // The editor mounts with this render, so focus on the next tick.
    setTimeout(() => sourceRef.current?.focus(), 0);
  };

  // A resume holds nothing, so the navbar's (+) is a pencil here that opens the
  // source — the same thing tapping the preview does. It becomes the "done"
  // check once the editor has focus.
  useEditAction(editSource);

  const pdf = shown.state === 'ok' ? shown.pdf : null;

  // Exporting is a navbar action, like saving a note to the device — the same
  // download icon, in the same place. It appears once there's a compiled PDF to
  // save and disappears while the source is being edited; see `lib/save-action.ts`.
  useSaveAction(
    pdf
      ? {
          label: 'Download resume PDF',
          run: () => void savePdfToDevice(resumePdfFileName({ title }), pdf),
        }
      : null,
  );

  if (!note) {
    return (
      <ThemedView style={styles.empty}>
        <Stack.Screen options={{ title: 'Not found' }} />
        <ThemedText themeColor="textSecondary">This resume could not be found.</ThemedText>
      </ThemedView>
    );
  }

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <KeyboardAvoidingView
          style={styles.container}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.header, { paddingTop: insets.top + Spacing.four }]}>
            <View style={styles.titleRow}>
              <Feather name="file-text" size={22} color={ACCENT} />
              <TextInput
                value={title}
                onChangeText={onChangeTitle}
                placeholder="Untitled resume"
                placeholderTextColor={theme.textSecondary}
                style={[styles.title, noFocusOutline, { color: theme.text }]}
              />
              {/* Secondary action, so the app's 40px squircle icon button —
                  same control as `components/scroll-to-top.tsx`. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Compiler: ${engineLabel(engine)}`}
                onPress={() => setEnginePickerOpen(true)}
                style={({ pressed }) => [
                  styles.iconButton,
                  { backgroundColor: theme.backgroundElement },
                  pressed && styles.pressed,
                ]}>
                <Feather name="sliders" size={18} color={theme.textSecondary} />
              </Pressable>
            </View>
          </View>

          {mode === 'edit' ? (
            <View style={styles.editor}>
              <LatexSourceEditor
                value={source}
                onChangeText={onChangeSource}
                inputRef={sourceRef}
                onScroll={editorScroll.scrollProps.onScroll}
                onFocusChange={(focused) => {
                  setEditing(focused);
                  // Losing focus ends the edit — see LatexSourceEditor. On web
                  // the navbar's check blurs the field before its own onPress
                  // runs, so the blur, not the press, is the reliable signal.
                  if (!focused) showPreview();
                }}
              />
              {source.length === 0 && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onChangeSource(STARTER_RESUME)}
                  style={({ pressed }) => [
                    styles.starterButton,
                    { backgroundColor: theme.backgroundElement },
                    pressed && styles.pressed,
                  ]}>
                  <Feather name="file-plus" size={15} color={theme.textSecondary} />
                  <ThemedText type="small" themeColor="textSecondary">
                    Start from a template
                  </ThemedText>
                </Pressable>
              )}
              <TopFade visible={editorScroll.scrolled} />
            </View>
          ) : (
            <View style={styles.previewWrap}>
              <ScrollView
                {...previewScroll.scrollProps}
                contentContainerStyle={[styles.previewContent, { paddingBottom: tabBarInset }]}
                showsVerticalScrollIndicator={false}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Edit LaTeX source"
                  onPress={editSource}>
                  <PreviewPane
                    compilation={shown}
                    supported={supported}
                    hasSource={source.trim().length > 0}
                    onRetry={() => void runCompile(source)}
                  />
                </Pressable>
              </ScrollView>
              <TopFade visible={previewScroll.scrolled} />
            </View>
          )}
        </KeyboardAvoidingView>
        <EnginePicker
          open={enginePickerOpen}
          preference={preference}
          detected={detectEngine(source)}
          onClose={() => setEnginePickerOpen(false)}
          onChoose={(choice) => {
            setEnginePickerOpen(false);
            editedRef.current = true;
            updateNote(id, { pluginConfig: resumeConfigWithEngine(note, choice) });
          }}
        />
      </ThemedView>
    </SwipeBackView>
  );
}

/**
 * Which engine compiles this resume. A sheet rather than a segmented control:
 * the app has one shape for "pick one of these" and this is it (see the
 * selection menus in `floating-tab-bar.tsx`).
 *
 * "Automatic" is first and is the answer for nearly every document — it reads
 * the source, and the only thing it decides is whether fontspec is in play. The
 * two explicit choices exist for the document that needs the other one anyway,
 * which is the situation Overleaf's compiler dropdown exists for.
 */
function EnginePicker({
  open,
  preference,
  detected,
  onClose,
  onChoose,
}: {
  open: boolean;
  preference: LatexEngine | null;
  detected: LatexEngine;
  onClose: () => void;
  onChoose: (choice: LatexEngine | null) => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const options: { key: string; label: string; detail: string; value: LatexEngine | null }[] = [
    {
      key: 'auto',
      label: 'Automatic',
      detail: `Reads the source — currently ${engineLabel(detected)}`,
      value: null,
    },
    {
      key: 'pdflatex',
      label: 'pdfLaTeX',
      detail: "Overleaf's default, and what most templates expect",
      value: 'pdflatex',
    },
    {
      key: 'xelatex',
      label: 'XeLaTeX',
      detail: 'Needed for fontspec and system fonts',
      value: 'xelatex',
    },
  ];

  return (
    <View style={styles.sheetOverlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.sheetBackdrop}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          />
          <Animated.View
            entering={SlideInDown.duration(260)}
            exiting={SlideOutDown.duration(220)}
            style={[styles.sheetHost, { paddingBottom: insets.bottom + Spacing.three }]}>
            <GlassSurface intensity={75} tintOpacity={0.85} style={styles.sheet}>
              <ThemedText type="smallBold" style={styles.sheetTitle}>
                Compile with
              </ThemedText>
              {options.map((option) => {
                const selected = preference === option.value;
                return (
                  <Pressable
                    key={option.key}
                    accessibilityRole="button"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected }}
                    onPress={() => onChoose(option.value)}
                    style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}>
                    <View style={styles.sheetRowText}>
                      <ThemedText style={{ color: selected ? ACCENT : theme.text }}>
                        {option.label}
                      </ThemedText>
                      <ThemedText type="small" themeColor="textSecondary">
                        {option.detail}
                      </ThemedText>
                    </View>
                    {selected && <Feather name="check" size={18} color={ACCENT} />}
                  </Pressable>
                );
              })}
            </GlassSurface>
          </Animated.View>
        </>
      )}
    </View>
  );
}

function PreviewPane({
  compilation,
  supported,
  hasSource,
  onRetry,
}: {
  compilation: Compilation;
  supported: boolean;
  hasSource: boolean;
  onRetry: () => void;
}) {
  const theme = useTheme();

  if (!supported) {
    return (
      <ThemedText type="small" themeColor="textSecondary" style={styles.state}>
        Compiling a resume is available on the web app for now. The LaTeX source syncs, so a resume
        written here previews and exports there.
      </ThemedText>
    );
  }

  if (!hasSource) {
    return (
      <ThemedText type="small" themeColor="textSecondary" style={styles.state}>
        Nothing to preview yet — paste or write some LaTeX in the editor.
      </ThemedText>
    );
  }

  if (compilation.state === 'running' || compilation.state === 'idle') {
    return (
      <View style={styles.state}>
        <ActivityIndicator color={theme.textSecondary} />
        <ThemedText type="small" themeColor="textSecondary">
          {compilation.state === 'running' && compilation.stage === 'loading'
            ? 'Loading TeX…'
            : 'Compiling…'}
        </ThemedText>
      </View>
    );
  }

  if (compilation.state === 'failed') {
    return (
      <View style={[styles.errorPanel, { backgroundColor: theme.backgroundElement }]}>
        <View style={styles.errorHeader}>
          <Feather name="alert-circle" size={16} color={ACCENT} />
          <ThemedText type="smallBold">This resume didn’t compile</ThemedText>
        </View>
        <ThemedText type="small" themeColor="textSecondary">
          {summarizeDiagnostics(compilation.diagnostics)}
        </ThemedText>
        {compilation.diagnostics.slice(1, 4).map((d, i) => (
          <ThemedText key={i} type="small" themeColor="textSecondary">
            {d.line === undefined ? d.message : `Line ${d.line}: ${d.message}`}
          </ThemedText>
        ))}
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={({ pressed }) => [
            styles.retryButton,
            { backgroundColor: theme.backgroundSelected },
            pressed && styles.pressed,
          ]}>
          <Feather name="refresh-cw" size={14} color={theme.text} />
          <ThemedText type="small">Try again</ThemedText>
        </Pressable>
      </View>
    );
  }

  return (
    <>
      {compilation.warnings.length > 0 && (
        <View style={[styles.noticePanel, { backgroundColor: theme.backgroundElement }]}>
          <Feather name="type" size={15} color={ACCENT} />
          <ThemedText type="small" themeColor="textSecondary" style={styles.noticeText}>
            {summarizeFontSubstitutions(compilation.warnings)} Try the other compiler, or name a
            font the server has.
          </ThemedText>
        </View>
      )}
      <ResumePreview pdf={compilation.pdf} />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  // Matches ThemedText's `subtitle`, which the sentry/github screens use for
  // their headers — this one is a TextInput, so it can't use ThemedText itself.
  title: {
    flex: 1,
    fontSize: 32,
    lineHeight: 44,
    fontWeight: '600',
  },
  // 40px with a Spacing.three radius, matching the scroll-to-top button — the
  // app's established size for a secondary icon affordance.
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
  // The engine picker, matching the app's other option sheets.
  sheetOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  sheetBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheetHost: {
    paddingHorizontal: Spacing.three,
  },
  sheet: {
    borderRadius: Spacing.four,
    paddingVertical: Spacing.two,
  },
  sheetTitle: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.one,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  sheetRowText: {
    flex: 1,
    gap: 2,
  },
  editor: {
    flex: 1,
  },
  // Holds the scroller and the fade that sits over its top edge.
  previewWrap: {
    flex: 1,
  },
  starterButton: {
    position: 'absolute',
    left: Spacing.three,
    top: Spacing.six,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
  },
  previewContent: {
    paddingHorizontal: Spacing.three,
    // The page's shadow reaches ~16px above its top edge (radius 24 against an
    // 8px downward offset), so at the old 8px it started off-screen and sat in
    // the strongest part of the top fade — the sheet read as clipped rather
    // than lifted. This gives the shadow room of its own.
    paddingTop: Spacing.five,
    gap: Spacing.three,
  },
  state: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.five,
    textAlign: 'center',
  },
  errorPanel: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  // A compile that worked but didn't get the fonts it asked for. Quieter than
  // the error panel — the document is fine, it just isn't what its author saw.
  noticePanel: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    marginBottom: Spacing.two,
  },
  noticeText: {
    flex: 1,
  },
  errorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    marginTop: Spacing.one,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
  },
});
