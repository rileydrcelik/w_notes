import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode, RefObject } from 'react';
import { Platform, StyleSheet, useColorScheme, View, type StyleProp, type ViewStyle } from 'react-native';

// Real blur is available with iOS Liquid Glass; elsewhere GlassView renders a
// plain view, so BlurView supplies the frosted fallback.
export const LIQUID_GLASS = isLiquidGlassAvailable();

type GlassSurfaceProps = {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  /** Blur strength for the BlurView fallback (ignored by Liquid Glass). */
  intensity?: number;
  /** Tint alpha for the Liquid Glass path; higher is more opaque/less see-through. */
  tintOpacity?: number;
  /**
   * Android-only: a ref to the root BlurTargetView whose content this surface
   * should blur. Must point at a view that does NOT contain this surface, or the
   * renderer recurses and crashes. iOS blurs natively and ignores this.
   */
  blurTarget?: RefObject<View | null> | null;
};

/**
 * Frosted-glass surface shared by the floating tab bar and the side menu:
 * native Liquid Glass where available (iOS 26+), otherwise a translucent
 * BlurView (incl. real blur on Android when given a `blurTarget`).
 */
export function GlassSurface({
  style,
  children,
  intensity = 50,
  tintOpacity = 0.2,
  blurTarget,
}: GlassSurfaceProps) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';

  const tint = scheme === 'dark' ? `rgba(33,34,37,${tintOpacity})` : `rgba(240,240,243,${tintOpacity})`;

  if (LIQUID_GLASS) {
    return (
      <GlassView glassEffectStyle="clear" tintColor={tint} style={style}>
        {children}
      </GlassView>
    );
  }

  // On Android, real backdrop blur needs `dimezisBlurView` plus a `blurTarget`
  // ref to a BlurTargetView wrapping the screen content; iOS blurs natively and
  // ignores both. Without a target, BlurView just renders a tinted overlay.
  const androidBlur =
    Platform.OS === 'android' && blurTarget
      ? { blurMethod: 'dimezisBlurViewSdk31Plus' as const, blurTarget }
      : null;

  return (
    <BlurView intensity={intensity} tint={scheme} {...androidBlur} style={[style, styles.blurClip]}>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
      {children}
    </BlurView>
  );
}

const styles = StyleSheet.create({
  // Clip the blur to rounded corners (Android needs this).
  blurClip: { overflow: 'hidden' },
});
