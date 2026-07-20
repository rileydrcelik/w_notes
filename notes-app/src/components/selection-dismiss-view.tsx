import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useItemSelection } from '@/store/item-selection-store';

/**
 * Wraps the screen content and, while a selection is active, clears it when the
 * user taps/clicks a spot no card claimed (empty background).
 *
 * How it stays out of the way: cards are `Pressable`s, so they win the responder
 * negotiation on their own touches and toggle themselves — only unclaimed
 * background touches bubble up to this wrapper. And because it only asks for the
 * responder on a *start* touch, a scroll drag hands off to the underlying list
 * (the responder terminates → `onResponderRelease` never fires), so scrolling
 * never deselects. When nothing is selected it declines every touch, staying a
 * transparent pass-through.
 */
export function SelectionDismissView({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { active, clear } = useItemSelection();
  return (
    <View
      style={style}
      onStartShouldSetResponder={() => active}
      onResponderRelease={clear}>
      {children}
    </View>
  );
}
