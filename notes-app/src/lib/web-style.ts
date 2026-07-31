import { Platform, type TextStyle } from 'react-native';

/**
 * Removes the browser's default blue focus ring on web text inputs, for the
 * minimalist editing surfaces. `outlineWidth` is a react-native-web style key
 * (ignored on native), so this is effectively a no-op object off web.
 */
export const noFocusOutline: TextStyle = Platform.OS === 'web' ? { outlineWidth: 0 } : {};

/**
 * Hides a scrollbar on a web surface that scrolls but shouldn't advertise it —
 * an editing field whose chrome would otherwise cut into the glass bars floating
 * over it. `global.css` gives everything else a slim translucent bar on purpose,
 * so this is an opt-out for individual surfaces, not a new default.
 *
 * `scrollbarWidth` is a react-native-web style key: it compiles to both
 * `scrollbar-width: none` and a `::-webkit-scrollbar { display: none }` rule, so
 * one property covers Firefox and the WebKit/Blink browsers. It's the same style
 * RNW's own ScrollView uses for `showsVerticalScrollIndicator={false}`, which is
 * why a ScrollView needs that prop instead of this. Cast because the key is web-
 * only and absent from React Native's style types; ignored off web regardless.
 *
 * Typed `TextStyle` rather than `ViewStyle` for the same reason `noFocusOutline`
 * is: `TextStyle` extends `ViewStyle`, so this one constant goes on a TextInput
 * and on a View, where a `ViewStyle` would be rejected by the former.
 */
export const hideScrollbar: TextStyle =
  Platform.OS === 'web' ? ({ scrollbarWidth: 'none' } as TextStyle) : {};
