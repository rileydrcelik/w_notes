/**
 * Web: periodically pull remote changes while the tab is visible.
 *
 * Mirrors the native poll (poll.ts): a client with no local activity otherwise
 * never sees changes made on another device until the next manual sync trigger.
 * Pause while the tab is hidden to avoid pointless background fetches; the stores
 * refresh the UI off the engine's "applied remote changes" event.
 */
import { syncNow } from './sync-engine';

const POLL_MS = 15_000;

export function installSyncPoll(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;

  const start = () => {
    if (timer) return;
    timer = setInterval(() => void syncNow().catch(() => {}), POLL_MS);
  };
  const stop = () => {
    if (timer) {
      clearInterval(timer);
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
