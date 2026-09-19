/**
 * What a typed link becomes before it goes into a note body.
 *
 * People type `example.com`, not `https://example.com`, and a bare host stored
 * as an href is a *relative* link — it would resolve against the app's own
 * origin on web and against nothing at all on a phone. So a value with no
 * scheme gets `https://`.
 *
 * Only a handful of schemes are allowed through. The body is rendered as raw
 * HTML in the web card previews and the HTML export, so a `javascript:` href
 * written here would run on the next click anywhere that body is shown. This is
 * the one place a link is *authored*, so it is where the door is shut; the
 * export keeps its own allowlist (`note-html-export.ts`) for links that arrive
 * by paste or sync.
 */
const ALLOWED_SCHEME = /^(?:https?|mailto|tel):/i;
/** Anything that already starts with a scheme, allowed or not. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The href to store for what was typed, or null when it can't be a link. */
export function normalizeLinkUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return null;
  if (ALLOWED_SCHEME.test(value)) return value;
  // `localhost:3000` reads as a scheme of `localhost`, but a port is digits.
  if (HAS_SCHEME.test(value) && !/^[^:/]+:\d+(?:[/?#]|$)/.test(value)) return null;
  if (value.startsWith('//')) return `https:${value}`;
  // An address with an @ and no slash before it is an email, not a host.
  if (/^[^/@]+@[^/@]+\.[^/@]+$/.test(value)) return `mailto:${value}`;
  return `https://${value}`;
}

/** Whether an href already in a body is safe to open from the editor. */
export function isOpenableLinkUrl(href: string | null | undefined): href is string {
  return !!href && ALLOWED_SCHEME.test(href.trim());
}
