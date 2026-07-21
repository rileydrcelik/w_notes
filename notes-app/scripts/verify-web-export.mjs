// Gate on the web export before it ships. Run after `fix-web-export.mjs`,
// immediately before deploying `dist`.
//
// Every check here corresponds to an outage this project has actually had, and
// each is invisible until the site is live:
//
//   - A stale `.env.local` baked `http://localhost:8000` in as the API URL, so
//     production web talked to a stopped local backend and silently never
//     synced. Nothing looked broken; notes just stopped moving between devices.
//   - Cloudflare drops any directory named `node_modules`, taking expo-sqlite's
//     `wa-sqlite.wasm` and the icon fonts with it. `fix-web-export.mjs` renames
//     the directory to avoid that — but nothing verified the rename worked, or
//     that every reference to the old path got rewritten.
//
// A bundle is a build artifact, so none of this is reachable from a unit,
// integration, or even browser test of the dev server. It's only checkable here.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const dist = join(process.cwd(), 'dist');
const TEXT_EXTS = new Set(['.js', '.css', '.html', '.json', '.map']);

/** Every file under `dist`, with the text ones' contents. */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else out.push(p);
  }
  return out;
}

const failures = [];
const fail = (msg) => failures.push(msg);
const rel = (p) => relative(dist, p).replace(/\\/g, '/');

if (!existsSync(dist)) {
  console.error('✗ no dist/ — run `npx expo export -p web` first');
  process.exit(1);
}

const files = collect(dist);
// .map files are excluded from the text scan: source maps embed original
// sources, so a localhost string in one is a comment or a dev-only branch, not
// the URL the app will actually call.
const texts = files.filter((p) => TEXT_EXTS.has(extname(p)) && extname(p) !== '.map');

// 1. No local API URL baked into the shipped bundle.
//
// Expo inlines a couple of its own localhost URLs into every export, including a
// production one — 8969 is the inspector proxy. Those are inert in a deployed
// bundle, so they're allowlisted; verified by exporting with `.env.local` moved
// aside and confirming 8969 is still present in an otherwise-correct build.
// Anything on another port is a real baked-in local backend.
const EXPO_INTERNAL_PORTS = new Set(['8081', '8969', '19000', '19006']);
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/g;
for (const p of texts) {
  const offenders = new Set();
  for (const m of readFileSync(p, 'utf8').matchAll(LOCAL_URL)) {
    if (!EXPO_INTERNAL_PORTS.has(m[1])) offenders.add(m[0]);
  }
  if (offenders.size) {
    fail(
      `${rel(p)} references ${[...offenders].join(', ')} — a local backend is ` +
        `baked into the bundle. Move .env.local aside and re-export with --clear.`,
    );
  }
}

// 2. The SQLite WASM survived. Without it the web database never initialises,
//    and the app comes up to an empty, permanently broken state.
if (!files.some((p) => p.endsWith('.wasm'))) {
  fail('no .wasm in dist/ — wa-sqlite is missing, so web SQLite cannot start');
}

// 3. Icon fonts survived; without them every icon renders as a blank box.
if (!files.some((p) => extname(p) === '.ttf')) {
  fail('no .ttf fonts in dist/ — icons will render blank');
}

// 4. Nothing still points at the directory Cloudflare will drop.
for (const p of texts) {
  if (readFileSync(p, 'utf8').includes('/assets/node_modules/')) {
    fail(`${rel(p)} still references /assets/node_modules/ — run fix-web-export.mjs`);
  }
}

// Surface the API URL the bundle will actually use. Not an assertion — the
// point is that a human sees it before deploying, since "wrong but plausible
// host" is exactly the failure that slipped through before.
const apiUrls = new Set();
for (const p of texts) {
  for (const m of readFileSync(p, 'utf8').matchAll(/https?:\/\/[a-z0-9.-]+(?::\d+)?(?=["'`])/gi)) {
    if (/api|localhost|127\.0\.0\.1/i.test(m[0])) apiUrls.add(m[0]);
  }
}
if (apiUrls.size) console.log(`  api-ish URLs in bundle: ${[...apiUrls].join(', ')}`);

if (failures.length) {
  console.error(`\n✗ web export is not safe to deploy (${failures.length} problem(s)):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('');
  process.exit(1);
}

console.log(`✓ web export looks deployable (${files.length} files checked)`);
