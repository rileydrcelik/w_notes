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
 * Three things live here. **Add entry** opens the form that drafts a new resume
 * entry, which is a writing action on the document. **Recompile** runs TeX over
 * the source as it stands. **The compiler** is the choice of TeX engine, which
 * used to be an icon in the screen header; it moved because it is a property of
 * the document you only ever want while you're working on it, and a permanent
 * header button for it made the header about the compiler rather than about the
 * resume.
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
  onTailor,
  canEdit,
  onRecompile,
  onChooseCompiler,
  compilerLabel,
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
  /** Aim the whole resume at one job (company, role, job description). */
  onTailor: () => void;
  /** False for an empty document — there is nothing there to rewrite. */
  canEdit: boolean;
  onRecompile: () => void;
  onChooseCompiler: () => void;
  /** The engine in force right now, e.g. "pdfLaTeX". */
  compilerLabel: string;
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
  // accessibility labels still say what each button does. Five buttons is the
  // most this bar holds, and every label showing at once needs roughly 630px, so
  // they drop in order of how much the icon already tells you: the crosshair,
  // pencil and file-plus are ambiguous enough to want words first, the refresh
  // arrow reads on its own, and the compiler is the one label that has to stay
  // because "pdfLaTeX" is information rather than a name for a button. At a phone
  // width only that one survives, which is what keeps the row inside its glass.
  const showCompilerLabel = width >= 380;
  const showEntryLabels = width >= 680;
  const showRecompileLabel = width >= 820;

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

        <View style={[styles.divider, { backgroundColor: hexToRgba(theme.textSecondary, 0.3) }]} />

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

        <View style={[styles.divider, { backgroundColor: hexToRgba(theme.textSecondary, 0.3) }]} />

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

        <View style={[styles.divider, { backgroundColor: hexToRgba(theme.textSecondary, 0.3) }]} />

        <RecompileButton
          onPress={onRecompile}
          stale={stale}
          compiling={compiling}
          showLabel={showRecompileLabel}
        />

        <View style={[styles.divider, { backgroundColor: hexToRgba(theme.textSecondary, 0.3) }]} />

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
