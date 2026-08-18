/**
 * The page-rendering half of `compileLatex`.
 *
 * A phone can't draw a PDF, so `pages: { width }` asks the server to draw each
 * page as a PNG and send both back alongside the PDF. Two things are worth
 * pinning: the request only grows when a caller actually wants pages (so web,
 * which never asks, sends byte-for-byte the same body it always has), and the
 * response's `pages`/`pagesError` make it back out to the caller untouched —
 * that's the only path `page-cache.ts` and the resume screen have to them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type FetchBody = {
  source: string;
  engine?: string;
  include_pages?: boolean;
  page_width?: number;
};

const apiFetch = vi.fn();

vi.mock('@/lib/sync/api', () => ({
  syncConfigured: true,
  apiFetch: (path: string, options: { body: FetchBody }) => apiFetch(path, options),
}));

const SOURCE = '\\documentclass{article}\\begin{document}hi\\end{document}';

// A minimal 1x1 PNG, base64-encoded — the exact bytes don't matter, only that
// they survive the round trip through `base64ToBytes`.
const PNG_B64 = 'iVBORw0KGgo=';

beforeEach(() => {
  apiFetch.mockReset();
});

describe('compileLatex — asking the server for pages', () => {
  it('sends include_pages and the requested width when pages are asked for', async () => {
    apiFetch.mockResolvedValue({ ok: true, pdf_base64: 'AA==', log: '' });
    const { compileLatex } = await import('@/lib/latex/engine');

    await compileLatex(SOURCE, { pages: { width: 480 } });

    const body = apiFetch.mock.calls[0][1].body;
    expect(body.include_pages).toBe(true);
    expect(body.page_width).toBe(480);
  });

  it('sends neither field when no caller asked for pages', async () => {
    apiFetch.mockResolvedValue({ ok: true, pdf_base64: 'AA==', log: '' });
    const { compileLatex } = await import('@/lib/latex/engine');

    await compileLatex(SOURCE);

    const body = apiFetch.mock.calls[0][1].body;
    expect(body).not.toHaveProperty('include_pages');
    expect(body).not.toHaveProperty('page_width');
  });

  it('returns the pages the server drew, decoded from base64', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      pdf_base64: 'AA==',
      log: '',
      pages: [{ width: 480, height: 640, png_base64: PNG_B64 }],
    });
    const { compileLatex, base64ToBytes } = await import('@/lib/latex/engine');

    const result = await compileLatex(SOURCE, { pages: { width: 480 } });

    if (!result.ok) throw new Error('expected the compile to succeed');
    expect(result.pages).toEqual([{ width: 480, height: 640, png: base64ToBytes(PNG_B64) }]);
  });

  it('carries the server\'s refusal to draw pages back to the caller', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      pdf_base64: 'AA==',
      log: '',
      pages_error: '40 pages is too long to preview.',
    });
    const { compileLatex } = await import('@/lib/latex/engine');

    const result = await compileLatex(SOURCE, { pages: { width: 480 } });

    if (!result.ok) throw new Error('expected the compile to succeed');
    expect(result.pagesError).toBe('40 pages is too long to preview.');
    expect(result.pages).toBeUndefined();
  });
});
