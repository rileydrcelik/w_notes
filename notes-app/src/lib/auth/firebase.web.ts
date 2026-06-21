/**
 * Web counterpart of `firebase.ts`. The native build wires Firebase auth to
 * AsyncStorage via `getReactNativePersistence`, which only exists in Firebase's
 * React Native entry — on web `firebase/auth` doesn't export it. Here `getAuth`
 * uses the browser's default persistence (IndexedDB, falling back to
 * localStorage) and bundles the redirect resolver. Config + the `firebaseEnabled`
 * flag mirror the native module exactly, except `authDomain` (see below).
 *
 * `authDomain` is forced to the app's OWN host instead of …firebaseapp.com. The
 * app page is cross-origin isolated (COOP `same-origin` + COEP, required for
 * wa-sqlite's SharedArrayBuffer). Firebase's redirect flow loads a helper iframe
 * from `authDomain`; when that's a *cross-origin* domain the credentialless
 * iframe is storage-partitioned and never returns the result, so
 * `getRedirectResult` hangs and `onAuthStateChanged` never fires (infinite
 * spinner on the account screen). Pointing `authDomain` at our host — where
 * `web-functions/__` proxies Firebase's reserved `/__/auth/*` paths to
 * firebaseapp.com — makes the helper same-origin and immune to the block.
 */
import { getApps, initializeApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

const config = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  // Same-origin auth helper (see note above). Off-DOM (build-time eval) fall back
  // to the configured domain; in the browser this is the serving host, where the
  // /__/auth/* proxy lives.
  authDomain:
    typeof window !== 'undefined'
      ? window.location.host
      : process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

export const firebaseEnabled = !!(config.apiKey && config.projectId && config.appId);

let auth: Auth | null = null;

if (firebaseEnabled) {
  const app = getApps().length ? getApps()[0] : initializeApp(config);
  auth = getAuth(app);
}

export { auth };
