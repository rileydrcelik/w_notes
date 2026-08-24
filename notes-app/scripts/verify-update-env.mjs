// Gate on the environment an OTA update would be bundled with. Run immediately
// before `eas update`.
//
// This is `verify-web-export.mjs`'s missing twin. That one catches a stale
// `.env.local` baking `http://localhost:8000` into the web bundle as the API
// URL — an outage this project has actually had, where production web talked to
// a stopped local backend and silently stopped syncing.
//
// The same file poisons an OTA the same way, and that path had no guard at all.
// It is the worse of the two by some margin:
//
//   - A bad web deploy is fixed by exporting again and re-deploying. A bad OTA
//     has already reached every phone on the channel, and the fix is another
//     update those phones have to be running well enough to fetch.
//   - The web export at least ends in a verifier that reads the built bundle.
//     An `eas update` bundles and publishes in one step with nothing in between.
//
// Deliberately a check, not a fix: this does not move `.env.local` aside for
// you. A script that quietly relocates a developer's file and then dies half
// way is a worse failure than the one it prevents.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Parse the `KEY=value` lines of a dotenv file. Comments and blanks ignored. */
function readEnvFile(path) {
  if (!existsSync(path)) return null;
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const cwd = process.cwd();
const base = readEnvFile(join(cwd, '.env')) ?? {};
const local = readEnvFile(join(cwd, '.env.local'));

// Expo resolves `.env.local` over `.env`, so the local file is what would win.
const resolved = { ...base, ...(local ?? {}) };
const url = resolved.EXPO_PUBLIC_API_URL ?? '';

const failures = [];

if (!url) {
  failures.push(
    'EXPO_PUBLIC_API_URL resolves to nothing. An update published with no API ' +
      'URL leaves every phone on the channel unable to sync.',
  );
} else if (/(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url)) {
  const from = local && 'EXPO_PUBLIC_API_URL' in local ? '.env.local' : '.env';
  failures.push(
    `EXPO_PUBLIC_API_URL is ${url} (from ${from}) — a local backend. ` +
      'Publishing this would point every phone on the channel at a machine ' +
      'that is not theirs. Move .env.local aside and re-run.',
  );
}

if (failures.length > 0) {
  console.error(`\n✗ not safe to publish an update (${failures.length} problem(s)):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('');
  process.exit(1);
}

console.log(`✓ update env looks publishable (EXPO_PUBLIC_API_URL=${url})`);
