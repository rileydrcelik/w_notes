/**
 * The device key is this install's anonymous identity for sync. It's a UUID
 * generated once and persisted in the local SQLite settings table, then sent as
 * a bearer token so the server can get-or-create the matching user row.
 *
 * When real auth lands, this key becomes just one credential attached to the
 * server-side user — so the same device keeps its data after signing in.
 */
import { db } from '@/lib/db';
import { runInDbOwner } from '@/lib/db-tabs';

const DEVICE_KEY_SETTING = 'device_key';

/** RFC-4122 v4 UUID. Math.random is fine here — this is an opaque identifier,
 *  not a security token. */
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

let cached: string | null = null;

/** Reads the key, minting and storing one on first call. */
async function readOrCreateDeviceKey(): Promise<string> {
  if (cached) return cached;
  const existing = await db.getSetting(DEVICE_KEY_SETTING);
  if (existing) {
    cached = existing;
    return existing;
  }
  const fresh = uuidv4();
  await db.setSetting(DEVICE_KEY_SETTING, fresh);
  cached = fresh;
  return fresh;
}

/** Mints a fresh key and stores it, discarding whatever was cached. */
async function replaceDeviceKey(): Promise<string> {
  const fresh = uuidv4();
  await db.setSetting(DEVICE_KEY_SETTING, fresh);
  cached = fresh;
  return fresh;
}

/**
 * Both halves run in the tab that owns the database, because `cached` is per
 * browser tab while the key it caches is one per profile — and this key is an
 * identity, so a tab holding a stale one authenticates as somebody else.
 *
 * Two ways that bit, both real:
 *
 *  - **Minting.** On a fresh profile the read-and-create is a read-modify-write.
 *    Two tabs racing it each store a key, and the loser keeps using one the
 *    database no longer holds — the anonymous-identity fork this app has had
 *    once already.
 *  - **Rotating.** Sign-out replaces the key so the next anonymous session is a
 *    separate identity. Done per tab, only the tab that signed out learns; the
 *    others keep presenting the key whose data was just claimed into the
 *    account, and go on syncing as the account the user signed out of.
 */
export const getDeviceKey = runInDbOwner('deviceKey:get', readOrCreateDeviceKey);
export const rotateDeviceKey = runInDbOwner('deviceKey:rotate', replaceDeviceKey);
