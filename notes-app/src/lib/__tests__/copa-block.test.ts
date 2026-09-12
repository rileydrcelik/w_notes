/**
 * See `lib/copa-block.ts` for why these two rules read `fileName` rather than
 * `fileUri`. The case worth naming: a file block whose bytes are not on this
 * device — every one of them on web after a reload.
 */
import { describe, expect, it } from 'vitest';

import { isEmptyCopaBlock, isFileBlock } from '@/lib/copa-block';

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
