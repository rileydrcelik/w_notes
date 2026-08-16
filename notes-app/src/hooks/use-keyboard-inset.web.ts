import { useRef, type RefObject } from 'react';
import type { ViewStyle } from 'react-native';

/**
 * Web half of {@link file://./use-keyboard-inset.ts}. There is no on-screen
 * keyboard to avoid in a browser — and reanimated's `useAnimatedKeyboard` isn't
 * implemented on web, where it logs "useAnimatedKeyboard is not available on
 * web yet" and reports zero anyway — so both hooks flatten to nothing and the
 * browser keeps handling focus scrolling itself.
 *
 * Every name exported here must match the native file exactly; a missing one is
 * a runtime crash on the platform that resolves to it, not a type error.
 */

const NONE: ViewStyle = {};
const NO_HEIGHT: ViewStyle = { height: 0 };

export function useKeyboardPadding(_ownBottomPadding = 0): ViewStyle {
  return NONE;
}

export function useKeyboardSpacer(): ViewStyle {
  return NO_HEIGHT;
}

/** Always zero, and `onSettle` never fires — there is no keyboard to settle. */
export function useKeyboardHeight(_onSettle?: () => void): RefObject<number> {
  return useRef(0);
}
