/**
 * Bridges the current auth identity to the sync API client without a circular
 * import (api.ts → token.ts → device-key; the auth context pushes the Firebase
 * user in here as it changes).
 *
 * The bearer sent to the backend is the Firebase ID token when signed in, or the
 * anonymous device key otherwise. Firebase refreshes its token automatically, so
 * `getIdToken()` always returns a fresh one.
 *
 * CRITICAL — identity safety: we only fall back to the device key when the app is
 * *supposed* to be anonymous (Firebase disabled, or never signed in / signed
 * out). If this device has claimed an account but the Firebase session is
 * momentarily unavailable (still restoring on launch, a transient refresh
 * failure, or a dropped web session), we throw instead of silently syncing under
 * the device key — otherwise a signed-in device forks its data onto a throwaway
 * anonymous identity and stops sharing notes with the account. Sync treats this
 * throw as "defer, retry later", not an error.
 */
import type { User as FirebaseUser } from 'firebase/auth';

import { db } from '@/lib/db';
import { getDeviceKey } from '@/lib/sync/device-key';
import { firebaseEnabled } from './firebase';

// Must match SYNCED_UID in sync-engine.ts — the uid this device has claimed. A
// non-empty value means "an account is expected"; '' / unset means anonymous.
const SYNCED_UID = 'synced_uid';

let currentUser: FirebaseUser | null = null;

/** Thrown when an account is expected but its Firebase session isn't available. */
export class AuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthUnavailableError';
  }
}

/** Called by the auth context whenever the signed-in user changes. */
export function setAuthUser(user: FirebaseUser | null): void {
  currentUser = user;
}

export function isSignedIn(): boolean {
  return currentUser !== null;
}

/** The bearer token for the next request: Firebase ID token, or device key. */
export async function getAuthToken(): Promise<string> {
  if (currentUser) return currentUser.getIdToken();

  // No live Firebase user. Decide whether that's legitimately anonymous or a
  // signed-in device whose session is temporarily gone.
  if (!firebaseEnabled) return getDeviceKey();

  const expectedUid = await db.getSetting(SYNCED_UID);
  if (expectedUid) {
    // This device claimed an account, but the session isn't available right now.
    // Refuse to sync rather than fork the account's data onto the device key.
    throw new AuthUnavailableError('signed-in session unavailable; deferring sync');
  }

  // Genuinely anonymous: never signed in, or cleanly signed out.
  return getDeviceKey();
}
