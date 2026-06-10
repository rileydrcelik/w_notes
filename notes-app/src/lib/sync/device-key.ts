/**
 * The device key is this install's anonymous identity for sync. It's a UUID
 * generated once and persisted in the local SQLite settings table, then sent as
 * a bearer token so the server can get-or-create the matching user row.
 *
 * When real auth lands, this key becomes just one credential attached to the
 * server-side user — so the same device keeps its data after signing in.
 */
import { db } from '@/lib/db';

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

/** Returns the persisted device key, creating and storing one on first call. */
export async function getDeviceKey(): Promise<string> {
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
