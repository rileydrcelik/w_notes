/**
 * The document a note exports as when the format has to keep its formatting.
 *
 * Two sharp edges here. The first is the allowlist: it is the only thing
 * standing between a stored body and a document rendered inside the app's own
 * origin, so "unknown tag survives" and "handler attribute survives" are the
 * cases that matter. The second is the wrapper — bodies are stored as bare
 * `<html>…</html>` markup, and nesting that inside a real document's body is
 * malformed HTML, which is one of the documented ways iOS's printer returns a
 * blank page.
 */
import { describe, expect, it } from 'vitest';

import type { Note } from '@/data/notes';
import {
  buildNoteDocument,
  noteHasExportableContent,
  sanitizeNoteHtml,
} from '@/lib/note-html-export';

/** A note with only the fields these functions read. */
const note = (title: string, body = ''): Note => ({ title, body }) as Note;

describe('sanitizeNoteHtml', () => {
  it('keeps the formatting the editors can produce', () => {
    const body =
      '<h2>Heading</h2><p><b>bold</b> and <i>italic</i></p><ul><li>one</li></ul><blockquote>q</blockquote>';
    expect(sanitizeNoteHtml(body)).toBe(body);
  });

  it('strips the canonical <html> wrapper the editors write', () => {
    // Left in, it would nest a second <html> inside the document's <body>.
    expect(sanitizeNoteHtml('<html><p>Body</p></html>')).toBe('<p>Body</p>');
  });

  it('unwraps an unknown tag but keeps its text', () => {
    expect(sanitizeNoteHtml('<p>a <span class="x">b</span> c</p>')).toBe('<p>a b c</p>');
  });

  it('removes a script element along with its contents', () => {
    // Unwrapping rather than removing would spill the source in as visible text.
    expect(sanitizeNoteHtml('<p>a</p><script>alert(1)</script>')).toBe('<p>a</p>');
    expect(sanitizeNoteHtml('<p>a</p><script>alert(1)</script>')).not.toContain('alert');
  });

  it('drops event handlers and styling from a tag it keeps', () => {
    const out = sanitizeNoteHtml('<p onclick="steal()" style="color:red" class="x">hi</p>');
    expect(out).toBe('<p>hi</p>');
  });

  it('keeps a safe link but drops a javascript: one', () => {
    expect(sanitizeNoteHtml('<a href="https://example.com">x</a>')).toBe(
      '<a href="https://example.com">x</a>',
    );
    expect(sanitizeNoteHtml('<a href="javascript:steal()">x</a>')).toBe('<a>x</a>');
  });

  it('keeps an https image but drops a file:// one', () => {
    // A file:// source renders as a blank box on iOS rather than failing loudly.
    expect(sanitizeNoteHtml('<img src="https://e.com/a.png">')).toContain('src="https://e.com/a.png"');
    expect(sanitizeNoteHtml('<img src="file:///tmp/a.png">')).toBe('<img>');
  });

  it('keeps whole-number image dimensions and drops anything else', () => {
    // The print stylesheet lays images out from these; a CSS-ish value has no
    // business reaching a document rendered in the app's own origin.
    expect(sanitizeNoteHtml('<img src="https://e.com/a.png" width="800" height="450">'))
      .toBe('<img src="https://e.com/a.png" width="800" height="450">');
    expect(sanitizeNoteHtml('<img src="https://e.com/a.png" width="100%">'))
      .toBe('<img src="https://e.com/a.png">');
  });

  it('drops an unresolved note-image reference rather than printing a broken box', () => {
    // Exports resolve these to data: URIs first (inlineNoteImages). One that
    // arrives unresolved has no bytes on this device.
    expect(sanitizeNoteHtml('<img src="wn-img:abc" width="10" height="10">'))
      .toBe('<img width="10" height="10">');
  });

  it('renders a code block as a pre, not as a run-together paragraph', () => {
    // The canonical body carries <codeblock>, which no browser knows. Left
    // alone the allowlist unwraps it and the code prints as ordinary prose.
    expect(sanitizeNoteHtml('<html><codeblock>const a = 1;</codeblock></html>'))
      .toBe('<pre>const a = 1;</pre>');
    // The shape the app actually stores: one <p> per line, a blank line as <br>.
    expect(sanitizeNoteHtml('<codeblock><p>a</p><br><p>b</p></codeblock>'))
      .toBe('<pre><p>a</p><br><p>b</p></pre>');
  });

  it('preserves the checkbox list markers the stylesheet keys off', () => {
    const out = sanitizeNoteHtml('<ul data-type="checkbox"><li checked>done</li><li>todo</li></ul>');
    expect(out).toBe('<ul data-type="checkbox"><li checked>done</li><li>todo</li></ul>');
  });

  it('neutralizes a tag carrying an unbalanced quote', () => {
    // The gap a review caught: with a stray quote the tag matched *nothing*, so
    // the allowlist never judged it and it reached the document verbatim —
    // event handlers included, in a page rendered in the app's own origin.
    expect(sanitizeNoteHtml('<img src=x onerror=alert(1) ">')).toBe('<img>');
    expect(sanitizeNoteHtml('<div onmouseover="alert(1)>hover me')).toBe('hover me');
    expect(sanitizeNoteHtml("<p onclick='alert(1)>x</p>")).toBe('<p>x</p>');
  });

  it('still keeps a > that lives inside a quoted attribute value', () => {
    // The guard against over-correcting the case above: a quoted value is tried
    // first, so a legitimate `>` inside one is part of the value, not the tag.
    expect(sanitizeNoteHtml('<a href="https://e.com/?a=>b">x</a>')).toBe(
      '<a href="https://e.com/?a=&gt;b">x</a>',
    );
  });

  it('drops an unclosed script rather than spilling its source as text', () => {
    // No closing tag means the paired rule never fires; removing just the tag
    // would leave `alert(1)` sitting in the document as visible prose.
    expect(sanitizeNoteHtml('<p>a</p><script>alert(1)')).toBe('<p>a</p>');
  });

  it('drops an unterminated comment rather than losing the rest of the note', () => {
    // Left in, a browser reads everything after `<!--` as comment, so the
    // export would silently end there.
    expect(sanitizeNoteHtml('<p>before</p><!-- <p>after</p>')).toBe('<p>before</p>');
  });

  it('is unbothered by an empty or missing body', () => {
    expect(sanitizeNoteHtml('')).toBe('');
  });
});

describe('buildNoteDocument', () => {
  it('produces a complete document, not a fragment', () => {
    const out = buildNoteDocument(note('Title', '<p>Body</p>'));
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain('</html>');
  });

  it('puts the title first, as a heading, then the formatted body', () => {
    const out = buildNoteDocument(note('Shopping', '<p><b>eggs</b></p>'));
    expect(out).toContain('<h1 class="note-title">Shopping</h1>');
    expect(out).toContain('<p><b>eggs</b></p>');
    expect(out.indexOf('note-title')).toBeLessThan(out.indexOf('<b>eggs</b>'));
  });

  it('omits the heading for an untitled note', () => {
    // A visible "Untitled note" heading would be worse than no heading.
    const out = buildNoteDocument(note('', '<p>Body</p>'));
    // The element, not the string: the stylesheet always carries a
    // `.note-title` rule, so a bare substring check could never fail.
    expect(out).not.toContain('<h1 class="note-title">');
    expect(out).toContain('<title>Untitled note</title>');
  });

  it('sets a code block\'s lines flush rather than paragraph-spaced', () => {
    const out = buildNoteDocument(note('T', '<codeblock><p>a</p><p>b</p></codeblock>'));
    expect(out).toMatch(/pre p\s*\{\s*margin:\s*0;?\s*\}/);
  });

  it('escapes a title containing markup', () => {
    const out = buildNoteDocument(note('a <b>c', '<p>x</p>'));
    expect(out).toContain('<h1 class="note-title">a &lt;b&gt;c</h1>');
  });

  it('keeps exactly one <html> element even though bodies carry their own', () => {
    const out = buildNoteDocument(note('T', '<html><p>Body</p></html>'));
    expect(out.match(/<html/g)).toHaveLength(1);
  });

  it('tolerates a null body', () => {
    // Rows synced from older clients can carry a null body.
    const out = buildNoteDocument({ title: 'T', body: null } as unknown as Note);
    expect(out).toContain('<h1 class="note-title">T</h1>');
  });
});

describe('noteHasExportableContent', () => {
  it('is true when there is a title or a body', () => {
    expect(noteHasExportableContent(note('T'))).toBe(true);
    expect(noteHasExportableContent(note('', '<p>Body</p>'))).toBe(true);
  });

  it('counts a body that is only an image, a rule or a list — as the store does', () => {
    // `htmlToPlainText` drops all three, but `rich-html.web.ts` saves a body
    // carrying one as real content. Refusing to export a note the app itself
    // stored and renders would be the wrong half of that disagreement.
    expect(noteHasExportableContent(note('', '<img src="https://e.com/a.png">'))).toBe(true);
    expect(noteHasExportableContent(note('', '<hr>'))).toBe(true);
    expect(noteHasExportableContent(note('', '<ul><li>a</li></ul>'))).toBe(true);
  });

  it('is false for a note that would export a blank page', () => {
    expect(noteHasExportableContent(note('', ''))).toBe(false);
    expect(noteHasExportableContent(note('   ', '<p></p>'))).toBe(false);
  });
});
