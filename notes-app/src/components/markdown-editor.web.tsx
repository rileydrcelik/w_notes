import { useEffect, useRef, useState, type RefObject } from 'react';
import { Editor, wrappingInputRule } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Strike from '@tiptap/extension-strike';
import Underline from '@tiptap/extension-underline';
import Code from '@tiptap/extension-code';
import Heading from '@tiptap/extension-heading';
import Blockquote from '@tiptap/extension-blockquote';
import Link from '@tiptap/extension-link';
import { BulletList, OrderedList, ListItem, TaskList, TaskItem } from '@tiptap/extension-list';
import { Placeholder, UndoRedo } from '@tiptap/extensions';
import type { EnrichedTextInputInstance, OnChangeStateEvent } from 'react-native-enriched';

import { type Palette } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { setActiveEditorDismiss } from '@/lib/active-editor';
import { storedHtmlToTiptap, tiptapHtmlToStored } from '@/lib/rich-html.web';

const LINK_COLOR = '#3c87f7';

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
    Heading.configure({ levels: [1, 2, 3, 4, 5, 6] }),
    BulletList,
    OrderedList,
    ListItemP,
    TaskListMd,
    TaskItemP,
    Blockquote,
    Link.configure({ openOnClick: false, autolink: true }),
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
.wn-rich .ProseMirror pre {
  background: ${theme.backgroundElementAlt};
  border-radius: 8px;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
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
  const [seed] = useState(() => storedHtmlToTiptap(value));
  const [placeholderText] = useState(placeholder ?? '');

  useEffect(() => {
    const element = mountRef.current;
    if (!element) return;

    const editor = new Editor({
      element,
      extensions: extensions(placeholderText),
      content: seed,
      editorProps: { attributes: { class: 'wn-rich-input' } },
      onUpdate: ({ editor: e }) => cbRef.current.onChangeText(tiptapHtmlToStored(e.getHTML())),
      onFocus: () => {
        // Mirror native: expose a blur so the navbar's "done" (web has no
        // keyboard to dismiss) can return the editor to its resting state.
        setActiveEditorDismiss(() => editor.commands.blur());
        cbRef.current.onFocusChange?.(true);
      },
      onBlur: () => {
        setActiveEditorDismiss(null);
        cbRef.current.onFocusChange?.(false);
      },
    });

    // Bridge the subset of the native imperative API the web toolbar (if any)
    // would use, so callers can share one `editorRef` type across platforms.
    if (editorRef) {
      editorRef.current = {
        focus: () => editor.commands.focus(),
        blur: () => editor.commands.blur(),
        toggleBold: () => editor.chain().focus().toggleBold().run(),
        toggleItalic: () => editor.chain().focus().toggleItalic().run(),
        toggleStrikeThrough: () => editor.chain().focus().toggleStrike().run(),
        toggleUnderline: () => editor.chain().focus().toggleUnderline().run(),
        toggleUnorderedList: () => editor.chain().focus().toggleBulletList().run(),
        toggleOrderedList: () => editor.chain().focus().toggleOrderedList().run(),
        toggleCheckboxList: () => editor.chain().focus().toggleTaskList().run(),
      } as unknown as EnrichedTextInputInstance;
    }

    return () => {
      editor.destroy();
      setActiveEditorDismiss(null);
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
