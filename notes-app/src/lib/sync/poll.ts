/**
 * Native: periodically pull remote changes while the app is in the foreground.
 *
 * The write path only syncs on local edits, on mount, and on app foreground, so
 * a client sitting open with no local activity never learns about changes made
 * on another device (e.g. the web client). This installs a lightweight poll that
 * runs a sync pass on an interval while active and pauses when backgrounded; the
 * stores already refresh the UI off the engine's "applied remote changes" event.
 */
import { AppState, type AppStateStatus } from 'react-native';

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

  const onChange = (s: AppStateStatus) => {
    if (s === 'active') start();
    else stop();
  };

  if (AppState.currentState === 'active') start();
  const sub = AppState.addEventListener('change', onChange);
  return () => {
    stop();
    sub.remove();
  };
}
