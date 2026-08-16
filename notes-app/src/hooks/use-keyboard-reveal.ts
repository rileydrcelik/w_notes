import { useCallback, useEffect, useRef } from 'react';
import {
  TextInput,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from 'react-native';

import { Spacing } from '@/constants/theme';
import { useKeyboardHeight } from '@/hooks/use-keyboard-inset';

/**
 * Breathing room left between the field being typed into and the keyboard.
 * Wider than the `Spacing.two` the floating toolbars keep: they are chrome you
 * read past, this is the line you are writing, and a field flush against the
 * keys reads as clipped by them.
 */
const GAP = Spacing.four;

/**
 * Scrolls a form so the field you're typing into stays above the keyboard.
 *
 * On Android the window is edge-to-edge and the keyboard never resizes it (see
 * `use-keyboard-inset`), so a `ScrollView` has no idea the bottom third of it
 * just disappeared: tap a field near the end of a long form and you type into
 * something you can't see. This closes that gap.
 *
 * It measures the *focused* input rather than tracking each field, so a screen
 * only has to spread `scrollProps` onto its scroller and hand `reveal` to the
 * inputs' `onFocus`. Fields that open with `autoFocus` still need it wired: the
 * keyboard is usually already up by then, so nothing else announces them.
 *
 * The field and the scroller are measured with the *same* call, and only their
 * difference is used, so whatever a "window" means on this platform cancels
 * out. Comparing a `measureInWindow` against `useWindowDimensions` was the first
 * attempt and scrolled reliably short — the two disagree by a status bar under
 * edge-to-edge, and being off by almost-nothing is the worst kind of wrong.
 * (`measureLayout` against the content view was the second, and Fabric rejects
 * the only content handle `ScrollView` exposes: `getInnerViewNode` returns a
 * legacy numeric tag, which the new architecture won't measure against.)
 *
 * Pair it with `useKeyboardSpacer`: this hook decides where to scroll to, the
 * spacer is what makes that offset reachable at the end of the content.
 *
 * Do not spread this `scrollProps` and `useScrollToTop`'s onto the same list:
 * both carry a `ref` and an `onScroll`, so the second spread silently wins and
 * whichever hook lost stops working, with nothing to catch it at compile time.
 * A screen that needs both wants a merged handler, not two spreads.
 */
export function useKeyboardReveal() {
  const listRef = useRef<ScrollView>(null);
  /** Live scroll offset — `scrollTo` takes an absolute position, not a delta. */
  const offset = useRef(0);

  // The reveal reads the keyboard height, and the keyboard settling triggers the
  // reveal; the ref breaks that knot without making either depend on the other's
  // identity.
  const revealRef = useRef<() => void>(() => {});
  const keyboardHeight = useKeyboardHeight(() => revealRef.current());

  const reveal = useCallback(() => {
    const list = listRef.current;
    // The focused input, straight from RN, so nothing has to be wired per field.
    // Optional-chained: react-native-web's TextInput has no such helper, and web
    // browsers scroll a focused field into view on their own regardless.
    const input = TextInput.State?.currentlyFocusedInput?.();
    const scroller = list?.getNativeScrollRef?.();
    if (!list || !scroller || !input?.measureInWindow) return;
    scroller.measureInWindow((_sx, scrollerY, _sw, scrollerHeight) => {
      input.measureInWindow((_x, y, _width, height) => {
        // The lowest the field's bottom edge can sit and still be readable: the
        // bottom of the scroller, less whatever the keyboard is covering.
        const limit = scrollerY + scrollerHeight - keyboardHeight.current - GAP;
        const bottom = y + height;
        // Already clear of the keyboard — leave the scroll where the user put it.
        if (bottom <= limit) return;
        list.scrollTo({ y: offset.current + (bottom - limit), animated: true });
      });
    });
  }, [keyboardHeight]);

  useEffect(() => {
    revealRef.current = reveal;
  }, [reveal]);

  const scrollProps = {
    ref: listRef,
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      offset.current = e.nativeEvent.contentOffset.y;
    },
    scrollEventThrottle: 16,
  };

  return { scrollProps, reveal };
}
