/**
 * Firebase app + auth initialization (JS SDK).
 *
 * Config is read from `EXPO_PUBLIC_FIREBASE_*` env vars; when they're absent the
 * SDK isn't initialized and `auth` stays null, so the app runs anonymously
 * (device-key sync only) until Firebase is configured. Auth state is persisted
 * across launches in AsyncStorage.
 */
import { getApps, initializeApp } from 'firebase/app';
import { initializeAuth, type Auth, type Persistence } from 'firebase/auth';
import * as fbAuth from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';

const config = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

export const firebaseEnabled = !!(config.apiKey && config.projectId && config.appId);

// getReactNativePersistence ships only in Firebase's React Native build, which
// Metro resolves at runtime; the web type entry tsc sees doesn't declare it.
const getReactNativePersistence = (fbAuth as unknown as {
  getReactNativePersistence: (storage: unknown) => Persistence;
}).getReactNativePersistence;

let auth: Auth | null = null;

if (firebaseEnabled) {
  const app = getApps().length ? getApps()[0] : initializeApp(config);
  auth = initializeAuth(app, {
    persistence: getReactNativePersistence(AsyncStorage),
  });
}

export { auth };
