import { useRouter } from 'expo-router';
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector, type PanGesture } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useScreenFadeStyle } from '@/hooks/use-screen-fade';
import { useSidebar } from '@/store/sidebar-store';

// How far / fast a rightward drag must go before it commits to navigating back.
const COMMIT_DISTANCE = 120;
const COMMIT_VELOCITY = 800;
// How far / fast a leftward drag must go before it opens the drawer. Mirrors the
// home screen's open gesture so every screen reveals the drawer the same way.
const OPEN_DISTANCE = 60;
const OPEN_VELOCITY = 500;

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * Gives a nested stack screen the same two horizontal swipe affordances the home
 * screen has: a leftward drag opens the right-hand drawer, and a rightward drag
 * navigates back.
 *
 * iOS already gets back-navigation from the stack's native full-screen gesture
 * (`fullScreenGestureEnabled`), so there we only drive the open-drawer gesture.
 * Android has no native equivalent, so it additionally animates and drives the
 * back gesture in JS.
 */
export function SwipeBackView({ children, style }: Props) {
  const { openSidebar } = useSidebar();
  // Web has no native stack transition; fade/slide the screen in on focus.
  const fadeStyle = useScreenFadeStyle();

  // Web has no swipe gestures at all: there a "drag" is a mouse drag, which is
  // also how you select text. A live Pan lets gesture-handler track every drag
  // to decide whether it's a swipe, and that tracking intermittently collapses
  // the browser's native text selection (and makes it jump to adjacent lines)
  // in the note editor. Pointer users open the drawer via the menu button /
  // backdrop and go back via the navbar, so the swipes are redundant here.
  if (Platform.OS === 'web') {
    return <Animated.View style={[styles.fill, style, fadeStyle]}>{children}</Animated.View>;
  }

  // Claim only leftward drags so a rightward swipe still reaches the back
  // gesture, and bail on vertical movement so lists keep scrolling.
  const openDrawer = Gesture.Pan()
    .activeOffsetX(-20)
    .failOffsetY([-15, 15])
    .onEnd((event) => {
      if (event.translationX < -OPEN_DISTANCE || event.velocityX < -OPEN_VELOCITY) {
        runOnJS(openSidebar)();
      }
    });

  if (Platform.OS !== 'android') {
    return (
      <GestureDetector gesture={openDrawer}>
        <Animated.View style={[styles.fill, style, fadeStyle]}>{children}</Animated.View>
      </GestureDetector>
    );
  }
  return (
    <AndroidSwipeBack style={style} openDrawer={openDrawer}>
      {children}
    </AndroidSwipeBack>
  );
}

function AndroidSwipeBack({
  children,
  style,
  openDrawer,
}: Props & { openDrawer: PanGesture }) {
  const router = useRouter();
  const translateX = useSharedValue(0);

  const goBack = () => {
    if (router.canGoBack()) router.back();
  };

  const back = Gesture.Pan()
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

  // The two drags are opposite directions, so race them: whichever the user
  // commits to wins.
  return (
    <GestureDetector gesture={Gesture.Race(back, openDrawer)}>
      <Animated.View style={[styles.fill, style, animatedStyle]}>{children}</Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
