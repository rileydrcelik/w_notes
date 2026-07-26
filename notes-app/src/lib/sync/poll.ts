/**
 * Native: periodically pull remote changes while the app is in the foreground.
 *
 * The write path only syncs on local edits, on mount, and on app foreground, so
 * a client sitting open with no local activity never learns about changes made
 * on another device (e.g. the web client). This installs a lightweight poll that
 * runs a sync pass on an interval while active and pauses when backgrounded; the
 * stores already refresh the UI off the engine's "applied remote changes" event.
 *
 * The interval adapts (see poll-schedule.ts). The flat 15s it replaced put an
 * edit made on another device up to ~16s away once the far side's write debounce
 * is counted — slow enough that watching an edit cross devices read as broken.
 * Coming back to the foreground now syncs immediately rather than waiting out a
 * tick, which is the case that read worst: you switch devices *because* you just
 * changed something on the other one.
 */
import { AppState, type AppStateStatus } from 'react-native';

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
    // Don't make a just-foregrounded app wait a tick to catch up.
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
