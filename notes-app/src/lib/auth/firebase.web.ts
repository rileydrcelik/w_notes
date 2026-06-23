/**
 * Firebase auth init for **web**. `initializeAuth` with explicit browser
 * persistence and DELIBERATELY **no** `popupRedirectResolver`.
 *
 * Why no resolver: the SDK's redirect/popup resolver eagerly loads a gapi helper
 * iframe and waits for its handshake before auth init completes. This page is
 * cross-origin isolated (COOP `same-origin` + COEP, required for wa-sqlite's
 * SharedArrayBuffer), and that iframe handshake never completes here — so
 * `getRedirectResult`/init hang forever and `onAuthStateChanged` never fires
 * (infinite spinner on the account screen). With no resolver, the SDK initializes
 * from persistence alone and never touches the iframe.
 *
 * Google sign-in is therefore done WITHOUT the iframe: a manual OAuth redirect
 * gets a Google id_token, which we exchange via `signInWithCredential` (a plain
 * REST call, immune to the isolation issue). See providers.web.ts.
 */
import { getApps, initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  indexedDBLocalPersistence,
  initializeAuth,
  type Auth,
} from 'firebase/auth';

const config = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

export const firebaseEnabled = !!(config.apiKey && config.projectId && config.appId);

let auth: Auth | null = null;

if (firebaseEnabled) {
  const app = getApps().length ? getApps()[0] : initializeApp(config);
  auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  });
}

export { auth };
