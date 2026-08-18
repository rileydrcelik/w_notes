/**
 * Compiles a resume by asking the backend to do it.
 *
 * This replaced an in-browser WebAssembly TeX. That version genuinely worked,
 * but it cost every new browser an ~86MB one-time download — a 29MB engine plus
 * font bundles, two thirds of it a font set nothing in the document requested —
 * and it could never run on native at all. A server compile costs a round trip
 * instead, and one TeX install serves every device.
 *
 * No platform split: `fetch` is `fetch`. Native gets compiling for free; only
 * the on-screen preview is still web-only (see `pdf-render.ts`), so native can
 * compile and download a resume without rendering it.
 */
import { apiFetch, syncConfigured } from '@/lib/sync/api';
import { parseTexLog } from '@/lib/latex/log';
import type { CompileOptions, CompileResult } from '@/lib/latex/types';

/** The backend's response shape (`POST /latex/compile`). */
type CompileApiResponse = {
  ok: boolean;
  pdf_base64?: string | null;
  log?: string;
  // Both absent from a server older than the page-rendering deploy, which is
  // the ordinary state of things for a moment after a release: the client
  // updates over the air and the backend rolls separately. Optional here so
  // that reads as "no pages this time" and falls back to the download, rather
  // than as a malformed response.
  pages?: { width: number; height: number; png_base64: string }[] | null;
  pages_error?: string | null;
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * How long to wait for a compile before giving up on it.
 *
 * Deliberately *longer* than the server's own 60s cap (`_TIMEOUT_SECONDS` in
 * `backend/app/routers/latex.py`). When a document really is a runaway loop the
 * server kills it and hands back a log saying so, which is a far better answer
 * than "the client stopped waiting" — so the client must not fire first and
 * throw that away.
 *
 * This is for the other case: no answer is coming at all. Nothing listening on
 * `EXPO_PUBLIC_API_URL`, a connection that opens and then stalls, an auth token
 * refresh that never resolves. There was no limit here, so that case left the
 * preview spinning for ever with nothing on the way and no way out — the retry
 * button only exists once a compile has *failed*. A timeout is what turns a hang
 * into a failure you can act on.
 */
const COMPILE_TIMEOUT_MS = 75_000;

/**
 * Decode base64 to bytes without `atob` or `Buffer`. Hand-rolled deliberately:
 * `atob` is a browser global that Hermes has only recently shipped, and a
 * platform-dependent global is exactly the kind of thing that works in every
 * test and then throws on a real device.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = new Uint8Array((clean.length * 3) >> 2);
  let out = 0;
  let buffer = 0;
  let bits = 0;

  for (const char of clean) {
    const value = B64.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (buffer >> bits) & 0xff;
    }
  }

  // The final group may encode fewer bytes than the quantum reserved for it.
  return out === bytes.length ? bytes : bytes.subarray(0, out);
}

/** Whether a compile is possible at all — i.e. an API is configured. */
export function isLatexCompileSupported(): boolean {
  return syncConfigured;
}

export async function compileLatex(
  source: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const { onProgress, engine, pages } = options;

  if (!syncConfigured) {
    return {
      ok: false,
      log: '',
      diagnostics: [{ message: 'This app is not connected to a server, so it cannot compile.' }],
    };
  }

  onProgress?.('starting');

  // Cleared in `finally`, so a compile that answers normally doesn't leave a
  // 75-second timer alive behind it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPILE_TIMEOUT_MS);

  try {
    onProgress?.('compiling');
    const response = await apiFetch<CompileApiResponse>('/latex/compile', {
      method: 'POST',
      // Omitted rather than defaulted here: the server owns which engine is the
      // default, and one place deciding that is one place to change it. Pages
      // are likewise only mentioned when wanted, so the request a web client
      // sends is byte-for-byte the one it sent before they existed.
      body: {
        source,
        ...(engine ? { engine } : {}),
        ...(pages ? { include_pages: true, page_width: pages.width } : {}),
      },
      signal: controller.signal,
    });

    const log = response.log ?? '';

    if (response.ok && response.pdf_base64) {
      onProgress?.('done');
      return {
        ok: true,
        pdf: base64ToBytes(response.pdf_base64),
        log,
        pages: response.pages?.length
          ? response.pages.map((page) => ({
              width: page.width,
              height: page.height,
              png: base64ToBytes(page.png_base64),
            }))
          : undefined,
        pagesError: response.pages_error ?? undefined,
      };
    }

    // A document that doesn't compile is a normal answer, not an error: the
    // server returns the TeX log and the client turns it into "Line 5: …".
    const diagnostics = parseTexLog(log);
    if (diagnostics.length === 0) {
      diagnostics.push({ message: 'This document could not be compiled.' });
    }
    return { ok: false, log, diagnostics };
  } catch (e) {
    // Our own timeout, not the document's fault and not the network's either —
    // say so plainly, because "failed to fetch" after 75 silent seconds tells
    // nobody anything. Checked off the controller rather than off the error:
    // what a cancelled request throws differs between fetch implementations.
    if (controller.signal.aborted) {
      return {
        ok: false,
        log: '',
        diagnostics: [
          {
            message: `The server didn't answer within ${Math.round(
              COMPILE_TIMEOUT_MS / 1000,
            )} seconds. It may be unreachable — check the connection and try again.`,
          },
        ],
      };
    }
    // A transport failure — offline, a 429 from the compile queue, a 503 when
    // the server has no TeX installed. Say which, rather than blaming the LaTeX.
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, log: '', diagnostics: [{ message: describeFailure(message) }] };
  } finally {
    clearTimeout(timer);
  }
}

/** Turn an `ApiError`-ish message into something worth showing a person. */
function describeFailure(message: string): string {
  if (message.includes('429')) {
    return 'The server is busy compiling. Try again in a moment.';
  }
  if (message.includes('503')) {
    return 'The server cannot compile LaTeX right now.';
  }
  if (message.includes('413')) {
    return 'This document is too large to compile.';
  }
  return `The resume could not be compiled: ${message}`;
}
