/**
 * Builds a standalone HTML document from a note's canonical rich-text body — the
 * shared source for both the `.html` export and, through the platform's own HTML
 * renderer, the PDF one. This is the half `.txt` throws away: `buildNoteText`
 * flattens the body to plain lines, so bold, headings, lists and quotes all
 * survive only here.
 *
 * String-only on purpose, exactly like `html-text.ts`. The same code runs on
 * native, on web and under vitest, and none of those three agree on having a
 * DOM to parse with.
 *
 * The body arrives as the wrapper the editors write (`rich-html.web.ts`), which
 * is markup, *not* a document — no `<head>`, no doctype. Nesting that inside a
 * real document's `<body>` would be malformed, and a malformed input is one of
 * the documented ways iOS's printer returns blank pages. The allowlist below
 * drops that wrapper on its way through, so what gets re-wrapped is the content
 * alone.
 */
import type { Note } from '@/data/notes';
import { htmlToPlainText } from '@/lib/html-text';
import { noteFileTitle } from '@/lib/note-export';

/**
 * The tag vocabulary the two editors can actually produce — web's tiptap schema
 * (`markdown-editor.web.tsx`) and native's `react-native-enriched` config. An
 * allowlist rather than a blocklist: anything outside it is dropped, which is
 * both the fidelity answer (nothing renders that the editors can't make) and
 * the safety one — on web this document is printed inside the app's own origin.
 *
 * `html` is deliberately *not* in the list. Bodies are stored wrapped in one,
 * and keeping it would nest a second `<html>` inside the exported document's
 * `<body>` — so it is dropped by the same rule as any other unknown tag. An
 * earlier draft also stripped the wrapper explicitly; that turned out to be
 * unreachable, which is how it was found: the test covering it could not be
 * made to fail.
 */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
  'code', 'pre', 'blockquote',
  'ul', 'ol', 'li',
  'a', 'img',
]);

/**
 * Attributes kept, per tag. Everything unlisted goes — including `style`,
 * `class`, and every `on*` handler, which is the part that matters.
 */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href']),
  img: new Set(['src', 'alt', 'width', 'height']),
  // Checkbox lists are `<ul data-type="checkbox"><li checked>` in the canonical
  // body — there is no `<input>` in the dialect, so the markers are drawn in CSS
  // and these two attributes are what the stylesheet keys off.
  ul: new Set(['data-type']),
  li: new Set(['checked', 'data-checked']),
};

const SAFE_HREF = /^(?:https?:|mailto:|#)/i;
/**
 * `data:` and `https:` only. A `file://` source renders as a blank box on iOS
 * (WKWebView refuses it), which is worse than dropping it — and the same goes
 * for the `wn-img:` reference a stored body actually carries. Callers resolve
 * those to `data:` URIs before exporting (`inlineNoteImages`); one that arrives
 * here unresolved has no bytes on this device, and is dropped rather than
 * printed as a broken box.
 */
const SAFE_SRC = /^(?:https:|data:image\/)/i;

/**
 * `<tag attrs>` where quoted attribute values may legally contain `>`.
 *
 * The final alternative is `[^>]`, **not** `[^>"']`. With the stricter class a
 * quote could only be consumed as half of a balanced pair, so a tag carrying a
 * stray quote — `<img src=x onerror=alert(1) ">` — matched nothing at all and
 * sailed through the sanitizer *verbatim*, handlers and all, into a document
 * this app renders in its own origin. Trying the quoted alternatives first
 * keeps well-formed markup byte-identical (a `>` inside `title="a>b"` is still
 * part of the value); the looser fallback only decides how far an unbalanced
 * tag reaches, and reaching the `>` is what lets the allowlist judge it.
 */
const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
const ATTR = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  // The value comes out of already-escaped markup, so `&` is left alone —
  // re-escaping it would turn a stored `&amp;` into a visible "&amp;".
  return value.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function keptAttributes(tag: string, raw: string): string {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed || !raw.trim()) return '';
  let out = '';
  for (const match of raw.matchAll(ATTR)) {
    const name = match[1].toLowerCase();
    if (!allowed.has(name)) continue;
    const quoted = match[2];
    const value = quoted ? quoted.replace(/^["']|["']$/g, '') : '';
    if (name === 'href' && !SAFE_HREF.test(value)) continue;
    if (name === 'src' && !SAFE_SRC.test(value)) continue;
    // Dimensions are laid out by the print stylesheet, so a non-numeric one is
    // just dropped rather than being allowed to carry a CSS-ish value through.
    if ((name === 'width' || name === 'height') && !/^\d+$/.test(value)) continue;
    // A bare boolean (`checked`) keeps its bare form; CSS matches it either way.
    out += quoted ? ` ${name}="${escapeAttr(value)}"` : ` ${name}`;
  }
  return out;
}

/**
 * Reduce a stored body to the known tag subset: unknown tags are unwrapped
 * (their text survives), script-like elements are removed with their contents,
 * and surviving tags keep only the attributes listed above.
 */
export function sanitizeNoteHtml(html: string): string {
  if (!html) return '';
  return html
    // The canonical body's code block is `<codeblock>` — the tag the native
    // editor reads and writes, and not an element a browser knows. Mapped to
    // `<pre>` on the way out so an exported page and a printed PDF render it as
    // the block it is; left alone it would be unwrapped by the allowlist below
    // and the code would come out as an ordinary run-together paragraph.
    .replace(/<codeblock\b[^>]*>/gi, '<pre>')
    .replace(/<\/codeblock>/gi, '</pre>')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Remove these *with* their contents; unwrapping a <script> would spill its
    // source into the page as visible text.
    .replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    // The unterminated forms have no closing tag to pair with, so the rule above
    // never fires and dropping the tag alone would spill exactly what it set out
    // to contain. A dangling `<!--` is the same shape of problem from the other
    // side: a browser treats the rest of the document as comment, silently
    // losing the remainder of the note. Both take everything after them.
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*$/i, '')
    .replace(/<!--[\s\S]*$/, '')
    // Whatever is left is a stray closing tag.
    .replace(/<\/?(script|style|iframe|object|embed)\b[^>]*>/gi, '')
    .replace(TAG, (_match, slash: string, rawName: string, rawAttrs: string) => {
      const name = rawName.toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return '';
      return slash ? `</${name}>` : `<${name}${keptAttributes(name, rawAttrs)}>`;
    });
}

/**
 * A print-tuned sibling of the editor's `editorCss`, deliberately not an import
 * of it. The editor styles follow the app's theme, and a dark-on-dark PDF is
 * simply wrong on paper — so this is always dark text on white. The cost is
 * that the two can drift; that is accepted, and noted here so the next person
 * knows it is a choice rather than an oversight.
 *
 * `@page` is what Android's printer honours for margins. iOS ignores it and
 * takes its margins as an option to `printToFileAsync` instead, so the native
 * saver passes both.
 */
const PRINT_CSS = `
@page { margin: 18mm; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  color: #111;
  background: #fff;
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  overflow-wrap: break-word;
}
h1.note-title { font-size: 28px; line-height: 1.25; margin: 0 0 20px; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 24px 0 8px; }
h1 { font-size: 24px; } h2 { font-size: 21px; } h3 { font-size: 18px; }
h4, h5, h6 { font-size: 16px; }
p { margin: 0 0 12px; }
ul, ol { margin: 0 0 12px; padding-left: 24px; }
li { margin: 0 0 4px; }
blockquote { margin: 0 0 12px; padding-left: 16px; border-left: 3px solid #ddd; color: #444; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; background: #f3f3f3; padding: 1px 4px; border-radius: 4px; }
pre { background: #f3f3f3; padding: 12px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
/* A stored code block holds one <p> per line; a paragraph's gap would double-space the code. */
pre p { margin: 0; }
pre code { background: none; padding: 0; }
a { color: #1a4fd8; }
/* height:auto matters once an image carries width/height attributes: without it
   a picture wider than the page is squeezed horizontally and keeps its full
   height. */
img { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
/* Checkbox lists carry no <input> in the canonical body — draw the box here. */
ul[data-type="checkbox"] { list-style: none; padding-left: 4px; }
ul[data-type="checkbox"] > li::before { content: "\\2610\\00a0\\00a0"; }
ul[data-type="checkbox"] > li[checked]::before { content: "\\2611\\00a0\\00a0"; }
/* Don't strand a heading alone at the foot of a page. */
h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; }
blockquote, pre, li { break-inside: avoid; page-break-inside: avoid; }
`.trim();

/**
 * Whether there is anything worth exporting — mirrors `save-sheet.ts`'s refusal
 * on an empty sheet, so a blank note produces an honest message instead of a
 * one-page PDF containing nothing.
 */
export function noteHasExportableContent(note: Note): boolean {
  if (note.title.trim().length > 0) return true;
  const body = note.body ?? '';
  // Mirror the store's own definition of a non-empty body (`rich-html.web.ts`):
  // a note can be all image, or a horizontal rule, and still be real content.
  // `htmlToPlainText` drops both on the floor, so asking it alone would refuse
  // to export a note the app itself saved and renders.
  if (/<(ul|ol|img|hr)\b/i.test(body)) return true;
  return htmlToPlainText(body).length > 0;
}

/**
 * The complete document: the note's title as an `<h1>`, then its formatted
 * body — the same title-first shape `buildNoteText` gives the `.txt` export. An
 * untitled note gets no heading rather than a heading reading "Untitled note".
 */
export function buildNoteDocument(note: Note): string {
  const title = note.title.trim();
  const heading = title ? `<h1 class="note-title">${escapeText(title)}</h1>` : '';
  const body = sanitizeNoteHtml(note.body ?? '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(noteFileTitle(note))}</title>
<style>
${PRINT_CSS}
</style>
</head>
<body>
${heading}
${body}
</body>
</html>
`;
}
