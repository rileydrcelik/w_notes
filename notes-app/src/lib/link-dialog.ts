/**
 * The one link dialog, opened by whichever editor has focus.
 *
 * The dialog is mounted once at the root (`components/link-dialog.tsx`), for
 * the same reason the rename dialog is: an editor sits inside its screen's
 * ScrollView, and anything it rendered itself would scroll with the body and
 * sit under the navbar. The editor owns the selection and knows how to apply a
 * link, so it hands the dialog callbacks rather than the dialog reaching back in.
 */
export type LinkDialogRequest = {
  /** The link's current href, or '' for a new one. */
  url: string;
  /**
   * The text to show for a new link, when there's no selection to wrap — the
   * dialog asks for it. `null` when the link wraps text that's already there.
   */
  text: string | null;
  /** Apply `url` (already normalized). `text` is only meaningful when asked for. */
  onApply: (url: string, text: string) => void;
  /** Present when editing an existing link. */
  onRemove?: () => void;
  /** The dialog closed without a change. */
  onCancel: () => void;
  /**
   * The editor that opened it. An editor that goes away takes its dialog with
   * it (`closeLinkDialogFor`) — otherwise Save would land on nothing, or on a
   * remounted editor with offsets taken from the old text.
   */
  owner: object;
};

/** A request as the dialog holds it: `key` tells one opening from the next. */
export type OpenLinkDialog = LinkDialogRequest & { key: number };

let current: OpenLinkDialog | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function openLinkDialog(request: LinkDialogRequest): void {
  current = { ...request, key: ++seq };
  emit();
}

export function closeLinkDialog(): void {
  if (!current) return;
  current = null;
  emit();
}

/** Close the dialog, but only if `owner` opened it. */
export function closeLinkDialogFor(owner: object): void {
  if (current?.owner === owner) closeLinkDialog();
}

/** Whether `owner` has the dialog open — an editor stays "editing" meanwhile. */
export function isLinkDialogOpenFor(owner: object): boolean {
  return current?.owner === owner;
}

export function getLinkDialog(): OpenLinkDialog | null {
  return current;
}

export function subscribeLinkDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
