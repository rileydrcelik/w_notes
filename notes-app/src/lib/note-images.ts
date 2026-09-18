/**
 * The canonical form of an image inside a note body, and the string surgery
 * that moves one between the stored body and an editor.
 *
 * A stored body never carries bytes and never carries a device path. It carries
 * a reference:
 *
 *     <img src="wn-img:8f3c…d1" width="1170" height="640">
 *
 * The bytes live on disk and in S3 under that same id (see `note-image-files`),
 * which is what lets the body be identical on every device. A `file://` or
 * `blob:` path in a synced body would be a dead pointer everywhere but the
 * device that wrote it.
 *
 * `src` is the *only* channel available. The native editor's HTML normalizer
 * keeps exactly `src`, `alt`, `width` and `height` on an `<img>` and drops
 * everything else, so an id smuggled in a `data-*` attribute would not survive
 * a round trip through a phone.
 *
 * String-only on purpose, like `note-html-export.ts`: the same code runs on
 * native, on web and under vitest, and none of those three agree on having a
 * DOM to parse with.
 */

/** Scheme marking an `<img>` whose bytes this app owns. */
export const NOTE_IMAGE_SCHEME = 'wn-img:';

/** The `src` a stored body carries for the image with this id. */
export function noteImageRef(id: string): string {
  return `${NOTE_IMAGE_SCHEME}${id}`;
}

/** The id behind a stored `src`, or null if it isn't one of ours. */
export function parseNoteImageRef(src: string): string | null {
  if (!src.startsWith(NOTE_IMAGE_SCHEME)) return null;
  const id = src.slice(NOTE_IMAGE_SCHEME.length).trim();
  return id ? id : null;
}

type Attrs = { name: string; value: string | null }[];

const IMG_TAG = /<img\b([^>]*?)\/?>/gi;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(raw: string): Attrs {
  const out: Attrs = [];
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(raw); m; m = ATTR.exec(raw)) {
    const value = m[2] ?? m[3] ?? m[4] ?? null;
    out.push({ name: m[1], value });
  }
  return out;
}

/** Quote a value for re-emission. Values parsed out of HTML keep their existing
 *  entities, so only the quote character itself has to be dealt with; a value we
 *  inject ourselves (a path, an id) gets `&` escaped too. */
function quote(value: string): string {
  return value.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;').replace(/"/g, '&quot;');
}

function serializeAttrs(attrs: Attrs): string {
  return attrs
    .map((a) => (a.value === null ? ` ${a.name}` : ` ${a.name}="${quote(a.value)}"`))
    .join('');
}

function get(attrs: Attrs, name: string): string | null {
  return attrs.find((a) => a.name.toLowerCase() === name)?.value ?? null;
}

function set(attrs: Attrs, name: string, value: string): void {
  const found = attrs.find((a) => a.name.toLowerCase() === name);
  if (found) found.value = value;
  else attrs.push({ name, value });
}

/**
 * Rewrite every `<img>` in `html` through `fn`. The tag's attributes are handed
 * over in source order and re-serialized in that same order, so anything the
 * callback doesn't touch survives untouched.
 */
function rewriteImages(html: string, fn: (attrs: Attrs) => void): string {
  if (!html || !html.includes('<img')) return html;
  return html.replace(IMG_TAG, (_whole, raw: string) => {
    const attrs = parseAttrs(raw);
    fn(attrs);
    return `<img${serializeAttrs(attrs)}>`;
  });
}

/** Every note-image id referenced by a body, in document order, without repeats. */
export function collectNoteImageIds(html: string): string[] {
  const ids: string[] = [];
  rewriteImages(html, (attrs) => {
    const src = get(attrs, 'src');
    const id = src ? parseNoteImageRef(src) : null;
    if (id && !ids.includes(id)) ids.push(id);
  });
  return ids;
}

/** A whole number, or null if the value isn't a usable dimension. */
function toPixels(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/**
 * Force every `<img>`'s width/height to whole numbers.
 *
 * iOS serializes them as floats (`width="300.000000"`); Android's parser runs
 * them through `Integer.parseInt`, which throws on a float and drops that whole
 * body onto the degraded path where markup renders as literal text. So an
 * iPhone-authored note could break on an Android phone. Bodies are canonicalized
 * on the way out of an editor, which is the one place both platforms pass
 * through.
 */
export function canonicalizeNoteImages(html: string): string {
  return rewriteImages(html, (attrs) => {
    for (const name of ['width', 'height'] as const) {
      const px = toPixels(get(attrs, name));
      if (px !== null) set(attrs, name, String(px));
    }
  });
}

/** What a device knows about one image: where its bytes are (null until they
 *  arrive) and how big they are. */
export type NoteImageInfo = { uri: string | null; width: number; height: number };
export type NoteImageIndex = Map<string, NoteImageInfo>;

/** Placeholder src for an image whose row this device has never seen. Renders as
 *  the platform's own broken-image glyph — the point is that the tag stays in
 *  the document rather than being dropped. */
const UNRESOLVED = 'wn-img-missing:';

/**
 * Stored body → the HTML an editor should be seeded with: every reference
 * becomes this device's own path to the bytes, scaled to fit `maxWidth`.
 *
 * Every reference resolves, including one whose bytes haven't downloaded yet and
 * one with no row at all. That is the whole point: an editor is uncontrolled and
 * serializes back whatever it was seeded with, so an `<img>` dropped at seed
 * time is an image deleted from the note on every device at the next keystroke.
 * A broken picture the user can see beats a silent deletion they can't.
 */
export function resolveNoteImages(
  html: string,
  index: NoteImageIndex,
  maxWidth: number,
): string {
  return rewriteImages(html, (attrs) => {
    const src = get(attrs, 'src');
    const id = src ? parseNoteImageRef(src) : null;
    if (!id) return;
    const info = index.get(id);
    set(attrs, 'src', info?.uri ?? `${UNRESOLVED}${id}`);

    // Only an image whose row we hold gets resized. The display size is derived,
    // and `unresolveNoteImages` restores the intrinsic one from that same row on
    // the way out — with no row there is nothing to restore from, so scaling here
    // would bake one device's editor width into the body that syncs everywhere.
    if (!info) return;
    const { width, height } = info;
    if (!width || !height) return;
    const scale = width > maxWidth ? maxWidth / width : 1;
    set(attrs, 'width', String(Math.round(width * scale)));
    set(attrs, 'height', String(Math.round(height * scale)));
  });
}

/**
 * Editor HTML → the stored body: this device's paths become references again,
 * and the display size the editor was seeded with is restored to the image's
 * intrinsic size.
 *
 * `idForSrc` maps a path back to an id. Native can do that from the path itself
 * (the file is named after the id); web keeps a map, because an object URL says
 * nothing about what it points at.
 */
export function unresolveNoteImages(
  html: string,
  idForSrc: (src: string) => string | null,
  index: NoteImageIndex,
): string {
  return rewriteImages(html, (attrs) => {
    const src = get(attrs, 'src');
    if (!src) return;
    const id = src.startsWith(UNRESOLVED) ? src.slice(UNRESOLVED.length) : idForSrc(src);
    if (!id) return;
    set(attrs, 'src', noteImageRef(id));

    const info = index.get(id);
    if (info) {
      set(attrs, 'width', String(Math.round(info.width)));
      set(attrs, 'height', String(Math.round(info.height)));
    } else {
      for (const name of ['width', 'height'] as const) {
        const px = toPixels(get(attrs, name));
        if (px !== null) set(attrs, name, String(px));
      }
    }
  });
}
