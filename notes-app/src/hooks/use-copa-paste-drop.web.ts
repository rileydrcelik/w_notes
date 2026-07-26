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
 * anywhere over the screen, and they're only mounted while the copa feed is.
 */
export function useCopaPasteDrop(): { dragging: boolean } {
  const { createTextCopa, createDroppedFileCopa } = useCopa();
  const [dragging, setDragging] = useState(false);

  // Latest store callbacks, read at event time so the listeners below can bind
  // once instead of detaching and re-attaching on every render.
  const createRef = useRef({ createTextCopa, createDroppedFileCopa });
  useEffect(() => {
    createRef.current = { createTextCopa, createDroppedFileCopa };
  }, [createTextCopa, createDroppedFileCopa]);

  useEffect(() => {
    // dragenter/dragleave fire for every element the pointer crosses, so a plain
    // boolean flickers off as the cursor moves between cards. Counting the
    // enter/leave pairs instead keeps the overlay steady until the drag is
    // really gone.
    let depth = 0;

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

    const onDrop = (e: DragEvent) => {
      endDrag();
      const dt = e.dataTransfer;
      if (!dt) return;
      const files = filesIn(dt);
      if (files.length) {
        // Wherever it landed: the browser's own handling of a dropped file is to
        // navigate to it, which would unload the app. Always take it instead.
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
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    // A drag that ends outside the window never sends a matching dragleave, so
    // without this the overlay could stay up over nothing.
    window.addEventListener('dragend', endDrag);

    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', endDrag);
    };
  }, []);

  return { dragging };
}
