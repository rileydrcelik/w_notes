import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { db } from '@/lib/db';

/**
 * Which plugin options appear in the navbar's create menu, plus (for now inert)
 * credential fields. Mirrors the editor-prefs store: each value is persisted
 * under its own key in the SQLite `settings` table, hydrated on mount and written
 * back on change. The toggles default **on** so the create menu is unchanged
 * until a user opts something out. The credential strings are stored but not yet
 * wired to auth (the server holds the real tokens).
 */
const KEYS = {
  sentryEnabled: 'createOptions.sentryEnabled',
  githubEnabled: 'createOptions.githubEnabled',
  taskManagerEnabled: 'createOptions.taskManagerEnabled',
  sentryToken: 'createOptions.sentryToken',
  githubToken: 'createOptions.githubToken',
  githubRepo: 'createOptions.githubRepo',
} as const;

/** Keys of the on/off create-menu toggles. */
export type CreateToggleKey = 'sentryEnabled' | 'githubEnabled' | 'taskManagerEnabled';
/** Keys of the (inert) stored credential strings. */
export type CreateCredentialKey = 'sentryToken' | 'githubToken' | 'githubRepo';

type CreateOptionsState = {
  sentryEnabled: boolean;
  githubEnabled: boolean;
  taskManagerEnabled: boolean;
  sentryToken: string;
  githubToken: string;
  githubRepo: string;
};

export type CreateOptions = CreateOptionsState & {
  setEnabled: (key: CreateToggleKey, value: boolean) => void;
  setCredential: (key: CreateCredentialKey, value: string) => void;
};

const DEFAULTS: CreateOptionsState = {
  sentryEnabled: true,
  githubEnabled: true,
  taskManagerEnabled: true,
  sentryToken: '',
  githubToken: '',
  githubRepo: '',
};

const TOGGLE_KEYS: CreateToggleKey[] = ['sentryEnabled', 'githubEnabled', 'taskManagerEnabled'];
const isToggle = (k: keyof CreateOptionsState): k is CreateToggleKey =>
  (TOGGLE_KEYS as string[]).includes(k);

const CreateOptionsContext = createContext<CreateOptions | null>(null);

export function CreateOptionsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CreateOptionsState>(DEFAULTS);

  // Hydrate every saved value once on mount; unset keys keep their default.
  useEffect(() => {
    let cancelled = false;
    const keys = Object.keys(KEYS) as (keyof CreateOptionsState)[];
    Promise.all(keys.map((k) => db.getSetting(KEYS[k]).then((v) => [k, v] as const)))
      .then((entries) => {
        if (cancelled) return;
        setState((prev) => {
          const next = { ...prev };
          for (const [k, saved] of entries) {
            if (saved == null) continue;
            if (isToggle(k)) next[k] = saved === 'true';
            else next[k] = saved;
          }
          return next;
        });
      })
      .catch((e) => console.warn('[create-options] failed to load:', e));
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = useCallback((key: CreateToggleKey, value: boolean) => {
    setState((prev) => ({ ...prev, [key]: value }));
    db
      .setSetting(KEYS[key], value ? 'true' : 'false')
      .catch((e) => console.warn(`[create-options] failed to save ${key}:`, e));
  }, []);

  const setCredential = useCallback((key: CreateCredentialKey, value: string) => {
    setState((prev) => ({ ...prev, [key]: value }));
    db
      .setSetting(KEYS[key], value)
      .catch((e) => console.warn(`[create-options] failed to save ${key}:`, e));
  }, []);

  const value = useMemo<CreateOptions>(
    () => ({ ...state, setEnabled, setCredential }),
    [state, setEnabled, setCredential],
  );

  return <CreateOptionsContext.Provider value={value}>{children}</CreateOptionsContext.Provider>;
}

export function useCreateOptions(): CreateOptions {
  const ctx = useContext(CreateOptionsContext);
  if (!ctx) throw new Error('useCreateOptions must be used within a CreateOptionsProvider');
  return ctx;
}
