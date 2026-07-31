/**
 * The resume screen: a LaTeX source editor and a compiled preview of the same
 * note.
 *
 * Downloading the compiled PDF is a navbar action, not a control on this screen —
 * exporting lives in the floating bar everywhere it exists (a note in view mode
 * puts the same download icon there), so the screen registers its exporter with
 * `lib/save-action.ts` and the bar grows an icon while there's a PDF to save.
 *
 * On a phone, and in a narrow or portrait browser window, it edits the way every
 * other note does: opening a written resume shows the compiled preview (its read
 * view), and tapping the preview drops into the source. No mode toggle of its
 * own — see `lib/active-editor.ts`, which the source editor registers with.
 *
 * The navbar's trailing button on this screen is the **version history**, and it
 * stays that whether or not the source has focus. It is not a create button
 * (a resume contains nothing), not an edit pencil (tapping the preview already
 * starts an edit), and not a "done" check — see below.
 *
 * **In a wide landscape browser window the two stop taking turns and sit side by
 * side** (`lib/split-layout.ts`): source on the left, compiled pages on the
 * right. A LaTeX resume is the one document in this app whose source and output
 * are genuinely different documents — you write `\item` and what you want to
 * know is where the line lands on the page — and showing them one at a time was
 * costing a round trip through the read view to answer that. This is not a mode
 * toggle and there is no control for it: it's the same screen laid out for the
 * room it has, so it appears and disappears with the window.
 *
 * Two of this screen's rules were built on the mode boundary that split removes,
 * so split states them directly instead:
 *
 * - **Compiling.** Stacked, it happens on leaving the editor. Split, there is no
 *   leaving, so it happens when you ask: the toolbar's recompile button. Not a
 *   debounce — a TeX run is seconds of server time over the whole document, and
 *   a pause for thought is not a request to spend one. The preview keeps the
 *   last PDF and dims it while the source is ahead of it.
 * - **The toolbar, the export icon, and the navbar's trailing button**, which
 *   stacked appear, disappear, or turn into a "done" check as editor focus moves.
 *   Split, the source is permanently on screen and there is no read view to
 *   return to, so the check has nothing to do: all three are simply always
 *   there, and nothing flickers as you click between the panes.
 *
 * The body is LaTeX source, persisted with the same debounce-and-adopt-remote-
 * edits rules as an ordinary note, so a resume open on two devices behaves like
 * everything else.
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
import {
  ResumeEntryModal,
  type EntrySheetMode,
} from '@/components/resume/resume-entry-modal';
import { ResumePreview } from '@/components/resume/resume-preview';
import {
  RESUME_TOOLBAR_CLEARANCE,
  ResumeToolbar,
} from '@/components/resume/resume-toolbar';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ResumeTailorModal } from '@/components/resume/resume-tailor-modal';
import { VersionList } from '@/components/resume/version-list';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useResumeVersions } from '@/hooks/use-resume-versions';
import { useSaveAction } from '@/hooks/use-save-action';
import { useVersionAction } from '@/hooks/use-version-action';
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
import {
  draftResumeEntry,
  requestEntryEdit,
  type ResumeEditDraft,
  type ResumeEntryDraft,
} from '@/lib/latex/entry';
import {
  insertResumeEntry,
  replaceResumeEntry,
  resumeSectionNames,
} from '@/lib/latex/sections';
import type { CompileDiagnostic, CompileStage, LatexEngine } from '@/lib/latex/types';
import {
  resumeConfigWithEngine,
  resumeConfigWithVersion,
  resumeCurrentVersionId,
  resumeEnginePreference,
  resumePdfFileName,
  STARTER_RESUME,
} from '@/lib/resume-note';
import { describeTailorTarget, originalLabel } from '@/lib/resume-versions';
import { tailorResume, type TailorDraft } from '@/lib/latex/tailor';
import type { ResumeVersion } from '@/data/notes';
import { savePdfToDevice } from '@/lib/save-pdf';
import { useSplitLayout } from '@/lib/split-layout';
import { noFocusOutline } from '@/lib/web-style';
import { ACCENT } from '@/components/resume/accent';
import { SHEET_MAX_WIDTH } from '@/components/resume/sheet';
import { useNotes } from '@/store/notes-store';

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
  // Side by side, or one at a time. Recomputed from the window, so dragging a
  // browser window across the threshold moves between the two layouts live.
  const split = useSplitLayout();

  const note = getNote(id);
  // This resume's history, and the one way to add to it. Reloads after a sync, so
  // a change made on another device shows up here without revisiting the screen.
  const {
    versions,
    append: appendVersion,
    update: updateVersion,
    remove: removeVersion,
    isEmpty,
  } = useResumeVersions(id);
  const [title, setTitle] = useState(note?.title ?? '');
  const [source, setSource] = useState(note?.body ?? '');
  // A written resume opens in its read view (the preview), a blank one in the
  // editor — same as opening a note that has body text versus a new empty one.
  const [mode, setMode] = useState<Mode>((note?.body ?? '').trim() ? 'view' : 'edit');
  const [compilation, setCompilation] = useState<Compilation>({ state: 'idle' });
  const [editing, setEditing] = useState(false);
  const [enginePickerOpen, setEnginePickerOpen] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [tailorOpen, setTailorOpen] = useState(false);
  // Something the screen needs to say that isn't an error state of the preview:
  // a restore that couldn't protect the document it was replacing, or a tailored
  // resume that came out longer than the one page it was asked for. Shown rather
  // than swallowed — in both cases silence would read as "it worked".
  const [notice, setNotice] = useState<string | null>(null);
  // Which job the entry sheet is doing. Kept beside `entryOpen` rather than
  // folded into it so closing the sheet doesn't also reset what it was, which
  // would flip the header's wording during the close animation.
  const [entryMode, setEntryMode] = useState<EntrySheetMode>('add');
  // The toolbar's own sheets steal focus from the source field, and a blur is
  // what normally ends an edit and returns the screen to the preview. Opening
  // one of them is still editing, so the blur it causes is ignored and focus is
  // handed back on close — otherwise tapping "Add entry" would drop you out of
  // the editor and leave the toolbar you just used nowhere to be seen.
  const holdEditorRef = useRef(false);
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

  // Which version of its history this resume is currently being edited as. Kept
  // on the note (`pluginConfig`), so it survives a reload and travels with the
  // resume rather than living only in this screen's state.
  const currentVersionId = note ? resumeCurrentVersionId(note) : null;
  const setCurrentVersion = useCallback(
    (versionId: string | null) => {
      const current = snapshot.current.stored;
      if (!current) return;
      snapshot.current.updateNote(current.id, {
        pluginConfig: resumeConfigWithVersion(current, versionId),
      });
    },
    [],
  );

  // Read by the debounced commit. Through refs so that changing version — or the
  // hook handing back a new callback — doesn't re-arm the timer and delay the
  // save someone is waiting on.
  const versionRef = useRef<string | null>(null);
  const updateVersionRef = useRef(updateVersion);
  useEffect(() => {
    versionRef.current = currentVersionId;
    updateVersionRef.current = updateVersion;
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
  //
  // The version you are on is committed with the note, on the same timer. A
  // version is the document you are working *in* rather than a photograph of one,
  // so hand-typing belongs to it: switch to another version and back and your
  // edits are where you left them, and leaving a version never quietly discards
  // what you had done to it. Only the source moves — the label says what the
  // version *is*, and that stays true however much you refine it.
  useEffect(() => {
    if (!editedRef.current) return;
    const timer = setTimeout(() => {
      const stored = snapshot.current.stored;
      committedRef.current = { title, body: source };
      if (stored && stored.title === title && stored.body === source) return;
      updateNote(id, { title, body: source });
      if (versionRef.current) void updateVersionRef.current(versionRef.current, source);
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

  // What the preview should actually show. Derived rather than reset in an
  // effect, so a change takes effect in the same render instead of flashing the
  // old document — everything below reads `shown`, and only the load effect sees
  // `idle` and goes to fetch a new result. A remote edit lands here too.
  const shown: Compilation = useMemo(() => {
    if (compilation.state !== 'ok' && compilation.state !== 'failed') return compilation;
    // A result produced by the *other* engine is not a result for this one: the
    // same LaTeX renders differently under each, which is the whole point of
    // offering both. Picking an engine is also an explicit "compile it this
    // way", so it blanks the result in either layout and recompiles.
    if (compilation.engine !== engine) return { state: 'idle' };
    // A source change is different, and the two layouts want opposite things
    // from it. Stacked, you are looking at the preview *or* the source, so a
    // result for text you can no longer see is worthless — blank it, and the
    // effect below fetches the current one. Split, the preview is permanently on
    // screen with the source beside it, and blanking it would replace the page
    // you're working against with a spinner on every keystroke. So the last PDF
    // stays put and `stale` below says it's behind.
    if (compilation.source !== source && !split) return { state: 'idle' };
    return compilation;
    // Memoised so the fresh `idle` object on a mismatch doesn't re-key the
    // callbacks that depend on it every render.
  }, [compilation, engine, source, split]);

  // The page on screen was made from text that has since changed. Only ever true
  // in the split layout — stacked, `shown` has already gone `idle` instead — and
  // it is the whole signal that a manual recompile exists to answer: the toolbar
  // button takes the accent and the preview dims.
  const stale =
    (shown.state === 'ok' || shown.state === 'failed') && shown.source !== source;

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
  //
  // Split changes only *when this is allowed to run*, not what it does. Stacked,
  // it waits for the read view, because the source pane has no preview to fill.
  // Split, the preview is always there, so it runs whenever there's no result —
  // opening a resume, switching engine, or pasting into a blank one. It cannot
  // become compile-as-you-type: the first thing it does is set `running`, and
  // the second keystroke's run sees a state that isn't `idle` and stands down.
  useEffect(() => {
    if (!supported || (!split && mode !== 'view') || shown.state !== 'idle') return;
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
  }, [supported, split, mode, shown.state, source, id, engine, isCurrent, runCompile]);

  // Leaving the editor just leaves it. Whether the result on screen is still
  // the right one is `shown`'s question, not this one's: it reads as `idle` the
  // moment the source or engine moves on, and the effect above takes it from
  // there. Two places deciding that was how a remotely-edited resume kept
  // showing its old PDF.
  //
  // Split, this changes nothing visible — both panes are up either way — but
  // `mode` is still what the screen would fall back to if the window narrowed
  // past the threshold mid-edit, so it stays honest.
  const showPreview = useCallback(() => {
    setEditing(false);
    setMode('view');
  }, []);

  // Tapping the preview drops into the source, the way tapping a note's body
  // puts a caret in it. Split, the source is already on screen, so this is just
  // "put the caret over there" — which is why the split preview isn't wrapped in
  // a Pressable: clicking the page there should select text or scroll it, not
  // yank focus to the other pane.
  const editSource = () => {
    setMode('edit');
    // The editor mounts with this render, so focus on the next tick.
    setTimeout(() => sourceRef.current?.focus(), 0);
  };

  // Opening a sheet from the toolbar, and closing one. The screen stays in edit
  // mode throughout, and the caret goes back where it was.
  const openOverEditor = (setOpen: (value: boolean) => void) => {
    holdEditorRef.current = true;
    setOpen(true);
  };
  const closeOverEditor = (setOpen: (value: boolean) => void) => {
    setOpen(false);
    holdEditorRef.current = false;
    setTimeout(() => sourceRef.current?.focus(), 0);
  };

  // A resume holds nothing, so the navbar's trailing button isn't a (+) here —
  // and it isn't a pencil either. This screen is *already editing*: it opens
  // straight into the source when the resume is empty, and side by side the
  // source is permanently on screen beside the page. A pencil offers to start
  // something that has already started. The history is the one thing about a
  // resume this screen can't otherwise show you, so it takes the slot. See
  // `lib/version-action.ts`, and the leaf-object rule in `.claude/CLAUDE.md`
  // that this is the written exception to.
  //
  // `keepWhileEditing` is the narrower claim, and only split can make it: there
  // the history stays put through focus because the "done" check has no read
  // view to return to. Stacked, an existing resume opens in `view` like any
  // other document, so the check is meaningful and the button yields to it.
  useVersionAction(
    () => {
      // One sheet at a time, matching the toolbar's own buttons: two stacked
      // sheets would leave the one underneath unreachable.
      setEntryOpen(false);
      setEnginePickerOpen(false);
      openOverEditor(setVersionsOpen);
    },
    { keepWhileEditing: split },
  );

  // The sections this resume already has, for the adder's category chips.
  const sections = useMemo(() => resumeSectionNames(source), [source]);

  /**
   * Record a change in the resume's history.
   *
   * Two snapshots on the first change ever, one on every change after. The first
   * is "the original": the document as it stood before any of this, labelled with
   * the resume's title. It has to be written *here*, on the first mutation, and
   * not when the resume was created — most resumes are pasted in whole and never
   * touched by the adder, so pre-writing a row for every one of them would store
   * a copy of every resume in the app for nothing. And it cannot be written
   * later: once the first change lands, the pre-change text exists nowhere.
   *
   * `createdAt` is passed explicitly on the pair so the original sorts before the
   * change that prompted it. Both are written in the same millisecond otherwise,
   * and the list would be free to show them either way round.
   *
   * Fire-and-forget, unlike `restoreVersion` below. If this write fails the
   * person loses a line of history, which is a real cost but a recoverable one —
   * the document itself is exactly what they asked for. Restoring is the opposite
   * shape and is treated as such.
   */
  /**
   * Start a new version for a change that just happened, and move onto it.
   *
   * One version per action, and exactly one for the original. The original is
   * written here, on the first action a resume ever has, because that is the last
   * moment the pre-change text exists — and only here, so a resume accumulates one
   * "before you started" entry rather than one per action.
   *
   * The original write is **awaited** and a failure abandons the change: it is the
   * only copy of the untouched document, which the debounced commit below is about
   * to overwrite. The new version is awaited too, for a plainer reason — its id is
   * what the screen becomes "on", and without it the typing that follows would go
   * on updating the version this change just superseded.
   */
  const recordChange = async (
    before: string,
    after: string,
    label: string,
  ): Promise<string | null> => {
    const now = Date.now();
    if (isEmpty()) {
      const original = await appendVersion(originalLabel({ title }), before, now - 1);
      if (!original) {
        setNotice(
          "This couldn't be applied, because the resume as it stands now couldn't be saved to your history first. Nothing has changed — try again.",
        );
        return null;
      }
    }
    const created = await appendVersion(label, after, now);
    if (created) setCurrentVersion(created);
    return created;
  };

  const applyEntry = async (
    section: string,
    latex: string,
    label: string,
  ): Promise<string | null> => {
    const after = insertResumeEntry(source, section, latex);
    // The computed value, not the `source` state variable — `onChangeSource` only
    // schedules the update, so reading state back here would snapshot the
    // document as it was before the insert.
    if (!(await recordChange(source, after, label))) {
      return "This couldn't be saved to your version history, so it hasn't been applied. Nothing has changed — try again.";
    }
    onChangeSource(after);
    return null;
  };

  const requestEntry = async (draft: ResumeEntryDraft) => {
    const result = await draftResumeEntry(source, draft);
    return result.ok
      ? ({ ok: true, latex: result.entry.latex, summary: result.entry.summary } as const)
      : ({ ok: false, message: result.message } as const);
  };

  const requestEdit = async (draft: ResumeEditDraft) => {
    const result = await requestEntryEdit(source, draft, engine);
    return result.ok
      ? ({
          ok: true,
          scope: result.edit.scope,
          oldLatex: result.edit.oldLatex,
          newLatex: result.edit.newLatex,
          summary: result.edit.summary,
        } as const)
      : ({ ok: false, message: result.message } as const);
  };

  /**
   * Aim the whole resume at one job.
   *
   * Returns the tailored document rather than applying it: the sheet shows a diff
   * of what tailoring did — which entries it promoted off the bench and which it
   * commented out — and applying is a separate decision made against that. This
   * is the one action whose result is a whole new document, and a diff is the only
   * form in which that is actually reviewable.
   */
  const runTailor = async (draft: TailorDraft) => {
    const result = await tailorResume(source, draft, engine);
    if (!result.ok) return { ok: false as const, message: result.message };
    return {
      ok: true as const,
      latex: result.resume.latex,
      // What it is diffed against: the document as it stood when Tailor was
      // pressed, so the diff describes *this* run rather than accumulated drift.
      before: source,
      pages: result.resume.pages,
      label: describeTailorTarget(draft),
    };
  };

  /** Apply a tailored resume the person has just looked at. */
  const applyTailored = async (latex: string, label: string): Promise<string | null> => {
    if (!(await recordChange(source, latex, label))) {
      return "The tailored resume couldn't be saved to your version history, so it hasn't been applied. Nothing has changed.";
    }
    onChangeSource(latex);
    return null;
  };

  /**
   * Go back to an earlier version.
   *
   * A switch, not a copy. Nothing new is written and nothing is snapshotted on
   * the way out, because the version being left already holds its own text — the
   * debounced commit keeps whichever version is current in step with the editor,
   * so leaving one is simply leaving it as it stands.
   *
   * That is what makes this safe without a confirmation: switching away loses
   * nothing, and switching back finds it exactly as it was.
   *
   * Routed through `onChangeSource`, not `setSource`, so it counts as a local
   * edit: that sets `editedRef`, which is what lets the debounced commit persist
   * the restored text at all, and what stops the remote-adoption effect treating
   * it as stale and reverting it.
   */
  const restoreVersion = (version: ResumeVersion) => {
    closeOverEditor(setVersionsOpen);
    if (version.id === currentVersionId && version.source === source) return;
    // Ordered deliberately: become the new version *before* the text changes, so
    // the debounce that follows writes to the version now on screen rather than
    // back into the one just left.
    setCurrentVersion(version.id);
    onChangeSource(version.source);
  };

  /**
   * Apply a reviewed edit, whichever reach it has.
   *
   * A `span` edit is spliced in by a literal single-occurrence replace, checked
   * against the source *as it is now* rather than as it was when the request went
   * up — a resume open on another device, or typed in while the model was
   * working, can have moved underneath the answer.
   *
   * A `document` edit replaces the source outright. There is no quote to check,
   * which is why the server compiled it before sending it; the version recorded
   * below is what makes it undoable.
   */
  const applyEdit = async (
    scope: 'span' | 'document',
    oldLatex: string,
    newLatex: string,
    label: string,
  ): Promise<string | null> => {
    const result =
      scope === 'document'
        ? ({ ok: true, source: newLatex } as const)
        : replaceResumeEntry(source, oldLatex, newLatex);
    if (!result.ok) {
      return result.reason === 'ambiguous'
        ? 'That text appears more than once in the resume now, so it is not clear which to change. Try describing the part more specifically.'
        : 'That part could not be found in the resume any more — it may have been edited since. Try again.';
    }
    if (!(await recordChange(source, result.source, label))) {
      return "This couldn't be saved to your version history, so it hasn't been applied. Nothing has changed — try again.";
    }
    onChangeSource(result.source);
    return null;
  };

  const pdf = shown.state === 'ok' ? shown.pdf : null;

  // A sheet is up, so it owns the screen. The toolbar rides above the navbar,
  // which is below both sheets, so without this it stays lit underneath them —
  // a bar for a document you can't currently reach, showing through the thing
  // covering it. Its own buttons are what opened the sheet, and they're no use
  // until the sheet is answered.
  const sheetOpen = entryOpen || enginePickerOpen || versionsOpen || tailorOpen;

  // Bottom padding both panes reserve. Split keeps the toolbar up permanently,
  // so it has to be cleared like a piece of furniture rather than left to float
  // over the last line of whichever pane you were using.
  const bottomInset = tabBarInset + (split ? RESUME_TOOLBAR_CLEARANCE : 0);

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

  // The two panes, built once and then either stacked (one at a time, by `mode`)
  // or set side by side. Identical either way — the layout decides where they go,
  // not what they are.
  const editorPane = (
    <View style={styles.editor}>
      <LatexSourceEditor
        value={source}
        onChangeText={onChangeSource}
        inputRef={sourceRef}
        onScroll={editorScroll.scrollProps.onScroll}
        // Split, the toolbar is up for good and the field runs the full height
        // of the window beneath it, so the text needs its own room to clear it.
        // Stacked, the field already ran to the bottom edge and still does.
        bottomInset={split ? bottomInset : 0}
        onFocusChange={(focused) => {
          // A blur caused by one of the toolbar's own sheets is not the end of
          // an edit, so the screen stays as it is.
          if (!focused && holdEditorRef.current) return;
          setEditing(focused);
          // Losing focus ends the edit — see LatexSourceEditor. On web the
          // navbar's check blurs the field before its own onPress runs, so the
          // blur, not the press, is the reliable signal.
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
  );

  const preview = (
    <PreviewPane
      compilation={shown}
      supported={supported}
      hasSource={source.trim().length > 0}
      stale={stale}
      onRetry={() => void runCompile(source)}
    />
  );

  const previewPane = (
    <View style={styles.previewWrap}>
      <ScrollView
        {...previewScroll.scrollProps}
        contentContainerStyle={[styles.previewContent, { paddingBottom: bottomInset }]}
        showsVerticalScrollIndicator={false}>
        {/* Stacked, the page *is* the read view, so tapping it starts an edit
            the way tapping a note's body does. Split, the source is already
            beside it and the page is just a page — clicking it should select or
            scroll, not throw focus across the screen. */}
        {split ? (
          preview
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit LaTeX source"
            onPress={editSource}>
            {preview}
          </Pressable>
        )}
      </ScrollView>
      <TopFade visible={previewScroll.scrolled} />
    </View>
  );

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
              {/* The compiler picker used to live here as a 40px icon button. It
                  moved into the editing toolbar: which engine to run is a thing
                  you want while you're working on the document, not a permanent
                  fixture of its header. */}
            </View>
          </View>

          {split ? (
            <View style={styles.split}>
              <View
                style={[
                  styles.pane,
                  styles.sourcePane,
                  { borderRightColor: hexToRgba(theme.textSecondary, 0.18) },
                ]}>
                {editorPane}
              </View>
              <View style={styles.pane}>{previewPane}</View>
            </View>
          ) : mode === 'edit' ? (
            editorPane
          ) : (
            previewPane
          )}
        </KeyboardAvoidingView>

        {/* Editing tools ride above the navbar while the source has focus —
            the same arrangement the rich-text editor's formatting bar uses.
            Split, the source never loses the screen, so the bar never leaves
            either: it is the layout's furniture rather than a thing that comes
            and goes as you click between the two panes. */}
        <ResumeToolbar
          visible={(split || editing) && !sheetOpen}
          compilerLabel={engineLabel(engine)}
          stale={stale}
          compiling={shown.state === 'running'}
          onRecompile={() => void runCompile(source)}
          // One sheet at a time: both buttons live on the same bar, and two
          // stacked sheets would leave the one underneath unreachable.
          onAddEntry={() => {
            setEnginePickerOpen(false);
            setEntryMode('add');
            openOverEditor(setEntryOpen);
          }}
          onEditEntry={() => {
            setEnginePickerOpen(false);
            setEntryMode('edit');
            openOverEditor(setEntryOpen);
          }}
          onTailor={() => {
            setEntryOpen(false);
            setEnginePickerOpen(false);
            setVersionsOpen(false);
            openOverEditor(setTailorOpen);
          }}
          // Nothing to edit, and nothing to choose from, in an empty document.
          canEdit={source.trim().length > 0}
          onChooseCompiler={() => {
            setEntryOpen(false);
            openOverEditor(setEnginePickerOpen);
          }}
        />

        <ResumeEntryModal
          open={entryOpen}
          mode={entryMode}
          sections={sections}
          source={source}
          onClose={() => closeOverEditor(setEntryOpen)}
          onDraft={requestEntry}
          onApply={applyEntry}
          onRequestEdit={requestEdit}
          onApplyEdit={applyEdit}
        />

        {/* Tap to dismiss. Rides above the toolbar rather than over it, so it
            never covers the buttons you would use to act on what it says. */}
        {notice && (
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(150)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            onPress={() => setNotice(null)}
            style={[styles.notice, { bottom: bottomInset + RESUME_TOOLBAR_CLEARANCE }]}>
            <GlassSurface intensity={75} tintOpacity={0.85} style={styles.noticeSurface}>
              <Feather name="alert-circle" size={16} color={ACCENT} />
              <ThemedText type="small" style={styles.noticeBarText}>
                {notice}
              </ThemedText>
            </GlassSurface>
          </AnimatedPressable>
        )}

        <ResumeTailorModal
          open={tailorOpen}
          onClose={() => closeOverEditor(setTailorOpen)}
          onTailor={runTailor}
          onApply={applyTailored}
        />

        <VersionList
          open={versionsOpen}
          versions={versions}
          currentVersionId={currentVersionId}
          onClose={() => closeOverEditor(setVersionsOpen)}
          onRestore={restoreVersion}
          onDelete={(version) => void removeVersion(version.id)}
        />

        <EnginePicker
          open={enginePickerOpen}
          preference={preference}
          detected={detectEngine(source)}
          onClose={() => closeOverEditor(setEnginePickerOpen)}
          onChoose={(choice) => {
            closeOverEditor(setEnginePickerOpen);
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
  // Not `insets.bottom`. That is the home indicator; the floating navbar sits
  // above it and renders *over* this sheet, so a sheet that only cleared the
  // inset ran underneath the bar. This is the clearance every other scrolling
  // surface and sheet in the app reserves — the entry sheet learned it first.
  const tabBarInset = useTabBarInset();

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
            // `box-none`, so the empty space beside the sheet falls through to
            // the backdrop underneath. This wrapper is full-width and centres a
            // capped-width sheet, which on a wide window leaves large dead areas
            // either side of it — without this they swallow the click and the
            // sheet cannot be dismissed by clicking off it.
            pointerEvents="box-none"
            style={[styles.sheetHost, { paddingBottom: tabBarInset }]}>
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
  stale,
  onRetry,
}: {
  compilation: Compilation;
  supported: boolean;
  hasSource: boolean;
  /**
   * The source has been edited past this result (split layout only). The pages
   * stay — they're still the best answer available and the thing you're writing
   * against — but they're dimmed, so "this is not your text yet" is legible
   * from the page itself and not only from the toolbar's accent.
   */
  stale: boolean;
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
      <View
        style={[
          styles.errorPanel,
          { backgroundColor: theme.backgroundElement },
          // Dimmed on the same terms as a stale page: these diagnostics are
          // about text that has already been edited, which is usually exactly
          // what you did about them.
          stale && styles.stalePages,
        ]}>
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
    <View style={stale && styles.stalePages}>
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
    </View>
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
    alignItems: 'center',
  },
  sheet: {
    width: '100%',
    maxWidth: SHEET_MAX_WIDTH,
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
  // The two-pane layout. Equal halves: the source column and the page are both
  // fixed-ish widths that want the same room, and a draggable divider would be
  // the first piece of chrome on a screen whose whole argument is that it has
  // none.
  split: {
    flex: 1,
    flexDirection: 'row',
  },
  pane: {
    flex: 1,
  },
  // A hairline, not a gutter or a raised edge. The panes are two views of one
  // document and the line only has to say where one ends.
  sourcePane: {
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  // The page on screen is behind the source beside it. Dimmed rather than
  // covered or blurred: it's still readable and still the thing being written
  // against, it just isn't current.
  stalePages: {
    opacity: 0.45,
  },
  notice: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
  },
  noticeSurface: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  noticeBarText: {
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
