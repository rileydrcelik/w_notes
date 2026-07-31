/**
 * The resume screen's split breakpoint.
 *
 * `fitsSplitLayout` decides whether source and preview sit side by side or take
 * turns, which is the difference between two working layouts — so the edges are
 * worth pinning down. Both halves of the condition matter and each has a failure
 * mode of its own: too narrow gives two unusable columns, and a portrait window
 * can clear the width bar while having no business being halved.
 *
 * Pure, so it needs no renderer. It does live in a module that imports
 * `react-native` for the hook beside it, hence the stub.
 */
import { describe, expect, it, vi } from 'vitest';

import { fitsSplitLayout, SPLIT_MIN_WIDTH } from '@/lib/split-layout';

// Hoisted above both imports by vitest, which is why the factory is written out
// inline rather than built from `test/stubs/react-native`: a factory that closes
// over an imported helper runs before that import has been initialised.
// `split-layout.ts` only pulls these two names off react-native anyway.
vi.mock('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
  useWindowDimensions: () => ({ width: 1440, height: 900 }),
}));

describe('fitsSplitLayout', () => {
  it('splits a typical landscape desktop window', () => {
    expect(fitsSplitLayout(1440, 900)).toBe(true);
  });

  it('splits at exactly the threshold width', () => {
    // Inclusive: the constant is the narrowest window that *gets* the split, so
    // an off-by-one here would leave a window that should split refusing to.
    expect(fitsSplitLayout(SPLIT_MIN_WIDTH, 600)).toBe(true);
  });

  it('stacks one pixel below the threshold', () => {
    expect(fitsSplitLayout(SPLIT_MIN_WIDTH - 1, 600)).toBe(false);
  });

  it('stacks a phone', () => {
    expect(fitsSplitLayout(390, 844)).toBe(false);
  });

  it('stacks a portrait window that is wide enough', () => {
    // The case width alone would get wrong: 1000px clears the bar, but halving a
    // window taller than it is wide gives two columns too narrow to work in.
    expect(fitsSplitLayout(1000, 1200)).toBe(false);
  });

  it('stacks a square window', () => {
    // Landscape is `width > height`, not `>=` — a square window is not landscape.
    expect(fitsSplitLayout(1000, 1000)).toBe(false);
  });

  it('stacks a short but narrow window', () => {
    // Landscape by shape, still under the width bar: both conditions have to
    // hold, so passing one is not enough.
    expect(fitsSplitLayout(700, 400)).toBe(false);
  });
});
