import { usePathname } from 'expo-router';
import { useEffect } from 'react';

import { useItemSelection } from '@/store/item-selection-store';

/**
 * Drops the current note/folder selection when the route changes. Selection mode
 * itself is exited by deselecting every card (tapping them off), or by
 * long-pressing / right-clicking the navbar's "⋯" button. Renders nothing — the
 * cards stay fully interactive so more can be tapped into the selection.
 */
export function SelectionBackdrop() {
  const { clear } = useItemSelection();
  const pathname = usePathname();

  // Leaving the current screen drops any selection.
  useEffect(() => {
    clear();
  }, [pathname, clear]);

  return null;
}
