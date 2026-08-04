/**
 * Grid column arithmetic.
 *
 * Two separate jobs live here. `trailingSpacers` keeps a partial last row
 * left-aligned at single-card width instead of stretching its cards across the
 * row. `gridColumnsFor`/`gridColumnWidthFor` decide how many cards a row holds
 * and how wide each one is — which used to be a fixed five on web at every
 * window size, so a narrow window spent its entire width on gutters and empty
 * columns: 14px tiles at 390px, and exactly 0 at 320px, where the feed rendered
 * cards that could not be seen.
 *
 * The width cases below are the regression net for that. They are asserted as
 * plain arithmetic against a width argument rather than through a renderer,
 * because that is exactly what the bug was.
 *
 * `Platform.OS` is read inside these functions, so covering both platforms means
 * re-importing the module under a different mock — that's `vi.resetModules()` +
 * `vi.doMock()`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { platformFor } from '../../../test/stubs/react-native';

/** Import grid.ts fresh, with `Platform` mocked to the given platform. The mock
 *  has to cover `select` too — grid.ts pulls in the theme, which uses it. */
async function gridFor(os: 'ios' | 'web') {
  vi.resetModules();
  vi.doMock('react-native', () => ({
    Platform: platformFor(os),
    useWindowDimensions: () => ({ width: 1024, height: 768 }),
  }));
  return import('@/lib/grid');
}

/** Widths worth checking: desktop, laptop, tablet, and the narrow ones that broke. */
const WIDTHS = [1920, 1440, 1280, 1024, 960, 834, 768, 720, 600, 500, 414, 390, 360, 320, 300, 240];

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('react-native');
});

describe('trailingSpacers', () => {
  it('adds none when the last row is full', async () => {
    const { trailingSpacers } = await gridFor('ios');
    expect(trailingSpacers(4, 2)).toBe(0);
  });

  it('adds one when a single card is left over', async () => {
    const { trailingSpacers } = await gridFor('ios');
    expect(trailingSpacers(5, 2)).toBe(1);
  });

  it('adds none for an empty grid', async () => {
    // 0 % n is 0, and the guard must not turn that into a full row of spacers.
    const { trailingSpacers } = await gridFor('ios');
    expect(trailingSpacers(0, 2)).toBe(0);
  });

  it('fills out a partial last row', async () => {
    const { trailingSpacers } = await gridFor('web');
    expect(trailingSpacers(1, 5)).toBe(4);
    expect(trailingSpacers(3, 5)).toBe(2);
    expect(trailingSpacers(7, 5)).toBe(3);
  });

  it('adds none when the count is an exact multiple', async () => {
    const { trailingSpacers } = await gridFor('web');
    expect(trailingSpacers(5, 5)).toBe(0);
    expect(trailingSpacers(10, 5)).toBe(0);
  });

  it('always completes the row, at every column count', async () => {
    // The property behind the specific cases: count + spacers is always a whole
    // number of rows. Swept across column counts now that it varies with width —
    // spacers computed against a different count than the list renders with
    // leave a partial row short or pad it into a phantom extra one.
    const { trailingSpacers } = await gridFor('web');
    for (let columns = 2; columns <= 5; columns++) {
      for (let count = 0; count < 50; count++) {
        expect((count + trailingSpacers(count, columns)) % columns).toBe(0);
      }
    }
  });
});

describe('gridColumnsFor', () => {
  it('keeps phones at two columns whatever the width', async () => {
    const { gridColumnsFor } = await gridFor('ios');
    for (const w of WIDTHS) expect(gridColumnsFor(w)).toBe(2);
  });

  it('still shows five columns on a desktop window', async () => {
    // The established look, which this change must not disturb.
    const { gridColumnsFor } = await gridFor('web');
    expect(gridColumnsFor(1920)).toBe(5);
    expect(gridColumnsFor(1440)).toBe(5);
  });

  it('sheds columns as the window narrows', async () => {
    const { gridColumnsFor } = await gridFor('web');
    expect(gridColumnsFor(1024)).toBe(4);
    expect(gridColumnsFor(768)).toBe(3);
    expect(gridColumnsFor(390)).toBe(2);
  });

  it('never drops below two columns', async () => {
    // Below two, `columnWrapperStyle` becomes invalid for the list and a note
    // grid degenerates into one tile per row.
    const { gridColumnsFor } = await gridFor('web');
    for (const w of [...WIDTHS, 200, 120, 1]) {
      expect(gridColumnsFor(w)).toBeGreaterThanOrEqual(2);
    }
  });

  it('never widens as the window narrows', async () => {
    const { gridColumnsFor } = await gridFor('web');
    const sorted = [...WIDTHS].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(gridColumnsFor(sorted[i])).toBeGreaterThanOrEqual(gridColumnsFor(sorted[i - 1]));
    }
  });
});

describe('copaColumnsFor', () => {
  it('keeps a phone on one full-width column', async () => {
    const { copaColumnsFor } = await gridFor('ios');
    for (const w of WIDTHS) expect(copaColumnsFor(w)).toBe(1);
  });

  it('leaves the desktop feed at the four columns it had', async () => {
    const { copaColumnsFor } = await gridFor('web');
    for (const w of [1920, 1440, 1280]) expect(copaColumnsFor(w)).toBe(4);
  });

  it('falls back to the phone layout in a phone-width window', async () => {
    // The bug: four columns at every width quartered a 390px window into ~77px
    // cards — worse here than in the note grid, since a copy block is a
    // paragraph of text in a card of fixed height.
    const { copaColumnsFor } = await gridFor('web');
    for (const w of [414, 390, 360, 320]) expect(copaColumnsFor(w)).toBe(1);
  });

  it('gives every card room to hold a paragraph', async () => {
    // A copa card is fixed-height and mostly text, so the floor that matters is
    // width per card, not merely "greater than zero".
    const { copaColumnsFor } = await gridFor('web');
    for (const w of WIDTHS) {
      const columns = copaColumnsFor(w);
      const padding = w >= 1280 ? 128 : w >= 960 ? 64 : w >= 720 ? 32 : 16;
      const card = (w - padding * 2 - 16 * (columns - 1)) / columns;
      expect(card).toBeGreaterThan(200);
    }
  });

  it('never widens as the window narrows', async () => {
    const { copaColumnsFor } = await gridFor('web');
    const sorted = [...WIDTHS].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(copaColumnsFor(sorted[i])).toBeGreaterThanOrEqual(copaColumnsFor(sorted[i - 1]));
    }
  });
});

describe('gridColumnWidthFor', () => {
  it('never returns a width a card cannot be drawn at', async () => {
    // The actual regression: the old arithmetic reached 0 at a 320px window and
    // went negative below it, which reads to the user as a feed of missing cards
    // rather than as a layout bug.
    const { gridColumnWidthFor } = await gridFor('web');
    for (const w of [...WIDTHS, 200, 120, 1]) {
      expect(gridColumnWidthFor(w)).toBeGreaterThan(0);
    }
  });

  it('gives a narrow window a usable tile, not a sliver', async () => {
    const { gridColumnWidthFor } = await gridFor('web');
    for (const w of [500, 414, 390, 360, 320]) {
      expect(gridColumnWidthFor(w)).toBeGreaterThan(100);
    }
  });

  it('leaves desktop tile sizes exactly as they were', async () => {
    // Pinned to the pre-change values so a future tweak to the breakpoints can't
    // silently reflow the desktop grid.
    const { gridColumnWidthFor } = await gridFor('web');
    expect(gridColumnWidthFor(1920)).toBe(320);
    expect(gridColumnWidthFor(1440)).toBe(224);
    expect(gridColumnWidthFor(1280)).toBe(192);
  });

  it('never lets a row overflow the window it is in', async () => {
    // columns * tile + gaps + both gutters must fit. An off-by-one here pushes
    // the last column out of view, which on web is a horizontal scrollbar the
    // design rules forbid.
    const { gridColumnsFor, gridColumnWidthFor } = await gridFor('web');
    for (const w of WIDTHS) {
      const columns = gridColumnsFor(w);
      const used = columns * gridColumnWidthFor(w) + 16 * (columns - 1);
      expect(used).toBeLessThanOrEqual(w);
    }
  });
});

/**
 * The second half of the same bug. Fixing the tile geometry gave narrow windows
 * real tiles, which then exposed that the text inside them was a fixed four
 * lines: four 20px lines plus the card's chrome need ~144px, and a 320px window
 * legitimately produces a 113px tile. The cell clips, so the surplus was cut
 * mid-line with no ellipsis.
 *
 * The chrome is restated here from the card styles rather than imported, so a
 * drift between `grid.ts` and `components/notes/cards*.tsx` fails a test instead
 * of quietly clipping again.
 */
const CARD_CHROME = 2 * 2 + 16 * 2 + 20 + 8; // borders + padding + title row + gap
const PREVIEW = { fontSize: 14, lineHeight: 20, max: 4 } as const;

describe('cardPreviewLines', () => {
  /** Tile height at a window width, the way the cards derive it. */
  async function tiles(os: 'ios' | 'web') {
    const grid = await gridFor(os);
    return (w: number) => Math.round(grid.gridColumnWidthFor(w) / grid.CARD_ASPECT_RATIO);
  }

  it('never lets the text run past the tile it sits in', async () => {
    // The property that matters: the ink of the last line stays inside the card.
    // Line boxes may overrun by their own (empty) leading, so the ink height is
    // lines * lineHeight minus that leading.
    const { cardPreviewLines } = await gridFor('web');
    const tileHeight = await tiles('web');
    const leading = (PREVIEW.lineHeight - PREVIEW.fontSize) / 2;
    for (const w of WIDTHS) {
      const tile = tileHeight(w);
      const lines = cardPreviewLines(tile, PREVIEW.fontSize, PREVIEW.lineHeight, PREVIEW.max);
      expect(lines * PREVIEW.lineHeight - leading).toBeLessThanOrEqual(tile - CARD_CHROME);
    }
  });

  it('sheds lines in the narrow windows that used to clip', async () => {
    // 360 gave a 130px tile against four lines' 144px, and 320 a 113px one.
    const { cardPreviewLines } = await gridFor('web');
    const tileHeight = await tiles('web');
    expect(cardPreviewLines(tileHeight(360), 14, 20, 4)).toBe(3);
    expect(cardPreviewLines(tileHeight(320), 14, 20, 4)).toBe(2);
  });

  it('keeps the full four lines wherever they already fit', async () => {
    // Desktop and phone-width tiles are unchanged — this fix only takes lines
    // away where they were being cut off anyway.
    const { cardPreviewLines } = await gridFor('web');
    const web = await tiles('web');
    for (const w of [1920, 1440, 1280, 1024, 768, 390]) {
      expect(cardPreviewLines(web(w), 14, 20, 4)).toBe(4);
    }
    const phone = await tiles('ios');
    for (const w of [390, 414, 428]) {
      expect(cardPreviewLines(phone(w), 14, 20, 4)).toBe(4);
    }
  });

  it('treats a narrow phone the same as a narrow window', async () => {
    // A 360px phone has the same 130px tile as a 360px browser and was clipping
    // its fourth line just as quietly; the count is derived from the tile, so
    // both shed it. The two platforms must not disagree about the same tile.
    const { cardPreviewLines } = await gridFor('web');
    const web = await tiles('web');
    const phone = await tiles('ios');
    expect(phone(360)).toBe(web(360));
    expect(cardPreviewLines(phone(360), 14, 20, 4)).toBe(3);
  });

  it('never grows past the maximum, however tall the tile', async () => {
    // A tablet in the phone layout gets a 400px+ tile; filling it with text
    // would turn a short excerpt into a wall of it.
    const { cardPreviewLines } = await gridFor('web');
    expect(cardPreviewLines(2000, 14, 20, 4)).toBe(4);
    expect(cardPreviewLines(2000, 11, 16, 3)).toBe(3);
  });

  it('returns zero rather than a negative count when nothing fits', async () => {
    // A negative numberOfLines is not "no lines" to React Native, and the card
    // hides the preview entirely on 0.
    const { cardPreviewLines } = await gridFor('web');
    expect(cardPreviewLines(CARD_CHROME, 14, 20, 4)).toBe(0);
    expect(cardPreviewLines(0, 14, 20, 4)).toBe(0);
    expect(cardPreviewLines(-100, 14, 20, 4)).toBe(0);
  });

  it('never widens as the window narrows', async () => {
    const { cardPreviewLines } = await gridFor('web');
    const tileHeight = await tiles('web');
    const sorted = [...WIDTHS].sort((a, b) => a - b);
    const linesAt = (w: number) => cardPreviewLines(tileHeight(w), 14, 20, 4);
    for (let i = 1; i < sorted.length; i++) {
      expect(linesAt(sorted[i])).toBeGreaterThanOrEqual(linesAt(sorted[i - 1]));
    }
  });
});
