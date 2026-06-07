import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { StyleSheet, useColorScheme, View, type StyleProp, type ViewStyle } from 'react-native';

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
};

/**
 * Frosted-glass surface shared by the floating tab bar and the side menu:
 * native Liquid Glass where available (iOS 26+), otherwise a translucent
 * BlurView (incl. real blur on Android once the dev client includes expo-blur).
 */
export function GlassSurface({
  style,
  children,
  intensity = 50,
  tintOpacity = 0.2,
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

  // iOS blurs the backdrop natively. Android's BlurView only does real backdrop
  // blur via the experimental `dimezisBlurView`, which requires the BlurView to
  // be a *sibling* of its capture target; ours sit inside it, which crashes the
  // renderer with a view-tree cycle. So we skip it and lean on the tint overlay
  // (`tintOpacity`) for the frosted look on Android.
  return (
    <BlurView intensity={intensity} tint={scheme} style={[style, styles.blurClip]}>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
      {children}
    </BlurView>
  );
}

const styles = StyleSheet.create({
  // Clip the blur to rounded corners (Android needs this).
  blurClip: { overflow: 'hidden' },
});
