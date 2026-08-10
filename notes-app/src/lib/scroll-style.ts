import type { ScrollViewProps } from 'react-native';

/**
 * Hides a scroll container's indicator, the native half of the app-wide "no
 * scrollbars" rule.
 *
 * `global.css` already takes the bar away on web. Native has its own, drawn by
 * the platform rather than by CSS and switched off per container, so the same
 * screen kept a bar on a phone that it never had in a browser — and a rule that
 * only holds on one platform isn't a design language, it's a coincidence. The
 * reasoning is the one in `global.css`: a bar is chrome the app never asked for,
 * cutting a hard edge through surfaces built to read as floating glass.
 *
 * Spread this onto every `ScrollView` / `FlatList`; `useScrollToTop` already
 * carries it, so a list wired to the back-to-top button needs nothing. Both keys
 * are set regardless of the container's axis — the one that doesn't apply costs
 * nothing, and it means no scroller can pick up a bar later by turning
 * `horizontal` on.
 *
 * Scrolling itself is untouched. Where a surface genuinely needs to say more
 * content lies below, design the signal — a fade, a peeking row — rather than
 * bringing a bar back.
 */
export const noScrollbar = {
  showsVerticalScrollIndicator: false,
  showsHorizontalScrollIndicator: false,
} satisfies Pick<
  ScrollViewProps,
  'showsVerticalScrollIndicator' | 'showsHorizontalScrollIndicator'
>;
