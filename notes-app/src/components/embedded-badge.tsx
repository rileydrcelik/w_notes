import Feather from '@expo/vector-icons/Feather';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, { ZoomIn, ZoomOut } from 'react-native-reanimated';

/**
 * Blue rather than the star's gold, and a globe rather than a second symbol in
 * the same family, because the two marks answer different questions. A favorite
 * is something you set; this is something that is true — the site has this note
 * on it — and it changes without you touching the note.
 */
const EMBEDDED_COLOR = '#3c87f7';

/**
 * Marks a note the portfolio site has embedded somewhere.
 *
 * Render conditionally (`note.embedded && <EmbeddedBadge />`) so the pop and
 * shrink fire as the state flips — which here happens on its own, when the site
 * picks the note up or drops it, rather than in response to a tap.
 */
export function EmbeddedBadge({
  size = 14,
  style,
}: {
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Animated.View
      accessibilityRole="image"
      accessibilityLabel="Embedded on the website"
      entering={ZoomIn.springify().damping(11).stiffness(190)}
      exiting={ZoomOut.duration(150)}
      style={style}>
      <Feather name="globe" size={size} color={EMBEDDED_COLOR} />
    </Animated.View>
  );
}
