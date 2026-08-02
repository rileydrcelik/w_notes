/**
 * `htmlToPlainText` flattens the rich editor's canonical HTML for previews,
 * clipboard copies and .txt export. It's a regex pipeline over untrusted-ish
 * input, so the interesting cases are structural (does a block become a line?)
 * and adversarial (what does malformed HTML do?).
 */
import { describe, expect, it } from 'vitest';

import { hasEscapedBlockMarkup, htmlToPlainText, plainTextToHtml } from '@/lib/html-text';

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

  it('decodes an escaped block tag back into the literal string that renders as a visible tag', () => {
    // This is the exact mechanism behind the `hasEscapedBlockMarkup` fingerprint:
    // when the native HTML parser fails on a paste it stashes the raw markup as
    // literal text, the next serialize escapes it to `&lt;li&gt;`, and this
    // decode is what turns it back into a visible "<li>one</li>" on screen. If
    // this stops decoding `&lt;`/`&gt;`, the symptom stops reproducing and the
    // detector above loses its reason to exist — so this case is load-bearing,
    // not incidental.
    expect(htmlToPlainText('<p>&lt;li&gt;one&lt;/li&gt;</p>')).toBe('<li>one</li>');
  });
});

/**
 * `hasEscapedBlockMarkup` is a signal, not a verdict: it flags a body that
 * looks like it holds block tags the editor escaped instead of parsing, so the
 * app can report/ask about it. It must never fire on a healthy body that
 * simply contains real markup — that would flag every ordinary note with a
 * list — and it deliberately ignores inline tags as too weak a signal.
 */
describe('hasEscapedBlockMarkup', () => {
  it.each([
    ['<li>', '&lt;li&gt;'],
    ['<ul>', '&lt;ul&gt;'],
    ['closing </ul>', '&lt;/ul&gt;'],
    ['<blockquote>', '&lt;blockquote&gt;'],
    ['<h2>', '&lt;h2&gt;'],
    ['<pre>', '&lt;pre&gt;'],
    ['<table>', '&lt;table&gt;'],
    ['<div>', '&lt;div&gt;'],
  ])('detects an escaped %s tag', (_label, escaped) => {
    expect(hasEscapedBlockMarkup(`<p>before ${escaped} after</p>`)).toBe(true);
  });

  it('matches regardless of tag case', () => {
    expect(hasEscapedBlockMarkup('<p>&lt;LI&gt;</p>')).toBe(true);
  });

  it('does not flag a healthy body with real, unescaped markup', () => {
    // The most important negative: a real list must never trip this, or the
    // detector would fire on every ordinary note that has one.
    expect(hasEscapedBlockMarkup('<html><ul><li>one</li></ul></html>')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(hasEscapedBlockMarkup('')).toBe(false);
  });

  it('returns false for a body with no markup at all', () => {
    expect(hasEscapedBlockMarkup('just some plain text')).toBe(false);
  });

  it.each([
    ['<b>', '&lt;b&gt;'],
    ['<a href>', '&lt;a href&gt;'],
    ['<em>', '&lt;em&gt;'],
  ])('does not flag an escaped inline %s tag alone', (_label, escaped) => {
    expect(hasEscapedBlockMarkup(`<p>before ${escaped} after</p>`)).toBe(false);
  });

  it('returns true when a real list and escaped block markup are both present', () => {
    expect(
      hasEscapedBlockMarkup('<ul><li>real item</li></ul><p>&lt;blockquote&gt;</p>'),
    ).toBe(true);
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
