import { useCallback, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

/**
 * How far down (px) the user must scroll before the "back to top" button shows.
 * Roughly one grid row / a couple of paragraphs — far enough that the button
 * never appears on a list that barely overflows.
 */
const SHOW_AFTER = 240;

/**
 * Scroll events are only used to compare an offset against a threshold, so they
 * don't need per-frame resolution. A coarser interval keeps the JS thread quiet
 * while scrolling (state is only set when the threshold is actually crossed).
 */
const THROTTLE = 64;

/** The scroll containers this hook can drive: a FlatList or a ScrollView. */
type ScrollTarget = {
  scrollToOffset?: (params: { offset: number; animated?: boolean }) => void;
  scrollTo?: (params: { y: number; animated?: boolean }) => void;
};

/**
 * Wires a scroll container up to a {@link ScrollToTopButton}: tracks whether the
 * user has scrolled far enough for the button to be worth showing, and jumps
 * back to the top when it's pressed.
 *
 * Spread `scrollProps` onto the list (it carries the ref and the scroll
 * listener) and pass `scrolled`/`scrollToTop` to the button. The generic names
 * the container so its own ref type stays intact:
 *
 * ```tsx
 * const { scrollProps, scrolled, scrollToTop } = useScrollToTop<FlatList<Item>>();
 * <FlatList {...scrollProps} … />
 * <ScrollToTopButton visible={scrolled} onPress={scrollToTop} />
 * ```
 */
export function useScrollToTop<T extends ScrollTarget>() {
  const ref = useRef<T | null>(null);
  const [scrolled, setScrolled] = useState(false);
  // Mirrors `scrolled` so the listener can tell whether the threshold was
  // actually crossed without depending on (and being rebuilt by) the state.
  const scrolledRef = useRef(false);

  const setScrolledOnce = useCallback((next: boolean) => {
    if (next === scrolledRef.current) return;
    scrolledRef.current = next;
    setScrolled(next);
  }, []);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      setScrolledOnce(event.nativeEvent.contentOffset.y > SHOW_AFTER);
    },
    [setScrolledOnce],
  );

  const scrollToTop = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    // A FlatList offsets; a plain ScrollView takes a coordinate.
    if (node.scrollToOffset) node.scrollToOffset({ offset: 0, animated: true });
    else node.scrollTo?.({ y: 0, animated: true });
    // Hide the button immediately rather than waiting for the animated scroll to
    // report its way back to 0 — it has done its job the moment it's pressed.
    setScrolledOnce(false);
  }, [setScrolledOnce]);

  return {
    /** Spread onto the FlatList / ScrollView. */
    scrollProps: { ref, onScroll, scrollEventThrottle: THROTTLE },
    /** True once the content is scrolled far enough to offer a jump back up. */
    scrolled,
    scrollToTop,
  };
}
