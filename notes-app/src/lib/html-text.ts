/**
 * Flatten the rich editor's HTML body into plain text for note/copa previews
 * and clipboard copies. Each block (paragraph, list item, heading, quote, …)
 * becomes its own line, list items keep a bullet marker, the remaining tags are
 * dropped, and the handful of entities the parser emits are decoded. Plain
 * (non-HTML) bodies — e.g. notes saved before the rich editor — pass through
 * essentially unchanged.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return '';
  return html
    // Checkbox lists first, while the `data-type="checkbox"` wrapper is intact,
    // so their items get a box (☑/☐) instead of a plain bullet.
    .replace(/<ul\b[^>]*\bdata-type=["']?checkbox["']?[^>]*>([\s\S]*?)<\/ul>/gi, (_m, inner) =>
      inner.replace(/<li\b[^>]*\bchecked\b[^>]*>/gi, '\n☑ ').replace(/<li\b[^>]*>/gi, '\n☐ '),
    )
    // Remaining (bulleted/ordered) list items get a bullet. Each starts a line.
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // `&amp;` goes last, always. Decoding it first would turn `&amp;lt;` — the
    // escaped form of the literal text "&lt;" — into `&lt;`, which the rules
    // above would then decode a second time into "<". Running it last means
    // nothing it produces can be re-scanned.
    .replace(/&amp;/g, '&')
    // Tidy up: collapse runs of spaces, drop blank lines, trim each line.
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

/**
 * Structural tags that carry no meaning as literal text in a note. Inline marks
 * (`<b>`, `<a>`, …) are left out on purpose: they're short, common in prose
 * about writing, and far weaker evidence than a stray `<li>`.
 */
const ESCAPED_BLOCK_TAG = /&lt;\/?(?:ul|ol|li|blockquote|pre|h[1-6]|table|tr|td|div)\b/i;

/**
 * Whether a stored body looks like it contains block markup that was escaped
 * instead of parsed — the fingerprint of a paste the native editor failed to
 * read.
 *
 * When `react-native-enriched`'s HTML parser throws on pasted markup it falls
 * back to inserting that markup into the buffer as literal text (iOS:
 * `InputHtmlParser.mm`'s `@catch`, which our own note at
 * `components/markdown-editor.tsx:106` already describes). The next serialize
 * escapes those angle brackets, so `<li>` becomes `&lt;li&gt;` in the canonical
 * body — and every renderer then faithfully decodes it back into a visible tag.
 * That is why the damage shows identically on web and on mobile: one corrupted
 * body, not two broken previews.
 *
 * A **signal, not a verdict.** A note genuinely written about HTML contains
 * `&lt;li&gt;` legitimately and would match this, which is exactly why nothing
 * here rewrites a body — repairing on this evidence would corrupt the honest
 * note to fix the damaged one. Use it to report and to ask, never to edit.
 */
export function hasEscapedBlockMarkup(html: string): boolean {
  return !!html && ESCAPED_BLOCK_TAG.test(html);
}

/**
 * Wrap plain text in the canonical rich-text HTML both editors read and write,
 * so text that arrives from outside the app (a clipboard paste, a dropped
 * selection) renders as real paragraphs instead of one escaped blob. Roughly the
 * inverse of `htmlToPlainText` for text that carries no formatting.
 */
export function plainTextToHtml(text: string): string {
  if (!text) return '';
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // An empty line still needs a <br> inside its paragraph, or the editors
    // collapse it away and the pasted spacing is lost.
    .map((line) => `<p>${escape(line) || '<br>'}</p>`)
    .join('');
}
