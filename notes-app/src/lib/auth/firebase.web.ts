/**
 * Web counterpart of `firebase.ts`. The native build wires Firebase auth to
 * AsyncStorage via `getReactNativePersistence`, which only exists in Firebase's
 * React Native entry — on web `firebase/auth` doesn't export it. Here `getAuth`
 * uses the browser's default persistence (IndexedDB, falling back to
 * localStorage), so the session survives reloads. Config + the `firebaseEnabled`
 * flag mirror the native module exactly.
 */
import { getApps, initializeApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

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
  auth = getAuth(app);
}

export { auth };
