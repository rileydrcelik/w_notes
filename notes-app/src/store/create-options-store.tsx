import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { subscribeAuthUser } from '@/lib/auth/token';
import {
  deleteCredential,
  emptyCredentialStatus,
  fetchCredentials,
  saveCredential,
  type CredentialProvider,
  type CredentialStatus,
} from '@/lib/credentials';
import { db } from '@/lib/db';
import { subscribeSynced } from '@/lib/sync/sync-engine';

/**
 * Which plugin options appear in the navbar's create menu, plus (for now inert)
 * credential fields. Mirrors the editor-prefs store: each value is persisted
 * under its own key in the SQLite `settings` table, hydrated on mount and written
 * back on change. The toggles default **off**: plugins are opt-in, so a fresh
 * install offers only notes and folders and the create menu stays short until you
 * turn something on in Settings. Once you do, the choice is remembered.
 *
 * An unset key means "never chosen" rather than "off by request", and the two
 * are not always the same answer: a device that was already using a plugin when
 * this default changed gets it seeded on, once, from its own data — see
 * `TOGGLE_PLUGIN` and the hydrate below.
 *
 * **Provider tokens are not here.** They live server-side, encrypted, one per
 * account (`lib/credentials.ts`), and this store holds only their *status* —
 * saved or not, plus the last four characters. Keeping the token itself in the
 * SQLite `settings` table would put a plaintext secret on every device, which
 * is the thing storing it server-side exists to avoid. `githubRepo` is not a
 * secret and stays local, as a per-device default.
 */
const KEYS = {
  sentryEnabled: 'createOptions.sentryEnabled',
  githubEnabled: 'createOptions.githubEnabled',
  taskManagerEnabled: 'createOptions.taskManagerEnabled',
  financeEnabled: 'createOptions.financeEnabled',
  resumeEnabled: 'createOptions.resumeEnabled',
  githubRepo: 'createOptions.githubRepo',
} as const;

/**
 * Keys the inert credential UI used to write a token into, before tokens moved
 * server-side. Cleared once on hydrate: they were never read by anything, but a
 * device that stored one is holding a plaintext PAT for no reason.
 */
const LEGACY_TOKEN_KEYS = ['createOptions.sentryToken', 'createOptions.githubToken'];

/**
 * Keys of the on/off plugin toggles.
 *
 * The `createOptions.*` strings above are the persisted SQLite keys and must not
 * be renamed alongside UI copy — changing one silently resets that toggle to its
 * default for every existing user.
 */
export type CreateToggleKey =
  | 'sentryEnabled'
  | 'githubEnabled'
  | 'taskManagerEnabled'
  | 'financeEnabled'
  | 'resumeEnabled';
/** Keys of the locally stored (non-secret) create-option strings. */
export type CreateCredentialKey = 'githubRepo';

type CreateOptionsState = {
  sentryEnabled: boolean;
  githubEnabled: boolean;
  taskManagerEnabled: boolean;
  financeEnabled: boolean;
  resumeEnabled: boolean;
  githubRepo: string;
};

export type CreateOptions = CreateOptionsState & {
  setEnabled: (key: CreateToggleKey, value: boolean) => void;
  setCredential: (key: CreateCredentialKey, value: string) => void;
  /** Server-held token status per provider. Never contains a token. */
  credentials: Record<CredentialProvider, CredentialStatus>;
  /** True until the first status fetch settles, so the UI can avoid claiming
   *  "not saved" about a token it simply hasn't looked up yet. */
  credentialsLoading: boolean;
  /** Store a token for one provider. Rejects on failure so the field can report it. */
  setToken: (provider: CredentialProvider, token: string) => Promise<void>;
  /** Forget this account's token for one provider. */
  clearToken: (provider: CredentialProvider) => Promise<void>;
};

const DEFAULTS: CreateOptionsState = {
  sentryEnabled: false,
  githubEnabled: false,
  taskManagerEnabled: false,
  financeEnabled: false,
  resumeEnabled: false,
  githubRepo: '',
};

const TOGGLE_KEYS: CreateToggleKey[] = [
  'sentryEnabled',
  'githubEnabled',
  'taskManagerEnabled',
  'financeEnabled',
  'resumeEnabled',
];

/**
 * The plugin each toggle governs, named as the data names it: a note's
 * `pluginType`, or `'project'` for a task-manager folder.
 *
 * Used to grandfather devices that were already using a plugin before the
 * default became off. Without this, shipping the new default would take the
 * "New sheet" option away from someone with sheets open — they never set the
 * preference, because they never had to.
 */
const TOGGLE_PLUGIN: Record<CreateToggleKey, string> = {
  sentryEnabled: 'sentry',
  githubEnabled: 'github',
  taskManagerEnabled: 'project',
  financeEnabled: 'finance',
  resumeEnabled: 'resume',
};
const isToggle = (k: keyof CreateOptionsState): k is CreateToggleKey =>
  (TOGGLE_KEYS as string[]).includes(k);

const CreateOptionsContext = createContext<CreateOptions | null>(null);

export function CreateOptionsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CreateOptionsState>(DEFAULTS);
  const [credentials, setCredentials] = useState(emptyCredentialStatus);
  const [credentialsLoading, setCredentialsLoading] = useState(true);

  // Token status comes from the server, not from SQLite — there is no local
  // copy to hydrate. A failure here is left as "nothing saved" rather than
  // surfaced: Settings should still open when the backend is unreachable, and
  // the fields themselves report a real error when you try to save one.
  //
  // The exception is `AuthUnavailableError`, which is not a failure at all.
  // On a cold web load this effect runs before Firebase has restored its
  // session, so `getAuthToken` refuses to send the device key in a signed-in
  // account's place and throws. Treating that as "nothing saved" is what made a
  // saved token show an empty field after every reload — the status was never
  // fetched, and with no dependencies this effect never asked again. So we hold
  // `credentialsLoading` and re-run when the identity resolves. It can only
  // resolve: the throw happens exactly when an account is expected.
  //
  // Written with `.then` rather than an awaited helper to match the hydrate
  // below — an async function called from an effect sets state on a path the
  // lint rule can't see past, and flags it as a cascading render.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchCredentials()
        .then((c) => {
          if (cancelled) return;
          setCredentials(c);
          setCredentialsLoading(false);
        })
        .catch((e) => {
          // Duck-typed rather than an `instanceof`: this module reaches the
          // error through several layers, and a name check can't be defeated by
          // two copies of the class.
          if ((e as { name?: string })?.name === 'AuthUnavailableError') return;
          console.warn('[create-options] failed to load credential status:', e);
          if (!cancelled) setCredentialsLoading(false);
        });
    };
    load();
    const unsubscribe = subscribeAuthUser(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // One-time cleanup of the plaintext tokens the old inert UI wrote. Nothing
  // ever read them, so there is nothing to migrate — but leaving a PAT sitting
  // in local SQLite would undo the point of moving tokens server-side.
  useEffect(() => {
    for (const key of LEGACY_TOKEN_KEYS) {
      db.getSetting(key)
        .then((v) => (v ? db.setSetting(key, '') : undefined))
        .catch(() => {});
    }
  }, []);

  // Hydrate every saved value from SQLite; unset keys keep their default. Runs
  // on mount and on every data refresh, so a web tab that just took the DB over
  // from another tab (see reopenDbAndRefresh) picks up settings it couldn't read
  // while it was a follower.
  useEffect(() => {
    let cancelled = false;
    const keys = Object.keys(KEYS) as (keyof CreateOptionsState)[];
    const hydrate = () => {
      Promise.all([
        Promise.all(keys.map((k) => db.getSetting(KEYS[k]).then((v) => [k, v] as const))),
        db.pluginTypesInUse().catch(() => [] as string[]),
      ])
        .then(([entries, inUse]) => {
          if (cancelled) return;
          const using = new Set(inUse);
          setState((prev) => {
            const next = { ...prev };
            for (const [k, saved] of entries) {
              if (saved == null) {
                // Never chosen. Off is the default, but not for a plugin this
                // device is already using — that isn't a preference, it's a
                // question nobody was asked, and answering it "off" would
                // silently retire a plugin mid-use. Write the answer through so
                // this only has to be worked out once.
                if (isToggle(k) && using.has(TOGGLE_PLUGIN[k])) {
                  next[k] = true;
                  db
                    .setSetting(KEYS[k], 'true')
                    .catch((e) => console.warn(`[create-options] failed to seed ${k}:`, e));
                }
                continue;
              }
              if (isToggle(k)) next[k] = saved === 'true';
              else next[k] = saved;
            }
            return next;
          });
        })
        .catch((e) => console.warn('[create-options] failed to load:', e));
    };
    hydrate();
    const unsub = subscribeSynced(hydrate);
    return () => {
      cancelled = true;
      unsub();
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

  const setToken = useCallback(
    async (provider: CredentialProvider, token: string) => {
      const status = await saveCredential(provider, token);
      setCredentials((prev) => ({ ...prev, [provider]: status }));
    },
    [],
  );

  const clearToken = useCallback(async (provider: CredentialProvider) => {
    await deleteCredential(provider);
    setCredentials((prev) => ({
      ...prev,
      [provider]: { provider, saved: false, hint: '', updated_at: null },
    }));
  }, []);

  const value = useMemo<CreateOptions>(
    () => ({
      ...state,
      setEnabled,
      setCredential,
      credentials,
      credentialsLoading,
      setToken,
      clearToken,
    }),
    [state, setEnabled, setCredential, credentials, credentialsLoading, setToken, clearToken],
  );

  return <CreateOptionsContext.Provider value={value}>{children}</CreateOptionsContext.Provider>;
}

export function useCreateOptions(): CreateOptions {
  const ctx = useContext(CreateOptionsContext);
  if (!ctx) throw new Error('useCreateOptions must be used within a CreateOptionsProvider');
  return ctx;
}
