/**
 * Web stubs for the sync file-transfer primitives. Cross-device file bytes ride
 * an S3 presigned-URL flow that depends on expo-file-system's native File API,
 * which doesn't exist on web. Sync isn't wired on web in this local-only pass,
 * so these are never reached — they exist only so the sync-engine import chain
 * compiles in the web bundle. They throw if ever called.
 */

const unsupported = (): never => {
  throw new Error('Copa file sync is not supported on web yet.');
};

export async function uploadCopaFile(_fileUri: string, _mimeType: string | null): Promise<string> {
  return unsupported();
}

export async function downloadCopaFile(_row: {
  id: string;
  remoteKey: string;
  mimeType: string | null;
  fileName: string | null;
}): Promise<{ fileUri: string; thumbUri: string | null }> {
  return unsupported();
}
