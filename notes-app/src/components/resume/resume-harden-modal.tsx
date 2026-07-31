/**
 * Hardening a resume against one job title.
 *
 * **One field**, and that is the whole design. The tailor asks for a company, a
 * role and a posting because it is aiming at one advert; this is aiming at the
 * job title itself, and the server already knows what a hundred-odd titles are
 * screened for. Asking for anything more would be asking someone to supply
 * information the server has better than they do.
 *
 * Same shape as `resume-tailor-modal.tsx` otherwise, and deliberately so — the
 * two open from adjacent buttons on the same bar, and a sheet that looked or
 * behaved differently would read as a different feature rather than a sibling of
 * the one beside it. Fill in, wait, read the diff, apply or discard. There is no
 * LaTeX review step for the same reason there isn't one there: the honest review
 * of a whole rewritten document is the diff and then the compiled page, and the
 * version history is what makes applying it safe.
 *
 * The one thing this sheet says that the tailor's doesn't is **which reference it
 * was built against**. A title in the table gets a specific, compiled list; a
 * title that isn't gets the model's general knowledge of the role. Both are
 * useful and they are not the same claim, so the review says which one happened
 * rather than letting the result imply the stronger of the two.
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
import { emptyHardenDraft, MAX_ROLE_CHARS, type HardenDraft } from '@/lib/latex/harden';
import { noFocusOutline } from '@/lib/web-style';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const SHEET_TINT_OPACITY = 0.9;
const SCROLL_FADE_HEIGHT = 44;

type Stage =
  | { state: 'form' }
  | { state: 'working' }
  /**
   * Hardened, compiled, and waiting to be looked at. Nothing has touched the
   * resume yet — applying is a separate decision made against the diff.
   */
  | {
      state: 'review';
      latex: string;
      before: string;
      label: string;
      pages: number | null;
      matchedRole: string;
    }
  | { state: 'failed'; message: string };

export function ResumeHardenModal({
  open,
  onClose,
  onHarden,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Ask for the hardened resume. Resolves to a message when it couldn't be done —
   * the sheet stays up saying why, because the alternative is closing on a resume
   * that didn't change and looking like it worked.
   */
  onHarden: (draft: HardenDraft) => Promise<
    | {
        ok: true;
        latex: string;
        before: string;
        pages: number | null;
        label: string;
        matchedRole: string;
      }
    | { ok: false; message: string }
  >;
  /** Apply the hardened resume the person has just read. */
  onApply: (latex: string, label: string) => Promise<string | null>;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const { height: windowHeight } = useWindowDimensions();

  const maxSheetHeight = windowHeight - insets.top - SHEET_TOP_GAP - tabBarInset;

  const [draft, setDraft] = useState<HardenDraft>(emptyHardenDraft);
  const [stage, setStage] = useState<Stage>({ state: 'form' });

  // Bumped on every open and close, so an answer to a question that has since
  // been abandoned doesn't land on a form someone has started filling in again.
  // Hardening takes minutes, which makes that a real sequence rather than a
  // theoretical one. In an effect because writing a ref during render is exactly
  // what React tells you not to do.
  const runRef = useRef(0);
  useEffect(() => {
    runRef.current += 1;
  }, [open]);

  // Opening the sheet starts fresh. Adjusting state during render on a changed
  // prop rather than in an effect — React's recommended form, and the shape both
  // sibling sheets use.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setDraft(emptyHardenDraft());
      setStage({ state: 'form' });
    }
  }

  const role = draft.role.trim();
  const tooLong = role.length > MAX_ROLE_CHARS;
  const canHarden = role.length > 0 && !tooLong;

  const busy = stage.state === 'working';
  // In review the work is already done, so the button is always live there.
  const ready = stage.state === 'review' || (!busy && canHarden);

  const run = async () => {
    if (!canHarden) return;
    const started = runRef.current;
    setStage({ state: 'working' });
    const result = await onHarden(draft);
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
      matchedRole: result.matchedRole,
    });
  };

  const applyHardened = async () => {
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

  // `backgroundElementAlt` for the same reason the sibling sheets use it: the
  // glass is already a raised surface, so a field filled at the raised tone
  // barely reads as a field.
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
            // the backdrop underneath — without it a wide window's dead areas
            // swallow the click and the sheet can't be dismissed by clicking off.
            pointerEvents="box-none"
            style={[styles.sheetWrap, { paddingBottom: tabBarInset }]}>
            <GlassSurface
              intensity={75}
              tintOpacity={SHEET_TINT_OPACITY}
              style={[styles.sheet, { maxHeight: maxSheetHeight }]}>
              <View style={styles.header}>
                <Feather name="shield" size={16} color={ACCENT} />
                <ThemedText type="smallBold" style={styles.headerText}>
                  Harden for a job title
                </ThemedText>
              </View>

              {stage.state === 'review' ? (
                <HardenReview
                  before={stage.before}
                  after={stage.latex}
                  pages={stage.pages}
                  matchedRole={stage.matchedRole}
                />
              ) : stage.state === 'working' ? (
                <View style={styles.working}>
                  <ActivityIndicator color={theme.textSecondary} />
                  <ThemedText type="small" themeColor="textSecondary" style={styles.workingText}>
                    Choosing what evidences this role, then compiling it to check it fits on one
                    page. This takes a minute or two.
                  </ThemedText>
                </View>
              ) : (
                <View style={styles.scrollWrap}>
                  <ScrollView
                    style={styles.scroll}
                    contentContainerStyle={styles.scrollContent}
                    showsVerticalScrollIndicator={false}
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
                      This builds the one-page resume you send by default for a job title — the
                      strongest case you can make to anyone hiring for it, rather than to one
                      posting. It checks your experience, including anything you&rsquo;ve commented
                      out, against what that title is actually screened for. Nothing is deleted, and
                      your current version is saved to the history first.
                    </ThemedText>

                    <ThemedText type="small" themeColor="textSecondary">
                      Primary job title
                    </ThemedText>
                    <TextInput
                      value={draft.role}
                      onChangeText={(next) => setDraft({ role: next })}
                      placeholder="Data Engineer"
                      placeholderTextColor={theme.textSecondary}
                      style={fieldStyle}
                      autoCapitalize="words"
                      autoCorrect={false}
                      onSubmitEditing={() => void run()}
                      returnKeyType="go"
                    />
                    <ThemedText type="small" themeColor="textSecondary" style={styles.hint}>
                      {tooLong
                        ? 'That is a job description, not a job title. Give the title on its own.'
                        : 'The title as postings write it — “Data Engineer”, not “the data role at a startup”. A resume is specific to one title, so harden a separate copy for each one you apply to.'}
                    </ThemedText>
                  </ScrollView>
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
                    stage.state === 'review' ? 'Apply this hardened resume' : 'Harden this resume'
                  }
                  accessibilityState={{ disabled: !ready }}
                  onPress={() => void (stage.state === 'review' ? applyHardened() : run())}
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
                        : 'Harden'}
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
 * What hardening did, as a diff — plus what it was measured against.
 *
 * The compiled page shows what the resume *is*; the diff shows what changed to
 * get there, which is the thing worth checking. The line about the reference is
 * the part that has no equivalent in the tailor's review: there, the standard was
 * a posting the person pasted themselves and can re-read. Here it is a list they
 * never saw, so the review at least says whose list it was.
 */
function HardenReview({
  before,
  after,
  pages,
  matchedRole,
}: {
  before: string;
  after: string;
  pages: number | null;
  matchedRole: string;
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
      <View style={[styles.matched, { backgroundColor: theme.backgroundElementAlt }]}>
        {/* 15, matching the problem box above and the tailor sheet's — the two
            asides read as the same family and a point of drift between them
            shows. */}
        <Feather
          name={matchedRole ? 'check-circle' : 'info'}
          size={15}
          color={theme.textSecondary}
        />
        <ThemedText type="small" themeColor="textSecondary" style={styles.matchedText}>
          {matchedRole
            ? `Checked against the qualifications compiled for ${matchedRole}.`
            : 'No compiled reference for that title, so this used general knowledge of the role. Check the keywords against a few real postings.'}
        </ThemedText>
      </View>
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
  hint: {
    paddingBottom: Spacing.two,
  },
  diffContent: {
    paddingBottom: Spacing.two,
  },
  // Sits under the diff rather than over it, so it doesn't need the scroll fade
  // the form and the tailor's review use — it is the last thing in the sheet and
  // nothing scrolls beneath it.
  matched: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    borderRadius: Spacing.two,
    marginHorizontal: Spacing.three,
    marginTop: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  matchedText: {
    flex: 1,
  },
  // Same shape as the other two resume sheets' `field`. These open from adjacent
  // buttons on one toolbar, so a different radius or inset here reads as two
  // different apps.
  field: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    marginBottom: Spacing.two,
    fontSize: 15,
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
  // Both buttons match the sibling sheets' Discard/Apply pair exactly: a filled
  // squircle for the secondary action rather than bare text, and the darkened
  // accent behind the primary's white label.
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
