/**
 * How a backend failure is grouped in Sentry.
 *
 * Every `ApiError` is constructed on one line of `api.ts`, so Sentry's default
 * stack-trace grouping folded every non-2xx from every endpoint into a single
 * issue. That issue reads as one bug that keeps coming back while it is really a
 * queue of unrelated ones — and whatever works from its latest event, a person
 * or an autofix run, is handed the wrong error.
 *
 * This lives apart from `api.ts` because it is pure string work with no device
 * dependency, and `api.ts` imports the Sentry SDK, which initializes itself on
 * import and pulls in React Native. Keeping the function here is what lets the
 * unit suite (`vitest.config.ts`: "no React, no renderer, no device") test the
 * real production function rather than a copy of it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Does this path segment name a *value* rather than a *route*?
 *
 * The discriminator is "contains a digit", not length alone. Length alone is
 * wrong here and quietly so: this app's own routes include `latest-event` and
 * `download-url`, both exactly 12 characters, so a `length >= 12` rule collapses
 * them to `:id` and merges `/files/download-url` into `/files/:id` — the very
 * endpoint-blurring the fingerprint exists to prevent. Route names in this API
 * are lowercase words and never carry digits; ids (numeric, uuid, nanoid) always
 * do. The `.`-exclusion keeps a filename like `resume.latex.pdf` intact.
 */
function looksLikeId(seg: string): boolean {
  if (/^\d+$/.test(seg)) return true; // database + Sentry issue ids
  if (UUID.test(seg)) return true;
  return seg.length >= 12 && /\d/.test(seg) && !seg.includes('.');
}

/**
 * A stable, low-cardinality shape for one endpoint: query string dropped, and
 * any segment that looks like an id collapsed to `:id`. `/sync/pull?since=4396`
 * and `/sentry/issues/7588198150/latest-event` become `/sync/pull` and
 * `/sentry/issues/:id/latest-event`, so a fingerprint built from this names the
 * endpoint rather than the individual request.
 */
export function fingerprintPath(path: string): string {
  const [pathname] = path.split('?');
  return pathname
    .split('/')
    .map((seg) => (looksLikeId(seg) ? ':id' : seg))
    .join('/');
}
