import { useEffect, useRef, useState, type RefObject } from 'react';
import { Editor, Extension, textblockTypeInputRule, wrappingInputRule } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Strike from '@tiptap/extension-strike';
import Underline from '@tiptap/extension-underline';
import Code from '@tiptap/extension-code';
import CodeBlock from '@tiptap/extension-code-block';
import Heading from '@tiptap/extension-heading';
import Blockquote from '@tiptap/extension-blockquote';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { BulletList, OrderedList, ListItem, TaskList, TaskItem } from '@tiptap/extension-list';
import { Placeholder, UndoRedo } from '@tiptap/extensions';
import { Plugin, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { EnrichedTextInputInstance, OnChangeStateEvent } from 'react-native-enriched';

import { Accent, hexToRgba, Spacing, type Palette } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  clearActiveEditorInsertImage,
  setActiveEditorDismiss,
  setActiveEditorInsertImage,
} from '@/lib/active-editor';
import {
  backspaceInCode,
  enterInCode,
  exitOffset,
  typeInCode,
  type CodeEdit,
} from '@/lib/code-typing';
import { db } from '@/lib/db';
import { pickNoteImage } from '@/lib/note-image-files';
import { insertNoteImage } from '@/lib/note-image-insert';
import {
  noteImageIdResolver,
  resolveNoteImages,
  unresolveNoteImages,
  type NoteImageIndex,
} from '@/lib/note-images';
import { storedHtmlToTiptap, tiptapHtmlToStored } from '@/lib/rich-html.web';

const LINK_COLOR = '#3c87f7';

/**
 * Width an image is scaled to fit inside the editor, in CSS pixels.
 *
 * Fixed rather than measured: the display size is written into the tag the
 * editor holds, and a body has to come back out identical whatever size the
 * window is, or two devices would fight over the same note for ever. The
 * stylesheet's `max-width: 100%` is what actually keeps a picture inside a
 * narrow window.
 */
const EDITOR_MAX_WIDTH = 720;

/** How far a checked item fades. The value the task manager already marks a
 *  done issue with (`doneTitle` in `project/[id]/type/[typeId].tsx`), so "done"
 *  reads the same weight wherever it appears. Shared with native too. */
const CheckedOpacity = 0.6;

/** `- ` / `* `, `1. `, `> `, `# ` etc. all ship as default input rules on the
 * respective extensions. Only the task/checkbox list needs one added by hand. */
const CHECKBOX_INPUT_REGEX = /^\s*(\[([ xX])?\])\s$/;

// Native canonicalizes `<strong>`→`<b>` and `<em>`→`<i>` on read, but the note
// card previews render raw HTML — so serialize the native tags directly to stay
// pixel-identical everywhere. Strike (`<s>`) and Underline (`<u>`) already match.
const BoldB = Bold.extend({
  parseHTML: () => [{ tag: 'strong' }, { tag: 'b' }],
  renderHTML: ({ HTMLAttributes }) => ['b', HTMLAttributes, 0],
});
const ItalicI = Italic.extend({
  parseHTML: () => [{ tag: 'em' }, { tag: 'i' }],
  renderHTML: ({ HTMLAttributes }) => ['i', HTMLAttributes, 0],
});

// An image in a stored body is a reference, not bytes (`lib/note-images.ts`);
// this node's job is to keep one alive through a round trip. Inline, because
// both native serializers emit `<img>` inside the paragraph. `width`/`height`
// are carried verbatim — native lays out from them, and dropping them here
// would strip the size off every body a phone wrote. `allowBase64` keeps a
// `data:` image someone pastes as HTML: the stored body shouldn't hold bytes,
// but a node the schema rejects is content deleted on the next keystroke, and
// the paste handler is the right place to convert one into an attachment.
const NoteImage = Image.extend({
  inline: true,
  group: 'inline',
  addAttributes() {
    const dimension = (name: 'width' | 'height') => ({
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute(name),
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs[name] == null ? {} : { [name]: attrs[name] },
    });
    return { ...this.parent?.(), width: dimension('width'), height: dimension('height') };
  },
}).configure({ allowBase64: true });

/** Spaces one Tab press is worth. Two, matching the codebase this app is
 *  written in, and narrow enough that a couple of levels still fit a phone. */
const TAB_SIZE = 2;

/** Apply a `lib/code-typing.ts` edit to the code block starting at `start`. */
function codeEditTransaction(tr: Transaction, start: number, edit: CodeEdit): Transaction {
  if (edit.insert) tr.insertText(edit.insert, start + edit.from, start + edit.to);
  else if (edit.to > edit.from) tr.delete(start + edit.from, start + edit.to);
  return tr.setSelection(
    TextSelection.create(tr.doc, start + (edit.anchor ?? edit.caret), start + edit.caret),
  );
}

function applyCodeEdit(editor: Editor, start: number, edit: CodeEdit): boolean {
  return editor.commands.command(({ tr }) => {
    codeEditTransaction(tr, start, edit);
    return true;
  });
}

// The canonical body's code block is `<codeblock>`, not `<pre><code>` — that is
// the tag the native `react-native-enriched` editor reads and writes, and the
// body is one shared format. Without this node TipTap's schema simply drops a
// code block written on a phone, and the next keystroke here would serialize the
// note without it. `<pre>` is accepted on the way in so pasted code still lands
// as a block.
const NativeCodeBlock = CodeBlock.extend({
  parseHTML: () => [{ tag: 'codeblock', preserveWhitespace: 'full' as const }, { tag: 'pre', preserveWhitespace: 'full' as const }],
  renderHTML: ({ HTMLAttributes }) => ['codeblock', HTMLAttributes, 0],
  // The stock rule only fires on ``` *followed by a space or a newline*, which
  // is right for `- ` and `# ` — there the space is what separates a marker from
  // an ordinary hyphen — but there is nothing ambiguous about a third backtick,
  // and having to press space after it reads as the shortcut not working. Both
  // rules are kept, so ```js still opens one too.
  addInputRules() {
    return [
      ...(this.parent?.() ?? []),
      textblockTypeInputRule({ find: /^```$/, type: this.type }),
    ];
  },
  // Brackets close themselves and Enter follows the code's indentation — the
  // rules live in `lib/code-typing.ts`; this only maps a block's text offsets
  // onto document positions and back. Each edit is one transaction, so one undo
  // takes back a whole auto-closed pair or auto-indented line.
  addKeyboardShortcuts() {
    const parent = this.parent?.() ?? {};
    const inBlock = () => {
      const { $from, $to } = this.editor.state.selection;
      if ($from.parent.type !== this.type || !$from.sameParent($to)) return null;
      const start = $from.start();
      return { text: $from.parent.textContent, from: $from.pos - start, to: $to.pos - start, start };
    };
    // A selection hands Tab / Shift+Tab to `TabIndent`, which indents from each
    // line's start. The stock handlers here indent from wherever the selection
    // begins, and one reaching past the block rewrites the text after it into
    // the block.
    const unlessSelecting = (key: 'Tab' | 'Shift-Tab') => (props: Parameters<NonNullable<typeof parent.Tab>>[0]) =>
      this.editor.state.selection.empty ? (parent[key]?.(props) ?? false) : false;
    return {
      ...parent,
      Tab: unlessSelecting('Tab'),
      'Shift-Tab': unlessSelecting('Shift-Tab'),
      Enter: (props) => {
        const at = inBlock();
        if (!at) return parent.Enter?.(props) ?? false;
        const exit = at.from === at.to ? exitOffset(at.text, at.from) : null;
        if (exit !== null) {
          return this.editor
            .chain()
            .command(({ tr }) => {
              tr.delete(at.start + exit, at.start + at.text.length);
              return true;
            })
            .exitCode()
            .run();
        }
        return applyCodeEdit(this.editor, at.start, enterInCode(at.text, at.from, at.to, TAB_SIZE));
      },
      Backspace: (props) => {
        const at = inBlock();
        const edit = at && at.from === at.to ? backspaceInCode(at.text, at.from, TAB_SIZE) : null;
        if (at && edit) return applyCodeEdit(this.editor, at.start, edit);
        return parent.Backspace?.(props) ?? false;
      },
    };
  },
  addProseMirrorPlugins() {
    const type = this.type;
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        props: {
          // Typed characters, not key bindings: `{` is a different key on every
          // layout, and this is what the browser reports as text.
          handleTextInput: (view, from, to, typed) => {
            // Mid-composition the IME owns the text; replacing it under the IME
            // duplicates or drops characters (TipTap's input rules skip it too).
            if (view.composing || typed.length !== 1) return false;
            const $from = view.state.doc.resolve(from);
            const $to = view.state.doc.resolve(to);
            if ($from.parent.type !== type || !$from.sameParent($to)) return false;
            const start = $from.start();
            const edit = typeInCode($from.parent.textContent, from - start, to - start, typed, TAB_SIZE);
            if (!edit) return false;
            view.dispatch(codeEditTransaction(view.state.tr, start, edit));
            return true;
          },
        },
      }),
    ];
  },
}).configure({
  // Tab inside a code block indents the line (and Shift+Tab lifts it), which is
  // the extension's own handling of a selection spanning several lines.
  enableTabIndentation: true,
  tabSize: TAB_SIZE,
  languageClassPrefix: null,
});

/**
 * Tab indents, everywhere in the body.
 *
 * Lower priority than everything else, so the code block's own Tab handling
 * (whole-line indent, Shift+Tab to outdent) wins where it applies and this is
 * what is left for ordinary text.
 *
 * Tab no longer moves focus out of the editor, which is how a browser normally
 * lets a keyboard user leave a field — so Escape is wired up to blur instead,
 * and the navbar's done check still ends editing with a pointer.
 */
const TabIndent = Extension.create({
  name: 'tabIndent',
  priority: 50,
  addKeyboardShortcuts() {
    // With a selection, Tab indents every line it touches (and Shift+Tab lifts
    // them) rather than typing over it — replacing three selected paragraphs, or
    // a selected image, with two spaces is deletion, not indentation.
    //
    // A line is a textblock, or one line of a code block. `text` is the run of
    // text the line starts with — up to the first inline node, so an image at
    // the start of a caption isn't counted as part of its indentation and then
    // deleted by position.
    const eachLine = (change: (tr: Transaction, lineStart: number, text: string) => void) =>
      this.editor.commands.command(({ tr, state }) => {
        const { from, to } = state.selection;
        const starts: { pos: number; text: string }[] = [];
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!node.isTextblock) return true;
          const contentStart = pos + 1;
          if (node.type.spec.code) {
            let offset = 0;
            for (const line of node.textContent.split('\n')) {
              const lineStart = contentStart + offset;
              const lineEnd = lineStart + line.length;
              if (lineEnd >= from && lineStart <= to) starts.push({ pos: lineStart, text: line });
              offset += line.length + 1;
            }
          } else {
            const first = node.firstChild;
            starts.push({ pos: contentStart, text: first?.isText ? (first.text ?? '') : '' });
          }
          return false;
        });
        // Last first, so an edit never shifts a position still to be used.
        for (const line of starts.reverse()) change(tr, line.pos, line.text);
        return true;
      });
    return {
      Tab: () =>
        this.editor.state.selection.empty
          ? this.editor.commands.insertContent(' '.repeat(TAB_SIZE))
          : eachLine((tr, at) => tr.insertText(' '.repeat(TAB_SIZE), at)),
      // Bound even where there is nothing to lift: left to the browser, Shift+Tab
      // moves focus out of the body and ends editing. Leading whitespace may be
      // stored as non-breaking spaces (html-space.ts), so both count.
      'Shift-Tab': () =>
        eachLine((tr, at, text) => {
          const lead = /^[  ]*/.exec(text)![0].length;
          const cut = Math.min(TAB_SIZE, lead);
          if (cut > 0) tr.delete(at, at + cut);
        }),
      Escape: () => this.editor.commands.blur(),
    };
  },
});

// Match the native tag subset: list items and checkbox items hold a single
// paragraph (no nesting), so bodies round-trip through the boundary normalizer.
const ListItemP = ListItem.extend({ content: 'paragraph' });
const TaskItemP = TaskItem.extend({ content: 'paragraph' }).configure({ nested: false });

// Stock TaskList ships no markdown input rule (unlike BulletList/OrderedList),
// so `[ ] ` / `[x] ` wouldn't start a checklist. Add the wrapping rule.
const TaskListMd = TaskList.extend({
  addInputRules() {
    return [wrappingInputRule({ find: CHECKBOX_INPUT_REGEX, type: this.type })];
  },
});

function extensions(placeholder: string) {
  return [
    Document,
    Paragraph,
    Text,
    BoldB,
    ItalicI,
    Strike,
    Underline,
    Code,
    NativeCodeBlock,
    TabIndent,
    Heading.configure({ levels: [1, 2, 3, 4, 5, 6] }),
    BulletList,
    OrderedList,
    ListItemP,
    TaskListMd,
    TaskItemP,
    Blockquote,
    Link.configure({ openOnClick: false, autolink: true }),
    NoteImage,
    UndoRedo,
    Placeholder.configure({ placeholder }),
  ];
}

/** Content CSS for the editor, themed. Scoped under the mount's wrapper class so
 * it can't leak into the rest of the web app. */
function editorCss(theme: Palette): string {
  const secondary = theme.textSecondary;
  return `
.wn-rich .ProseMirror {
  outline: none;
  color: ${theme.text};
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  min-height: 120px;
  white-space: pre-wrap;
  word-wrap: break-word;
  /* The swipe-back GestureDetector wraps the screen and react-native-gesture-
     handler sets user-select:none on it (to suppress selection during drags),
     which cascades in and breaks dragging a selection across lines here. Force
     the editable content back to selectable. */
  user-select: text;
  -webkit-user-select: text;
}
.wn-rich .ProseMirror > * { margin: 0 0 4px; }
.wn-rich .ProseMirror h1 { font-size: 28px; font-weight: 700; }
.wn-rich .ProseMirror h2 { font-size: 22px; font-weight: 700; }
.wn-rich .ProseMirror h3 { font-size: 18px; font-weight: 700; }
.wn-rich .ProseMirror ul, .wn-rich .ProseMirror ol { padding-left: 1.4em; margin: 0 0 4px; }
.wn-rich .ProseMirror a { color: ${LINK_COLOR}; text-decoration: underline; }
.wn-rich .ProseMirror code {
  background: ${theme.backgroundElementAlt};
  border-radius: 4px;
  padding: 1px 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 90%;
}
.wn-rich .ProseMirror pre,
.wn-rich .ProseMirror codeblock {
  background: ${theme.backgroundElementAlt};
  border-radius: ${Spacing.two}px;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
/* codeblock is the canonical tag but not an element the browser knows, so it
   arrives inline with no whitespace handling of its own. pre-wrap keeps the
   indentation and the newlines that make it a code block, while still wrapping a
   long line rather than running it off the side — there are no scrollbars here
   (see global.css). An empty one keeps its height so there is something to put
   the caret in. */
.wn-rich .ProseMirror codeblock {
  display: block;
  white-space: pre-wrap;
  word-wrap: break-word;
  min-height: 24px;
  margin: 0 0 4px;
}
.wn-rich .ProseMirror blockquote {
  border-left: 3px solid ${theme.backgroundSelected};
  padding-left: 12px;
  color: ${secondary};
}
/* List items hold a paragraph; strip its default margin so the text lines up
   with the marker/checkbox instead of being pushed down. */
.wn-rich .ProseMirror li p { margin: 0; }
.wn-rich .ProseMirror ul[data-type="taskList"] { list-style: none; padding-left: 0; }
.wn-rich .ProseMirror ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 8px; }
/* Center the checkbox within a box the height of the first text line so it sits
   level with the text (not above it). */
.wn-rich .ProseMirror ul[data-type="taskList"] li > label {
  display: inline-flex;
  align-items: center;
  height: 24px;
  margin: 0;
  user-select: none;
}
.wn-rich .ProseMirror ul[data-type="taskList"] li > label input { margin: 0; width: 16px; height: 16px; accent-color: ${secondary}; }
.wn-rich .ProseMirror ul[data-type="taskList"] li > div { flex: 1 1 auto; min-width: 0; }
/* A checked item reads as done rather than merely marked: struck through,
   italicised and dimmed. Only its text — the box keeps full strength, so a
   glance down the gutter still reads as a column of boxes. */
.wn-rich .ProseMirror ul[data-type="taskList"] li[data-checked="true"] > div {
  text-decoration: line-through;
  font-style: italic;
  opacity: ${CheckedOpacity};
}
.wn-rich .ProseMirror img {
  max-width: 100%;
  height: auto;
  border-radius: ${Spacing.two}px;
  vertical-align: bottom;
}
/* Selected reads as selected the way everything else in the app does: the
   accent, faded in rather than snapped on. A box-shadow rather than an outline
   so the ring follows the corner radius — outline's radius handling differs
   between engines, and a squared ring around a squircle is exactly the seam
   this design language avoids. */
.wn-rich .ProseMirror img {
  box-shadow: 0 0 0 0 ${hexToRgba(Accent, 0)};
  transition: box-shadow 160ms ease;
}
.wn-rich .ProseMirror img.ProseMirror-selectednode {
  box-shadow: 0 0 0 ${Spacing.half}px ${Accent};
}
.wn-rich .ProseMirror p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  color: ${secondary};
  float: left;
  height: 0;
  pointer-events: none;
}
`;
}

type Props = {
  /** Initial body as HTML (the editor is uncontrolled — pass `key={id}` to reseed). */
  value: string;
  /** Fires with the current HTML on every change. */
  onChangeText: (html: string) => void;
  placeholder?: string;
  /** Imperative handle so the formatting toolbar can drive formatting commands. */
  editorRef?: RefObject<EnrichedTextInputInstance | null>;
  /** Reports focus so the screen can show/hide the formatting toolbar. */
  onFocusChange?: (focused: boolean) => void;
  /** Reports the active inline/block styles so the toolbar can highlight them. */
  onStateChange?: (state: OnChangeStateEvent) => void;
  /**
   * Declared to match native, where a screen uses it to scroll the caret back
   * into view. Unused here: the browser keeps the caret visible in a focused
   * contenteditable by itself, and there is no keyboard covering the page.
   */
  onSelectionChange?: (selection: { start: number; end: number; atEnd: boolean }) => void;
};

/**
 * Web counterpart of the native rich `MarkdownEditor`. Mobile uses the native
 * `react-native-enriched` editor; here we run a custom TipTap/ProseMirror editor
 * configured to emit the *same* canonical HTML tag subset. It is a true WYSIWYG
 * editor with **markdown-style keyboard input** (`**bold**`, `# `, `- `, `1. `,
 * `> `, `` ` ``, `[ ] `) and undo/redo — the enriched library's own web build
 * deliberately strips input rules, shortcuts, and history, which is why we build
 * our own here rather than reuse it. There is no markdown *translation*: bodies
 * are HTML on both sides, and the only boundary shaping (checkbox dialect, list
 * `<p>` wrapping, `<html>` wrapper) lives in `rich-html.web.ts`.
 *
 * The editor is uncontrolled: seed once from `value` and persist via
 * `onChangeText`; remount with `key={id}` to reseed between notes.
 */
export function MarkdownEditor({
  value,
  onChangeText,
  placeholder,
  editorRef,
  onFocusChange,
  onStateChange,
}: Props) {
  const theme = useTheme();
  const mountRef = useRef<HTMLDivElement | null>(null);

  // Latest callbacks without reinitializing the editor (which would drop caret
  // and undo history). Seed content is frozen for the life of the mount.
  const cbRef = useRef({ onChangeText, onFocusChange, onStateChange });
  cbRef.current = { onChangeText, onFocusChange, onStateChange };
  const [storedSeed] = useState(value);
  const [placeholderText] = useState(placeholder ?? '');
  // What this device knows about the images the body references. Held in a ref
  // because every serialize needs it synchronously, and inserting adds to it.
  const imagesRef = useRef<NoteImageIndex>(new Map());

  useEffect(() => {
    const element = mountRef.current;
    if (!element) return;
    // The index has to be read before the editor can be seeded, so init is
    // async — and a mount torn down in that window must not leave an editor
    // behind, nor build one nobody will ever see.
    let disposed = false;
    let editor: Editor | null = null;
    // A focus asked for before the async init finishes — copa autofocuses a new
    // draft a couple of frames after mount, and the edit pencil can be pressed
    // at any time — is remembered and applied when the editor arrives, rather
    // than landing on a null handle and doing nothing.
    let focusWhenReady = false;

    const toStored = (html: string) =>
      tiptapHtmlToStored(
        unresolveNoteImages(html, noteImageIdResolver(imagesRef.current), imagesRef.current),
      );

    /** Store an image and place it at the caret. */
    const place = async (sourceUri: string) => {
      const inserted = await insertNoteImage(sourceUri, imagesRef.current);
      if (!inserted || !editor || disposed) return;
      const scale =
        inserted.width > EDITOR_MAX_WIDTH ? EDITOR_MAX_WIDTH / inserted.width : 1;
      editor
        .chain()
        .focus()
        .setImage({
          src: inserted.uri,
          width: Math.round(inserted.width * scale),
          height: Math.round(inserted.height * scale),
        } as { src: string })
        .run();
    };

    /** Take an image off the clipboard, if there is one. Runs on the editor's
     *  own DOM node, so it can only fire while this editor has the selection —
     *  unlike a window listener, which fires app-wide whether the editor is on
     *  screen or not (the leak the copa tab had to unship). */
    const handlePaste = (event: ClipboardEvent | null): boolean => {
      const files = Array.from(event?.clipboardData?.files ?? []);
      const images = files.filter((f) => f.type.startsWith('image/'));
      // Copying a picture from a browser puts both the image and its markup on
      // the clipboard; the image is what was meant.
      if (images.length === 0) return false;
      event?.preventDefault();
      void (async () => {
        for (const file of images) {
          const url = URL.createObjectURL(file);
          try {
            await place(url);
          } finally {
            // The bytes were re-encoded into storage by now; this URL was only
            // ever the handle onto the clipboard's copy.
            URL.revokeObjectURL(url);
          }
        }
      })();
      return true;
    };

    const chooseImage = () => {
      void (async () => {
        const source = await pickNoteImage();
        if (!source) return;
        try {
          await place(source);
        } finally {
          if (source.startsWith('blob:')) URL.revokeObjectURL(source);
        }
      })();
    };

    // Installed before the await, so a caller that reaches for the handle early
    // gets something that works rather than null.
    if (editorRef) {
      editorRef.current = {
        focus: () => {
          if (editor) editor.commands.focus();
          else focusWhenReady = true;
        },
        blur: () => editor?.commands.blur(),
      } as unknown as EnrichedTextInputInstance;
    }

    const build = () => {
      const seed = storedHtmlToTiptap(
        // A fixed width, not the element's: a body has to serialize back
        // identically whatever size the window happens to be.
        resolveNoteImages(storedSeed, imagesRef.current, EDITOR_MAX_WIDTH),
      );
      const instance = new Editor({
        element,
        extensions: extensions(placeholderText),
        content: seed,
        // ProseMirror's default parse collapses space runs and drops a
        // paragraph's leading space, so an indent would vanish every time a note
        // loads. `true` (not 'full') still ignores formatting whitespace
        // *between* blocks.
        parseOptions: { preserveWhitespace: true },
        editorProps: {
          attributes: { class: 'wn-rich-input' },
          handlePaste: (_view, event) => handlePaste(event),
        },
        onUpdate: ({ editor: e }) => cbRef.current.onChangeText(toStored(e.getHTML())),
        onFocus: () => {
          // Mirror native: expose a blur so the navbar's "done" (web has no
          // keyboard to dismiss) can return the editor to its resting state.
          setActiveEditorDismiss(() => instance.commands.blur());
          setActiveEditorInsertImage(chooseImage);
          cbRef.current.onFocusChange?.(true);
        },
        onBlur: () => {
          setActiveEditorDismiss(null);
          clearActiveEditorInsertImage(chooseImage);
          cbRef.current.onFocusChange?.(false);
        },
      });
      editor = instance;

      // Bridge the subset of the native imperative API the web toolbar (if any)
      // would use, so callers can share one `editorRef` type across platforms.
      if (editorRef) {
        editorRef.current = {
          focus: () => instance.commands.focus(),
          blur: () => instance.commands.blur(),
          toggleBold: () => instance.chain().focus().toggleBold().run(),
          toggleItalic: () => instance.chain().focus().toggleItalic().run(),
          toggleStrikeThrough: () => instance.chain().focus().toggleStrike().run(),
          toggleUnderline: () => instance.chain().focus().toggleUnderline().run(),
          toggleUnorderedList: () => instance.chain().focus().toggleBulletList().run(),
          toggleOrderedList: () => instance.chain().focus().toggleOrderedList().run(),
          toggleCheckboxList: () => instance.chain().focus().toggleTaskList().run(),
        } as unknown as EnrichedTextInputInstance;
      }
      if (focusWhenReady) instance.commands.focus();
    };

    /**
     * Ctrl/Cmd+I inserts an image.
     *
     * It is the shortcut that was asked for, and it costs italic its usual
     * binding — worth saying out loud. Italic is still a keystroke away through
     * this editor's markdown input (`*text*`), which is how every other style
     * here is applied; there is no toolbar on web by design. Bound on the
     * editor's own node, so it can't fire anywhere else in the app.
     */
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key !== 'i' && event.key !== 'I') return;
      event.preventDefault();
      chooseImage();
    };
    element.addEventListener('keydown', onKeyDown);

    void (async () => {
      try {
        const index = await db.getNoteImageIndex();
        imagesRef.current = new Map(index.map((i) => [i.id, i]));
      } catch {
        // Without the index every reference resolves to a placeholder the editor
        // still keeps in the document — degraded, never destructive.
      }
      if (disposed) return;
      build();
    })();

    return () => {
      disposed = true;
      element.removeEventListener('keydown', onKeyDown);
      editor?.destroy();
      setActiveEditorDismiss(null);
      clearActiveEditorInsertImage(chooseImage);
      if (editorRef) editorRef.current = null;
    };
    // Init once — content/placeholder are frozen; `key={id}` remounts to reseed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="wn-rich">
      <style>{editorCss(theme)}</style>
      <div ref={mountRef} />
    </div>
  );
}
