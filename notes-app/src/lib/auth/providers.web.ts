/**
 * Web sign-in providers. The native build drives Google Sign-In / Apple
 * Authentication through native modules; on web those don't exist.
 *
 * Google uses a **manual OAuth redirect**, not Firebase's `signInWithRedirect`.
 * The page is cross-origin isolated (COOP `same-origin` + COEP, required for
 * wa-sqlite/OPFS — see metro.config.js). That breaks BOTH of Firebase's built-in
 * web flows: `signInWithPopup` needs `window.opener` (severed by COOP), and
 * `signInWithRedirect`/`getRedirectResult` need a gapi helper iframe whose
 * handshake never completes under isolation (hangs the account screen forever).
 *
 * So we do it ourselves: redirect the whole page to Google's OAuth endpoint for an
 * id_token (implicit flow — the same `response_type=id_token` Firebase itself
 * uses), then on return exchange that token via `signInWithCredential`, which is a
 * plain REST call with no iframe/opener and works fine under isolation.
 * `onAuthStateChanged` (auth-context) picks up the resulting session.
 *
 * Apple is unavailable on web for now. When Firebase isn't configured (`auth` is
 * null) the app simply stays anonymous.
 */
import {
  GoogleAuthProvider,
  signInWithCredential,
  signOut as firebaseSignOut,
} from 'firebase/auth';

import { auth } from './firebase';

// The Firebase project's auto-created Google OAuth web client (public, not a
// secret — it's already in the client bundle). Its Authorized redirect URIs must
// include the app origin + "/" (where Google sends the id_token back).
const GOOGLE_CLIENT_ID =
  '711378059243-58ova4brehlnv066nfndjevasq6cr953.apps.googleusercontent.com';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const NONCE_KEY = 'g_oauth_nonce';

/** Thrown when the user dismisses the sign-in flow (not an error). */
export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in cancelled');
    this.name = 'SignInCancelled';
  }
}

/** A hex nonce, required by Google's id_token (implicit) flow to prevent replay. */
function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The redirect target Google sends the id_token back to (must be registered). */
function redirectUri(): string {
  return `${window.location.origin}/`;
}

export async function signInWithGoogle(): Promise<void> {
  if (!auth) throw new Error('Firebase is not configured');
  const nonce = randomNonce();
  sessionStorage.setItem(NONCE_KEY, nonce);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'id_token',
    scope: 'openid email profile',
    nonce,
    prompt: 'select_account',
  });
  // Full-page navigation to Google; control returns to the app at redirectUri()
  // with the id_token in the URL fragment (handled by completeRedirectSignIn).
  window.location.assign(`${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`);
}

export async function signInWithApple(): Promise<never> {
  throw new Error('Apple sign-in is not available on web yet.');
}

/** Apple sign-in isn't offered on web. */
export async function isAppleAuthAvailable(): Promise<boolean> {
  return false;
}

/**
 * Completes a manual Google sign-in when the page loads back from Google with an
 * id_token in the URL fragment. Exchanges it for a Firebase session via
 * `signInWithCredential`; `onAuthStateChanged` then fires. No-op on an ordinary
 * load (no `id_token`/`error` fragment) and on native.
 */
export async function completeRedirectSignIn(): Promise<void> {
  if (!auth || typeof window === 'undefined') return;
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return;

  const params = new URLSearchParams(hash.slice(1));
  const idToken = params.get('id_token');
  const error = params.get('error');
  // Only react to an OAuth return; leave ordinary fragments alone.
  if (!idToken && !error) return;

  // Clear the fragment so a reload doesn't reprocess it (and doesn't leave the
  // token sitting in the address bar).
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  sessionStorage.removeItem(NONCE_KEY);

  if (error) {
    if (error === 'access_denied') throw new SignInCancelled();
    throw new Error(`Google sign-in failed: ${error}`);
  }

  await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
}

export async function signOutProviders(): Promise<void> {
  if (auth) await firebaseSignOut(auth);
}
