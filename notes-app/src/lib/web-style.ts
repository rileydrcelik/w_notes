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

/**
 * Stops a multiline field soft-wrapping, so it scrolls sideways instead.
 *
 * For source, where a wrapped line is a lie: one logical line becomes two rows
 * on screen, and anything counting rows — a line-number gutter above all — goes
 * out of step with the document from the first long `\resumeSubheading`. Turning
 * wrapping off makes one line one row, which is what lets a gutter be a list of
 * numbers rather than a layout measurement problem.
 *
 * `whiteSpace: 'pre'` is the react-native-web style key that reaches the
 * textarea; `overflowX: 'auto'` gives back the horizontal scroll that wrapping
 * used to make unnecessary. Both are web-only keys, absent from React Native's
 * style types and ignored off web — hence the cast, exactly as `hideScrollbar`
 * does it. RNW has no special handling for either, so they fall through its
 * style compiler's default branch and come out as plain CSS declarations;
 * `overflowX` passes validation where a bare `overflow` would not, that one
 * being on RNW's list of rejected shorthands.
 *
 * Pairs with `hideScrollbar` on the source editor, which means the horizontal
 * scrollbar this enables is then hidden — deliberately, since a bar along the
 * bottom edge would sit under the floating toolbar. Shift+wheel and dragging the
 * caret past the edge both still scroll.
 */
export const noWrap: TextStyle =
  Platform.OS === 'web' ? ({ whiteSpace: 'pre', overflowX: 'auto' } as TextStyle) : {};
