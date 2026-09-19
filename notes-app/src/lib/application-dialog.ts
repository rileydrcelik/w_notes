import type { InternshipStatus } from '@/lib/internship';

/**
 * The "add application" dialog, opened by the tracker's (+).
 *
 * Mounted once at the root (`components/internship/add-application-dialog.tsx`)
 * so it stacks above the navbar, as the link dialog is. The tracker screen owns
 * the body, so it hands the dialog a callback rather than the dialog writing it.
 */
export type ApplicationDialogRequest = {
  onAdd: (name: string, status: InternshipStatus) => void;
};

type Open = ApplicationDialogRequest & { key: number };

let current: Open | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function openApplicationDialog(request: ApplicationDialogRequest): void {
  current = { ...request, key: ++seq };
  emit();
}

export function closeApplicationDialog(): void {
  if (!current) return;
  current = null;
  emit();
}

export function getApplicationDialog(): Open | null {
  return current;
}

export function subscribeApplicationDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
