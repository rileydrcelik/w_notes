/**
 * `encodeSignificantSpaces` decides which of a note's spaces survive the next
 * HTML parse. Get it wrong one way and indents vanish on reload; the other way
 * and every ordinary word gap turns into &nbsp;, churning bodies on sync.
 */
import { describe, expect, it } from 'vitest';

import { encodeSignificantSpaces } from '@/lib/html-space';

const NBSP = ' ';

describe('encodeSignificantSpaces', () => {
  it('pins a leading indent the way the Android editor writes it', () => {
    // Android stores "    x" as "&nbsp;&nbsp;&nbsp; x".
    expect(encodeSignificantSpaces('    indented', true)).toBe(`${NBSP}${NBSP}${NBSP} indented`);
  });

  it('pins a single leading space when it opens a block', () => {
    expect(encodeSignificantSpaces(' x', true)).toBe(`${NBSP}x`);
  });

  it('leaves a single leading space alone mid-block, after a non-space', () => {
    expect(encodeSignificantSpaces(' x', false)).toBe(' x');
  });

  it('leaves ordinary single spaces between words untouched', () => {
    expect(encodeSignificantSpaces('a b c', true)).toBe('a b c');
  });

  it('pins a run of spaces between words', () => {
    expect(encodeSignificantSpaces('a    b', false)).toBe(`a${NBSP}${NBSP}${NBSP} b`);
  });

  it('keeps existing non-breaking spaces as they are, so encoding is stable', () => {
    const once = encodeSignificantSpaces('    x  y', true);
    expect(encodeSignificantSpaces(once, true)).toBe(once);
  });

  it('returns empty text unchanged', () => {
    expect(encodeSignificantSpaces('', true)).toBe('');
  });
});
