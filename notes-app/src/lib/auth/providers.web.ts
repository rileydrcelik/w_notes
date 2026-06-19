/**
 * Web sign-in providers. The native build drives Google Sign-In / Apple
 * Authentication through native modules; on web those don't exist.
 *
 * Google uses Firebase's **redirect** flow, not the popup flow. The web SQLite
 * engine (wa-sqlite/OPFS) needs the page to be cross-origin isolated, which
 * requires `Cross-Origin-Opener-Policy: same-origin` (see metro.config.js). That
 * COOP value severs `window.opener`, which `signInWithPopup` depends on to hand
 * the result back — so the popup completes but the SDK never receives it. A
 * full-page redirect sidesteps the opener entirely: the result is delivered to
 * `onAuthStateChanged` on the return trip, with `completeRedirectSignIn`
 * surfacing any error from that round trip.
 *
 * Apple is unavailable on web for now. When Firebase isn't configured (`auth` is
 * null) the app simply stays anonymous.
 */
import {
  GoogleAuthProvider,
  getRedirectResult,
  signInWithRedirect,
  signOut as firebaseSignOut,
} from 'firebase/auth';

import { auth } from './firebase';

/** Thrown when the user dismisses the sign-in flow (not an error). */
export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in cancelled');
    this.name = 'SignInCancelled';
  }
}

export async function signInWithGoogle(): Promise<void> {
  if (!auth) throw new Error('Firebase is not configured');
  // Navigates away; control returns to the app (and onAuthStateChanged /
  // completeRedirectSignIn) after the provider round trip.
  await signInWithRedirect(auth, new GoogleAuthProvider());
}

export async function signInWithApple(): Promise<never> {
  throw new Error('Apple sign-in is not available on web yet.');
}

/** Apple sign-in isn't offered on web. */
export async function isAppleAuthAvailable(): Promise<boolean> {
  return false;
}

/**
 * Completes a pending redirect sign-in when the page loads back from the
 * provider. On success `onAuthStateChanged` also fires, so this exists mainly to
 * surface redirect *errors* (e.g. `auth/unauthorized-domain`); a user who backed
 * out resolves to `null` here and is treated as a no-op.
 */
export async function completeRedirectSignIn(): Promise<void> {
  if (!auth) return;
  await getRedirectResult(auth);
}

export async function signOutProviders(): Promise<void> {
  if (auth) await firebaseSignOut(auth);
}
