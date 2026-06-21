// Post-processes the `expo export -p web` output so it survives a Cloudflare
// deploy. Cloudflare silently drops any directory named `node_modules`, and
// Expo vendors web assets there — the icon fonts (@expo/vector-icons), the
// expo-router nav images, and crucially expo-sqlite's `wa-sqlite.wasm`. Without
// this, those files 404 on the live site (served the SPA fallback instead), so
// icons render blank and the web database never initializes.
//
// We move `dist/assets/node_modules/` to `dist/assets/vendor/` (not an ignored
// name) and rewrite the baked-in `/assets/node_modules/` URLs in the bundle to
// match. Run after `expo export -p web`, before deploying `dist`.

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const dist = join(process.cwd(), 'dist');
const fromDir = join(dist, 'assets', 'node_modules');
const toDir = join(dist, 'assets', 'vendor');
const FROM = '/assets/node_modules/';
const TO = '/assets/vendor/';
const TEXT_EXTS = new Set(['.js', '.css', '.html', '.json', '.map']);

if (existsSync(fromDir)) {
  renameSync(fromDir, toDir);
  console.log(`moved ${FROM} -> ${TO}`);
} else {
  console.log(`no ${FROM} directory (nothing to move)`);
}

let rewritten = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
    } else if (TEXT_EXTS.has(extname(p))) {
      const txt = readFileSync(p, 'utf8');
      if (txt.includes(FROM)) {
        writeFileSync(p, txt.split(FROM).join(TO));
        rewritten++;
        console.log(`rewrote refs in ${p.slice(dist.length + 1)}`);
      }
    }
  }
}
walk(dist);
console.log(`done — rewrote ${rewritten} file(s)`);
