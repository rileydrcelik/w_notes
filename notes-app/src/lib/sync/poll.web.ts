/**
 * Web: periodically pull remote changes while the tab is visible.
 *
 * Mirrors the native poll (poll.ts): a client with no local activity otherwise
 * never sees changes made on another device until the next manual sync trigger.
 * Pause while the tab is hidden to avoid pointless background fetches; the stores
 * refresh the UI off the engine's "applied remote changes" event.
 *
 * The interval adapts, for the reasons spelled out in poll.ts and the schedule
 * itself in poll-schedule.ts. Becoming visible also runs a pass immediately —
 * switching to this tab usually means you just changed something on the other
 * device and expect to see it here, not up to an interval later.
 */
import { nextPollDelay } from './poll-schedule';
import { msSinceSyncActivity, syncNow } from './sync-engine';

export function installSyncPoll(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const schedule = () => {
    if (!running || timer) return;
    timer = setTimeout(async () => {
      timer = null;
      // Chained rather than setInterval: the next tick is measured from the end
      // of the pass, so a slow round trip can't queue passes back to back.
      await syncNow().catch(() => {});
      schedule();
    }, nextPollDelay(msSinceSyncActivity()));
  };

  const start = () => {
    if (running) return;
    running = true;
    // Don't make a just-revealed tab wait a tick to catch up.
    void syncNow().catch(() => {});
    schedule();
  };

  const stop = () => {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') start();
    else stop();
  };

  if (document.visibilityState === 'visible') start();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
