/**
 * Sign-in providers. Each gets a provider credential from the native flow
 * (Google Sign-In / Apple Authentication) and exchanges it for a Firebase
 * session via `signInWithCredential`. Firebase then owns the session + token
 * refresh; our backend only ever sees the resulting Firebase ID token.
 */
import {
  GoogleAuthProvider,
  OAuthProvider,
  signInWithCredential,
  signOut as firebaseSignOut,
  type UserCredential,
} from 'firebase/auth';
import {
  GoogleSignin,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';

import { auth } from './firebase';

let googleConfigured = false;

function ensureGoogleConfigured(): void {
  if (googleConfigured) return;
  // webClientId is the Firebase project's OAuth *web* client ID (Firebase
  // console → Authentication → Google → Web SDK configuration).
  GoogleSignin.configure({
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  });
  googleConfigured = true;
}

/** Thrown when the user dismisses the native sign-in sheet (not an error). */
export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in cancelled');
    this.name = 'SignInCancelled';
  }
}

export async function signInWithGoogle(): Promise<UserCredential> {
  if (!auth) throw new Error('Firebase is not configured');
  ensureGoogleConfigured();
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  try {
    const result = await GoogleSignin.signIn();
    // google-signin v13+ nests the payload under `data`.
    const idToken =
      (result as { data?: { idToken?: string } }).data?.idToken ??
      (result as { idToken?: string }).idToken;
    if (!idToken) throw new Error('No Google ID token returned');
    const credential = GoogleAuthProvider.credential(idToken);
    return await signInWithCredential(auth, credential);
  } catch (e) {
    if ((e as { code?: string }).code === statusCodes.SIGN_IN_CANCELLED) {
      throw new SignInCancelled();
    }
    throw e;
  }
}

export async function signInWithApple(): Promise<UserCredential> {
  if (!auth) throw new Error('Firebase is not configured');
  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (!credential.identityToken) throw new Error('No Apple identity token returned');
    const provider = new OAuthProvider('apple.com');
    const firebaseCredential = provider.credential({
      idToken: credential.identityToken,
    });
    return await signInWithCredential(auth, firebaseCredential);
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') {
      throw new SignInCancelled();
    }
    throw e;
  }
}

/** Whether Apple sign-in is offered on this device (iOS 13+ only). */
export async function isAppleAuthAvailable(): Promise<boolean> {
  return AppleAuthentication.isAvailableAsync();
}

export async function signOutProviders(): Promise<void> {
  if (auth) await firebaseSignOut(auth);
  try {
    await GoogleSignin.signOut();
  } catch {
    // Not signed in via Google — nothing to clear.
  }
}
