/**
 * `htmlToPlainText` flattens the rich editor's canonical HTML for previews,
 * clipboard copies and .txt export. It's a regex pipeline over untrusted-ish
 * input, so the interesting cases are structural (does a block become a line?)
 * and adversarial (what does malformed HTML do?).
 */
import { describe, expect, it } from 'vitest';

import { htmlToPlainText } from '@/lib/html-text';

describe('htmlToPlainText', () => {
  it('returns an empty string for empty input', () => {
    expect(htmlToPlainText('')).toBe('');
  });

  it('passes plain text through unchanged', () => {
    // Notes saved before the rich editor hold bare text, not HTML.
    expect(htmlToPlainText('just some text')).toBe('just some text');
  });

  it('strips inline formatting but keeps the words', () => {
    expect(htmlToPlainText('<p>hello <strong>bold</strong> and <em>italic</em></p>')).toBe(
      'hello bold and italic',
    );
  });

  it('gives each block its own line', () => {
    expect(htmlToPlainText('<p>one</p><p>two</p><h1>three</h1>')).toBe('one\ntwo\nthree');
  });

  it('turns <br> into a line break', () => {
    expect(htmlToPlainText('<p>one<br>two</p>')).toBe('one\ntwo');
    expect(htmlToPlainText('<p>one<br/>two</p>')).toBe('one\ntwo');
  });

  it('marks list items with a bullet', () => {
    expect(htmlToPlainText('<ul><li>first</li><li>second</li></ul>')).toBe('• first\n• second');
  });

  it('marks checkbox items by checked state', () => {
    const html =
      '<ul data-type="checkbox"><li checked>done</li><li>pending</li></ul>';
    expect(htmlToPlainText(html)).toBe('☑ done\n☐ pending');
  });

  it('decodes the entities the editor emits', () => {
    expect(htmlToPlainText('<p>&lt;tag&gt; &amp; &quot;quoted&quot; &#39;apos&#39;</p>')).toBe(
      '<tag> & "quoted" \'apos\'',
    );
    expect(htmlToPlainText('<p>a&nbsp;b</p>')).toBe('a b');
  });

  // KNOWN BUG — `it.fails` asserts this currently *does* the wrong thing, so the
  // suite stays green while the bug is open and turns red the moment it's fixed.
  //
  // `&amp;lt;` is the escaped form of the literal text "&lt;", so it should
  // flatten to "&lt;". Instead it comes out as "<": htmlToPlainText decodes
  // `&amp;` → `&` *before* `&lt;` → `<`, so the "&lt;" it just produced is
  // re-scanned by the next replace and decoded a second time.
  //
  // Fix: move the `&amp;` replace to *last* in the chain, after the others.
  // Then nothing it produces can be re-decoded. Delete `.fails` when fixed.
  //
  // Impact is cosmetic but real: a note discussing HTML entities renders wrong
  // in previews, clipboard copies and .txt exports.
  it.fails('decodes &amp; without double-decoding the result', () => {
    expect(htmlToPlainText('<p>&amp;lt;</p>')).toBe('&lt;');
  });

  it('collapses runs of whitespace and drops blank lines', () => {
    expect(htmlToPlainText('<p>a    b</p><p></p><p>c</p>')).toBe('a b\nc');
  });

  it('trims leading and trailing whitespace overall', () => {
    expect(htmlToPlainText('  <p>  padded  </p>  ')).toBe('padded');
  });

  it('drops a tag that is never closed rather than swallowing the text', () => {
    // Malformed input reaches this function via paste and older saved bodies.
    expect(htmlToPlainText('<p>before<span>after</p>')).toBe('beforeafter');
  });

  it('keeps angle brackets that arrive as entities rather than tags', () => {
    expect(htmlToPlainText('<p>5 &lt; 10 and 10 &gt; 5</p>')).toBe('5 < 10 and 10 > 5');
  });

  it('handles a nested list without losing items', () => {
    const html = '<ul><li>outer<ul><li>inner</li></ul></li></ul>';
    expect(htmlToPlainText(html)).toBe('• outer\n• inner');
  });
});
