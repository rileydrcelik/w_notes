import { useCallback, useRef, useState } from 'react';

/**
 * Whatever the platform hands a scroll listener — the shapes genuinely differ,
 * so this is narrowed at runtime by {@link scrollOffsetY} rather than typed.
 *
 * A `ScrollView` gives a React Native synthetic event on every platform, because
 * react-native-web normalises that one. A multiline `TextInput` on web does not:
 * RNW lists `onScroll` as a *forwarded* prop, which means it goes straight to
 * the underlying `<textarea>` and the handler receives a DOM scroll event with
 * no `contentOffset` anywhere in it. Forwarded is not the same as normalised.
 */
export type ScrollOffsetEvent = unknown;

/**
 * How far down a scroll container is, from either shape of event. Returns 0
 * rather than throwing on an event with neither, because this runs on every
 * scroll frame and a broken fade must never take a screen down with it.
 */
export function scrollOffsetY(event: ScrollOffsetEvent): number {
  const shape = event as {
    nativeEvent?: { contentOffset?: { y?: unknown } };
    currentTarget?: { scrollTop?: unknown } | null;
    target?: { scrollTop?: unknown } | null;
  };
  // React Native (and RNW's ScrollView).
  const offset = shape?.nativeEvent?.contentOffset?.y;
  if (typeof offset === 'number') return offset;
  // A DOM element, i.e. the textarea behind a multiline TextInput on web.
  const domTarget = shape?.currentTarget?.scrollTop ?? shape?.target?.scrollTop;
  return typeof domTarget === 'number' ? domTarget : 0;
}

/**
 * Past this many pixels the content counts as "moved". Deliberately tiny: this
 * drives the top fade, which should appear the moment the first line slides
 * under the header — not after a threshold like the back-to-top button's, which
 * is asking a different question ("is scrolling back worth offering?").
 */
const MOVED_PAST = 2;

/**
 * Scroll events here only decide a boolean, so they don't need per-frame
 * resolution — and state is only set when the boolean actually flips.
 */
const THROTTLE = 32;

/**
 * Tracks whether a scroll container has moved off its top, for {@link TopFade}.
 *
 * ```tsx
 * const { scrolled, scrollProps } = useScrolled();
 * <ScrollView {...scrollProps}>…</ScrollView>
 * <TopFade visible={scrolled} />
 * ```
 *
 * Works for a multiline `TextInput` too — react-native-web forwards `onScroll`
 * to the underlying textarea, and native emits it for multiline fields.
 */
export function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  // Mirrors the state so the listener can tell whether the boundary was actually
  // crossed without depending on (and being rebuilt by) the state itself.
  const scrolledRef = useRef(false);

  const onScroll = useCallback((event: ScrollOffsetEvent) => {
    const next = scrollOffsetY(event) > MOVED_PAST;
    if (next === scrolledRef.current) return;
    scrolledRef.current = next;
    setScrolled(next);
  }, []);

  return {
    /** True once the content has moved off the top. */
    scrolled,
    /** Spread onto the ScrollView / TextInput. */
    scrollProps: { onScroll, scrollEventThrottle: THROTTLE },
  };
}
