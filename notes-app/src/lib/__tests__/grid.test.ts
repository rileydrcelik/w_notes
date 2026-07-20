/**
 * Grid column arithmetic.
 *
 * `trailingSpacers` is what keeps a partial last row left-aligned at single-card
 * width instead of stretching its cards across the row — the bug that made
 * partial-row cards render too wide on web.
 *
 * It reads `GRID_COLUMNS`, which is computed from `Platform.OS` *while the module
 * body evaluates*. There's no way to change it after importing, so covering both
 * platforms means re-importing the module under a different mock. That's what
 * `vi.resetModules()` + `vi.doMock()` are for here.
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

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('react-native');
});

describe('trailingSpacers on phones (2 columns)', () => {
  it('adds none when the last row is full', async () => {
    const { trailingSpacers, GRID_COLUMNS } = await gridFor('ios');
    expect(GRID_COLUMNS).toBe(2);
    expect(trailingSpacers(4)).toBe(0);
  });

  it('adds one when a single card is left over', async () => {
    const { trailingSpacers } = await gridFor('ios');
    expect(trailingSpacers(5)).toBe(1);
  });

  it('adds none for an empty grid', async () => {
    // 0 % n is 0, and the guard must not turn that into a full row of spacers.
    const { trailingSpacers } = await gridFor('ios');
    expect(trailingSpacers(0)).toBe(0);
  });
});

describe('trailingSpacers on web (5 columns)', () => {
  it('uses five columns', async () => {
    const { GRID_COLUMNS } = await gridFor('web');
    expect(GRID_COLUMNS).toBe(5);
  });

  it('fills out a partial last row', async () => {
    const { trailingSpacers } = await gridFor('web');
    expect(trailingSpacers(1)).toBe(4);
    expect(trailingSpacers(3)).toBe(2);
    expect(trailingSpacers(7)).toBe(3);
  });

  it('adds none when the count is an exact multiple', async () => {
    const { trailingSpacers } = await gridFor('web');
    expect(trailingSpacers(5)).toBe(0);
    expect(trailingSpacers(10)).toBe(0);
  });

  it('always completes the row', async () => {
    // The property behind the specific cases: count + spacers is always a whole
    // number of rows, for every count.
    const { trailingSpacers, GRID_COLUMNS } = await gridFor('web');
    for (let count = 0; count < 50; count++) {
      expect((count + trailingSpacers(count)) % GRID_COLUMNS).toBe(0);
    }
  });
});

describe('gridEdgePadding', () => {
  it('is empty on phones and adds horizontal padding on web', async () => {
    expect(await gridFor('ios').then((m) => m.gridEdgePadding)).toEqual({});
    expect(await gridFor('web').then((m) => m.gridEdgePadding)).toHaveProperty(
      'paddingHorizontal',
    );
  });
});
