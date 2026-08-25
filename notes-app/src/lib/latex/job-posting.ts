/**
 * Turning one job posting into the three fields the tailor needs, from a paste or
 * from a link.
 *
 * **The paste is the default.** That is not a preference about typing, it is what
 * the sites do — and it is the fact this module is built around rather than one
 * it hides. Measured against the real fetch: a static
 * Greenhouse board or a company careers page reads fine; Ashby returns a bare
 * "you need to enable JavaScript" shell; Lever answers `url_not_accessible`;
 * LinkedIn and Workday are refused outright. Those are the sites people actually
 * apply through, so the unreadable case is not an edge — it is the common one,
 * and it has to land somewhere useful.
 *
 * So asking for a link first meant opening with the question that usually fails.
 * `readPastedPosting` is what the sheet calls now: you paste the page you are
 * already looking at, and the company, the title and the requirements are pulled
 * out of that one paste. `readJobPosting` stays for the links that *do* read —
 * a static Greenhouse board or a company careers page — where it saves the copy.
 *
 * Either way this is a *separate, short* call rather than a branch inside
 * tailoring. Reading costs about fifteen seconds and can be corrected before the
 * long part starts; folded into the tailor, a bad read would have burned a whole
 * document generation and a TeX run first, to arrive at the same place two
 * minutes later.
 *
 * On the link path the page is fetched by Anthropic's `web_fetch` tool, not by
 * the backend and not by the app — nothing on our side of the wire ever requests
 * a URL a user typed. On the paste path nothing is fetched at all.
 */
import { ApiError, apiFetch, syncConfigured } from '@/lib/sync/api';
import { KEY_REQUIRED_MESSAGE } from '@/lib/ai-key';

/** What a posting gave up, ready to drop into the tailor's draft. */
export type JobPosting = {
  company: string;
  role: string;
  /** The posting's own text — responsibilities and, above all, requirements. */
  description: string;
};

export type PostingResult =
  | { ok: true; posting: JobPosting }
  /**
   * `unreadable` is the case the sheet acts on rather than just reports.
   *
   * On the link path it means the link was fine but the page can't be fetched, so
   * the answer is to fall back to pasting. On the paste path it means the paste
   * didn't contain a posting — there is nowhere further to fall back to, so the
   * sheet just says so and leaves the text for them to fix. Any other failure is
   * a message and nothing more.
   */
  | { ok: false; unreadable: boolean; message: string };

/**
 * The most a pasted page may be before it is refused locally.
 *
 * Matches `_MAX_POSTING_PAGE_CHARS` in `backend/app/routers/resume.py`. Checked
 * here as well as there so an obvious mistake — a whole site pasted in, a file
 * dropped by accident — is answered instantly instead of after a round trip that
 * bills the caller's key to reach the same conclusion.
 */
export const MAX_PASTED_PAGE_CHARS = 60_000;

/**
 * How long to wait for a posting to be read.
 *
 * One fetch and a short extraction — far quicker than tailoring, and deliberately
 * bounded well under it, because this runs *before* the long part and a person is
 * watching a link they just pasted.
 */
const POSTING_TIMEOUT_MS = 90_000;

/** True once a string looks like a link worth sending. */
export function looksLikeUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  // Needs a host with a dot in it: "https://foo" is not a posting.
  const host = trimmed.slice(trimmed.indexOf('://') + 3).split(/[/?#]/)[0];
  return host.includes('.') && host.length > 3;
}

/**
 * Pull the company, title and requirements out of a pasted job page.
 *
 * The tailor's default way in. What gets pasted is raw — nav bar, cookie notice,
 * "similar jobs" rail and all — and finding the posting inside that is the
 * server's job, not something the person should have to do with a mouse.
 *
 * Fails as `unreadable` when the paste holds no single posting (a list of
 * openings, a consent page, a stray clipboard). That is a real outcome rather
 * than an error: the text stays on screen and they can fix it.
 */
export async function readPastedPosting(text: string): Promise<PostingResult> {
  if (!syncConfigured) {
    return {
      ok: false,
      unreadable: false,
      message: 'This app is not connected to a server, so it cannot read job postings.',
    };
  }
  const pasted = text.trim();
  if (!pasted) {
    return { ok: false, unreadable: false, message: 'Paste the job posting first.' };
  }
  // Refused here rather than at the server for the reason on the constant: an
  // obvious mistake shouldn't cost a round trip and a bill to diagnose.
  if (pasted.length > MAX_PASTED_PAGE_CHARS) {
    return {
      ok: false,
      unreadable: false,
      message:
        'That paste is too long. Copy the posting itself rather than the whole page.',
    };
  }
  return request({ text: pasted });
}

export async function readJobPosting(url: string): Promise<PostingResult> {
  if (!syncConfigured) {
    return {
      ok: false,
      unreadable: false,
      message: 'This app is not connected to a server, so it cannot read job postings.',
    };
  }
  if (!looksLikeUrl(url)) {
    return {
      ok: false,
      unreadable: false,
      message: 'That doesn’t look like a link. It should start with http:// or https://.',
    };
  }
  return request({ url: url.trim() });
}

/**
 * The half both paths share: one request, one timeout, one reading of what came
 * back. Only the body differs, and it differs by exactly one key.
 */
async function request(body: { url: string } | { text: string }): Promise<PostingResult> {
  // Which way in this was. The two paths differ in what a failure *means* and so
  // in what the sheet should do next; deriving it from the body keeps that from
  // becoming a second argument the callers could disagree about.
  const fromPaste = 'text' in body;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POSTING_TIMEOUT_MS);

  try {
    const response = await apiFetch<JobPosting>('/resume/job-posting', {
      method: 'POST',
      signal: controller.signal,
      body,
    });
    if (!response?.description?.trim()) {
      return { ok: false, unreadable: true, message: UNREADABLE };
    }
    return {
      ok: true,
      posting: {
        company: response.company?.trim() ?? '',
        role: response.role?.trim() ?? '',
        description: response.description.trim(),
      },
    };
  } catch (e) {
    if (controller.signal.aborted) {
      // A read that takes this long is one we're not going to get — but what to
      // do about it differs by path, so the two do not share an answer.
      //
      // From a link it is `unreadable` in the sense that matters: we didn't get
      // the page, and pasting is the way forward, which is exactly what that flag
      // moves the sheet towards. From a paste there is no forward to move to, and
      // claiming the text held no posting when in truth nobody finished looking
      // would send someone off to rewrite text that was fine.
      return fromPaste
        ? { ok: false, unreadable: false, message: TIMED_OUT }
        : { ok: false, unreadable: true, message: UNREADABLE };
    }
    // 422 is the server saying it read the page and there was no posting on it.
    // That is the case worth acting on, so it carries the server's own sentence.
    if (e instanceof ApiError && e.status === 422) {
      // Except when it is not the server saying that at all. FastAPI answers a
      // request whose *shape* it does not recognise with this same status, and
      // its `detail` is a list of field errors rather than a sentence. That is
      // this client and that server disagreeing about the request: nothing was
      // ever read, and the paste is not at fault. Reporting it as “that is not a
      // posting” sends someone off to rewrite text that was fine — which is
      // exactly what a backend still on the pre-paste `PostingRequest` (`url`
      // required, no `text`) did, instantly and convincingly.
      if (isMalformedRequest(e)) {
        return { ok: false, unreadable: false, message: WRONG_SHAPE };
      }
      // The server writes a different sentence per path (`_UNPARSEABLE_PASTE` vs
      // `_UNREADABLE_POSTING`), so its own detail is preferred over either
      // fallback here.
      return {
        ok: false,
        unreadable: true,
        message: detailOf(e) ?? (fromPaste ? NOT_A_POSTING : UNREADABLE),
      };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, unreadable: false, message: describeFailure(message) };
  } finally {
    clearTimeout(timer);
  }
}

const NOT_A_POSTING =
  'That paste doesn’t look like a single job posting. Copy the posting page itself — title, description and requirements — rather than a list of openings.';

const WRONG_SHAPE =
  'The server rejected the request itself, so nothing was read — the paste is fine. This build is probably pointed at a server running an older version of the app.';

const TIMED_OUT =
  'Reading that posting took too long. Nothing has changed — try again.';

const UNREADABLE =
  'That page couldn’t be read. Many job sites — LinkedIn and Workday among them — block automated readers. Paste the posting instead.';

/**
 * True when a 422 is FastAPI rejecting the request's shape, not the endpoint
 * judging its content. `detail` tells them apart: the endpoint writes a
 * sentence, the framework writes a list of `{loc, msg, type}`. Only the list
 * shape counts — a 422 with no body at all stays the endpoint's, since that is
 * the one this client cannot distinguish and the posting-shaped reading is the
 * likelier of the two.
 */
function isMalformedRequest(e: ApiError): boolean {
  if (!e.body) return false;
  try {
    const parsed = JSON.parse(e.body) as { detail?: unknown };
    return Array.isArray(parsed.detail);
  } catch {
    return false;
  }
}

function detailOf(e: ApiError): string | null {
  if (!e.body) return null;
  try {
    const parsed = JSON.parse(e.body) as { detail?: unknown };
    return typeof parsed.detail === 'string' && parsed.detail.trim() ? parsed.detail : null;
  } catch {
    return null;
  }
}

function describeFailure(message: string): string {
  // Checked before every other status: this one is not a failure of the
  // request but a statement about the account, and the remedy is a screen
  // away rather than a retry.
  if (message.includes('402')) return KEY_REQUIRED_MESSAGE;
  if (message.includes('429')) {
    return 'The server is reading as much as it can right now. Try again in a moment.';
  }
  if (message.includes('503')) {
    return 'This server is not set up to read job postings yet.';
  }
  if (message.includes('400')) {
    return 'That doesn’t look like a link. It should start with http:// or https://.';
  }
  return `That link could not be read: ${message}`;
}
