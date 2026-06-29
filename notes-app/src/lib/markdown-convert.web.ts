/**
 * Backend-backed markdown → stored HTML conversion for the web editor.
 *
 * The note/copa body is stored as the native rich editor's HTML everywhere, and
 * that markdown→HTML conversion is owned by the server (`POST /convert/to-html`)
 * so there's a single authoritative implementation. This wraps that call and
 * falls back to the local JS converter (`markdownToHtml`) whenever the backend
 * is unconfigured or unreachable, so web editing still works offline.
 *
 * Web-only: paired with `markdown.ts`, imported solely from `*.web` files.
 */
import { apiFetch, syncConfigured } from '@/lib/sync/api';
import { markdownToHtml } from '@/lib/markdown';

/** True when we should even attempt the network (configured + browser online). */
function canReachBackend(): boolean {
  if (!syncConfigured) return false;
  // Skip the round-trip (and its Sentry noise) when the browser knows it's offline.
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * Convert markdown to the stored rich-text HTML body via the backend, falling
 * back to the local converter on any failure. Empty input yields an empty body.
 */
export async function markdownToStoredHtml(md: string): Promise<string> {
  if (!md.trim()) return '';
  if (canReachBackend()) {
    try {
      const { html } = await apiFetch<{ html: string }>('/convert/to-html', {
        method: 'POST',
        body: { markdown: md },
      });
      if (typeof html === 'string') return html;
    } catch {
      // Unreachable/erroring backend — fall through to the local converter.
    }
  }
  return markdownToHtml(md);
}
