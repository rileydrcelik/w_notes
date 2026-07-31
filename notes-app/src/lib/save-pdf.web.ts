/**
 * Web "download this PDF": blob + anchor click, the same shape as
 * `save-note.web.ts` and the copa web download.
 */
export async function savePdfToDevice(fileName: string, bytes: Uint8Array): Promise<void> {
  // Copy into a fresh buffer: the caller's array is the compile result, which is
  // also feeding the on-screen preview.
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
