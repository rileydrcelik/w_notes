/**
 * Tailoring a resume to one job: who it's for, what the role is, and the posting.
 *
 * Three fields and one button, deliberately. Everything that decides what the
 * tailored resume looks like is already in the resume and in the job description
 * — the choosing is the model's job, and a form of options for it would be asking
 * the user to do that choosing twice.
 *
 * Unlike the add/edit sheet there is **no LaTeX review step**, and that's a
 * considered difference rather than a shortcut. Reviewing an inserted entry works
 * because an entry is a few lines you can read; reviewing a whole rewritten
 * document in a sheet does not, and the honest review of a tailored resume is the
 * compiled page, which is on screen the moment this closes. What makes that safe
 * is the version history: the untailored resume is one tap away, and the server
 * refuses to hand over a document that doesn't compile.
 *
 * The wait is long — up to a few minutes, because the server writes the document
 * and then compiles it to check it really is one page — so the progress state says
 * what is happening rather than showing a bare spinner.
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
import { hexToRgba, Spacing } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { ACCENT, ACCENT_FILL } from '@/components/resume/accent';
import { SHEET_MAX_WIDTH, SHEET_TOP_GAP } from '@/components/resume/sheet';
import { DiffView } from '@/components/resume/diff-view';
import { looksLikeUrl, readJobPosting } from '@/lib/latex/job-posting';
import { emptyTailorDraft, type TailorDraft } from '@/lib/latex/tailor';
import { noFocusOutline } from '@/lib/web-style';
import { noScrollbar } from '@/lib/scroll-style';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const SHEET_TINT_OPACITY = 0.9;
const SCROLL_FADE_HEIGHT = 44;

type Stage =
  | { state: 'form' }
  /** Reading the linked posting — short, and it happens before the long part. */
  | { state: 'reading' }
  | { state: 'working' }
  /**
   * Tailored, compiled, and waiting to be looked at.
   *
   * Nothing has touched the resume yet. A tailored document is a whole rewrite,
   * and the only reviewable form of that is a diff — which entries came off the
   * bench, which were commented out, which bullets were rewritten.
   */
  | {
      state: 'review';
      latex: string;
      before: string;
      label: string;
      pages: number | null;
    }
  | { state: 'failed'; message: string };

export function ResumeTailorModal({
  open,
  onClose,
  onTailor,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Ask for the tailored resume and apply it. Resolves to a message when it
   * couldn't be done — the sheet stays up saying why, because the alternative is
   * closing on a resume that didn't change and looking like it worked.
   */
  onTailor: (draft: TailorDraft) => Promise<
    | { ok: true; latex: string; before: string; pages: number | null; label: string }
    | { ok: false; message: string }
  >;
  /** Apply the tailored resume the person has just read. */
  onApply: (latex: string, label: string) => Promise<string | null>;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const { height: windowHeight } = useWindowDimensions();

  const maxSheetHeight = windowHeight - insets.top - SHEET_TOP_GAP - tabBarInset;

  const [draft, setDraft] = useState<TailorDraft>(emptyTailorDraft);
  const [link, setLink] = useState('');
  // The paste fields start hidden and are revealed by a link that couldn't be
  // read — which, for LinkedIn and Workday, is most of the time. Once shown they
  // stay shown: having been sent back to pasting, being sent forward again to a
  // link box you already know doesn't work would be the wrong direction.
  const [pasting, setPasting] = useState(false);
  const [stage, setStage] = useState<Stage>({ state: 'form' });

  // Bumped on every open and close, so an answer to a question that has since
  // been abandoned doesn't land on a form someone has started filling in again.
  // Tailoring takes minutes, which makes that a real sequence rather than a
  // theoretical one. In an effect because writing a ref during render is exactly
  // what React tells you not to do.
  const runRef = useRef(0);
  useEffect(() => {
    runRef.current += 1;
  }, [open]);

  // Opening the sheet starts a fresh job. Reusing the last one would offer to
  // tailor again for a company you already applied to. Adjusting state during
  // render on a changed prop rather than in an effect — React's recommended form,
  // and the same shape `resume-entry-modal.tsx` uses.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setDraft(emptyTailorDraft());
      setLink('');
      setPasting(false);
      setStage({ state: 'form' });
    }
  }

  // Either a link to read, or a posting already pasted in. The pasted path still
  // needs a role, because a resume aimed at a description with no title attached
  // has nothing to lead with.
  const pasted = draft.role.trim().length > 0 && draft.jobDescription.trim().length > 0;
  const canTailor = pasting ? pasted : looksLikeUrl(link) || pasted;

  const tailorWith = async (job: TailorDraft, started: number) => {
    setStage({ state: 'working' });
    const result = await onTailor(job);
    if (started !== runRef.current) return;
    if (!result.ok) {
      setStage({ state: 'failed', message: result.message });
      return;
    }
    setStage({
      state: 'review',
      latex: result.latex,
      before: result.before,
      label: result.label,
      pages: result.pages,
    });
  };

  // Nothing to press while a request is out; in review the work is already done,
  // so the button is always live there.
  const busy = stage.state === 'working' || stage.state === 'reading';
  const ready = stage.state === 'review' || (!busy && canTailor);

  const applyTailored = async () => {
    if (stage.state !== 'review') return;
    const started = runRef.current;
    const problem = await onApply(stage.latex, stage.label);
    if (started !== runRef.current) return;
    if (problem) {
      setStage({ state: 'failed', message: problem });
      return;
    }
    onClose();
  };

  const run = async () => {
    if (!canTailor) return;
    const started = runRef.current;

    // A link that hasn't been read yet: read it first. This is the cheap step —
    // if the page can't be fetched we find out in seconds and hand the person the
    // paste fields, instead of spending a minute writing a resume against nothing.
    if (!pasted && looksLikeUrl(link)) {
      setStage({ state: 'reading' });
      const result = await readJobPosting(link);
      if (started !== runRef.current) return;
      if (!result.ok) {
        // Unreadable is the expected outcome for most job sites, so it opens the
        // way forward rather than just reporting a failure.
        if (result.unreadable) setPasting(true);
        setStage({ state: 'failed', message: result.message });
        return;
      }
      const filled: TailorDraft = {
        company: result.posting.company,
        role: result.posting.role,
        jobDescription: result.posting.description,
      };
      // Kept, so the version label names the job and a retry after a tailoring
      // failure doesn't re-read the page.
      setDraft(filled);
      await tailorWith(filled, started);
      return;
    }

    await tailorWith(draft, started);
  };

  // `backgroundElementAlt` for the same reason the entry sheet uses it: the glass
  // is already a raised surface, so a field filled at the raised tone barely reads
  // as a field.
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
            onPress={busy ? undefined : onClose}
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
            style={[styles.sheetWrap, { paddingBottom: tabBarInset }]}>
            <GlassSurface
              intensity={75}
              tintOpacity={SHEET_TINT_OPACITY}
              style={[styles.sheet, { maxHeight: maxSheetHeight }]}>
              {/* No icon — see `resume-harden-modal.tsx`. The two sheets open
                  from adjacent buttons and have to stay a matched pair. */}
              <View style={styles.header}>
                <ThemedText type="smallBold" style={styles.headerText}>
                  Tailor to a job
                </ThemedText>
              </View>

              {stage.state === 'review' ? (
                <TailorReview
                  before={stage.before}
                  after={stage.latex}
                  pages={stage.pages}
                />
              ) : stage.state === 'reading' || stage.state === 'working' ? (
                <View style={styles.working}>
                  <ActivityIndicator color={theme.textSecondary} />
                  <ThemedText type="small" themeColor="textSecondary" style={styles.workingText}>
                    {stage.state === 'reading'
                      ? 'Reading the posting…'
                      : 'Choosing what to include, then compiling it to check it fits on one page. This takes a minute or two.'}
                  </ThemedText>
                </View>
              ) : (
                <View style={styles.scrollWrap}>
                  <ScrollView
                    style={styles.scroll}
                    contentContainerStyle={styles.scrollContent}
                    {...noScrollbar}
                    keyboardShouldPersistTaps="handled">
                    {stage.state === 'failed' && (
                      <View
                        style={[styles.problem, { backgroundColor: theme.backgroundElementAlt }]}>
                        <Feather name="alert-circle" size={15} color={ACCENT} />
                        <ThemedText type="small" style={styles.problemText}>
                          {stage.message}
                        </ThemedText>
                      </View>
                    )}

                    <ThemedText type="small" themeColor="textSecondary" style={styles.blurb}>
                      Picks what belongs on a one-page resume for this job and matches the
                      posting&rsquo;s wording so an ATS can find it. Nothing is deleted.
                    </ThemedText>

                    {!pasting && (
                      <>
                        <ThemedText type="small" themeColor="textSecondary">
                          Job posting link
                        </ThemedText>
                        <TextInput
                          value={link}
                          onChangeText={setLink}
                          placeholder="https://…"
                          placeholderTextColor={theme.textSecondary}
                          style={fieldStyle}
                          autoCapitalize="none"
                          autoCorrect={false}
                          autoComplete="off"
                          spellCheck={false}
                          inputMode="url"
                        />
                        {/* Said before they try it, not after. Most postings live
                            on sites that cannot be read, and someone who already
                            knows that should not have to prove it first. The way
                            out is a button, and it lives in the actions row with
                            the other things you can press. */}
                        <ThemedText
                          type="small"
                          themeColor="textSecondary"
                          style={styles.linkOut}>
                          LinkedIn and Workday links can&rsquo;t be read.
                        </ThemedText>
                      </>
                    )}

                    {pasting && (
                      <>
                        <ThemedText type="small" themeColor="textSecondary">
                          Company
                        </ThemedText>
                        <TextInput
                          value={draft.company}
                          onChangeText={(company) => setDraft((d) => ({ ...d, company }))}
                          placeholder="Acme"
                          placeholderTextColor={theme.textSecondary}
                          style={fieldStyle}
                          autoCapitalize="words"
                        />

                        <ThemedText type="small" themeColor="textSecondary">
                          Role
                        </ThemedText>
                        <TextInput
                          value={draft.role}
                          onChangeText={(role) => setDraft((d) => ({ ...d, role }))}
                          placeholder="Senior Backend Engineer"
                          placeholderTextColor={theme.textSecondary}
                          style={fieldStyle}
                          autoCapitalize="words"
                        />

                        <ThemedText type="small" themeColor="textSecondary">
                          Job description, including requirements
                        </ThemedText>
                        <TextInput
                          value={draft.jobDescription}
                          onChangeText={(jobDescription) =>
                            setDraft((d) => ({ ...d, jobDescription }))
                          }
                          placeholder="Paste the posting here — the more of it the better."
                          placeholderTextColor={theme.textSecondary}
                          style={[...fieldStyle, styles.multiline]}
                          multiline
                          textAlignVertical="top"
                        />
                      </>
                    )}
                  </ScrollView>
                  {/* The job-description field is the tall one and sits at the
                      bottom, so without this the form reads as if it ends above
                      it. Same fade the entry sheet grew for the same reason. */}
                  <LinearGradient
                    pointerEvents="none"
                    colors={[
                      hexToRgba(theme.background, 0),
                      hexToRgba(theme.background, SHEET_TINT_OPACITY),
                    ]}
                    style={styles.scrollFade}
                  />
                </View>
              )}

              <View style={styles.actions}>
                {/* Only while a link is the thing on offer: once the paste
                    fields are showing, this is where you already are. Sits at
                    the left, away from the Cancel/Tailor pair on the right, so
                    "go somewhere else" doesn't sit inside "finish or abandon".
                    Accent-on-tint rather than a filled squircle — it is a real
                    choice, not the primary one, and a second filled button would
                    compete with Tailor for the same glance. */}
                {!pasting && stage.state !== 'review' && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Enter the job posting manually"
                    onPress={() => setPasting(true)}
                    disabled={busy}
                    style={({ pressed }) => [
                      styles.secondaryButton,
                      styles.manualButton,
                      { backgroundColor: hexToRgba(ACCENT, 0.14) },
                      busy && styles.disabled,
                      pressed && styles.pressed,
                    ]}>
                    <Feather name="edit-3" size={15} color={ACCENT} />
                    <ThemedText type="small" style={{ color: ACCENT }}>
                      Enter it manually
                    </ThemedText>
                  </Pressable>
                )}
                <Pressable
                  accessibilityRole="button"
                  onPress={onClose}
                  disabled={busy}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    { backgroundColor: theme.backgroundElement },
                    busy && styles.disabled,
                    pressed && styles.pressed,
                  ]}>
                  <ThemedText type="small" themeColor="textSecondary">
                    {stage.state === 'review' ? 'Discard' : 'Cancel'}
                  </ThemedText>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    stage.state === 'review' ? 'Apply this tailored resume' : 'Tailor this resume'
                  }
                  accessibilityState={{ disabled: !ready }}
                  onPress={() => void (stage.state === 'review' ? applyTailored() : run())}
                  disabled={!ready}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    !ready && styles.disabled,
                    pressed && styles.pressed,
                  ]}>
                  <ThemedText type="small" style={styles.primaryLabel}>
                    {stage.state === 'review'
                      ? 'Apply'
                      : stage.state === 'failed'
                        ? 'Try again'
                        : 'Tailor'}
                  </ThemedText>
                </Pressable>
              </View>
            </GlassSurface>
          </Animated.View>
        </>
      )}
    </View>
  );
}

/**
 * What tailoring did, as a diff.
 *
 * The compiled page shows what the resume *is*; this shows what changed to get
 * there, which is the thing you actually want to check — that the role it
 * promoted off the bench is one you would want promoted, and that what it
 * commented out is something you are happy to leave off.
 */
function TailorReview({
  before,
  after,
  pages,
}: {
  before: string;
  after: string;
  pages: number | null;
}) {
  const theme = useTheme();
  return (
    <View style={styles.scrollWrap}>
      <DiffView
        before={before}
        after={after}
        trailing={
          pages !== null ? (
            <ThemedText type="small" themeColor={pages === 1 ? 'textSecondary' : 'text'}>
              {pages === 1 ? '· one page' : `· ${pages} pages`}
            </ThemedText>
          ) : null
        }
        style={styles.scroll}
        contentContainerStyle={styles.diffContent}
      />
      <LinearGradient
        pointerEvents="none"
        colors={[hexToRgba(theme.background, 0), hexToRgba(theme.background, SHEET_TINT_OPACITY)]}
        style={styles.scrollFade}
      />
    </View>
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
  sheetWrap: {
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
  },
  sheet: {
    width: '100%',
    maxWidth: SHEET_MAX_WIDTH,
    borderRadius: Spacing.four,
    paddingVertical: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.one,
  },
  headerText: {
    flex: 1,
  },
  // `flexShrink: 1` is load-bearing — React Native defaults it to 0, so without
  // it the scroller keeps its full content height and overflows the sheet's cap.
  scrollWrap: {
    flexGrow: 0,
    flexShrink: 1,
  },
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.three,
    paddingBottom: SCROLL_FADE_HEIGHT,
    gap: Spacing.one,
  },
  scrollFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: SCROLL_FADE_HEIGHT,
  },
  blurb: {
    paddingBottom: Spacing.two,
  },
  // The note above the manual-entry button. Text, not a control — it says why
  // you would want the button, and the button says what it does.
  linkOut: {
    paddingBottom: Spacing.one,
  },
  // Borrows `secondaryButton`'s shape so the row reads as one control repeated
  // rather than three sized by hand; only the fill differs. `marginRight: auto`
  // is what pushes Cancel and Tailor to the right and leaves this on the left —
  // the row is `justifyContent: 'flex-end'`, so without it all three bunch up.
  manualButton: {
    marginRight: 'auto',
  },
  diffContent: {
    paddingBottom: SCROLL_FADE_HEIGHT,
  },
  // Same shape as `resume-entry-modal.tsx`'s `field`, which is itself matched to
  // the app's other sheet forms (github-issue-compose, issue-attributes-sheet).
  // These two sheets open from the same toolbar, so a different radius or inset
  // here reads as two different apps.
  field: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    marginBottom: Spacing.two,
    fontSize: 15,
  },
  multiline: {
    minHeight: 132,
    textAlignVertical: 'top',
  },
  working: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.five,
  },
  workingText: {
    textAlign: 'center',
  },
  problem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
    marginBottom: Spacing.two,
  },
  problemText: {
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.one,
  },
  // Both buttons match `resume-entry-modal.tsx`'s Discard/Apply pair exactly: a
  // filled squircle for the secondary action rather than bare text, and the
  // darkened accent behind the primary's white label.
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ACCENT_FILL,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  primaryLabel: {
    color: '#ffffff',
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.6,
  },
});
