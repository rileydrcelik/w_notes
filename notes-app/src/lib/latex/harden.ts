/**
 * Asking the backend to harden a resume against one job title.
 *
 * The tailor's sibling — same arrangement, same server-side Anthropic call, same
 * whole-document answer — and the difference between them is what each is *for*.
 *
 * Tailoring aims at one advert: this company, this posting, these words. What it
 * produces is single-use, and a week later it is a document about a job someone
 * didn't get. Hardening aims at the **job title**, which is the unit hiring
 * actually screens against — a title names a set of qualifications, and the same
 * set turns up across every posting using it. What comes back is the resume you
 * send by default, and the one each later tailoring starts from.
 *
 * That is why it takes exactly one input. The server keeps a reference table of
 * what a hundred-odd job titles are screened for (`backend/app/resume_roles.py`),
 * compiled from reading many real postings for each — so the only thing it needs
 * from a person is which title they are going after. `matchedRole` says which row
 * it found, or is empty when the title isn't in the table and the model's own
 * knowledge stood in; the sheet shows the difference, because "checked against a
 * recruiter's list for this exact title" and "checked against what a model knows"
 * are not the same claim.
 *
 * Safety is the tailor's, unchanged: the server **compiles what the model wrote
 * before returning it**, so a document that doesn't build never arrives, and the
 * screen records a version before applying, so the un-hardened resume is one tap
 * away in the history.
 */
import type { LatexEngine } from '@/lib/latex/types';
import { ApiError, apiFetch, syncConfigured } from '@/lib/sync/api';

/** What the hardening form collects. One field, and it is the job title. */
export type HardenDraft = {
  /** The primary job title being applied for, e.g. "Data Engineer". */
  role: string;
};

/** An empty draft, for opening the form. */
export function emptyHardenDraft(): HardenDraft {
  return { role: '' };
}

/**
 * How long to wait. The same allowance as tailoring, because it is the same work
 * on the server: up to three rounds of writing a whole document *and* compiling
 * it, since "one page" is checked rather than hoped for.
 */
const HARDEN_TIMEOUT_MS = 300_000;

/**
 * The longest job title the server will take.
 *
 * Kept in step with `_MAX_ROLE_CHARS` in `backend/app/routers/resume.py`. Checked
 * here as well so someone who pastes a whole posting into the title field is told
 * so while they can still see the field, rather than after a round trip.
 */
export const MAX_ROLE_CHARS = 120;

/**
 * A failure that arrived *after* the response started.
 *
 * `/resume/harden` streams (see `hold_open` in `backend/app/routers/resume.py`):
 * it sends headers immediately and holds the connection open with whitespace,
 * because this API is published through a Cloudflare Tunnel that gives the
 * origin ~100 seconds to start answering and a real resume takes longer than
 * that. Measured against production: a one-page resume answered in 18s, a longer
 * one — the normal case — was cut off at 125s with a 524, every time.
 *
 * The cost is that the status code is chosen before the answer is known, so it
 * is always 200 and a refusal has to travel in the body. Guard-clause failures
 * (no role, resume too large) still arrive as ordinary 4xx, so both paths below
 * are live and neither is dead code.
 */
type StreamedError = { error?: { status: number; detail: string } };

type HardenApiResponse = StreamedError & {
  latex: string;
  emphasis?: string;
  pages?: number | null;
  matched_role?: string;
};

export type HardenedResume = {
  /** The complete hardened document. */
  latex: string;
  /** One line on what this version leads with. */
  emphasis: string;
  /**
   * Pages it compiled to. Normally 1 — the server keeps trying until it is, or
   * runs out of attempts — so anything else is worth telling the user.
   */
  pages: number | null;
  /**
   * The reference row the server matched, e.g. "Full Stack Software Engineer".
   * Empty when the title matched nothing and the model worked from its own
   * knowledge of the role.
   */
  matchedRole: string;
};

export type HardenResult =
  | { ok: true; resume: HardenedResume }
  | { ok: false; message: string };

/** Whether hardening is possible at all — i.e. an API is configured. */
export function isHardenSupported(): boolean {
  return syncConfigured;
}

/**
 * Ask the server for a hardened resume. Never throws, for the same reason the
 * other resume requests don't: every way this fails is something the person can
 * act on.
 */
export async function hardenResume(
  source: string,
  draft: HardenDraft,
  engine: LatexEngine,
): Promise<HardenResult> {
  if (!syncConfigured) {
    return {
      ok: false,
      message: 'This app is not connected to a server, so it cannot harden resumes.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARDEN_TIMEOUT_MS);

  try {
    const response = await apiFetch<HardenApiResponse>('/resume/harden', {
      method: 'POST',
      signal: controller.signal,
      body: { source, role: draft.role, engine },
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
        matchedRole: response.matched_role?.trim() ?? '',
      },
    };
  } catch (e) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        message: `The server didn't answer within ${Math.round(
          HARDEN_TIMEOUT_MS / 60_000,
        )} minutes. Your resume is unchanged. Try again.`,
      };
    }
    const detail = serverDetail(e);
    if (detail) return { ok: false, message: detail };
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message: describeHardenFailure(message) };
  } finally {
    clearTimeout(timer);
  }
}

/** The `detail` FastAPI put in the body, if this was a refusal that carried one. */
function serverDetail(e: unknown): string | null {
  if (!(e instanceof ApiError) || !e.body) return null;
  // Only the statuses whose detail is written for a person to read — same rule
  // as `tailor.ts`, and the same reason: a 500's body is not, and a 502 from a
  // proxy might not even be JSON.
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
 * because the one thing someone needs to know after a failed run is whether their
 * document survived it.
 */
function describeHardenFailure(message: string): string {
  if (message.includes('429')) {
    return 'The server is writing as much as it can right now. Try again in a moment.';
  }
  if (message.includes('503')) {
    return 'This server is not set up to harden resumes yet.';
  }
  if (message.includes('504')) {
    return 'Hardening this resume took too long. Your resume is unchanged — try again.';
  }
  if (message.includes('413')) {
    return 'This resume is too large to harden.';
  }
  if (message.includes('422')) {
    // The server's own sentence is the useful one here, and the caller prefers
    // it; this is the fallback for a 422 that carried no readable detail.
    return 'The hardened resume could not be produced. Your resume is unchanged.';
  }
  return `The resume could not be hardened: ${message}`;
}
