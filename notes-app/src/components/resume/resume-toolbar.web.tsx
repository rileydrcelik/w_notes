/**
 * The resume editing toolbar, web variant.
 *
 * Identical bar, different anchor. The native file rides the keyboard inset with
 * `useAnimatedKeyboard`, which reanimated does not implement on web — it logs
 * "useAnimatedKeyboard is not available on web yet" and reports a height of zero
 * (`JSReanimated.ts`). The fallback would land in the right place anyway, but
 * this screen is *mostly* a web screen — compiling and previewing a resume only
 * works here — so that warning would fire for nearly every person who ever opens
 * the toolbar. There's no keyboard inset to track on web regardless: the browser
 * doesn't resize the viewport for one, and the navbar never moves.
 *
 * So this variant sits at a fixed offset above the floating navbar.
 *
 * **Its exported name and props must match `resume-toolbar.tsx` exactly.** A
 * `.web` file that drifts from its base is invisible to TypeScript and to any
 * suite that runs one platform — `lib/__tests__/platform-parity.test.ts` exists
 * because that once cost three days of a broken native launch with a green
 * suite, and it covers this pair automatically.
 */
import Feather from '@expo/vector-icons/Feather';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { GlassSurface } from '@/components/glass-surface';
import { ACCENT } from '@/components/resume/accent';
import { RecompileButton } from '@/components/resume/recompile-button';
import { ThemedText } from '@/components/themed-text';
import { hexToRgba, Spacing, TabBar } from '@/constants/theme';
import { useTabBarBottom } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';

const BAR_HEIGHT = 48;
const GAP = Spacing.two;

/** See `resume-toolbar.tsx` — the split layout adds this to its content inset. */
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
  const navbarBottom = useTabBarBottom();

  if (!visible) return null;

  // See `resume-toolbar.tsx` — seven buttons, and every label at once needs ~980px.
  const showCompilerLabel = width >= 505;
  const showEntryLabels = width >= 840;
  const showRecompileLabel = width >= 980;
  // See `resume-toolbar.tsx`: below this the seven icons alone overflow the bar,
  // and the dividers are the only part of its width that isn't a touch target.
  const showDividers = width >= 415;

  return (
    <Animated.View
      entering={FadeIn.duration(150)}
      exiting={FadeOut.duration(120)}
      pointerEvents="box-none"
      style={[styles.host, { bottom: navbarBottom + TabBar.height + GAP }]}>
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
