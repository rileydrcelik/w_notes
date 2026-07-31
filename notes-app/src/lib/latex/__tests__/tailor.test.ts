/**
 * The tailor's client side.
 *
 * What matters here is entirely about what the user is told. Tailoring is the one
 * action that replaces the whole resume, so after a failure the only question is
 * "did my resume survive that?" — and the server writes a sentence that answers
 * it ("the tailored resume didn't compile, so it hasn't been applied; your resume
 * is unchanged"). That sentence arrives in the error *body*, not its message, so
 * a client that only reads `message` throws away the useful half and shows a
 * generic line instead. These tests pin that down, plus the deadline: a request
 * that can take minutes and has no timeout is a spinner that never stops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { tailorResume, emptyTailorDraft } = await import('@/lib/latex/tailor');
const { ApiError } = await import('@/lib/sync/api');

const draft = {
  company: 'Acme',
  role: 'SRE',
  jobDescription: 'Kubernetes, Terraform.',
};

describe('emptyTailorDraft', () => {
  it('starts blank, so reopening the sheet never re-offers the last job', () => {
    expect(emptyTailorDraft()).toEqual({ company: '', role: '', jobDescription: '' });
  });
});

describe('tailorResume', () => {
  it('returns the tailored document and its page count', async () => {
    behaviour = () =>
      Promise.resolve({ latex: '\\documentclass{article}', emphasis: ' Led with SRE ', pages: 1 });
    const result = await tailorResume('\\source', draft, 'pdflatex');
    if (!result.ok) throw new Error(`expected success, got ${result.message}`);
    expect(result.resume.latex).toBe('\\documentclass{article}');
    expect(result.resume.emphasis).toBe('Led with SRE');
    expect(result.resume.pages).toBe(1);
  });

  it('reports the page count when it came out longer than one page', async () => {
    // The server only returns >1 once it has run out of attempts, and the screen
    // has to be able to say so rather than calling it a one-page resume.
    behaviour = () => Promise.resolve({ latex: '\\doc', pages: 2 });
    const result = await tailorResume('\\source', draft, 'pdflatex');
    if (!result.ok) throw new Error('expected success');
    expect(result.resume.pages).toBe(2);
  });

  it('sends the engine and the job description under the wire names', async () => {
    let sent: Record<string, unknown> = {};
    behaviour = (_path, options) => {
      sent = (options as { body?: Record<string, unknown> }).body ?? {};
      return Promise.resolve({ latex: '\\doc', pages: 1 });
    };
    await tailorResume('\\source', draft, 'xelatex');
    expect(sent.job_description).toBe('Kubernetes, Terraform.');
    expect(sent.engine).toBe('xelatex');
    expect(sent.company).toBe('Acme');
    expect(sent.source).toBe('\\source');
  });

  it('treats an empty document as a failure rather than applying it', async () => {
    behaviour = () => Promise.resolve({ latex: '   ' });
    const result = await tailorResume('\\source', draft, 'pdflatex');
    expect(result.ok).toBe(false);
  });

  it("prefers the server's own sentence on a 422, which says the resume survived", async () => {
    behaviour = () =>
      Promise.reject(
        new ApiError('422 Unprocessable Content for /resume/tailor', 422,
          JSON.stringify({
            detail:
              "The tailored resume didn't compile, so it hasn't been applied. Your resume is unchanged. Try again.",
          }),
        ),
      );
    const result = await tailorResume('\\source', draft, 'pdflatex');
    if (result.ok) throw new Error('expected failure');
    expect(result.message).toContain('unchanged');
    expect(result.message).toContain("didn't compile");
  });

  it('passes through a 413 detail, which says what to shorten', async () => {
    behaviour = () =>
      Promise.reject(
        new ApiError('413 for /resume/tailor', 413, JSON.stringify({ detail: 'Too long: trim it.' })),
      );
    const result = await tailorResume('\\source', draft, 'pdflatex');
    if (result.ok) throw new Error('expected failure');
    expect(result.message).toBe('Too long: trim it.');
  });

  it('does not surface a 500 body, which is not written for a person', async () => {
    behaviour = () =>
      Promise.reject(
        new ApiError('500 for /resume/tailor', 500, JSON.stringify({ detail: 'Traceback...' })),
      );
    const result = await tailorResume('\\source', draft, 'pdflatex');
    if (result.ok) throw new Error('expected failure');
    expect(result.message).not.toContain('Traceback');
  });

  it('falls back to a readable line when the body is not JSON', async () => {
    behaviour = () =>
      Promise.reject(new ApiError('429 for /resume/tailor', 429, '<html>rate limited</html>'));
    const result = await tailorResume('\\source', draft, 'pdflatex');
    if (result.ok) throw new Error('expected failure');
    expect(result.message).not.toContain('<html>');
    expect(result.message).toContain('Try again');
  });

  it('never throws — every failure is a message the sheet can show', async () => {
    behaviour = () => Promise.reject(new Error('network down'));
    const result = await tailorResume('\\source', draft, 'pdflatex');
    expect(result.ok).toBe(false);
  });
});

describe('the request deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up rather than waiting for ever, and says the resume is unchanged', async () => {
    // A backend that accepts the request and never answers. Without a deadline
    // this is a sheet that sits on "choosing what to include" indefinitely.
    behaviour = (_path, options) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () =>
          reject(new Error('The operation was aborted')),
        );
      });
    const pending = tailorResume('\\source', draft, 'pdflatex');
    await vi.advanceTimersByTimeAsync(300_000);
    const result = await pending;
    if (result.ok) throw new Error('expected a timeout');
    expect(result.message).toContain('unchanged');
  });

  it('clears its timer when the request answers normally', async () => {
    behaviour = () => Promise.resolve({ latex: '\\doc', pages: 1 });
    const result = await tailorResume('\\source', draft, 'pdflatex');
    expect(result.ok).toBe(true);
    // A five-minute timer left alive per request is a leak; nothing should be
    // pending once the call has resolved.
    expect(vi.getTimerCount()).toBe(0);
  });
});
