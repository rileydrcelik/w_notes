/**
 * The resume adder's client side.
 *
 * Two things worth pinning down. `parseContextLinks` decides which URLs are
 * even offered to the server — the server validates them again, but a link
 * silently dropped here is a page that never gets read and no error to explain
 * why. And the request needs a deadline: drafting with context links takes tens
 * of seconds by design (the model is fetching pages), so "slow" and "never
 * answering" look identical from the sheet, which sits on "Writing it in your
 * resume's style…" until something says otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { draftResumeEntry, emptyEntryDraft, parseContextLinks } from '@/lib/latex/entry';

/** A backend that accepts the request and never answers. */
const stalledFetch = vi.fn((_path: string, options: { signal?: AbortSignal }) => {
  return new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
  });
});

vi.mock('@/lib/sync/api', () => ({
  syncConfigured: true,
  apiFetch: (path: string, options: { signal?: AbortSignal }) => stalledFetch(path, options),
}));

describe('parseContextLinks', () => {
  it('takes one URL per line', () => {
    expect(parseContextLinks('https://a.test/x\nhttps://b.test/y')).toEqual([
      'https://a.test/x',
      'https://b.test/y',
    ]);
  });

  it('also splits on commas, since people paste lists that way', () => {
    expect(parseContextLinks('https://a.test/x, https://b.test/y')).toEqual([
      'https://a.test/x',
      'https://b.test/y',
    ]);
  });

  it('trims each entry', () => {
    // A trailing space would otherwise travel to the server inside the URL.
    expect(parseContextLinks('  https://a.test/x  \n\t https://b.test/y')).toEqual([
      'https://a.test/x',
      'https://b.test/y',
    ]);
  });

  it('drops blank lines rather than sending empty strings', () => {
    expect(parseContextLinks('https://a.test/x\n\n   \n')).toEqual(['https://a.test/x']);
  });

  it('is empty for an untouched field', () => {
    expect(parseContextLinks('')).toEqual([]);
    expect(parseContextLinks('   \n  ')).toEqual([]);
  });
});

describe('draftResumeEntry against a server that never answers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stalledFetch.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up rather than leaving the sheet writing for ever', async () => {
    const pending = draftResumeEntry('\\documentclass{article}', {
      ...emptyEntryDraft('Experience'),
      title: 'Engineer',
    });
    await vi.advanceTimersByTimeAsync(140_000);
    const result = await pending;

    expect(result.ok).toBe(false);
  });

  it('blames the silence and points at the likely cause', async () => {
    const pending = draftResumeEntry('\\documentclass{article}', {
      ...emptyEntryDraft('Experience'),
      title: 'Engineer',
    });
    await vi.advanceTimersByTimeAsync(140_000);
    const result = await pending;

    if (result.ok) throw new Error('expected the stalled draft to fail');
    expect(result.message).toContain('140 seconds');
    expect(result.message).toMatch(/context links/i);
  });

  it('is still waiting a second before the deadline', async () => {
    // Guards the other direction: a deadline short enough to fire during a real
    // draft would cancel work that was about to succeed. Two context links
    // measured ~45s end to end.
    let settled = false;
    void draftResumeEntry('\\documentclass{article}', {
      ...emptyEntryDraft('Experience'),
      title: 'Engineer',
    }).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(139_000);
    expect(settled).toBe(false);
  });

  it('sends the parsed context links, not the raw field text', async () => {
    void draftResumeEntry('\\documentclass{article}', {
      ...emptyEntryDraft('Experience'),
      title: 'Engineer',
      contextLinks: 'https://a.test/x\nhttps://b.test/y',
    });
    await vi.advanceTimersByTimeAsync(0);

    const body = (stalledFetch.mock.calls[0][1] as { body: { context_links: string[] } }).body;
    expect(body.context_links).toEqual(['https://a.test/x', 'https://b.test/y']);
  });

  it('passes an abort signal to the request at all', async () => {
    void draftResumeEntry('\\documentclass{article}', {
      ...emptyEntryDraft('Experience'),
      title: 'Engineer',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(stalledFetch).toHaveBeenCalledTimes(1);
    expect(stalledFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
