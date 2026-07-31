/**
 * A compile that never gets an answer has to end anyway.
 *
 * This is the failure that motivated the timeout, and it is worth a test because
 * it looks like nothing: a backend container crash-looping on a bad import still
 * has its port published, so the TCP connection is *accepted* and then simply
 * never answered. `fetch` doesn't reject — there's no refusal to report — so the
 * promise stays pending for ever, the preview spins, and the retry button never
 * appears because a compile that hasn't failed can't be retried.
 *
 * The client timeout is what turns that silence into a failure someone can act
 * on. It sits above the server's own 60s cap on purpose, so a genuine runaway
 * document is still killed server-side and reported with its log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A backend that accepts the request and never answers — the crash-looped
 * container. It settles only if the caller aborts, which is precisely the
 * behaviour under test.
 */
const stalledFetch = vi.fn((_path: string, options: { signal?: AbortSignal }) => {
  return new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
  });
});

vi.mock('@/lib/sync/api', () => ({
  syncConfigured: true,
  apiFetch: (path: string, options: { signal?: AbortSignal }) => stalledFetch(path, options),
}));

const SOURCE = '\\documentclass{article}\\begin{document}hi\\end{document}';

beforeEach(() => {
  vi.useFakeTimers();
  stalledFetch.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('compileLatex against a server that never answers', () => {
  it('gives up rather than hanging for ever', async () => {
    const { compileLatex } = await import('@/lib/latex/engine');

    const pending = compileLatex(SOURCE);
    // Long enough to be sure it isn't just slow: past the server's own 60s cap.
    await vi.advanceTimersByTimeAsync(75_000);
    const result = await pending;

    // `CompileResult` is a discriminated union, so this both asserts the outcome
    // and narrows it for the diagnostics below.
    if (result.ok) throw new Error('expected the stalled compile to fail');
    expect(result.diagnostics).toHaveLength(1);
  });

  it('blames the silence, not the document', async () => {
    const { compileLatex } = await import('@/lib/latex/engine');

    const pending = compileLatex(SOURCE);
    await vi.advanceTimersByTimeAsync(75_000);
    const result = await pending;

    if (result.ok) throw new Error('expected the stalled compile to fail');
    // The distinction that matters to whoever is looking at it: their LaTeX is
    // not the problem, the server is.
    expect(result.diagnostics[0].message).toContain('75 seconds');
    expect(result.diagnostics[0].message).toMatch(/unreachable/i);
  });

  it('is still waiting a second before the deadline', async () => {
    const { compileLatex } = await import('@/lib/latex/engine');

    let settled = false;
    void compileLatex(SOURCE).then(() => {
      settled = true;
    });

    // Guards the other direction: a timeout short enough to fire during a real
    // compile would throw away the server's own log, which is the better answer.
    await vi.advanceTimersByTimeAsync(74_000);
    expect(settled).toBe(false);
  });

  it('passes an abort signal to the request at all', async () => {
    const { compileLatex } = await import('@/lib/latex/engine');

    void compileLatex(SOURCE);
    await vi.advanceTimersByTimeAsync(0);

    expect(stalledFetch).toHaveBeenCalledTimes(1);
    expect(stalledFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
