/**
 * Sentry grouping for backend failures.
 *
 * Every `ApiError` is constructed on one line of api.ts, so Sentry's default
 * stack-trace grouping folded every non-2xx from every endpoint into a single
 * issue. That issue reads as one bug that keeps coming back while it is really a
 * queue of unrelated ones — and whatever works from its latest event, a person
 * or an autofix run, is handed the wrong error. The fingerprint has to name the
 * endpoint instead, without letting per-request values shatter it into
 * thousands of issues.
 */
import { describe, expect, it } from 'vitest';

import { fingerprintPath } from '../fingerprint';

describe('fingerprintPath', () => {
  it('drops the query string so one endpoint is one group', () => {
    // The reported failure: /sync/pull?since=4396 must not be its own issue,
    // distinct from the identical failure at a different cursor.
    expect(fingerprintPath('/sync/pull?since=4396')).toBe('/sync/pull');
    expect(fingerprintPath('/sync/pull?since=4396')).toBe(fingerprintPath('/sync/pull?since=9'));
  });

  it('collapses numeric ids', () => {
    expect(fingerprintPath('/sentry/issues/7588198150/latest-event')).toBe(
      '/sentry/issues/:id/latest-event',
    );
  });

  it('collapses opaque ids like uuids', () => {
    expect(fingerprintPath('/notes/3f8a1c2e-9b4d-4a11-8e77-2c5d9f0a1b33')).toBe('/notes/:id');
  });

  it('keeps distinct endpoints distinct', () => {
    expect(fingerprintPath('/sync/pull')).not.toBe(fingerprintPath('/sync/push'));
    expect(fingerprintPath('/sync/pull')).toBe('/sync/pull');
  });

  it('keeps real route names that are as long as an id', () => {
    // Regression: a length-only id rule collapsed these. Both are exactly 12
    // characters, so `/files/download-url` became `/files/:id` — merging it with
    // any other single-segment /files route, which is the blurring this whole
    // function exists to stop. Route names here carry no digits; ids do.
    expect(fingerprintPath('/files/download-url')).toBe('/files/download-url');
    expect(fingerprintPath('/files/upload-url')).toBe('/files/upload-url');
    expect(fingerprintPath('/files/download-url')).not.toBe(fingerprintPath('/files/upload-url'));
    expect(fingerprintPath('/resume/job-posting')).toBe('/resume/job-posting');
  });

  it('leaves ordinary path segments alone', () => {
    expect(fingerprintPath('/latex/compile')).toBe('/latex/compile');
    expect(fingerprintPath('/sentry/autofix/status?short_id=W-NOTES-RN-C')).toBe(
      '/sentry/autofix/status',
    );
  });
});
