/**
 * Serializing a read-modify-write that more than one browser tab can start.
 *
 * The GitHub outbox and the retitle queue each keep their entries as a single
 * JSON blob in one settings row. Within a tab a promise chain is enough: two
 * enqueues can't both read the old blob and write back a copy missing the
 * other's entry. Across tabs it isn't, and now that every tab can write — a
 * follower's `db.setSetting` is served by the owner like any other call — two
 * tabs racing means one of them silently drops the other's queued work, which
 * is the exact loss these queues exist to prevent.
 *
 * So the chain is paired with a Web Lock, which is held across the whole
 * read-modify-write and is per browser profile rather than per tab. The lock is
 * the same primitive that elects the database owner (`web-db-lock.ts`) and
 * marks a page session live (`page-session.ts`); this is the third thing in
 * this app that is "one per profile", and it borrows the same mechanism.
 *
 * The chain stays underneath it. It is what orders this tab's own operations,
 * it is all there is on native (no `navigator.locks`, one realm, nothing to
 * arbitrate), and it keeps working where a lock request is refused outright —
 * an opaque origin, or a document that is no longer fully active.
 *
 * Nesting deadlocks, exactly as the bare chain always did: an operation passed
 * to one of these must not call another one on the same name.
 */

/** Runs operations one at a time, across every tab of this browser profile. */
export type ProfileSerializer = <T>(op: () => Promise<T>) => Promise<T>;

/**
 * One serializer per named store. `name` becomes the lock's name, so two
 * callers that pass the same name are serialized against each other and against
 * every other tab's callers with that name.
 */
export function serializedPerProfile(name: string): ProfileSerializer {
  const lockName = `wnotes-store-${name}`;
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(op: () => Promise<T>): Promise<T> => {
    const attempt = () => withProfileLock(lockName, op);
    // Chained onto the tail whether or not the previous operation succeeded, so
    // one failure can't wedge the queue behind it.
    const run = tail.then(attempt, attempt);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

async function withProfileLock<T>(lockName: string, op: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return op();

  let running: Promise<T> | undefined;
  try {
    await locks.request(lockName, async () => {
      running = op();
      // Caught here so a rejection releases the lock and is then re-thrown to
      // the caller by the `await running` below, rather than escaping through
      // `request` before the result can be read back.
      await running.catch(() => {});
    });
  } catch {
    // The request itself failed, which is not the same as the work failing:
    // `navigator.locks` exists but refuses on an opaque origin and on a
    // document that isn't fully active. Proceed unlocked rather than drop the
    // operation — the chain above still orders this tab's own calls.
    if (!running) return op();
  }
  return running ?? op();
}
