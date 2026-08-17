/**
 * The resume adder: a form for one new entry, and a look at what came back
 * before it touches the document.
 *
 * The three-button ending — Discard, Edit, Apply — is the point of the whole
 * screen. A resume is a document someone has been shaping for years, and the
 * thing being inserted was written by a model that has seen it for about four
 * seconds. So nothing lands until it's been read, and if it's *nearly* right the
 * fix is to correct the LaTeX here rather than to throw the draft away and
 * re-describe the job in different words.
 *
 * The dates are text inputs, not date pickers. Resume dates are things like
 * "2024", "Summer 2024" and "Present"; a picker would demand a day and a month
 * that nobody puts on a resume, and would have no way to express an ongoing
 * role at all.
 *
 * Category is chips rather than a dropdown — the app's existing shape for
 * "choose one of these" (see `StateFilterBar` in `app/(home)/github/[id].tsx`) —
 * with a "New section" chip that reveals a name field. The sections come from
 * parsing the document, so the list is whatever this resume actually has.
 */
import Feather from '@expo/vector-icons/Feather';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LinearGradient } from 'expo-linear-gradient';

import { GlassSurface } from '@/components/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { Fonts, hexToRgba, Spacing } from '@/constants/theme';
import { useKeyboardPadding } from '@/hooks/use-keyboard-inset';
import { useTheme } from '@/hooks/use-theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import {
  emptyEditDraft,
  emptyEntryDraft,
  type ResumeEditDraft,
  type ResumeEntryDraft,
} from '@/lib/latex/entry';
import { DiffView } from '@/components/resume/diff-view';
import { resolveAddLabel, resolveEditLabel } from '@/lib/resume-versions';
import { ACCENT, ACCENT_FILL } from '@/components/resume/accent';
import { SHEET_MAX_WIDTH, SHEET_TOP_GAP } from '@/components/resume/sheet';
import { noFocusOutline } from '@/lib/web-style';
import { noScrollbar } from '@/lib/scroll-style';



/**
 * The sheet's tint strength, shared by the glass and by the fade at the bottom
 * of the form.
 *
 * One constant because the two have to agree: the fade ends on the same colour
 * the sheet is tinted with, so its bottom edge disappears into the surface. Let
 * these drift apart and the fade stops reading as "the content runs out here"
 * and starts reading as a grey band across the sheet.
 */
const SHEET_TINT_OPACITY = 0.9;

/** How much of the form's last rows the fade covers. */
const SCROLL_FADE_HEIGHT = 44;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Where the sheet is in its flow.
 *
 * `review` carries `oldLatex` when the sheet is editing: applying an edit needs
 * both halves, because what makes it checkable is that the *existing* text was
 * quoted (see `replaceResumeEntry` in `lib/latex/sections.ts`). `latex` is the
 * replacement either way, and is the thing the person reads and may hand-correct.
 */
type Stage =
  | { state: 'form' }
  | { state: 'writing' }
  // `label` is what this change will be called in the resume's version history.
  // Resolved when the answer arrives rather than when it's applied, because it
  // depends on the form as it was filled in, and the form is reset on close.
  | {
      state: 'review';
      latex: string;
      label: string;
      editing: boolean;
      /** Present for an edit, absent for an addition. Empty for a whole-document one. */
      oldLatex?: string;
      /** How wide an edit reaches; absent for an addition. */
      scope?: 'span' | 'document';
    }
  | { state: 'failed'; message: string };

/** Adding a new entry, or rewriting one that's already there. */
export type EntrySheetMode = 'add' | 'edit';

export function ResumeEntryModal({
  open,
  mode,
  sections,
  source,
  onClose,
  onDraft,
  onApply,
  onRequestEdit,
  onApplyEdit,
}: {
  open: boolean;
  /**
   * One sheet serves both jobs. They share everything that matters — the form,
   * the wait, and above all the review step that stops anything landing in the
   * document unread — and differ only in which fields the form shows and which
   * request the button makes. Two components would have been two copies of the
   * review flow, and the review flow is the part worth having exactly once.
   */
  mode: EntrySheetMode;
  /** Section titles already in the document, for the category chips. */
  sections: string[];
  /** The resume as it stands, so a whole-document rewrite has something to diff against. */
  source: string;
  onClose: () => void;
  /**
   * Ask the server for the entry. Resolves to the LaTeX or a message.
   *
   * `summary` is the model's own one-line description of what it wrote, which
   * becomes this change's label in the version history. It can come back empty —
   * a label is cosmetic and must never cost anyone the entry it captions — so
   * this sheet falls back to deriving one from the form (`resolveAddLabel`).
   */
  onDraft: (
    draft: ResumeEntryDraft,
  ) => Promise<{ ok: true; latex: string; summary: string } | { ok: false; message: string }>;
  /**
   * Insert the (possibly hand-edited) LaTeX into the resume, under `label` in its
   * version history. Returns a message when it could not be applied — the
   * resume's current state is snapshotted before it is changed, and if that
   * snapshot can't be written the change doesn't happen.
   */
  onApply: (section: string, latex: string, label: string) => Promise<string | null>;
  /** Ask the server to rewrite an entry. Resolves to both halves of the change. */
  onRequestEdit: (
    draft: ResumeEditDraft,
  ) => Promise<
    | {
        ok: true;
        /** How wide the change reaches — see `DraftedEdit.scope`. */
        scope: 'span' | 'document';
        oldLatex: string;
        newLatex: string;
        summary: string;
      }
    | { ok: false; message: string }
  >;
  /**
   * Apply the reviewed change. Returns a message when it could not be applied —
   * the document may have moved on since the request went up, and that has to
   * be said rather than silently doing nothing.
   */
  onApplyEdit: (
    scope: 'span' | 'document',
    oldLatex: string,
    newLatex: string,
    label: string,
  ) => Promise<string | null>;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  // What the sheet has to clear at the bottom. Not the safe-area inset — the
  // floating navbar sits above that and renders over this sheet, so a sheet that
  // only cleared the inset ran underneath the bar. This is the same clearance
  // every scrolling surface in the app reserves for it.
  const tabBarInset = useTabBarInset();

  // How tall the sheet may get, in pixels rather than as a percentage.
  //
  // It was `maxHeight: '80%'`, which had two problems. It resolved against a
  // parent with no height of its own, which is the kind of thing that works
  // until it quietly doesn't; and 80% of the window is nearly all of it, so a
  // bottom-anchored sheet at that height runs into the top of the page — which
  // is what narrowing the sheet exposed, since a narrower form is a taller one
  // (the category chips wrap onto more rows).
  //
  // Measured from the window instead, and deliberately in terms of what has to
  // stay clear: the top inset, the gap above, and the navbar below. What's left
  // is what the sheet gets.
  const maxSheetHeight = windowHeight - insets.top - SHEET_TOP_GAP - tabBarInset;

  // Lifts the sheet over the keyboard. The clearance above is for the floating
  // navbar, which the keyboard covers while it is up, so that much of it is dead
  // space and is spent on the keyboard rather than stacked on top of it. This was
  // a `KeyboardAvoidingView` on the theory that Android resizes its window for
  // the keyboard; it doesn't — the app is edge-to-edge, so the keyboard is drawn
  // over a window that never changes size, and the whole sheet sat behind it.
  const keyboardPad = useKeyboardPadding(tabBarInset - Spacing.three);

  const [draft, setDraft] = useState<ResumeEntryDraft>(() => emptyEntryDraft(sections[0] ?? ''));
  const [editDraft, setEditDraft] = useState<ResumeEditDraft>(emptyEditDraft);
  const [newSection, setNewSection] = useState('');
  const [stage, setStage] = useState<Stage>({ state: 'form' });

  // Bumped on every open and every close, so an in-flight draft started before
  // the transition can tell that it has been abandoned. In an effect rather
  // than in the render block below, because writing a ref during render is
  // exactly what React tells you not to do.
  const runRef = useRef(0);
  useEffect(() => {
    runRef.current += 1;
  }, [open]);

  // Opening the sheet starts a fresh entry. Reusing the last one would offer to
  // add a second copy of the job you just added, which is never the intent.
  // Adjusting state during render on a changed prop, rather than in an effect —
  // React's recommended form, and the same shape `formatting-toolbar.tsx` uses
  // to reset itself when its editor blurs.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setDraft(emptyEntryDraft(sections[0] ?? ''));
      setEditDraft(emptyEditDraft());
      setNewSection('');
      setStage({ state: 'form' });
    }
  }

  const set = <K extends keyof ResumeEntryDraft>(key: K, value: ResumeEntryDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setEdit = <K extends keyof ResumeEditDraft>(key: K, value: ResumeEditDraft[K]) =>
    setEditDraft((d) => ({ ...d, [key]: value }));

  const usingNewSection = !draft.sectionExists;
  const section = usingNewSection ? newSection.trim() : draft.section;
  const editing = mode === 'edit';
  const canWrite = editing
    ? editDraft.target.trim().length > 0 && editDraft.instructions.trim().length > 0
    : draft.title.trim().length > 0 && section.length > 0;

  const write = async () => {
    if (!canWrite) return;
    const run = runRef.current;
    setStage({ state: 'writing' });
    const result = editing
      ? await onRequestEdit({
          target: editDraft.target.trim(),
          instructions: editDraft.instructions.trim(),
        })
      : await onDraft({ ...draft, section, sectionExists: !usingNewSection });
    // Drafting takes seconds, and the sheet can be closed and reopened for a
    // different entry while it's in the air. This component is never unmounted
    // (the screen renders it always, `open` only hides it), so without this the
    // abandoned request's answer would arrive and throw the user out of the
    // form they'd already started filling in. Same reasoning as the compile
    // screen's `isCurrent` check: apply an answer only if it's still the
    // question being asked.
    if (run !== runRef.current) return;
    if (!result.ok) {
      setStage({ state: 'failed', message: result.message });
      return;
    }
    setStage(
      'newLatex' in result
        ? {
            state: 'review',
            latex: result.newLatex,
            oldLatex: result.oldLatex,
            scope: result.scope,
            label: resolveEditLabel(result.summary, editDraft),
            editing: false,
          }
        : {
            state: 'review',
            latex: result.latex,
            label: resolveAddLabel(result.summary, draft),
            editing: false,
          },
    );
  };

  const apply = async (
    latex: string,
    label: string,
    oldLatex?: string,
    scope: 'span' | 'document' = 'span',
  ) => {
    // Both paths are allowed to refuse, for two different reasons. An edit's quote
    // may no longer match — the document can have moved on while this was being
    // reviewed. And either can fail to snapshot the resume's current state, which
    // has to happen before it changes. Staying on the sheet with the reason beats
    // closing on a change that silently did nothing.
    const problem =
      oldLatex !== undefined
        ? await onApplyEdit(scope, oldLatex, latex, label)
        : await onApply(section, latex, label);
    if (problem) {
      setStage({ state: 'failed', message: problem });
      return;
    }
    onClose();
  };

  // `backgroundElementAlt`, not `backgroundElement`: the sheet's glass is already
  // a raised surface, so a field filled at the raised tone barely reads as a
  // field at all. The alt tone is the deeper one in every palette — light, dark,
  // Solarized and Midnight — which is what makes this one token rather than a
  // hand-picked shade that only works on one of them.
  const fieldStyle = [
    styles.field,
    noFocusOutline,
    { color: theme.text, backgroundColor: theme.backgroundElementAlt },
  ];

  return (
    <View style={styles.overlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.backdrop}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          />
          <Animated.View style={[styles.sheetHost, keyboardPad]} pointerEvents="box-none">
            <Animated.View
              entering={SlideInDown.duration(260)}
              exiting={SlideOutDown.duration(220)}
              // `box-none`, so the empty space beside the sheet falls through to
              // the backdrop underneath. This wrapper is full-width and centres a
              // capped-width sheet, which on a wide window leaves large dead areas
              // either side of it — without this they swallow the click and the
              // sheet cannot be dismissed by clicking off it.
              pointerEvents="box-none"
              style={[styles.sheetWrap, { paddingBottom: tabBarInset }]}>
              <GlassSurface
                intensity={75}
                tintOpacity={SHEET_TINT_OPACITY}
                style={[styles.sheet, { maxHeight: maxSheetHeight }]}>
                <View style={styles.header}>
                  <ThemedText type="smallBold">
                    {stage.state === 'review'
                      ? editing
                        ? 'Make this change?'
                        : 'Add this to your resume?'
                      : editing
                        ? 'Edit an entry'
                        : 'Add to resume'}
                  </ThemedText>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                    onPress={onClose}
                    style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
                    <Feather name="x" size={18} color={theme.textSecondary} />
                  </Pressable>
                </View>

                {stage.state === 'writing' && (
                  <View style={styles.centered}>
                    <ActivityIndicator color={theme.textSecondary} />
                    <ThemedText type="small" themeColor="textSecondary">
                      {editing
                        ? 'Finding that entry and rewriting it…'
                        : 'Writing it in your resume’s style…'}
                    </ThemedText>
                  </View>
                )}

                {stage.state === 'failed' && (
                  <View style={styles.centered}>
                    <Feather name="alert-circle" size={18} color={ACCENT} />
                    <ThemedText type="small" themeColor="textSecondary" style={styles.centeredText}>
                      {stage.message}
                    </ThemedText>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setStage({ state: 'form' })}
                      style={({ pressed }) => [
                        styles.secondaryButton,
                        { backgroundColor: theme.backgroundSelected },
                        pressed && styles.pressed,
                      ]}>
                      <ThemedText type="small">Back to the form</ThemedText>
                    </Pressable>
                  </View>
                )}

                {stage.state === 'review' && (
                  <>
                    {/* An edit replaces one run of the document with another,
                        so what there is to check is the *difference* — a wall of
                        near-identical LaTeX asks someone to spot it themselves.
                        An addition has no "before" to diff against: every line is
                        new, and a diff of that is a green block that says less
                        than the text does. So the edit gets a diff and the
                        addition gets the entry. Hand-correcting drops both back
                        to the raw text, because that is the thing being edited. */}
                    {stage.oldLatex !== undefined && !stage.editing ? (
                      // A span edit diffs against its own quote; a whole-document
                      // rewrite has no quote, so it diffs against the resume.
                      <DiffView
                        before={stage.scope === 'document' ? source : stage.oldLatex}
                        after={stage.latex}
                        style={styles.previewScroll}
                        contentContainerStyle={styles.diffContent}
                      />
                    ) : (
                      <ScrollView
                        style={styles.previewScroll}
                        contentContainerStyle={styles.previewContent}
                        {...noScrollbar}>
                        {stage.editing ? (
                          <TextInput
                            value={stage.latex}
                            onChangeText={(latex) => setStage({ ...stage, latex })}
                            multiline
                            autoCapitalize="none"
                            autoCorrect={false}
                            spellCheck={false}
                            keyboardType="ascii-capable"
                            style={[
                              styles.preview,
                              noFocusOutline,
                              { color: theme.text, backgroundColor: theme.backgroundElement },
                            ]}
                          />
                        ) : (
                          <ThemedText
                            style={[
                              styles.preview,
                              { color: theme.text, backgroundColor: theme.backgroundElement },
                            ]}>
                            {stage.latex}
                          </ThemedText>
                        )}
                      </ScrollView>
                    )}

                    <View style={styles.actions}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setStage({ state: 'form' })}
                        style={({ pressed }) => [
                          styles.secondaryButton,
                          { backgroundColor: theme.backgroundElement },
                          pressed && styles.pressed,
                        ]}>
                        <ThemedText type="small" themeColor="textSecondary">
                          Discard
                        </ThemedText>
                      </Pressable>
                      {/* One-way: Edit opens the text for correction and then
                          gets out of the way, leaving Discard and Apply. It is
                          deliberately not a pencil that becomes a check —
                          that pair belongs to the app-wide editing gesture
                          (`lib/active-editor.ts`), and a second one inside a
                          sheet would read as a competing edit mode. There is
                          nothing to "finish" here anyway: the draft isn't part
                          of the document until Apply. */}
                      {!stage.editing && (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Correct this LaTeX before applying it"
                          onPress={() => setStage({ ...stage, editing: true })}
                          style={({ pressed }) => [
                            styles.secondaryButton,
                            { backgroundColor: theme.backgroundElement },
                            pressed && styles.pressed,
                          ]}>
                          <Feather name="edit-3" size={14} color={theme.textSecondary} />
                          <ThemedText type="small" themeColor="textSecondary">
                            Edit
                          </ThemedText>
                        </Pressable>
                      )}
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => void apply(stage.latex, stage.label, stage.oldLatex, stage.scope)}
                        style={({ pressed }) => [
                          styles.primaryButton,
                          pressed && styles.pressed,
                        ]}>
                        <ThemedText type="small" style={styles.primaryLabel}>
                          Apply
                        </ThemedText>
                      </Pressable>
                    </View>
                  </>
                )}

                {stage.state === 'form' && (
                  <>
                    {/* This form is taller than its sheet and always will be, so
                        something has to say there is more below — without it,
                        Description read as a field that didn't exist. The fade
                        is that something, and on both platforms it's the only
                        one: `global.css` hides the bar on web and
                        {@link noScrollbar} hides the indicator on native. The
                        fade is carrying the message, which is why it isn't
                        optional. */}
                    <View style={styles.scrollWrap}>
                      <ScrollView
                        {...noScrollbar}
                        style={styles.formScroll}
                        contentContainerStyle={styles.form}
                        keyboardShouldPersistTaps="handled">
                        {editing ? (
                          <>
                            {/* Free text rather than a picker. The entries in a
                                resume have no identity of their own — they're a
                                run of macros in a document — so "the Globex
                                role" is how a person refers to one, and letting
                                them say that is less work than making them find
                                it in a list of parsed spans. The server turns it
                                into an exact quote and checks that quote before
                                anything changes. */}
                            <Labelled label="What to change">
                              <TextInput
                                value={editDraft.target}
                                onChangeText={(t) => setEdit('target', t)}
                                placeholder="e.g. the Globex role, the Skills section, or the whole resume"
                                placeholderTextColor={theme.textSecondary}
                                multiline
                                style={[...fieldStyle, styles.links]}
                              />
                            </Labelled>

                            <Labelled label="How to change it">
                              <TextInput
                                value={editDraft.instructions}
                                onChangeText={(t) => setEdit('instructions', t)}
                                placeholder="e.g. add a bullet about the Postgres migration, and cut the last one down"
                                placeholderTextColor={theme.textSecondary}
                                multiline
                                style={[...fieldStyle, styles.multiline]}
                              />
                            </Labelled>
                          </>
                        ) : (
                          <>
                        <ThemedText type="small" themeColor="textSecondary">
                          Category
                        </ThemedText>
                        <View style={styles.chips}>
                          {sections.map((name) => {
                            const selected = draft.sectionExists && draft.section === name;
                            return (
                              <Chip
                                key={name}
                                label={name}
                                selected={selected}
                                onPress={() => setDraft((d) => ({ ...d, section: name, sectionExists: true }))}
                              />
                            );
                          })}
                          <Chip
                            label="New section"
                            icon="plus"
                            selected={usingNewSection}
                            onPress={() => setDraft((d) => ({ ...d, sectionExists: false }))}
                          />
                        </View>
                        {usingNewSection && (
                          <TextInput
                            value={newSection}
                            onChangeText={setNewSection}
                            placeholder="Section name, e.g. Projects"
                            placeholderTextColor={theme.textSecondary}
                            style={fieldStyle}
                          />
                        )}

                        <Labelled label="Title">
                          <TextInput
                            value={draft.title}
                            onChangeText={(t) => set('title', t)}
                            placeholder="Job title, degree, or project name"
                            placeholderTextColor={theme.textSecondary}
                            style={fieldStyle}
                          />
                        </Labelled>

                        <Labelled label="Subtitle">
                          <TextInput
                            value={draft.subtitle}
                            onChangeText={(t) => set('subtitle', t)}
                            placeholder="Company, school, or team"
                            placeholderTextColor={theme.textSecondary}
                            style={fieldStyle}
                          />
                        </Labelled>

                        <View style={styles.row}>
                          <Labelled label="From" style={styles.half}>
                            <TextInput
                              value={draft.dateFrom}
                              onChangeText={(t) => set('dateFrom', t)}
                              placeholder="Jun 2024"
                              placeholderTextColor={theme.textSecondary}
                              style={fieldStyle}
                            />
                          </Labelled>
                          <Labelled label="To" style={styles.half}>
                            <TextInput
                              value={draft.dateTo}
                              onChangeText={(t) => set('dateTo', t)}
                              placeholder="Present"
                              placeholderTextColor={theme.textSecondary}
                              style={fieldStyle}
                            />
                          </Labelled>
                        </View>

                        <Labelled label="Location">
                          <TextInput
                            value={draft.location}
                            onChangeText={(t) => set('location', t)}
                            placeholder="City, or Remote"
                            placeholderTextColor={theme.textSecondary}
                            style={fieldStyle}
                          />
                        </Labelled>

                        <Labelled label="Link">
                          <TextInput
                            value={draft.link}
                            onChangeText={(t) => set('link', t)}
                            placeholder="https://…"
                            placeholderTextColor={theme.textSecondary}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                            style={fieldStyle}
                          />
                        </Labelled>

                        <Labelled label="Description">
                          <TextInput
                            value={draft.description}
                            onChangeText={(t) => set('description', t)}
                            placeholder="What changed because of you — and by how much, if you know."
                            placeholderTextColor={theme.textSecondary}
                            multiline
                            style={[...fieldStyle, styles.multiline]}
                          />
                        </Labelled>

                        {/* Pages for the model to read before writing, rather
                            than a link that ends up in the resume — which is
                            what the Link field above is. The hint says so,
                            because two URL fields on one form is otherwise a
                            fair thing to get wrong. */}
                        <Labelled label="Context links">
                          <TextInput
                            value={draft.contextLinks}
                            onChangeText={(t) => set('contextLinks', t)}
                            placeholder={'https://github.com/you/project\nhttps://yourblog.com/post'}
                            placeholderTextColor={theme.textSecondary}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                            multiline
                            style={[...fieldStyle, styles.links]}
                          />
                          <ThemedText type="small" themeColor="textSecondary" style={styles.hint}>
                            Read for background, one per line — not added to the resume.
                          </ThemedText>
                        </Labelled>
                          </>
                        )}
                      </ScrollView>
                      <ScrollFade />
                    </View>

                    <View style={styles.actions}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !canWrite }}
                        disabled={!canWrite}
                        onPress={write}
                        style={({ pressed }) => [
                          styles.primaryButton,
                          pressed && styles.pressed,
                          !canWrite && styles.disabled,
                        ]}>
                        <ThemedText type="small" style={styles.primaryLabel}>
                          Write entry
                        </ThemedText>
                      </Pressable>
                    </View>
                  </>
                )}
              </GlassSurface>
            </Animated.View>
          </Animated.View>
        </>
      )}
    </View>
  );
}

/**
 * Dissolves the last rows of the form into the sheet.
 *
 * The form is taller than the sheet can ever be, and a hard cut at the bottom
 * edge reads as the end of the content rather than the middle of it — which is
 * exactly how the Description field came to look like a field that wasn't there.
 * A fade says the opposite: this continues.
 *
 * It ends on the sheet's own tint (`SHEET_TINT_OPACITY`), not on the page
 * background, because it sits on glass — anything else would draw a band across
 * the surface instead of vanishing into it.
 */
function ScrollFade() {
  const theme = useTheme();
  return (
    <LinearGradient
      pointerEvents="none"
      colors={[
        hexToRgba(theme.backgroundElement, 0),
        hexToRgba(theme.backgroundElement, SHEET_TINT_OPACITY),
      ]}
      style={styles.scrollFade}
    />
  );
}

/** A field with its label above it. */
function Labelled({
  label,
  style,
  children,
}: {
  label: string;
  style?: object;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.labelled, style]}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      {children}
    </View>
  );
}

/** Bordered squircle chip — the app's existing filter control. */
function Chip({
  label,
  selected,
  icon,
  onPress,
}: {
  label: string;
  selected: boolean;
  icon?: 'plus';
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          borderColor: selected ? ACCENT : hexToRgba(theme.textSecondary, 0.35),
          backgroundColor: selected ? hexToRgba(ACCENT, 0.14) : 'transparent',
        },
        pressed && styles.pressed,
      ]}>
      {icon === 'plus' && (
        <Feather name="plus" size={13} color={selected ? ACCENT : theme.textSecondary} />
      )}
      <ThemedText type="small" style={{ color: selected ? ACCENT : theme.textSecondary }}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheetHost: {
    paddingHorizontal: Spacing.three,
    justifyContent: 'flex-end',
    flex: 1,
  },
  // Centred and capped rather than stretched. `sheetHost` is a column, so its
  // children stretch the full width by default — which is right for a phone and
  // absurd on the split layout's desktop window.
  // `flexShrink` here and on the sheet so that when the keyboard shortens the
  // box, the already-shrinkable scrollers below give up the room rather than the
  // sheet pushing its own header off the top. Inert without that pressure.
  sheetWrap: {
    width: '100%',
    maxWidth: SHEET_MAX_WIDTH,
    alignSelf: 'center',
    flexShrink: 1,
  },
  sheet: {
    borderRadius: Spacing.four,
    paddingVertical: Spacing.two,
    flexShrink: 1,
    // The height cap is applied inline, from the window — see `maxSheetHeight`.
    // Tall enough to hold the form, short enough that the resume stays visible
    // behind it: this is an addition to a document, not a new screen.
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
  },
  close: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.two,
  },
  // `flexShrink: 1` is what makes this scroll at all, and it is not optional.
  //
  // React Native defaults `flexShrink` to 0, unlike the web. So with only
  // `flexGrow: 0` this took its full *content* height and refused to give any of
  // it back — which cost twice over. The ScrollView had no bounded height, so it
  // had nothing to scroll within; and the sheet's `maxHeight: '80%'` was then
  // exceeded, so `GlassSurface`'s `overflow: 'hidden'` quietly cut off whatever
  // ran past it. The last field in the form — Description — was simply gone, and
  // no amount of scrolling would reach it because scrolling wasn't happening.
  //
  // Shrinking gives it a real height (whatever is left after the header and the
  // pinned actions), and a bounded ScrollView is a scrolling one.
  // Holds the scroller and the fade sitting over its bottom edge. It carries the
  // shrinking now, so it is the piece the sheet's remaining height lands on.
  scrollWrap: {
    flexGrow: 0,
    flexShrink: 1,
  },
  formScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  scrollFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: SCROLL_FADE_HEIGHT,
  },
  form: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
    gap: Spacing.three,
  },
  labelled: {
    gap: Spacing.one,
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  half: {
    flex: 1,
  },
  field: {
    // Spacing.three to match the app's other sheet forms (github-issue-compose,
    // issue-attributes-sheet), which this sits next to in the same navigation.
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 15,
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  // Shorter than the description box: a couple of URLs, not a paragraph.
  links: {
    minHeight: 56,
    textAlignVertical: 'top',
  },
  hint: {
    paddingHorizontal: Spacing.one,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  // Same fix, same reason: a long drafted entry would otherwise push the
  // Discard/Edit/Apply row out through the bottom of the sheet, leaving no way
  // to accept or reject the thing you were asked to review.
  previewScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  // The diff supplies its own row padding, so this only has to clear the bottom.
  diffContent: {
    paddingBottom: Spacing.three,
  },
  previewContent: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.three,
  },
  preview: {
    fontFamily: Fonts.mono,
    fontSize: 12,
    lineHeight: 18,
    borderRadius: Spacing.two,
    padding: Spacing.three,
    minHeight: 120,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: ACCENT_FILL,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  primaryLabel: {
    color: '#ffffff',
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  centered: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.five,
  },
  centeredText: {
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
  disabled: {
    opacity: 0.5,
  },
});
