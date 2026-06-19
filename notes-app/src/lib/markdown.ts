/**
 * Markdown ↔ HTML bridge for the web build. Note/copa bodies are stored as the
 * rich editor's HTML across every device (the canonical, synced format), but the
 * web app edits in plain markdown. So the web editor seeds itself by turning the
 * stored HTML into markdown, and writes back by turning the markdown into HTML —
 * which keeps a web-edited note rendering correctly in the native rich editor
 * (and vice-versa).
 *
 * Web-only: both libraries lean on the browser DOM / standard JS, and this
 * module is imported solely from `*.web` files.
 */
import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// ATX headings (`#`), fenced code blocks, and `-` bullets match what the rich
// editor's HTML round-trips to most cleanly.
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
turndown.use(gfm);

// The native editor emits checkbox lists as `<ul data-type="checkbox"><li
// checked>…`, which the GFM plugin doesn't recognise. Map those to task-list
// markdown so checkboxes survive the trip to/from the app.
turndown.addRule('enrichedCheckbox', {
  filter: (node) =>
    node.nodeName === 'LI' &&
    (node.parentNode as Element | null)?.getAttribute?.('data-type') === 'checkbox',
  replacement: (content, node) => {
    const checked = (node as Element).hasAttribute('checked');
    return `- [${checked ? 'x' : ' '}] ${content.trim()}\n`;
  },
});

marked.setOptions({ gfm: true, breaks: false });

/** Stored HTML body → markdown source for editing in the web textarea. */
export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return '';
  return turndown.turndown(html).trim();
}

/** Markdown source from the web editor → HTML body to store/sync. */
export function markdownToHtml(md: string): string {
  if (!md.trim()) return '';
  let html = (marked.parse(md, { async: false }) as string).trim();
  // Reshape GFM task lists (`<li><input type="checkbox">…`) into the rich
  // editor's checkbox format so they render natively on mobile.
  html = html.replace(/<ul>([\s\S]*?)<\/ul>/gi, (whole, inner: string) => {
    if (!/type="checkbox"/i.test(inner)) return whole;
    const items = inner.replace(
      /<li[^>]*>\s*<input([^>]*)>\s*([\s\S]*?)<\/li>/gi,
      (_m, attrs: string, text: string) =>
        `<li${/checked/i.test(attrs) ? ' checked' : ''}>${text.trim()}</li>`,
    );
    return `<ul data-type="checkbox">${items}</ul>`;
  });
  return html;
}
