/**
 * Native: no-op. Foreground/background sync is already handled via React
 * Native's AppState in the stores, so there's nothing to install here. The web
 * build resolves `flush-on-hide.web.ts` instead.
 */
export function installSyncFlush(): () => void {
  return () => {};
}
