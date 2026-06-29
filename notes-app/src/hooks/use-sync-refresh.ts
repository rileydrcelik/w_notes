import { useCallback, useState } from 'react';

import { syncNow } from '@/lib/sync/sync-engine';

/**
 * Backs a pull-to-refresh control: runs one sync pass (push local changes, pull
 * remote ones) and tracks the spinner state. The stores refresh themselves off
 * the sync engine's "applied remote changes" event, so this just drives the
 * round trip and the `refreshing` flag.
 *
 * Errors are swallowed (already reported to Sentry inside the pass) — a failed
 * refresh just stops the spinner rather than surfacing a scary modal.
 */
export function useSyncRefresh(): { refreshing: boolean; onRefresh: () => void } {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void syncNow()
      .catch(() => {})
      .finally(() => setRefreshing(false));
  }, []);
  return { refreshing, onRefresh };
}
