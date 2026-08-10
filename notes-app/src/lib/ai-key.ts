/**
 * The account's Anthropic API key: what the app knows about it, and how it asks
 * the server to change it.
 *
 * The key itself never lives here. It is typed once, sent once, and from then on
 * the app only ever sees {@link AiKeyState} — whether one is stored and its last
 * four characters. That is deliberate rather than incidental: a credential the
 * client caches is a credential in AsyncStorage, in a Redux devtools dump, and
 * in whatever the next crash reporter decides to attach. The one place it is
 * allowed to exist is the text field it was pasted into, for as long as that
 * screen is open.
 *
 * The AI features are gated because they cost real money — a frontier model over
 * a whole resume, several times per press for the tailor — and the backend is
 * multi-tenant. The operator's own account rides the server's key (`owner`);
 * everyone else brings their own.
 */
import { ApiError, apiFetch } from '@/lib/sync/api';

/** Everything the UI needs to know about the account's key, and nothing more. */
export type AiKeyState = {
  /** Whether AI features will run — either a stored key, or owner status. */
  configured: boolean;
  /** Last four characters of the stored key, for telling one key from another. */
  hint: string | null;
  /** This account uses the server's key and needs none of its own. */
  owner: boolean;
  /** The server can store keys at all. False when it has no encryption secret. */
  canStore: boolean;
};

/**
 * HTTP 402, which the backend returns from an AI endpoint when the caller has no
 * key to spend.
 *
 * It has a name here because the client has to tell it apart from every other
 * failure: 402 puts "add your key" on screen, while a 413 means the resume is
 * too long and a 503 means the server is having a bad day. Matching on the
 * status rather than the message keeps the copy free to change.
 */
export const KEY_REQUIRED_STATUS = 402;

/** Whether a failed request failed *only* because no key is set up. */
export const isKeyRequired = (error: unknown): boolean =>
  error instanceof ApiError && error.status === KEY_REQUIRED_STATUS;

type Wire = {
  configured?: boolean;
  hint?: string | null;
  owner?: boolean;
  can_store?: boolean;
};

/**
 * Read the wire shape defensively, defaulting to the *closed* interpretation.
 *
 * A malformed or half-understood response should leave the app believing there
 * is no key, which shows a prompt someone can act on. Defaulting the other way
 * would hide the prompt and let every AI press fail with nothing explaining why.
 */
const fromWire = (raw: Wire): AiKeyState => ({
  configured: raw.configured === true,
  hint: raw.hint ?? null,
  owner: raw.owner === true,
  canStore: raw.can_store !== false,
});

export async function fetchAiKeyState(): Promise<AiKeyState> {
  return fromWire(await apiFetch<Wire>('/me/ai-key'));
}

/** Store (or replace) the account's key. Rejects with an ApiError on a bad one. */
export async function saveAiKey(key: string): Promise<AiKeyState> {
  return fromWire(await apiFetch<Wire>('/me/ai-key', { method: 'PUT', body: { key: key.trim() } }));
}

export async function forgetAiKey(): Promise<AiKeyState> {
  return fromWire(await apiFetch<Wire>('/me/ai-key', { method: 'DELETE' }));
}

/**
 * What to show when a key is missing. One string, because there is one remedy
 * and every AI surface should name it the same way.
 */
export const KEY_REQUIRED_MESSAGE =
  'This runs on Anthropic’s API and needs your own key. Add one in Settings → AI.';
