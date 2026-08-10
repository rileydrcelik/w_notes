/**
 * Asking the backend to aim a resume at one job.
 *
 * The counterpart to `entry.ts`, and the same arrangement: the Anthropic call
 * happens server-side, because a key in the app bundle is a key anyone can read.
 * What differs is what comes back — a whole document rather than a fragment.
 *
 * That makes this the one request in the resume plugin that replaces the resume
 * instead of reaching into it, and it is safe for two reasons that live elsewhere.
 * The server **compiles what the model wrote before returning it**, so a document
 * that doesn't build never arrives; and the screen records a version before
 * applying it, so the untailored resume is one tap away in the history.
 *
 * How the commented-out parts of a resume matter here is worth knowing: this app
 * treats a resume as a superset, where benched experience and projects live on as
 * LaTeX comments. Tailoring is mostly *choosing* — uncommenting what earns its
 * place for this job and commenting out what doesn't — and the server's prompt
 * requires that nothing is ever deleted, so the bench survives every round.
 */
import type { LatexEngine } from '@/lib/latex/types';
import { ApiError, apiFetch, syncConfigured } from '@/lib/sync/api';
import { KEY_REQUIRED_MESSAGE } from '@/lib/ai-key';

/** What the tailoring form collects. */
export type TailorDraft = {
  /** Who the application is to. Optional — a posting without a named company
   *  still tailors fine, it just can't say "at Acme". */
  company: string;
  /** The job title being applied for. */
  role: string;
  /** The posting, pasted whole, requirements included. */
  jobDescription: string;
};

/** An empty draft, for opening the form. */
export function emptyTailorDraft(): TailorDraft {
  return { company: '', role: '', jobDescription: '' };
}

/**
 * How long to wait.
 *
 * Far longer than the other two requests, because the server is doing far more:
 * up to three rounds of writing a whole document *and* compiling it, since "one
 * page" is checked rather than hoped for. Its own ceiling is roughly a model call
 * plus a TeX run, times three attempts; this sits above that so that when it does
 * give up, its explanation wins over "the client stopped waiting".
 */
const TAILOR_TIMEOUT_MS = 300_000;

/**
 * A failure that arrived *after* the response started.
 *
 * `/resume/tailor` streams (see `hold_open` in `backend/app/routers/resume.py`):
 * it sends headers immediately and holds the connection open with whitespace,
 * because this API is published through a Cloudflare Tunnel that gives the
 * origin ~100 seconds to start answering and tailoring takes longer. Measured
 * against production, the two-pass path was cut off at 125s with a 524 every
 * time — which is why the logs show tailoring never once completing there.
 *
 * The cost is that the status code is chosen before the answer is known, so it
 * is always 200 and a refusal travels in the body. Guard-clause failures (no
 * role, no job description) still arrive as ordinary 4xx.
 */
type StreamedError = { error?: { status: number; detail: string } };

type TailorApiResponse = StreamedError & {
  latex: string;
  emphasis?: string;
  /** How many pages it actually came out at, per the TeX log. */
  pages?: number | null;
};

export type TailoredResume = {
  /** The complete tailored document. */
  latex: string;
  /** One line on what this version leads with. */
  emphasis: string;
  /**
   * Pages it compiled to. Normally 1 — the server keeps trying until it is, or
   * runs out of attempts — so anything else is worth telling the user, since they
   * asked for a one-page resume and this isn't one.
   */
  pages: number | null;
};

export type TailorResult =
  | { ok: true; resume: TailoredResume }
  | { ok: false; message: string };

/** Whether tailoring is possible at all — i.e. an API is configured. */
export function isTailorSupported(): boolean {
  return syncConfigured;
}

/**
 * Ask the server for a tailored resume. Never throws, for the same reason the
 * other two don't: every way this fails is something the person can act on.
 */
export async function tailorResume(
  source: string,
  draft: TailorDraft,
  engine: LatexEngine,
): Promise<TailorResult> {
  if (!syncConfigured) {
    return {
      ok: false,
      message: 'This app is not connected to a server, so it cannot tailor resumes.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TAILOR_TIMEOUT_MS);

  try {
    const response = await apiFetch<TailorApiResponse>('/resume/tailor', {
      method: 'POST',
      signal: controller.signal,
      body: {
        source,
        company: draft.company,
        role: draft.role,
        job_description: draft.jobDescription,
        engine,
      },
    });

    // Checked before anything else: this arrives with a 200, so reading `latex`
    // first would report "empty resume" for a server that explained itself.
    if (response?.error?.detail) {
      return { ok: false, message: response.error.detail };
    }
    if (!response?.latex?.trim()) {
      return { ok: false, message: 'The server came back with an empty resume. Try again.' };
    }
    return {
      ok: true,
      resume: {
        latex: response.latex,
        emphasis: response.emphasis?.trim() ?? '',
        pages: response.pages ?? null,
      },
    };
  } catch (e) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        message: `The server didn't answer within ${Math.round(
          TAILOR_TIMEOUT_MS / 60_000,
        )} minutes. Your resume is unchanged. Try again.`,
      };
    }
    // The server's own sentence, where it wrote one. Worth preferring over a
    // generic line for the 4xx cases: "the tailored resume didn't compile, so it
    // hasn't been applied — your resume is unchanged" is the difference between
    // knowing what happened and guessing.
    const detail = serverDetail(e);
    if (detail) return { ok: false, message: detail };
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message: describeTailorFailure(message) };
  } finally {
    clearTimeout(timer);
  }
}

/** The `detail` FastAPI put in the body, if this was a refusal that carried one. */
function serverDetail(e: unknown): string | null {
  if (!(e instanceof ApiError) || !e.body) return null;
  // Only for the statuses whose detail is written for a person to read. A 500's
  // body is not, and a 502 from a proxy might not even be JSON.
  if (e.status !== 400 && e.status !== 413 && e.status !== 422) return null;
  try {
    const parsed = JSON.parse(e.body) as { detail?: unknown };
    return typeof parsed.detail === 'string' && parsed.detail.trim() ? parsed.detail : null;
  } catch {
    return null;
  }
}

/**
 * Failure text. Every branch says the resume is unchanged where that's true,
 * because the one thing someone needs to know after a failed tailoring is whether
 * their document survived it.
 */
function describeTailorFailure(message: string): string {
  // Checked before every other status: this one is not a failure of the
  // request but a statement about the account, and the remedy is a screen
  // away rather than a retry.
  if (message.includes('402')) return KEY_REQUIRED_MESSAGE;
  if (message.includes('429')) {
    return 'The server is writing as much as it can right now. Try again in a moment.';
  }
  if (message.includes('503')) {
    return 'This server is not set up to tailor resumes yet.';
  }
  if (message.includes('504')) {
    return 'Tailoring this resume took too long. Your resume is unchanged — try again.';
  }
  if (message.includes('413')) {
    return 'That is too long to tailor. Shorten the job description to the role and its requirements.';
  }
  if (message.includes('422')) {
    // The server's own sentence is the useful one here — it distinguishes "didn't
    // compile" from the other refusals — so it's passed through by the caller.
    return 'The tailored resume could not be produced. Your resume is unchanged.';
  }
  return `The resume could not be tailored: ${message}`;
}
