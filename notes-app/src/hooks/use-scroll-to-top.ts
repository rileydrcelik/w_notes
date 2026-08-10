import { useCallback, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import { noScrollbar } from '@/lib/scroll-style';

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
 * Spread `scrollProps` onto the list (it carries the ref, the scroll listener
 * and {@link noScrollbar}) and pass `scrolled`/`scrollToTop` to the button. The
 * generic names the container so its own ref type stays intact:
 *
 * ```tsx
 * const { scrollProps, scrolled, scrollToTop } = useScrollToTop<FlatList<Item>>();
 * <FlatList {...scrollProps} … />
 * <ScrollToTopButton visible={scrolled} onPress={scrollToTop} />
 * ```
 *
 * `listRef` is the same container, for a screen that needs to drive it itself.
 */
export function useScrollToTop<T extends ScrollTarget>() {
  const ref = useRef<T | null>(null);
  const [scrolled, setScrolled] = useState(false);
  // Mirrors `scrolled` so the listener can tell whether the threshold was
  // actually crossed without depending on (and being rebuilt by) the state.
  const scrolledRef = useRef(false);
  // The last container this hook was attached to, kept across the detach that
  // precedes a remount — see `attach`, which needs to compare against it after
  // React has already cleared `ref`.
  const attached = useRef<T | null>(null);

  const setScrolledOnce = useCallback((next: boolean) => {
    if (next === scrolledRef.current) return;
    scrolledRef.current = next;
    setScrolled(next);
  }, []);

  /**
   * Holds the container, and resets on a *replacement* of it.
   *
   * The grid lists are keyed by their column count, because React Native
   * refuses an in-place `numColumns` change — so crossing a resize breakpoint
   * destroys the list and recreates it at offset 0. This state lives in the
   * parent and survives that untouched, which left the button floating over a
   * list already at the top with no scroll event coming to correct it. A new
   * node arriving where an old one was is the one signal that says it happened,
   * whatever the cause, so no screen has to remember to report it.
   */
  const attach = useCallback(
    (node: T | null) => {
      ref.current = node;
      // The detach half of a remount: keep `attached` so the node that follows
      // can be recognised as a different one.
      if (!node) return;
      if (attached.current && attached.current !== node) setScrolledOnce(false);
      attached.current = node;
    },
    [setScrolledOnce],
  );

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
    scrollProps: { ref: attach, onScroll, scrollEventThrottle: THROTTLE, ...noScrollbar },
    /** The attached container, for a screen that scrolls it for its own reasons. */
    listRef: ref,
    /** True once the content is scrolled far enough to offer a jump back up. */
    scrolled,
    scrollToTop,
  };
}
