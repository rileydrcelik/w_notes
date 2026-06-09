import { useRouter } from 'expo-router';
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

// How far / fast a rightward drag must go before it commits to navigating back.
const COMMIT_DISTANCE = 120;
const COMMIT_VELOCITY = 800;

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * Lets a rightward swipe anywhere on the screen navigate back.
 *
 * iOS already gets this from the stack's native full-screen gesture
 * (`fullScreenGestureEnabled`), which has no Android equivalent — so on iOS we
 * render the children untouched and only drive a JS gesture on Android.
 */
export function SwipeBackView({ children, style }: Props) {
  if (Platform.OS !== 'android') {
    return <>{children}</>;
  }
  return <AndroidSwipeBack style={style}>{children}</AndroidSwipeBack>;
}

function AndroidSwipeBack({ children, style }: Props) {
  const router = useRouter();
  const translateX = useSharedValue(0);

  const goBack = () => {
    if (router.canGoBack()) router.back();
  };

  const pan = Gesture.Pan()
    // Only claim the gesture once it's clearly a rightward drag; bail if it
    // turns vertical so lists and the note body keep scrolling.
    .activeOffsetX(20)
    .failOffsetY([-12, 12])
    .onUpdate((event) => {
      translateX.value = Math.max(0, event.translationX);
    })
    .onEnd((event) => {
      if (event.translationX > COMMIT_DISTANCE || event.velocityX > COMMIT_VELOCITY) {
        runOnJS(goBack)();
      } else {
        translateX.value = withTiming(0, { duration: 150 });
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.fill, style, animatedStyle]}>{children}</Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
