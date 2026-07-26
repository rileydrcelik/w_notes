/**
 * `htmlToPlainText` flattens the rich editor's canonical HTML for previews,
 * clipboard copies and .txt export. It's a regex pipeline over untrusted-ish
 * input, so the interesting cases are structural (does a block become a line?)
 * and adversarial (what does malformed HTML do?).
 */
import { describe, expect, it } from 'vitest';

import { htmlToPlainText, plainTextToHtml } from '@/lib/html-text';

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

  it('decodes &amp; without double-decoding the result', () => {
    // `&amp;lt;` is the escaped form of the literal text "&lt;", so it must
    // flatten to "&lt;" and not be decoded a second time into "<". This is why
    // the `&amp;` replace runs last in the chain — it once ran first, and the
    // "&lt;" it produced was re-scanned by the rule below it.
    expect(htmlToPlainText('<p>&amp;lt;</p>')).toBe('&lt;');
    expect(htmlToPlainText('<p>&amp;amp;</p>')).toBe('&amp;');
    // The ordinary cases must keep working.
    expect(htmlToPlainText('<p>a &amp; b</p>')).toBe('a & b');
    expect(htmlToPlainText('<p>&lt;div&gt;</p>')).toBe('<div>');
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

/**
 * `plainTextToHtml` is the inbound half: text arriving from outside the app (a
 * clipboard paste, a dropped selection) has to become the canonical HTML the
 * editors read. The risk is escaping — pasted text that looks like markup must
 * survive as text, not become live tags.
 */
describe('plainTextToHtml', () => {
  it('returns an empty string for empty input', () => {
    expect(plainTextToHtml('')).toBe('');
  });

  it('wraps each line in its own paragraph', () => {
    expect(plainTextToHtml('one\ntwo')).toBe('<p>one</p><p>two</p>');
  });

  it('escapes markup so pasted text can never become live tags', () => {
    expect(plainTextToHtml('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    // Ampersands escape first, or the entity itself would be double-decoded.
    expect(plainTextToHtml('a & b')).toBe('<p>a &amp; b</p>');
    expect(plainTextToHtml('&lt;')).toBe('<p>&amp;lt;</p>');
  });

  it('keeps a blank line as a break rather than collapsing it', () => {
    expect(plainTextToHtml('a\n\nb')).toBe('<p>a</p><p><br></p><p>b</p>');
  });

  it('normalises Windows and classic-Mac line endings', () => {
    // Text pasted out of a Windows app arrives with CRLF.
    expect(plainTextToHtml('a\r\nb')).toBe('<p>a</p><p>b</p>');
    expect(plainTextToHtml('a\rb')).toBe('<p>a</p><p>b</p>');
  });

  it('round-trips back through htmlToPlainText', () => {
    const text = 'first line\nsecond & <third>';
    expect(htmlToPlainText(plainTextToHtml(text))).toBe(text);
  });
});
