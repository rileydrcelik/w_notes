import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { hexToHsv, hsvToHex, normalizeHex, type Hsv } from '@/lib/folder-color';

const PAD_HEIGHT = 150;
const HUE_HEIGHT = 24;
const KNOB = 20;
const HUE_STOPS = ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'] as const;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * A hand-built colour picker: a saturation/brightness pad, a hue strip, and a
 * hex field, all driving one `#rrggbb` value.
 *
 * HSV is held here rather than re-derived from `value` each render. At zero
 * saturation or brightness a hex has no hue left in it, so dragging the pad into
 * a corner would otherwise snap the hue strip back to red.
 */
export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const theme = useTheme();
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  const [pad, setPad] = useState({ w: 0, h: PAD_HEIGHT });
  const [hueW, setHueW] = useState(0);

  // Adopt a change from outside (a swatch tap). Our own echo matches the HSV we
  // already hold, so it leaves the hue alone; and a hex field mid-edit that
  // already means this colour keeps what the person typed.
  if (value !== seen) {
    setSeen(value);
    if (hsvToHex(hsv) !== value) setHsv(hexToHsv(value));
    if (normalizeHex(text) !== value) setText(value);
  }

  const commit = (next: Hsv) => {
    setHsv(next);
    onChange(hsvToHex(next));
  };

  const padAt = (x: number, y: number) => {
    if (pad.w === 0) return;
    commit({ h: hsv.h, s: clamp01(x / pad.w), v: 1 - clamp01(y / pad.h) });
  };
  const hueAt = (x: number) => {
    if (hueW === 0) return;
    // Stops short of 360, which is red again and would read back as 0.
    commit({ ...hsv, h: clamp01(x / hueW) * 359.9 });
  };

  const padGesture = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin((e) => padAt(e.x, e.y))
    .onUpdate((e) => padAt(e.x, e.y));
  const hueGesture = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin((e) => hueAt(e.x))
    .onUpdate((e) => hueAt(e.x));

  const onText = (next: string) => {
    setText(next);
    const hex = normalizeHex(next);
    if (!hex) return;
    setHsv(hexToHsv(hex));
    onChange(hex);
  };

  const current = hsvToHex(hsv);
  const pureHue = hsvToHex({ h: hsv.h, s: 1, v: 1 });

  return (
    <View style={styles.root}>
      <GestureDetector gesture={padGesture}>
        <View
          style={styles.padWrap}
          onLayout={(e) => setPad({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
          accessibilityLabel="Saturation and brightness">
          <View style={[styles.pad, { backgroundColor: pureHue }]} pointerEvents="none">
            <LinearGradient
              colors={['#ffffff', 'rgba(255,255,255,0)']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
            <LinearGradient
              colors={['rgba(0,0,0,0)', '#000000']}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
          </View>
          <View
            pointerEvents="none"
            style={[
              styles.knob,
              {
                backgroundColor: current,
                left: hsv.s * pad.w - KNOB / 2,
                top: (1 - hsv.v) * pad.h - KNOB / 2,
              },
            ]}
          />
        </View>
      </GestureDetector>

      <GestureDetector gesture={hueGesture}>
        <View
          style={styles.hueWrap}
          onLayout={(e) => setHueW(e.nativeEvent.layout.width)}
          accessibilityLabel="Hue">
          <LinearGradient
            pointerEvents="none"
            colors={HUE_STOPS}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.hue}
          />
          <View
            pointerEvents="none"
            style={[
              styles.knob,
              { backgroundColor: pureHue, left: (hsv.h / 360) * hueW - KNOB / 2, top: (HUE_HEIGHT - KNOB) / 2 },
            ]}
          />
        </View>
      </GestureDetector>

      <View style={styles.hexRow}>
        <View style={[styles.preview, { backgroundColor: current }]} />
        <TextInput
          value={text}
          onChangeText={onText}
          onBlur={() => setText(current)}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={7}
          placeholder="#rrggbb"
          placeholderTextColor={theme.textSecondary}
          accessibilityLabel="Hex colour"
          style={[styles.hexInput, { color: theme.text, backgroundColor: theme.backgroundElement }]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: Spacing.three,
  },
  // The knob sits outside the clipped pad, so it isn't cut in half at an edge.
  padWrap: {
    height: PAD_HEIGHT,
  },
  pad: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: Spacing.three,
    overflow: 'hidden',
  },
  hueWrap: {
    height: HUE_HEIGHT,
  },
  hue: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: Spacing.two,
  },
  knob: {
    position: 'absolute',
    width: KNOB,
    height: KNOB,
    borderRadius: Spacing.two,
    borderWidth: 2,
    borderColor: '#ffffff',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  hexRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  preview: {
    width: 40,
    height: 40,
    borderRadius: Spacing.three,
  },
  hexInput: {
    flex: 1,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    fontSize: 16,
  },
});
