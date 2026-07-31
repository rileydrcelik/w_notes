import { Platform, useWindowDimensions } from 'react-native';

/**
 * When a screen can show its source and its rendered output side by side instead
 * of one at a time.
 *
 * The resume screen is the first to want this. Everywhere else, a document is a
 * read view you tap into — there's only ever one thing on screen, so "edit" and
 * "view" are the same rectangle at different times. A LaTeX resume is the one
 * document whose source and output are *different documents*: you write `\item`
 * and you want to see where the line lands on the page. Splitting them is only
 * possible where there's room for both, which in practice means a desktop
 * browser window.
 *
 * Below the threshold — a phone, a tablet, a narrow or portrait browser window —
 * the screen keeps its modal behaviour untouched.
 */

/**
 * Narrowest window that gets two panes. Each pane is half of this minus the
 * divider and padding, which leaves the source column wide enough for a LaTeX
 * line like `\resumeSubheading{...}{...}{...}{...}` to wrap somewhere sensible,
 * and the preview wide enough for a page to be legible rather than a thumbnail.
 */
export const SPLIT_MIN_WIDTH = 900;

/**
 * Whether a window of this size gets the split layout. Landscape is part of the
 * question and not just width: a tall narrow-ish window has the room to stack
 * but not to sit side by side, and halving it would give two unusable columns.
 *
 * Pure, and separate from the hook, so the breakpoint is unit-testable without a
 * renderer — same split as `lib/grid.ts`.
 */
export function fitsSplitLayout(width: number, height: number): boolean {
  return width >= SPLIT_MIN_WIDTH && width > height;
}

/**
 * Whether the current window should use the split layout. Web only: the
 * threshold above is reachable on a landscape tablet, but there the keyboard
 * takes half the screen the moment you touch the source, which would leave the
 * preview a sliver. That's a decision to revisit with a real device, not to
 * guess at from a width.
 */
export function useSplitLayout(): boolean {
  const { width, height } = useWindowDimensions();
  return Platform.OS === 'web' && fitsSplitLayout(width, height);
}
