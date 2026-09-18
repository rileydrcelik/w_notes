/**
 * See `lib/copa-block.ts` for why these two rules read `fileName` rather than
 * `fileUri`. The case worth naming: a file block whose bytes are not on this
 * device — every one of them on web after a reload.
 */
import { describe, expect, it } from 'vitest';

import { DRAFT_COPA_ID, isEmptyCopaBlock, isFileBlock } from '@/lib/copa-block';

/** A file block as it arrives on a device that hasn't fetched the bytes. */
const pulledFile = { fileName: 'report.pdf', fileUri: null, label: 'report.pdf', content: '' };
/** The same block on the device that attached it. */
const localFile = { fileName: 'report.pdf', fileUri: 'file:///docs/report.pdf', label: '', content: '' };

describe('isFileBlock', () => {
  it('is true once the bytes are here', () => {
    expect(isFileBlock(localFile)).toBe(true);
  });

  it('is true for a file whose bytes are not here yet — it is still a file', () => {
    // Judged on fileUri this said "no", and the feed drew a real attachment as
    // an empty text tile.
    expect(isFileBlock(pulledFile)).toBe(true);
  });

  it('is false for a text block', () => {
    expect(isFileBlock({ label: 'ssh key', content: '<p>ssh-rsa</p>' })).toBe(false);
  });
});

describe('isEmptyCopaBlock', () => {
  it('is false for a file block with no text, on the device that has the bytes', () => {
    expect(isEmptyCopaBlock(localFile, '', '')).toBe(false);
  });

  it('is false for a file block whose bytes are elsewhere — deleting it was the bug', () => {
    expect(isEmptyCopaBlock(pulledFile, '', '')).toBe(false);
  });

  it('is true for a block with neither a title nor any text', () => {
    expect(isEmptyCopaBlock({}, '', '')).toBe(true);
  });

  it('is true when the body is markup carrying no words', () => {
    expect(isEmptyCopaBlock({}, '', '<html><p></p></html>')).toBe(true);
  });

  it('is false once it has a title, even with an empty body', () => {
    expect(isEmptyCopaBlock({}, 'ssh key', '')).toBe(false);
  });

  it('is false once it has text, even with no title', () => {
    expect(isEmptyCopaBlock({}, '', '<p>ssh-rsa AAAA</p>')).toBe(false);
  });

  it('treats whitespace as empty', () => {
    expect(isEmptyCopaBlock({}, '   ', '<p>   </p>')).toBe(true);
  });

  it('reads the passed text, not the stored row, so a mid-edit block is judged on screen', () => {
    const stored = { label: '', content: '' };
    expect(isEmptyCopaBlock(stored, 'typed just now', '')).toBe(false);
  });
});

/**
 * `app/copa/[id].tsx`'s `promote()` gates the draft→real-row write with this
 * exact call: `isEmptyCopaBlock({}, nextLabel, nextContent)` — no stored block
 * at all, because a draft has no row yet. This is the call that decides whether
 * a keystroke ever reaches `createCopa()`, so it's pinned on the literal `{}`
 * shape rather than the `localFile`/`pulledFile` fixtures above, and on the
 * specific inputs a real keyboard/editor can actually produce: a title that's
 * pure whitespace, and the bare `<p></p>` an empty rich editor serializes to
 * (as opposed to the `<html>`-wrapped variant already covered above).
 */
describe('the promote gate (isEmptyCopaBlock({}, label, content), as promote() calls it)', () => {
  it('a freshly opened draft — both fields untouched — is empty', () => {
    expect(isEmptyCopaBlock({}, '', '')).toBe(true);
  });

  it('a title of only whitespace, with the editor still on its empty paragraph', () => {
    expect(isEmptyCopaBlock({}, '   ', '<p></p>')).toBe(true);
  });

  it('tabs and newlines count as whitespace too, not just spaces', () => {
    expect(isEmptyCopaBlock({}, '\t\n  \n', '')).toBe(true);
  });

  it('an empty paragraph carrying only a non-breaking space still flattens to nothing', () => {
    expect(isEmptyCopaBlock({}, '', '<p>&nbsp;</p>')).toBe(true);
  });

  it('a real title over the bare empty paragraph promotes the draft', () => {
    expect(isEmptyCopaBlock({}, 'ssh key', '<p></p>')).toBe(false);
  });

  it('real body text under a whitespace-only title also promotes the draft', () => {
    expect(isEmptyCopaBlock({}, '   ', '<p>ssh-rsa AAAA</p>')).toBe(false);
  });
});

describe('DRAFT_COPA_ID', () => {
  it('is the sentinel both the create paths and the copa screen route on', () => {
    // Pinned to the literal value: the e2e suite asserts the URL against
    // `/\/copa\/new$/` directly rather than importing this constant, so the
    // two can silently drift apart if this ever changes without the string
    // being grepped for everywhere it's hardcoded.
    expect(DRAFT_COPA_ID).toBe('new');
  });
});

describe('isEmptyCopaBlock and images', () => {
  it('does not call a block holding only a picture empty', () => {
    // htmlToPlainText strips tags, so an image-only body flattens to ''. Left to
    // that, the first thing anyone does with image insertion — paste a
    // screenshot, type nothing, leave the screen — deletes the block, and copa
    // has no trash.
    expect(
      isEmptyCopaBlock(
        { fileName: null, fileUri: null },
        '',
        '<html><p><img src="wn-img:img-abc" width="720" height="405"></p></html>',
      ),
    ).toBe(false);
  });

  it('still calls a block with no text and no picture empty', () => {
    expect(isEmptyCopaBlock({ fileName: null, fileUri: null }, '', '<html><p></p></html>')).toBe(
      true,
    );
  });
});
