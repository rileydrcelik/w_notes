/**
 * Web: flush pending local changes to the backend when the tab is hidden or
 * unloaded.
 *
 * The write path only ever schedules a *debounced* sync (`requestSync`, 800ms),
 * so a quick edit followed by navigating away or closing the tab could drop the
 * push until the next sync trigger fires — which is why a copa edit could appear
 * to only reach the server once a later note edit synced everything.
 *
 * `visibilitychange` → hidden fires while the page is still alive (tab switch,
 * minimize, in-app navigation that backgrounds it), so the fetch has time to
 * complete; `pagehide` is a best-effort catch on actual unload.
 */
import { syncNow } from './sync-engine';

export function installSyncFlush(): () => void {
  const flush = () => {
    void syncNow().catch(() => {});
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', flush);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', flush);
  };
}
