import { useCallback, useEffect, useRef, type RefObject } from 'react';
import {
  KeyboardState,
  runOnJS,
  useAnimatedKeyboard,
  useAnimatedReaction,
  useAnimatedStyle,
} from 'react-native-reanimated';

/**
 * How much of the screen the on-screen keyboard is covering, as styles you can
 * hand straight to an `Animated.View`.
 *
 * The thing to know: **Android does not resize the window for the keyboard.**
 * The app runs edge-to-edge, so the IME is drawn *over* it — which makes
 * `KeyboardAvoidingView` useless there (`behavior` is left undefined, and even
 * `height` measures a window that never changes). A bottom-anchored sheet
 * therefore stays exactly where it was and the keyboard lands on top of the
 * field you just tapped. Reanimated's IME inset is the one signal that tracks
 * the keyboard on both platforms, which is why the floating toolbars already
 * ride it (`formatting-toolbar`, `finance-toolbar`, `resume-toolbar`); anything
 * else that has to get out of the keyboard's way reads it from here rather than
 * inventing its own listener.
 *
 * Reanimated has no keyboard on web — `use-keyboard-inset.web.ts` returns flat
 * zeroes there and lets the browser do its own scrolling.
 */

/**
 * Bottom padding for the container of a bottom-anchored surface, so the surface
 * sits on top of the keyboard instead of under it.
 *
 * `ownBottomPadding` is whatever safe-area padding the surface already carries.
 * While the keyboard is up it covers the navigation bar, so that padding is
 * dead space and is subtracted rather than stacked — otherwise the sheet floats
 * a gesture bar's worth too high.
 *
 * Padding rather than a transform on purpose: it shrinks the box the sheet is
 * laid out in, so a tall sheet can shrink with it (see the `flexShrink` chain at
 * each call site) instead of sliding its own header off the top of the screen.
 */
export function useKeyboardPadding(ownBottomPadding = 0) {
  const keyboard = useAnimatedKeyboard();
  return useAnimatedStyle(() => ({
    paddingBottom: Math.max(0, keyboard.height.value - ownBottomPadding),
  }));
}

/**
 * Height for a spacer at the end of a scrollable form: it gives the last fields
 * somewhere to scroll to, so they can come out from under the keyboard at all.
 * Pair it with `useKeyboardReveal`, which does the scrolling.
 */
export function useKeyboardSpacer() {
  const keyboard = useAnimatedKeyboard();
  return useAnimatedStyle(() => ({ height: keyboard.height.value }));
}

/**
 * The same inset as a plain number, for code that has to do arithmetic with it
 * rather than hand it to a style — reading it here keeps that arithmetic on the
 * one signal the rest of the app moves by.
 *
 * `Keyboard.addListener`'s `endCoordinates.height` is the obvious alternative
 * and is *not* interchangeable: under edge-to-edge it is measured against a
 * window RN thinks never changed, and comes back short of the inset the sheets
 * and toolbars are actually moving by. Mixing the two is how a form scrolls in
 * the right direction and still stops under the keyboard.
 *
 * Returns a ref rather than state on purpose: this changes every frame while
 * the keyboard animates, and nothing wants to re-render at that rate.
 * `onSettle` fires once the keyboard has finished opening, which is the moment
 * the number is worth acting on.
 */
export function useKeyboardHeight(onSettle?: () => void): RefObject<number> {
  const height = useRef(0);
  const settle = useRef(onSettle);
  useEffect(() => {
    settle.current = onSettle;
  }, [onSettle]);

  const report = useCallback((next: number, settled: boolean) => {
    height.current = next;
    if (settled && next > 0) settle.current?.();
  }, []);

  const keyboard = useAnimatedKeyboard();
  useAnimatedReaction(
    () => ({ height: keyboard.height.value, state: keyboard.state.value }),
    (current, previous) => {
      if (current.height === previous?.height && current.state === previous?.state) return;
      runOnJS(report)(current.height, current.state === KeyboardState.OPEN);
    },
  );

  return height;
}
