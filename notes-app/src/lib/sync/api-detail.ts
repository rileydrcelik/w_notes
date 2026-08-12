/**
 * Turning a backend error into something worth showing a person.
 *
 * FastAPI puts the human-readable half of every `HTTPException` in
 * `{"detail": "..."}`. `ApiError` used to keep that in `.body` and nothing ever
 * read it, so the message the backend had carefully written never reached a
 * screen — every GitHub surface caught the error blind and substituted "Check
 * the backend is reachable".
 *
 * That was harmless while a failure really did mean the server was down. It
 * stopped being harmless with per-user tokens: the *expected* first experience
 * is now a 503 saying "No GitHub token saved for this account. Add one in
 * Settings → Plugins", and rendering that as a connectivity problem sends
 * someone off to debug their network instead of pasting a token.
 *
 * Lives apart from `api.ts` because that module imports the Sentry SDK, which
 * initialises on import and pulls in React Native — the unit suite cannot load
 * it at all. Same reason `fingerprint.ts` is its own file.
 */

/** Statuses whose `detail` was written for the caller to act on. */
function isActionable(status: number): boolean {
  // Under 500 the detail is ours and specific: 400 "GitHub rejected your token",
  // 404 unknown repo or provider, 422 a malformed field.
  //
  // 503 is the exception above that line, and the important one — it is how
  // every plugin route reports "you have not saved a token yet", which is the
  // single most likely error anyone sees after per-user credentials ship.
  //
  // 500/502/504 are deliberately excluded. Their detail is either FastAPI's
  // generic "Internal Server Error" or an upstream code with no advice in it,
  // and a caller is better served by the screen's own wording than by that.
  return status < 500 || status === 503;
}

/**
 * The `detail` string from a FastAPI error body, if there is a usable one.
 *
 * Returns undefined for a non-JSON body (an HTML gateway page, an empty 504)
 * and for the list-shaped `detail` of a 422 validation error, which is a
 * machine-readable field report rather than a sentence.
 */
export function detailFromBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const detail = (parsed as { detail?: unknown }).detail;
  if (typeof detail !== 'string') return undefined;
  const trimmed = detail.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * What to show for a failed request, or undefined to keep the screen's own text.
 *
 * Duck-typed rather than an `instanceof ApiError` check so this stays free of
 * `api.ts` and therefore testable. A network failure is not an `ApiError` at
 * all, has no status, and correctly falls through to the caller's fallback —
 * that is the one case where "check your connection" is the right thing to say.
 */
export function apiErrorMessage(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const { status, detail } = err as { status?: unknown; detail?: unknown };
  if (typeof status !== 'number' || typeof detail !== 'string') return undefined;
  return isActionable(status) ? detail : undefined;
}
