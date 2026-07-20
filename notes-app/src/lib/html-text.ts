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
