/**
 * Your own GitHub / Sentry tokens, held by the server.
 *
 * These used to be a single token belonging to whoever ran the backend, which
 * meant every account browsed *that person's* repositories — a second user
 * opened the GitHub plugin and was shown someone else's private repos. Each
 * account now supplies its own, stored encrypted server-side.
 *
 * **Write-only.** A token goes up and never comes back: the API returns only
 * whether one is saved and its last four characters. So this module has no
 * "load my token" call by design, and nothing here should ever cache a token in
 * SQLite — a plaintext copy on every device is precisely what holding it
 * server-side avoids.
 */
import { apiFetch, syncConfigured } from '@/lib/sync/api';

export type CredentialProvider = 'github' | 'sentry';

/** What the server will say about a token without revealing it. */
export type CredentialStatus = {
  provider: CredentialProvider;
  saved: boolean;
  /** Last 4 characters of the token, '' when nothing is saved. */
  hint: string;
  updated_at: number | null;
};

const EMPTY: Record<CredentialProvider, CredentialStatus> = {
  github: { provider: 'github', saved: false, hint: '', updated_at: null },
  sentry: { provider: 'sentry', saved: false, hint: '', updated_at: null },
};

/** A status map with nothing saved — the shape to fall back to when offline. */
export function emptyCredentialStatus(): Record<CredentialProvider, CredentialStatus> {
  return { github: { ...EMPTY.github }, sentry: { ...EMPTY.sentry } };
}

/**
 * Which providers this account has a token for.
 *
 * Returns the empty map rather than throwing when the backend isn't configured,
 * so Settings renders normally offline instead of showing an error for a
 * feature the user hasn't touched.
 */
export async function fetchCredentials(): Promise<
  Record<CredentialProvider, CredentialStatus>
> {
  if (!syncConfigured) return emptyCredentialStatus();
  const res = await apiFetch<{ credentials: CredentialStatus[] }>('/credentials');
  const out = emptyCredentialStatus();
  for (const c of res.credentials) {
    if (c.provider in out) out[c.provider] = c;
  }
  return out;
}

/** Store (or replace) this account's token for one provider. */
export async function saveCredential(
  provider: CredentialProvider,
  token: string,
): Promise<CredentialStatus> {
  return apiFetch<CredentialStatus>(`/credentials/${provider}`, {
    method: 'PUT',
    body: { token },
  });
}

/** Forget this account's token for one provider. */
export async function deleteCredential(provider: CredentialProvider): Promise<void> {
  await apiFetch(`/credentials/${provider}`, { method: 'DELETE' });
}
