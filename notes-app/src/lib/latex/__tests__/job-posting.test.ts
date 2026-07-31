/**
 * Reading a job posting from a link.
 *
 * The `unreadable` flag is the load-bearing part. Most job sites cannot be
 * fetched — LinkedIn and Workday refuse outright, Ashby serves a JavaScript
 * shell — so "couldn't read that page" is the *common* outcome, not an edge one,
 * and it is the only failure the sheet acts on rather than merely reports: it
 * reveals the paste fields. Get that flag wrong and a LinkedIn link is a dead
 * end with no way forward.
 */
import { describe, expect, it, vi } from 'vitest';

/** What the next call does. Set per test. */
let behaviour: (path: string, options: { signal?: AbortSignal }) => Promise<unknown> = () =>
  Promise.resolve({ description: 'x' });

vi.mock('@/lib/sync/api', () => ({
  syncConfigured: true,
  // Declared inline: a factory referencing a module-scope import hoists above it.
  ApiError: class ApiErrorStub extends Error {
    name = 'ApiError';
    constructor(
      message: string,
      readonly status: number,
      readonly body?: string,
    ) {
      super(message);
    }
  },
  apiFetch: (path: string, options: { signal?: AbortSignal }) => behaviour(path, options),
}));

const { readJobPosting, looksLikeUrl } = await import('@/lib/latex/job-posting');
const { ApiError } = await import('@/lib/sync/api');

describe('looksLikeUrl', () => {
  it('accepts a real posting link', () => {
    expect(looksLikeUrl('https://job-boards.greenhouse.io/anthropic/jobs/123')).toBe(true);
    expect(looksLikeUrl('  http://careers.example.com/x  ')).toBe(true);
  });

  it('rejects things that are not links, so they never reach the server', () => {
    expect(looksLikeUrl('')).toBe(false);
    expect(looksLikeUrl('Senior Backend Engineer')).toBe(false);
    expect(looksLikeUrl('greenhouse.io/jobs/1')).toBe(false);
    // A scheme the fetch would never accept anyway.
    expect(looksLikeUrl('ftp://example.com/x')).toBe(false);
    expect(looksLikeUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects a host with no dot in it', () => {
    expect(looksLikeUrl('https://localhost')).toBe(false);
    expect(looksLikeUrl('https://a')).toBe(false);
  });
});

describe('readJobPosting', () => {
  it('returns what the posting said', async () => {
    behaviour = () =>
      Promise.resolve({
        company: ' Acme ',
        role: ' Senior Backend Engineer ',
        description: ' Requires Kubernetes. ',
      });
    const result = await readJobPosting('https://boards.example.com/jobs/1');
    if (!result.ok) throw new Error(`expected success: ${result.message}`);
    expect(result.posting.company).toBe('Acme');
    expect(result.posting.role).toBe('Senior Backend Engineer');
    expect(result.posting.description).toBe('Requires Kubernetes.');
  });

  it('flags a 422 as unreadable, which is what reveals the paste fields', async () => {
    behaviour = () =>
      Promise.reject(
        new ApiError('422 for /resume/job-posting', 422,
          JSON.stringify({ detail: 'That page could not be read. Paste the posting instead.' }),
        ),
      );
    const result = await readJobPosting('https://www.linkedin.com/jobs/view/1');
    if (result.ok) throw new Error('expected failure');
    expect(result.unreadable).toBe(true);
    expect(result.message).toContain('aste');
  });

  it('treats an empty description as unreadable rather than as a posting', async () => {
    behaviour = () => Promise.resolve({ company: 'Acme', role: 'Engineer', description: '  ' });
    const result = await readJobPosting('https://boards.example.com/jobs/1');
    if (result.ok) throw new Error('expected failure');
    expect(result.unreadable).toBe(true);
  });

  it('does not flag a server-side problem as unreadable', async () => {
    // A 503 means the feature is off, not that the page is unfetchable. Showing
    // the paste fields here would invite someone to fill in a form that also
    // cannot work.
    behaviour = () => Promise.reject(new ApiError('503 for /resume/job-posting', 503, ''));
    const result = await readJobPosting('https://boards.example.com/jobs/1');
    if (result.ok) throw new Error('expected failure');
    expect(result.unreadable).toBe(false);
  });

  it('rejects a non-link before making a request at all', async () => {
    let called = false;
    behaviour = () => {
      called = true;
      return Promise.resolve({ description: 'x' });
    };
    const result = await readJobPosting('Senior Backend Engineer');
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('treats its own timeout as unreadable, since pasting is the way forward', async () => {
    vi.useFakeTimers();
    try {
      behaviour = (_path, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      const pending = readJobPosting('https://boards.example.com/jobs/1');
      await vi.advanceTimersByTimeAsync(90_000);
      const result = await pending;
      if (result.ok) throw new Error('expected a timeout');
      expect(result.unreadable).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws — every failure is a message the sheet can show', async () => {
    behaviour = () => Promise.reject(new Error('network down'));
    const result = await readJobPosting('https://boards.example.com/jobs/1');
    expect(result.ok).toBe(false);
  });
});
