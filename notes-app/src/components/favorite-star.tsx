import Feather from '@expo/vector-icons/Feather';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, { ZoomIn, ZoomOut } from 'react-native-reanimated';

const FAVORITE_COLOR = '#f5a623';

/**
 * The gold favorite star, with a little pop when it's toggled on and a shrink
 * when toggled off. Render conditionally (`isFavorite && <FavoriteStar />`) so
 * the enter/exit animations fire as the favorite state flips.
 */
export function FavoriteStar({
  size = 14,
  style,
}: {
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Animated.View
      entering={ZoomIn.springify().damping(11).stiffness(190)}
      exiting={ZoomOut.duration(150)}
      style={style}>
      <Feather name="star" size={size} color={FAVORITE_COLOR} />
    </Animated.View>
  );
}
