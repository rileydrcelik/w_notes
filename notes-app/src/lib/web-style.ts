import { Platform, type TextStyle } from 'react-native';

/**
 * Removes the browser's default blue focus ring on web text inputs, for the
 * minimalist editing surfaces. `outlineWidth` is a react-native-web style key
 * (ignored on native), so this is effectively a no-op object off web.
 */
export const noFocusOutline: TextStyle = Platform.OS === 'web' ? { outlineWidth: 0 } : {};

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
 * style types and ignored off web — hence the cast, exactly as `noFocusOutline`
 * takes its own web-only key. RNW has no special handling for either, so they
 * fall through its style compiler's default branch and come out as plain CSS
 * declarations; `overflowX` passes validation where a bare `overflow` would not,
 * that one being on RNW's list of rejected shorthands.
 *
 * The scroll this enables is silent: `global.css` hides scrollbars app-wide, so
 * no bar appears along the bottom edge to sit under the floating toolbar.
 * Shift+wheel and dragging the caret past the edge both still scroll.
 */
export const noWrap: TextStyle =
  Platform.OS === 'web' ? ({ whiteSpace: 'pre', overflowX: 'auto' } as TextStyle) : {};
