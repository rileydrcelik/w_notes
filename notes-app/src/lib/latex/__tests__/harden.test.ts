/**
 * The hardener's client side.
 *
 * Same concerns as `tailor.test.ts` — this is the other action that replaces the
 * whole resume, so after a failure the only question anyone has is "did my resume
 * survive that?", and the server's own sentence is the one that answers it. That
 * sentence arrives in the error *body*, not its message, so a client reading only
 * `message` throws away the useful half.
 *
 * One thing here has no equivalent there: `matchedRole`. It is the difference
 * between "checked against a list compiled from real postings for this exact
 * title" and "checked against what a model knows about this title", and the sheet
 * says which one happened. Dropping it on the floor would silently upgrade the
 * weaker claim to the stronger one, which is why it is pinned in both directions.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

/** What the next call does. Set per test. */
let behaviour: (path: string, options: { signal?: AbortSignal }) => Promise<unknown> = () =>
  Promise.resolve({ latex: 'x' });

vi.mock('@/lib/sync/api', () => ({
  syncConfigured: true,
  // Declared inline rather than closing over an imported helper: a factory that
  // references a module-scope import hoists above it and throws.
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

const { hardenResume, emptyHardenDraft, MAX_ROLE_CHARS } = await import('@/lib/latex/harden');
const { ApiError } = await import('@/lib/sync/api');

const draft = { role: 'Data Engineer' };

describe('emptyHardenDraft', () => {
  it('starts blank, so reopening the sheet never re-offers the last title', () => {
    expect(emptyHardenDraft()).toEqual({ role: '' });
  });
});

describe('hardenResume', () => {
  it('posts the title and the engine to the harden endpoint', async () => {
    let seen: { path?: string; body?: unknown } = {};
    behaviour = (path, options) => {
      seen = { path, body: (options as { body?: unknown }).body };
      return Promise.resolve({ latex: 'x' });
    };
    await hardenResume('\\source', draft, 'xelatex');
    expect(seen.path).toBe('/resume/harden');
    expect(seen.body).toEqual({ source: '\\source', role: 'Data Engineer', engine: 'xelatex' });
  });

  it('returns the hardened document, its page count and the matched role', async () => {
    behaviour = () =>
      Promise.resolve({
        latex: '\\documentclass{article}',
        emphasis: '  Led with pipelines  ',
        pages: 1,
        matched_role: 'Data Engineer',
      });
    const result = await hardenResume('\\source', draft, 'pdflatex');
    if (!result.ok) throw new Error(`expected success, got ${result.message}`);
    expect(result.resume.latex).toBe('\\documentclass{article}');
    expect(result.resume.emphasis).toBe('Led with pipelines');
    expect(result.resume.pages).toBe(1);
    expect(result.resume.matchedRole).toBe('Data Engineer');
  });

  it('reports an unmatched title as an empty matchedRole rather than inventing one', async () => {
    // The sheet reads this to say the resume was built against general knowledge
    // rather than a compiled list. A default of anything but empty would make the
    // weaker claim look like the stronger one.
    behaviour = () => Promise.resolve({ latex: 'x', pages: 1 });
    const result = await hardenResume('\\source', draft, 'pdflatex');
    if (!result.ok) throw new Error('expected success');
    expect(result.resume.matchedRole).toBe('');
  });

  it('treats an empty document as a failure rather than applying nothing', async () => {
    behaviour = () => Promise.resolve({ latex: '   ' });
    const result = await hardenResume('\\source', draft, 'pdflatex');
    expect(result.ok).toBe(false);
  });

  it("prefers the server's sentence, which is the one that says the resume is unchanged", async () => {
    const detail =
      "The hardened resume didn't compile, so it hasn't been applied. Your resume is unchanged. Try again.";
    behaviour = () =>
      Promise.reject(new ApiError('Request failed with status 422', 422, JSON.stringify({ detail })));
    const result = await hardenResume('\\source', draft, 'pdflatex');
    if (result.ok) throw new Error('expected failure');
    expect(result.message).toBe(detail);
  });

  it('ignores a body on statuses whose detail is not written for a person', async () => {
    behaviour = () =>
      Promise.reject(new ApiError('500', 500, JSON.stringify({ detail: 'Traceback (most recent…' })));
    const result = await hardenResume('\\source', draft, 'pdflatex');
    if (result.ok) throw new Error('expected failure');
    expect(result.message).not.toContain('Traceback');
  });

  it('says the resume is unchanged when the request times out', async () => {
    behaviour = (_path, options) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    vi.useFakeTimers();
    try {
      const pending = hardenResume('\\source', draft, 'pdflatex');
      await vi.advanceTimersByTimeAsync(300_000);
      const result = await pending;
      if (result.ok) throw new Error('expected failure');
      expect(result.message).toContain('unchanged');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MAX_ROLE_CHARS', () => {
  it("matches the backend's own cap", () => {
    // Two implementations of one rule, either side of the Python/TS boundary —
    // the same hazard `MAX_LABEL_CHARS` carries in `lib/resume-versions.ts`. A
    // client cap above the server's means someone is told their title is fine
    // and then refused by the server after typing it.
    const router = fileURLToPath(
      new URL('../../../../../backend/app/routers/resume.py', import.meta.url),
    );
    const source = readFileSync(router, 'utf8');
    const match = source.match(/^_MAX_ROLE_CHARS = (\d+)$/m);
    expect(match?.[1]).toBe(String(MAX_ROLE_CHARS));
  });
});
