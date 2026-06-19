/**
 * Auth context: exposes the current Firebase user and sign-in/out actions to the
 * UI, and drives the account merge/swap in the sync layer.
 *
 * The `onAuthStateChanged` listener is the single source of truth — sign-in
 * actions just kick off the native flow, and the listener reacts when Firebase's
 * session actually changes (including a session restored on app launch). When
 * Firebase isn't configured, the context reports `enabled: false` and the app
 * stays anonymous.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';

import { Sentry } from '@/lib/sentry';
import { onSignIn, onSignOut } from '@/lib/sync/sync-engine';
import { auth, firebaseEnabled } from './firebase';
import {
  SignInCancelled,
  completeRedirectSignIn,
  isAppleAuthAvailable,
  signInWithApple as appleSignIn,
  signInWithGoogle as googleSignIn,
  signOutProviders,
} from './providers';
import { setAuthUser } from './token';

type AuthContextValue = {
  user: FirebaseUser | null;
  /** Whether Firebase is configured at all. */
  enabled: boolean;
  /** True until the persisted session (if any) has been restored. */
  initializing: boolean;
  /** Whether to offer Apple sign-in (iOS only). */
  appleAvailable: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [initializing, setInitializing] = useState(firebaseEnabled);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    isAppleAuthAvailable()
      .then(setAppleAvailable)
      .catch(() => {});
  }, []);

  // Resolve a pending web redirect sign-in on load (no-op on native). Success is
  // also picked up by onAuthStateChanged below; this surfaces redirect errors.
  useEffect(() => {
    completeRedirectSignIn().catch((e) =>
      Sentry.captureException(e, { tags: { source: 'auth', op: 'redirectResult' } }),
    );
  }, []);

  useEffect(() => {
    // When Firebase is disabled, `initializing` already starts false (it's
    // seeded from firebaseEnabled), so there's nothing to wait for.
    if (!auth) return;
    // Reacts to sign-in, sign-out, and session-restored-on-launch.
    return onAuthStateChanged(auth, (next) => {
      setAuthUser(next);
      setUser(next);
      setInitializing(false);
      if (next) {
        onSignIn(next.uid).catch((e) =>
          Sentry.captureException(e, { tags: { source: 'auth', op: 'signIn' } }),
        );
      }
    });
  }, []);

  const signInWithGoogle = useCallback(async () => {
    try {
      await googleSignIn();
    } catch (e) {
      if (!(e instanceof SignInCancelled)) throw e;
    }
  }, []);

  const signInWithApple = useCallback(async () => {
    try {
      await appleSignIn();
    } catch (e) {
      if (!(e instanceof SignInCancelled)) throw e;
    }
  }, []);

  const signOut = useCallback(async () => {
    // Flush + wipe local data under the account, then end the Firebase session.
    await onSignOut();
    await signOutProviders();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      enabled: firebaseEnabled,
      initializing,
      appleAvailable,
      signInWithGoogle,
      signInWithApple,
      signOut,
    }),
    [user, initializing, appleAvailable, signInWithGoogle, signInWithApple, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
