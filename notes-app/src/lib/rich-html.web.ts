/**
 * HTML ⇄ HTML normalization between TipTap's serialization and the canonical
 * stored format the native `react-native-enriched` editor reads/writes.
 *
 * This is NOT a markdown translation — both sides are the same rich-text HTML
 * family; markdown is only a live typing transform inside the editor. The only
 * shaping needed is (a) the checkbox-list dialect (TipTap emits
 * `<ul data-type="taskList">` / `<li data-type="taskItem" data-checked>`; native
 * wants `<ul data-type="checkbox">` / `<li checked>`), (b) stripping the `<p>`
 * TipTap wraps list items in, and (c) the `<html>…</html>` wrapper native needs.
 * The transforms mirror the enriched library's own web normalizers, so a
 * web-edited body renders identically on mobile.
 *
 * Web-only: leans on the browser DOM; imported solely from `*.web` files.
 */

import { encodeSignificantSpaces } from '@/lib/html-space';
import { canonicalizeNoteImages } from '@/lib/note-images';

/** Elements whose text runs as one line, for deciding where a space "opens" one. */
const SPACE_BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th';

/** Stored native HTML → the HTML TipTap should parse when seeding the editor. */
export function storedHtmlToTiptap(html: string): string {
  if (!html || !html.trim()) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Native checkbox list → TipTap task list. Wrap each item's inline content in
  // a <p> (TipTap task items hold a paragraph) and map `checked` → `data-checked`.
  doc.querySelectorAll('ul[data-type="checkbox"]').forEach((ul) => {
    ul.setAttribute('data-type', 'taskList');
    ul.querySelectorAll('li').forEach((li) => {
      li.setAttribute('data-type', 'taskItem');
      if (li.hasAttribute('checked')) {
        li.setAttribute('data-checked', 'true');
        li.removeAttribute('checked');
      } else {
        li.setAttribute('data-checked', 'false');
      }
      li.innerHTML = `<p>${li.innerHTML}</p>`;
    });
  });

  // Native code block → TipTap code block. The dialect differs inside: native
  // runs every line of a block through the same paragraph writer as the rest of
  // the document, so a code block's lines arrive as `<p>` elements (and a blank
  // one as `<br>`), while TipTap's code block holds plain text with newlines in
  // it. Flattened here, and rebuilt on the way out.
  //
  // The indentation comes back as non-breaking spaces, because that is how a
  // leading run is stored (see html-space.ts) — decoded to ordinary spaces so
  // what is in the editor, and what gets copied out of it, is real whitespace.
  doc.querySelectorAll('codeblock').forEach((block) => {
    const lines: string[] = [];
    block.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        // Formatting whitespace between the line elements, not a line.
        const text = node.nodeValue ?? '';
        if (text.trim()) lines.push(text);
        return;
      }
      if (!(node instanceof Element)) return;
      lines.push(node.tagName === 'BR' ? '' : (node.textContent ?? ''));
    });
    block.textContent = lines.join('\n').replace(/ /g, ' ');
  });

  // Native blank lines are <br>; TipTap represents them as empty paragraphs.
  // After the code blocks above, so a blank line inside one stays inside it.
  return doc.body.innerHTML.replace(/<br\s*\/?>/gi, '<p></p>');
}

/** TipTap's `editor.getHTML()` → the canonical stored/synced native HTML body. */
export function tiptapHtmlToStored(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // TipTap task list → native checkbox list, flattening the item back to its
  // inline content (drop the <label><input> UI and the wrapping <div><p>).
  doc.querySelectorAll('ul[data-type="taskList"]').forEach((ul) => {
    ul.setAttribute('data-type', 'checkbox');
    ul.querySelectorAll('li[data-type="taskItem"]').forEach((li) => {
      if (li.getAttribute('data-checked') === 'true') li.setAttribute('checked', '');
      li.removeAttribute('data-type');
      li.removeAttribute('data-checked');
      const p = li.querySelector('div > p') ?? li.querySelector('p');
      li.innerHTML = p ? p.innerHTML : (li.textContent ?? '');
    });
  });

  // TipTap code block → the native dialect: one `<p>` per line, because native
  // writes a block's lines through the same paragraph writer as the rest of the
  // document. Built as elements rather than as a string so the code's own `<`
  // and `&` are escaped by the DOM instead of by hand.
  //
  // Deliberately before the whitespace walker below: each line is a `<p>` by
  // then, so a code block's indentation is pinned as non-breaking spaces by the
  // same rule as every other line — which is exactly how native stores it, and
  // what stops the indentation being eaten on the next parse.
  doc.querySelectorAll('codeblock').forEach((block) => {
    const lines = (block.textContent ?? '').split('\n');
    // A trailing newline is the editor's own line-break placeholder, not a line.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    block.textContent = '';
    for (const line of lines) {
      const paragraph = doc.createElement('p');
      paragraph.textContent = line;
      block.appendChild(paragraph);
    }
  });

  // Bullet/ordered items: strip the <p> wrapper native doesn't use. Done on the
  // tree rather than on the serialized string: the regex this replaces —
  // `/<li([^>]*)><p>(.*?)<\/p><\/li>/gs` — pairs the first `</p></li>` it finds
  // with the opening `<li>`, so one nested list mis-pairs the tags and it emits
  // structurally broken HTML. Unwrapping the node in place can't mis-pair, and
  // it keeps whatever follows the paragraph inside the item.
  //
  // The editor's own schema (`ListItemP`, content 'paragraph') means typed
  // content never nests, so this was latent — but a body can also arrive from
  // native or from an older version, and those carry no such guarantee.
  doc.querySelectorAll('li').forEach((li) => {
    const first = li.firstElementChild;
    if (first?.tagName === 'P') first.replaceWith(...Array.from(first.childNodes));
  });

  // Pin deliberate spaces as &nbsp; so neither the next load here nor the native
  // parser collapses them (see html-space.ts). Walked per text node, carrying
  // "ended in a space" across the inline marks that split one block's text.
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let block: Element | null = null;
  let afterSpace = true;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const owner = parent?.closest(SPACE_BLOCKS) ?? null;
    // Text outside a block is formatting whitespace; <pre> keeps its own spaces.
    if (!owner || parent?.closest('pre')) continue;
    if (owner !== block) {
      block = owner;
      afterSpace = true;
    }
    const text = node.nodeValue ?? '';
    if (!text) continue;
    const encoded = encodeSignificantSpaces(text, afterSpace);
    if (encoded !== text) node.nodeValue = encoded;
    afterSpace = encoded.endsWith(' ');
  }

  let out = doc.body.innerHTML;
  // Whole-number image dimensions. Android parses them with `Integer.parseInt`,
  // so a float — which is what iOS writes — takes the body down the degraded
  // path where its markup renders as literal text (see note-images.ts).
  out = canonicalizeNoteImages(out);
  out = out.replace(/checked=""/g, 'checked');
  out = out.replace(/<p><\/p>/g, '<br>');

  // Empty body (no text and no structural content) stores as '' — an empty note
  // has an empty body, not an empty <html> wrapper. A line of only spaces now
  // serializes as &nbsp;, which is still nothing.
  const text = out
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, '')
    .trim();
  // A code block counts as content even with nothing typed in it yet: one is
  // created empty, on purpose, to be typed into. Storing '' would make it
  // disappear on the next load.
  if (!text && !/<(ul|ol|img|hr|codeblock)\b/i.test(out)) return '';

  return `<html>${out}</html>`;
}
