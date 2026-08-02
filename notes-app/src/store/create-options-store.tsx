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
 * `TOGGLE_PLUGIN` and the hydrate below. The credential strings are stored but
 * not yet wired to auth (the server holds the real tokens).
 */
const KEYS = {
  sentryEnabled: 'createOptions.sentryEnabled',
  githubEnabled: 'createOptions.githubEnabled',
  taskManagerEnabled: 'createOptions.taskManagerEnabled',
  financeEnabled: 'createOptions.financeEnabled',
  resumeEnabled: 'createOptions.resumeEnabled',
  sentryToken: 'createOptions.sentryToken',
  githubToken: 'createOptions.githubToken',
  githubRepo: 'createOptions.githubRepo',
} as const;

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
/** Keys of the (inert) stored credential strings. */
export type CreateCredentialKey = 'sentryToken' | 'githubToken' | 'githubRepo';

type CreateOptionsState = {
  sentryEnabled: boolean;
  githubEnabled: boolean;
  taskManagerEnabled: boolean;
  financeEnabled: boolean;
  resumeEnabled: boolean;
  sentryToken: string;
  githubToken: string;
  githubRepo: string;
};

export type CreateOptions = CreateOptionsState & {
  setEnabled: (key: CreateToggleKey, value: boolean) => void;
  setCredential: (key: CreateCredentialKey, value: string) => void;
};

const DEFAULTS: CreateOptionsState = {
  sentryEnabled: false,
  githubEnabled: false,
  taskManagerEnabled: false,
  financeEnabled: false,
  resumeEnabled: false,
  sentryToken: '',
  githubToken: '',
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
