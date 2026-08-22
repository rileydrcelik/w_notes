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

type RequestOptions = { signal?: AbortSignal; body?: { url?: string; text?: string } };

/** What the next call does. Set per test. */
let behaviour: (path: string, options: RequestOptions) => Promise<unknown> = () =>
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
  apiFetch: (path: string, options: RequestOptions) => behaviour(path, options),
}));

const { readJobPosting, readPastedPosting, MAX_PASTED_PAGE_CHARS, looksLikeUrl } = await import(
  '@/lib/latex/job-posting'
);
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

  it('sends a body with exactly one key: url, not text', async () => {
    let sentBody: RequestOptions['body'];
    behaviour = (_path, options) => {
      sentBody = options.body;
      return Promise.resolve({ description: 'x' });
    };
    await readJobPosting('https://boards.example.com/jobs/1');
    expect(sentBody).toEqual({ url: 'https://boards.example.com/jobs/1' });
  });
});

describe('readPastedPosting', () => {
  it('returns what the pasted page said', async () => {
    behaviour = () =>
      Promise.resolve({
        company: ' Acme ',
        role: ' Senior Backend Engineer ',
        description: ' Requires Kubernetes. ',
      });
    const result = await readPastedPosting('a whole careers page, pasted');
    if (!result.ok) throw new Error(`expected success: ${result.message}`);
    expect(result.posting.company).toBe('Acme');
    expect(result.posting.role).toBe('Senior Backend Engineer');
    expect(result.posting.description).toBe('Requires Kubernetes.');
  });

  it('refuses an empty paste locally, without a network call', async () => {
    let called = false;
    behaviour = () => {
      called = true;
      return Promise.resolve({ description: 'x' });
    };
    const result = await readPastedPosting('   ');
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('refuses an oversized paste locally, without a network call', async () => {
    let called = false;
    behaviour = () => {
      called = true;
      return Promise.resolve({ description: 'x' });
    };
    const result = await readPastedPosting('x'.repeat(MAX_PASTED_PAGE_CHARS + 1));
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('accepts a paste right at the limit', async () => {
    behaviour = () => Promise.resolve({ description: 'Requires Go.' });
    const result = await readPastedPosting('x'.repeat(MAX_PASTED_PAGE_CHARS));
    expect(result.ok).toBe(true);
  });

  it('sends a body with exactly one key: text, not url', async () => {
    let sentBody: RequestOptions['body'];
    behaviour = (_path, options) => {
      sentBody = options.body;
      return Promise.resolve({ description: 'x' });
    };
    await readPastedPosting('  a pasted posting  ');
    expect(sentBody).toEqual({ text: 'a pasted posting' });
  });

  it('prefers the server’s own detail on a 422', async () => {
    behaviour = () =>
      Promise.reject(
        new ApiError(
          '422 for /resume/job-posting',
          422,
          JSON.stringify({ detail: 'That paste is a list of ten openings, not one.' }),
        ),
      );
    const result = await readPastedPosting('a list of jobs');
    if (result.ok) throw new Error('expected failure');
    expect(result.unreadable).toBe(true);
    expect(result.message).toBe('That paste is a list of ten openings, not one.');
  });

  it('falls back to a paste-specific message on a 422 with no server detail', async () => {
    behaviour = () =>
      Promise.reject(new ApiError('422 for /resume/job-posting', 422, ''));
    const result = await readPastedPosting('a pasted page');
    if (result.ok) throw new Error('expected failure');
    expect(result.unreadable).toBe(true);
    // The paste-path fallback names a *posting*, unlike the link path's
    // fallback, which talks about a *page*.
    expect(result.message).toContain('single job posting');
  });

  it(
    'treats its own timeout as readable-but-slow, NOT unreadable — pasting is ' +
      'already the way forward, so there is nowhere further to send someone',
    async () => {
      vi.useFakeTimers();
      try {
        behaviour = (_path, options) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        const pending = readPastedPosting('a pasted posting');
        await vi.advanceTimersByTimeAsync(90_000);
        const result = await pending;
        if (result.ok) throw new Error('expected a timeout');
        // This is the property that was broken once: a link-path timeout is
        // `unreadable: true` (fall back to pasting), but there is no further
        // fallback from a paste, so it must NOT set the flag that reveals paste
        // fields that are already showing.
        expect(result.unreadable).toBe(false);
        expect(result.message).toContain('too long');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('never throws — every failure is a message the sheet can show', async () => {
    behaviour = () => Promise.reject(new Error('network down'));
    const result = await readPastedPosting('a pasted posting');
    expect(result.ok).toBe(false);
  });
});
