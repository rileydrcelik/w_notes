/**
 * Reading a scroll position off an event.
 *
 * One hook drives two very different containers, and they do not agree on what
 * a scroll event looks like. A `ScrollView` gives a React Native synthetic
 * event on every platform; a multiline `TextInput` on web gives a **DOM** event,
 * because react-native-web forwards `onScroll` straight to the `<textarea>`
 * rather than normalising it.
 *
 * Reading `nativeEvent.contentOffset.y` unconditionally is therefore a crash —
 * "can't access property y, contentOffset is undefined" — that only appears on
 * web, only in the editor, and only once someone scrolls. Types didn't catch it
 * (the DOM event satisfied the declared shape at the call site); these do.
 */
import { describe, expect, it } from 'vitest';

import { scrollOffsetY } from '@/hooks/use-scrolled';

describe('scrollOffsetY', () => {
  it('reads a React Native scroll event', () => {
    expect(scrollOffsetY({ nativeEvent: { contentOffset: { y: 42 } } })).toBe(42);
  });

  // The regression. A textarea's scroll event carries the position on the
  // element, and `nativeEvent` is the raw DOM event with no contentOffset.
  it('reads a DOM scroll event from a textarea', () => {
    const domEvent = { currentTarget: { scrollTop: 87 }, target: { scrollTop: 87 }, nativeEvent: {} };
    expect(scrollOffsetY(domEvent)).toBe(87);
  });

  it('prefers currentTarget, which is the element the listener is on', () => {
    // A scroll inside a child would otherwise report the wrong element.
    expect(scrollOffsetY({ currentTarget: { scrollTop: 10 }, target: { scrollTop: 999 } })).toBe(10);
  });

  it('treats the top as the top in both shapes', () => {
    expect(scrollOffsetY({ nativeEvent: { contentOffset: { y: 0 } } })).toBe(0);
    expect(scrollOffsetY({ currentTarget: { scrollTop: 0 } })).toBe(0);
  });

  // This runs on every scroll frame; throwing here takes the screen down.
  it.each([undefined, null, {}, { nativeEvent: {} }, { nativeEvent: { contentOffset: {} } }])(
    'returns 0 rather than throwing on %o',
    (event) => {
      expect(scrollOffsetY(event)).toBe(0);
    },
  );
});
