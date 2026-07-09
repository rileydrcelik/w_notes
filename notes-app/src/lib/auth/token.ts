/**
 * Bridges the current auth identity to the sync API client without a circular
 * import (api.ts → token.ts → device-key; the auth context pushes the Firebase
 * user in here as it changes).
 *
 * The bearer sent to the backend is the Firebase ID token when signed in, or the
 * anonymous device key otherwise. Firebase refreshes its token automatically, so
 * `getIdToken()` always returns a fresh one.
 */
import type { User as FirebaseUser } from 'firebase/auth';

import { getDeviceKey } from '@/lib/sync/device-key';

let currentUser: FirebaseUser | null = null;

/** Called by the auth context whenever the signed-in user changes. */
export function setAuthUser(user: FirebaseUser | null): void {
  currentUser = user;
}

export function isSignedIn(): boolean {
  return currentUser !== null;
}

/** The bearer token for the next request: Firebase ID token, or device key. */
export async function getAuthToken(): Promise<string> {
  if (currentUser) {
    try {
      return await currentUser.getIdToken();
    } catch {
      return getDeviceKey();
    }
  }
  return getDeviceKey();
}
