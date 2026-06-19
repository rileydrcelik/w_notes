import { Platform, type TextStyle } from 'react-native';

/**
 * Removes the browser's default blue focus ring on web text inputs, for the
 * minimalist editing surfaces. `outlineWidth` is a react-native-web style key
 * (ignored on native), so this is effectively a no-op object off web.
 */
export const noFocusOutline: TextStyle = Platform.OS === 'web' ? { outlineWidth: 0 } : {};
