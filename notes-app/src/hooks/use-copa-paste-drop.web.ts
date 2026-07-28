import { usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import type { DroppedFile } from '@/lib/copa-files';
import { useCopa } from '@/store/copa-store';

/**
 * Web-only: turns the copa feed into a drop target and a paste target, so a
 * desktop screenshot (Ctrl+V straight out of the snipping tool or a browser) or
 * a dragged-in file becomes a copy block without going through the picker.
 *
 * Files land as file blocks — their bytes ride the same S3 path as picked files,
 * so a screenshot pasted on the desktop shows up on the phone. Anything else on
 * the clipboard is taken as text and becomes a text block.
 *
 * Returns whether a drag is currently hovering, for the drop overlay to render.
 * Listeners live on `window` (not a DOM node) because a drag has to be caught
 * anywhere over the copa feed, wherever the pointer happens to be.
 *
 * They are bound only while copa is the *visible* route, which mounting alone
 * does not tell us. Copa and the home stack are sibling top tabs and the pager
 * doesn't lazy-load, so this screen mounts moments after launch and stays
 * mounted for the whole session whether or not the user ever opens it. Binding
 * on mount therefore made every paste and drop anywhere in the app — a note, a
 * spreadsheet cell — land in copa. Gating on the route is what actually scopes
 * them.
 */
export function useCopaPasteDrop(): { dragging: boolean } {
  const { createTextCopa, createDroppedFileCopa } = useCopa();
  const [dragging, setDragging] = useState(false);
  const pathname = usePathname();
  const active = pathname === '/copa' || pathname.startsWith('/copa/');

  // Latest store callbacks, read at event time so the listeners below can bind
  // once instead of detaching and re-attaching on every render.
  const createRef = useRef({ createTextCopa, createDroppedFileCopa });
  useEffect(() => {
    createRef.current = { createTextCopa, createDroppedFileCopa };
  }, [createTextCopa, createDroppedFileCopa]);

  useEffect(() => {
    // Off-route, bind nothing at all: this screen stays mounted behind whatever
    // the user is actually looking at.
    if (!active) return;

    // dragenter/dragleave fire for every element the pointer crosses, so a plain
    // boolean flickers off as the cursor moves between cards. Counting the
    // enter/leave pairs instead keeps the overlay steady until the drag is
    // really gone.
    let depth = 0;

    /**
     * Whether the drag in flight started inside a text field.
     *
     * Checking only where a drag *lands* isn't enough: dragging a selection out
     * of an input and releasing it a few pixels away, still inside the same
     * grid, lands on a non-editable sibling and reads as an external drop. That
     * is how spreadsheet cell text ended up as copa blocks.
     */
    let fromEditable = false;

    const endDrag = () => {
      depth = 0;
      setDragging(false);
    };

    /** True when the event landed in a text field, where the browser's own paste/drop should win. */
    const isEditable = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el || typeof el.closest !== 'function') return false;
      return !!el.closest('input, textarea, [contenteditable=""], [contenteditable="true"]');
    };

    /** Whether a transfer carries something we can turn into a block. */
    const hasPayload = (dt: DataTransfer | null): boolean =>
      !!dt && (dt.types.includes('Files') || dt.types.includes('text/plain'));

    const addFiles = async (files: DroppedFile[]) => {
      // Each create prepends, so adding back-to-front leaves a multi-file drop
      // sitting in the order it was dropped. Sequential, so the ordering holds.
      for (const file of [...files].reverse()) {
        await createRef.current.createDroppedFileCopa(file);
      }
    };

    /**
     * Pulls files off a clipboard/drag payload. Files win over text: copying an
     * image out of a browser puts both the image and its markup on the clipboard,
     * and the image is what was meant.
     */
    const filesIn = (dt: DataTransfer): DroppedFile[] => Array.from(dt.files ?? []);

    const onPaste = (e: ClipboardEvent) => {
      // A paste into a text field (the search box) is an ordinary edit.
      if (isEditable(e.target)) return;
      const dt = e.clipboardData;
      if (!dt) return;
      const files = filesIn(dt);
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
        return;
      }
      const text = dt.getData('text/plain');
      if (!text.trim()) return;
      e.preventDefault();
      createRef.current.createTextCopa(text);
    };

    // The drag handlers deliberately don't skip text fields: dragenter and
    // dragleave have to stay paired for the depth count to hold, and a file
    // dropped on the search box should still become a block (see onDrop).
    const onDragEnter = (e: DragEvent) => {
      if (!hasPayload(e.dataTransfer)) return;
      depth += 1;
      setDragging(true);
    };

    const onDragOver = (e: DragEvent) => {
      if (!hasPayload(e.dataTransfer)) return;
      // Without this the browser refuses the drop and navigates to the dropped
      // file instead, blowing the app out of the tab.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };

    const onDragLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };

    const onDragStart = (e: DragEvent) => {
      fromEditable = isEditable(e.target);
    };

    const onDrop = (e: DragEvent) => {
      const startedInField = fromEditable;
      endDrag();
      fromEditable = false;
      const dt = e.dataTransfer;
      if (!dt) return;

      // Moving a selection around within the app's own text fields is an edit,
      // not something to capture — whatever it happens to be released over.
      if (startedInField) return;

      const files = filesIn(dt);
      if (files.length) {
        // A file dropped into a text field belongs to that field, same as text.
        if (isEditable(e.target)) return;
        // Otherwise, wherever it landed: the browser's own handling of a dropped
        // file is to navigate to it, which would unload the app. Take it instead.
        e.preventDefault();
        void addFiles(files);
        return;
      }
      // Text dropped into a field is an ordinary edit — leave it to the browser.
      if (isEditable(e.target)) return;
      const text = dt.getData('text/plain');
      if (!text.trim()) return;
      e.preventDefault();
      createRef.current.createTextCopa(text);
    };

    window.addEventListener('paste', onPaste);
    window.addEventListener('dragstart', onDragStart);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    // A drag that ends outside the window never sends a matching dragleave, so
    // without this the overlay could stay up over nothing.
    window.addEventListener('dragend', endDrag);

    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('dragstart', onDragStart);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', endDrag);
    };
  }, [active]);

  return { dragging };
}
