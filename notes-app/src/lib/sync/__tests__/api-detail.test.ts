/**
 * The backend writes an actionable sentence into every plugin error; these pin
 * that it survives the trip to a screen.
 *
 * The bug being guarded is specific and was live: with per-user tokens, the
 * expected first experience is a 503 saying "add one in Settings → Plugins", and
 * every GitHub/Sentry surface swallowed it and rendered "Check the backend is
 * reachable" — sending you to debug a network that was fine.
 *
 * Imports `../api-detail` rather than `../api`, which cannot load under vitest:
 * it pulls in the Sentry SDK and React Native. Same reason as api-fingerprint.
 */
import { describe, expect, it } from 'vitest';

import { apiErrorMessage, detailFromBody } from '../api-detail';

/** An ApiError-shaped object; `apiErrorMessage` duck-types, so this is enough. */
const err = (status: number, body: string) => ({
  status,
  body,
  detail: detailFromBody(body),
});

const NO_TOKEN = JSON.stringify({
  detail: 'No GitHub token saved for this account. Add one in Settings → Plugins.',
});

describe('detailFromBody', () => {
  it('pulls the sentence out of a FastAPI error body', () => {
    expect(detailFromBody(NO_TOKEN)).toBe(
      'No GitHub token saved for this account. Add one in Settings → Plugins.',
    );
  });

  it('is undefined for a non-JSON body', () => {
    // A gateway HTML page, or an empty 504 — neither has a detail to show.
    expect(detailFromBody('<html>504 Gateway Timeout</html>')).toBeUndefined();
    expect(detailFromBody('')).toBeUndefined();
    expect(detailFromBody(undefined)).toBeUndefined();
  });

  it('is undefined when detail is a 422 field report rather than a sentence', () => {
    // FastAPI's validation errors put a list here. Rendering "[object Object]"
    // at somebody would be worse than the screen's own wording.
    const body = JSON.stringify({ detail: [{ loc: ['body', 'token'], msg: 'too short' }] });
    expect(detailFromBody(body)).toBeUndefined();
  });

  it('is undefined for a blank detail', () => {
    expect(detailFromBody(JSON.stringify({ detail: '   ' }))).toBeUndefined();
  });
});

describe('apiErrorMessage', () => {
  it('shows the 503 that tells you to save a token', () => {
    expect(apiErrorMessage(err(503, NO_TOKEN))).toBe(
      'No GitHub token saved for this account. Add one in Settings → Plugins.',
    );
  });

  it('shows a 400 naming the scope the token is missing', () => {
    const body = JSON.stringify({
      detail: 'GitHub rejected your token — check it in Settings → Plugins (needs: issues=write)',
    });
    expect(apiErrorMessage(err(400, body))).toContain('issues=write');
  });

  it('stays quiet on a generic 500 so the screen keeps its own wording', () => {
    const body = JSON.stringify({ detail: 'Internal Server Error' });
    expect(apiErrorMessage(err(500, body))).toBeUndefined();
  });

  it('stays quiet on a 502, where the detail is an upstream code with no advice', () => {
    expect(apiErrorMessage(err(502, JSON.stringify({ detail: 'GitHub API error (502)' })))).toBe(
      undefined,
    );
  });

  it('stays quiet for a network failure, which is not an ApiError at all', () => {
    // The one case where "check your connection" is the right thing to say.
    expect(apiErrorMessage(new TypeError('Network request failed'))).toBeUndefined();
    expect(apiErrorMessage(undefined)).toBeUndefined();
    expect(apiErrorMessage('nope')).toBeUndefined();
  });
});
