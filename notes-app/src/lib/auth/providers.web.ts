/**
 * Web sign-in providers. The native build drives Google Sign-In / Apple
 * Authentication through native modules; on web those don't exist, so Google
 * goes through Firebase's popup flow (the JS SDK's web-native path) and Apple is
 * unavailable for now. When Firebase isn't configured (`auth` is null — the
 * default in this local-only pass) the app simply stays anonymous.
 */
import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  type UserCredential,
} from 'firebase/auth';

import { auth } from './firebase';

/** Thrown when the user dismisses the sign-in popup (not an error). */
export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in cancelled');
    this.name = 'SignInCancelled';
  }
}

export async function signInWithGoogle(): Promise<UserCredential> {
  if (!auth) throw new Error('Firebase is not configured');
  try {
    return await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      throw new SignInCancelled();
    }
    throw e;
  }
}

export async function signInWithApple(): Promise<UserCredential> {
  throw new Error('Apple sign-in is not available on web yet.');
}

/** Apple sign-in isn't offered on web. */
export async function isAppleAuthAvailable(): Promise<boolean> {
  return false;
}

export async function signOutProviders(): Promise<void> {
  if (auth) await firebaseSignOut(auth);
}
