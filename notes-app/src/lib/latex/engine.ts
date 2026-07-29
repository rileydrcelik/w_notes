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
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

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
  const { onProgress, engine } = options;

  if (!syncConfigured) {
    return {
      ok: false,
      log: '',
      diagnostics: [{ message: 'This app is not connected to a server, so it cannot compile.' }],
    };
  }

  onProgress?.('starting');

  try {
    onProgress?.('compiling');
    const response = await apiFetch<CompileApiResponse>('/latex/compile', {
      method: 'POST',
      // Omitted rather than defaulted here: the server owns which engine is the
      // default, and one place deciding that is one place to change it.
      body: engine ? { source, engine } : { source },
    });

    const log = response.log ?? '';

    if (response.ok && response.pdf_base64) {
      onProgress?.('done');
      return { ok: true, pdf: base64ToBytes(response.pdf_base64), log };
    }

    // A document that doesn't compile is a normal answer, not an error: the
    // server returns the TeX log and the client turns it into "Line 5: …".
    const diagnostics = parseTexLog(log);
    if (diagnostics.length === 0) {
      diagnostics.push({ message: 'This document could not be compiled.' });
    }
    return { ok: false, log, diagnostics };
  } catch (e) {
    // A transport failure — offline, a 429 from the compile queue, a 503 when
    // the server has no TeX installed. Say which, rather than blaming the LaTeX.
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, log: '', diagnostics: [{ message: describeFailure(message) }] };
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
