/**
 * The resume editing toolbar: a glass bar that floats above the navbar while the
 * LaTeX source is being edited.
 *
 * Same shape and same rules as `components/formatting-toolbar.tsx` — it belongs
 * to an editor and it holds actions that act on the text rather than on the
 * screen. It is not a mode switch: nothing here changes what the screen is
 * showing, so it doesn't step on the app-wide pencil→check gesture
 * (`lib/active-editor.ts`).
 *
 * What lives here. **Add entry** opens the form that drafts a new resume entry,
 * and **Edit resume** reaches into what is already there — both writing actions
 * on the document. **Harden** and **Tailor** are the two whole-document actions
 * and sit next to each other because the pair is the point: hardening aims at a
 * job *title* and produces the resume you send by default, tailoring aims at one
 * posting and produces a single application. **Recompile** runs TeX over the
 * source as it stands. **The compiler** is the choice of TeX engine, which used
 * to be an icon in the screen header; it moved because it is a property of the
 * document you only ever want while you're working on it, and a permanent header
 * button for it made the header about the compiler rather than about the resume.
 *
 * Recompile is a manual button rather than something that fires as you type
 * because a TeX run is a round trip to a server that takes seconds and reads the
 * whole document; a debounce would spend one of those on every pause for
 * thought. `stale` is the other half of that bargain — with no automatic
 * compile, the bar has to be the thing that says the page you're looking at is
 * behind the text you've written.
 *
 * It rides above whichever is taller — the keyboard or the floating navbar — so
 * it clears the keyboard on a phone and the navbar on the web, without needing
 * to know which platform it's on.
 */
import Feather from '@expo/vector-icons/Feather';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedKeyboard,
  useAnimatedStyle,
} from 'react-native-reanimated';

import { GlassSurface } from '@/components/glass-surface';
import { ACCENT } from '@/components/resume/accent';
import { RecompileButton } from '@/components/resume/recompile-button';
import { ThemedText } from '@/components/themed-text';
import { hexToRgba, Spacing, TabBar } from '@/constants/theme';
import { useTabBarBottom } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';

/** Matches the formatting toolbar, so the two bars read as the same control. */
const BAR_HEIGHT = 48;
const GAP = Spacing.two;

/**
 * Vertical room the bar occupies above the navbar. A screen that keeps the
 * toolbar up permanently — the split layout does — adds this to its content
 * inset so the bar floats over the background rather than over the last line.
 */
export const RESUME_TOOLBAR_CLEARANCE = BAR_HEIGHT + GAP;

export function ResumeToolbar({
  visible,
  onAddEntry,
  onEditEntry,
  onHarden,
  onTailor,
  canEdit,
  onRecompile,
  onChooseCompiler,
  compilerLabel,
  isMaster,
  canSetMaster,
  onSetMaster,
  stale,
  compiling,
}: {
  /**
   * Shown while the source editor has focus — or permanently, where the source
   * is permanently on screen (the split layout).
   */
  visible: boolean;
  onAddEntry: () => void;
  onEditEntry: () => void;
  /** Build the default one-page resume for a job title (the title is the only input). */
  onHarden: () => void;
  /** Aim the whole resume at one job (company, role, job description). */
  onTailor: () => void;
  /** False for an empty document — there is nothing there to rewrite. */
  canEdit: boolean;
  onRecompile: () => void;
  onChooseCompiler: () => void;
  /** The engine in force right now, e.g. "pdfLaTeX". */
  compilerLabel: string;
  /** The version on screen is already the one tailoring builds from. */
  isMaster: boolean;
  /** False for a resume with no history yet — there is no version to mark. */
  canSetMaster: boolean;
  /** Make the version on screen the master. */
  onSetMaster: () => void;
  /** The source has moved past the PDF on screen; recompiling would change it. */
  stale: boolean;
  /** A compile is running, so the button reports it rather than starting another. */
  compiling: boolean;
}) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const keyboard = useAnimatedKeyboard();
  const navbarBottom = useTabBarBottom();

  // Clear the keyboard when there is one, the navbar when there isn't. On web
  // the keyboard height stays 0 and this resolves to the navbar; on a phone the
  // keyboard is always taller than the bar it covers.
  const floor = navbarBottom + TabBar.height;
  const rideAbove = useAnimatedStyle(() => ({
    transform: [{ translateY: -(Math.max(keyboard.height.value, floor) + GAP) }],
  }));

  if (!visible) return null;

  // On a narrow bar the labels cost more than they earn; the icons and their
  // accessibility labels still say what each button does. Seven buttons is the
  // most this bar holds, and every label showing at once needs roughly 980px, so
  // they drop in order of how much the icon already tells you: the shield,
  // crosshair, pencil and file-plus are ambiguous enough to want words first, the
  // refresh arrow reads on its own, and the compiler is the one label that has to
  // stay because "pdfLaTeX" is information rather than a name for a button.
  //
  // All three thresholds moved up when Harden arrived, and again when the master
  // star did: an extra icon costs ~53px of bar at every width (44 of button, 9 of
  // divider). The star is the one button that never takes a label, which is why
  // this round cost 53 rather than Harden's ~143.
  const showCompilerLabel = width >= 505;
  const showEntryLabels = width >= 840;
  const showRecompileLabel = width >= 980;

  // Below this the dividers come out, and that is a fit requirement rather than
  // a taste one. Stripped to icons the row still costs a hard 7 x 44 of button
  // (`minWidth`, which is the 44pt touch target and not negotiable) + 6 x 9 of
  // divider + 8 of bar padding = 370, inside a bar already inset 16 each side —
  // so it needs a 402px window, where six buttons needed 349. On a 320pt phone
  // that overflowed its glass. The dividers are the only part of that sum that
  // is decoration, so they are what goes; 7 x 44 + 8 = 316 fits with room over.
  const showDividers = width >= 415;

  return (
    <Animated.View
      entering={FadeIn.duration(150)}
      exiting={FadeOut.duration(120)}
      pointerEvents="box-none"
      style={[styles.host, rideAbove]}>
      <GlassSurface intensity={75} tintOpacity={0.6} style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add an entry to this resume"
          onPress={onAddEntry}
          style={({ pressed }) => [
            styles.button,
            showEntryLabels && styles.wide,
            pressed && styles.pressed,
          ]}>
          <Feather name="file-plus" size={18} color={theme.text} />
          {showEntryLabels && <ThemedText type="small">Add entry</ThemedText>}
        </Pressable>

        {showDividers && (
          <View style={[styles.divider, { backgroundColor: hexToRgba(theme.textSecondary, 0.3) }]} />
        )}

        {/* Dimmed rather than removed when there's nothing to edit: the bar is
            permanent furniture in the split layout, and a button that vanishes
            re-flows the other three under the cursor. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit part of this resume, or all of it"
          accessibilityState={{ disabled: !canEdit }}
          onPress={() => {
            if (canEdit) onEditEntry();
          }}
          style={({ pressed }) => [
            styles.button,
            showEntryLabels && styles.wide,
            pressed && canEdit && styles.pressed,
            !canEdit && styles.disabled,
          ]}>
          <Feather name="edit-3" size={18} color={theme.text} />
          {showEntryLabels && <ThemedText type="small">Edit resume</ThemedText>}
        </Pressable>

        {showDividers && (
          <View style={[styles.divider, { backgroundColor: hexToRgba(theme.textSecondary, 0.3) }]} />
        )}

        {/* Hardening reads the whole document too, and sits immediately before
            Tailor because the two are a pair: this one builds the resume you
            send by default, that one aims a copy of it at one posting. Dimmed on
            the same terms as both — an empty resume has nothing to choose from. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Harden this resume for a job title"
          accessibilityState={{ disabled: !canEdit }}
          onPress={() => {
            if (canEdit) onHarden();
          }}
          style={({ pressed }) => [
            styles.button,
            showEntryLabels && styles.wide,
            pressed && canEdit && styles.pressed,
            !canEdit && styles.disabled,
          ]}>
          <Feather name="shield" size={18} color={theme.text} />
          {showEntryLabels && <ThemedText type="small">Harden</ThemedText>}
        </Pressable>

        {showDividers && (
          <View style={[styles.divider, { backgroundColor: hexToRgba(theme.textSecondary, 0.3) }]} />
        )}

        {/* Tailoring reads the whole document rather than one entry, so it is
            dimmed on the same terms as Edit: an empty resume has nothing to
            choose from. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Tailor this resume to a job"
          accessibilityState={{ disabled: !canEdit }}
          onPress={() => {
            if (canEdit) onTailor();
          }}
          style={({ pressed }) => [
            styles.button,
            showEntryLabels && styles.wide,
            pressed && canEdit && styles.pressed,
            !canEdit && styles.disabled,
          ]}>
          <Feather name="crosshair" size={18} color={theme.text} />
          {showEntryLabels && <ThemedText type="small">Tailor</ThemedText>}
        </Pressable>

        {showDividers && (
          <View style={[styles.divider, { backgroundColor: hexToRgba(theme.textSecondary, 0.3) }]} />
        )}

        <RecompileButton
          onPress={onRecompile}
          stale={stale}
          compiling={compiling}
          showLabel={showRecompileLabel}
        />

        {showDividers && (
          <View style={[styles.divider, { backgroundColor: hexToRgba(theme.textSecondary, 0.3) }]} />
        )}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Compiler: ${compilerLabel}`}
          onPress={onChooseCompiler}
          style={({ pressed }) => [
            styles.button,
            showCompilerLabel && styles.wide,
            pressed && styles.pressed,
          ]}>
          <Feather name="sliders" size={18} color={theme.textSecondary} />
          {showCompilerLabel && (
            <ThemedText type="small" themeColor="textSecondary">
              {compilerLabel}
            </ThemedText>
          )}
        </Pressable>

        {showDividers && (
          <View style={[styles.divider, { backgroundColor: hexToRgba(theme.textSecondary, 0.3) }]} />
        )}

        {/* The master: the version every tailoring is built from, whatever is on
            screen. It sits last, past the compiler, because it is the only
            button here that changes nothing about the document — it changes what
            *later* work starts from.

            Three states, and only one of them is a button. Already the master:
            an accent star and no press, because the honest way to say "this
            isn't a control right now" is to not be one (the same reasoning as
            the read-only rows in `version-list.tsx`). Nothing to mark yet — a
            resume that has never compiled and so has no history — dimmed, like
            Edit on an empty document. Otherwise: press to make the version on
            screen the master.

            Icon-only at every width, unlike its neighbours. A seventh label
            would push the all-labels width past 1000px, and the star is already
            explained by the marker it puts on a row in the history sheet. */}
        {/* The marker wears `styles.button` and nothing else, so it keeps the
            exact box the Pressable had and the bar doesn't re-flow under the
            cursor at the moment you press it. */}
        {isMaster ? (
          <View accessibilityLabel="This version is the master" style={styles.button}>
            <Feather name="star" size={18} color={ACCENT} />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Use this version as the master"
            accessibilityState={{ disabled: !canSetMaster }}
            onPress={() => {
              if (canSetMaster) onSetMaster();
            }}
            style={({ pressed }) => [
              styles.button,
              pressed && canSetMaster && styles.pressed,
              !canSetMaster && styles.disabled,
            ]}>
            <Feather name="star" size={18} color={theme.textSecondary} />
          </Pressable>
        )}
      </GlassSurface>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    bottom: 0,
    left: Spacing.three,
    right: Spacing.three,
    alignItems: 'center',
  },
  bar: {
    height: BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.one,
    borderRadius: Spacing.three,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 16,
  },
  button: {
    height: 40,
    minWidth: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    borderRadius: Spacing.two,
  },
  wide: {
    paddingHorizontal: Spacing.three,
  },
  pressed: {
    opacity: 0.6,
  },
  disabled: {
    opacity: 0.4,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 24,
    marginHorizontal: Spacing.one,
  },
});
