// Publish an OTA update to the production channel.
//
// Wraps `eas update` for two reasons the raw command cannot cover on its own:
//
//   1. It refuses to run without `verify-update-env.mjs` passing. A stale
//      `.env.local` baked `http://localhost:8000` into the web bundle once; the
//      same file poisons an update the same way, except a bad update has
//      already reached every phone on the channel.
//   2. `eas update --non-interactive` requires `--message`, and a message typed
//      by hand each time is one that eventually says "fix" or drifts from what
//      actually shipped. This derives it from the version and the commit being
//      published, so the EAS dashboard says what a phone is running.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CHANNEL = 'production';
const run = (cmd, args) =>
  execFileSync(cmd, args, { stdio: 'inherit', shell: true, cwd: process.cwd() });

const version = JSON.parse(
  readFileSync(new URL('../app.json', import.meta.url), 'utf8'),
).expo.version;

// The gate. Throws (and so aborts) on a non-zero exit.
run(process.execPath, ['scripts/verify-update-env.mjs']);

/** Subject line of the commit being shipped, for the update message. */
function commitSubject() {
  try {
    return execFileSync('git', ['log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const subject = commitSubject();
const message = subject ? `${version} - ${subject}` : version;

console.log(`\npublishing ${version} to the "${CHANNEL}" channel`);
console.log(`message: ${message}\n`);

run('npx', [
  '--yes',
  'eas-cli@latest',
  'update',
  '--channel',
  CHANNEL,
  // Pull EXPO_PUBLIC_* from EAS's own production environment rather than
  // whatever dotenv files happen to be on this machine. The guard above still
  // runs, because the local files are what a mistake looks like and a silent
  // server-side override is not something to rely on for safety.
  '--environment',
  CHANNEL,
  '--message',
  JSON.stringify(message),
  '--non-interactive',
]);
