/**
 * The reference format for an image inside a note body, and the resolve /
 * unresolve pair that carries one in and out of an editor.
 *
 * Both editors are uncontrolled: they serialize back whatever they were seeded
 * with. So anything these functions drop on the way in is deleted from the note
 * on every device at the next keystroke, silently. The round-trip cases below
 * are the ones that matter — especially the ones where the bytes are missing.
 */
import { describe, expect, it } from 'vitest';

import {
  canonicalizeNoteImages,
  collectNoteImageIds,
  noteImageRef,
  parseNoteImageRef,
  resolveNoteImages,
  unresolveNoteImages,
  type NoteImageIndex,
} from '@/lib/note-images';

const ID = '8f3cd1';
const index: NoteImageIndex = new Map([
  [ID, { uri: 'file:///docs/note-images/8f3cd1', width: 1170, height: 640 }],
]);
/** Native names the file after the id, so the path is its own lookup table. */
const idFromPath = (src: string) => src.split('/').pop() || null;

describe('noteImageRef / parseNoteImageRef', () => {
  it('round-trips an id', () => {
    expect(parseNoteImageRef(noteImageRef(ID))).toBe(ID);
  });

  it('ignores sources that aren\'t ours', () => {
    expect(parseNoteImageRef('https://example.com/a.png')).toBeNull();
    expect(parseNoteImageRef('data:image/png;base64,AAA')).toBeNull();
    expect(parseNoteImageRef('wn-img:')).toBeNull();
  });
});

describe('collectNoteImageIds', () => {
  it('finds every reference once, in document order', () => {
    const html = `<html><p><img src="wn-img:a" width="10" height="10"></p>`
      + `<p><img src="wn-img:b"><img src="wn-img:a"></p></html>`;
    expect(collectNoteImageIds(html)).toEqual(['a', 'b']);
  });

  it('skips foreign images', () => {
    expect(collectNoteImageIds('<p><img src="https://e.com/a.png"></p>')).toEqual([]);
  });

  it('returns nothing for a body with no images', () => {
    expect(collectNoteImageIds('<html><p>hello</p></html>')).toEqual([]);
  });
});

describe('canonicalizeNoteImages', () => {
  it('rounds the float dimensions iOS writes', () => {
    // Android runs width through Integer.parseInt: a float throws, and the whole
    // body falls back to rendering as literal markup.
    expect(canonicalizeNoteImages('<img src="wn-img:a" width="300.000000" height="200.5">'))
      .toBe('<img src="wn-img:a" width="300" height="201">');
  });

  it('keeps other attributes, and their order', () => {
    expect(canonicalizeNoteImages('<img alt="a shot" src="wn-img:a" width="10.0">'))
      .toBe('<img alt="a shot" src="wn-img:a" width="10">');
  });

  it('leaves a body with no images alone', () => {
    const html = '<html><p>just text</p></html>';
    expect(canonicalizeNoteImages(html)).toBe(html);
  });

  it('drops nothing when a dimension is missing or nonsense', () => {
    expect(canonicalizeNoteImages('<img src="wn-img:a" width="auto">'))
      .toBe('<img src="wn-img:a" width="auto">');
  });
});

describe('resolve → unresolve', () => {
  const stored = `<html><p>before<img src="wn-img:${ID}" width="1170" height="640">after</p></html>`;

  it('resolves a reference to this device\'s path, scaled to fit', () => {
    const out = resolveNoteImages(stored, index, 585);
    expect(out).toContain('src="file:///docs/note-images/8f3cd1"');
    expect(out).toContain('width="585"');
    expect(out).toContain('height="320"');
  });

  it('leaves an image smaller than the editor at its own size', () => {
    const out = resolveNoteImages(stored, index, 4000);
    expect(out).toContain('width="1170"');
    expect(out).toContain('height="640"');
  });

  it('restores the stored body exactly', () => {
    const out = unresolveNoteImages(resolveNoteImages(stored, index, 585), idFromPath, index);
    expect(out).toBe(stored);
  });

  it('keeps the tag when the bytes have not downloaded yet', () => {
    // The row is known, the file isn't here. The image must still occupy the
    // document, or the next keystroke writes a body without it.
    const pending: NoteImageIndex = new Map([[ID, { uri: null, width: 1170, height: 640 }]]);
    const resolved = resolveNoteImages(stored, pending, 585);
    expect(resolved).toContain('<img');
    expect(unresolveNoteImages(resolved, idFromPath, pending)).toBe(stored);
  });

  it('keeps the tag when this device has never seen the row', () => {
    const empty: NoteImageIndex = new Map();
    const resolved = resolveNoteImages(stored, empty, 585);
    expect(resolved).toContain('<img');
    expect(unresolveNoteImages(resolved, idFromPath, empty)).toBe(stored);
  });

  it('leaves a foreign image untouched in both directions', () => {
    const html = '<html><p><img src="https://example.com/a.png" width="10" height="10"></p></html>';
    expect(resolveNoteImages(html, index, 585)).toBe(html);
    expect(unresolveNoteImages(html, () => null, index)).toBe(html);
  });

  it('restores the intrinsic size even after the editor resized the tag', () => {
    const edited = `<p><img src="file:///docs/note-images/${ID}" width="200" height="109"></p>`;
    expect(unresolveNoteImages(edited, idFromPath, index))
      .toBe(`<p><img src="wn-img:${ID}" width="1170" height="640"></p>`);
  });

  it('survives a second pass unchanged', () => {
    const once = resolveNoteImages(stored, index, 585);
    expect(resolveNoteImages(once, index, 585)).toBe(once);
  });
});
