// Copies pdf.js's rendering worker out of node_modules and into `public/pdfjs/`,
// where Expo's web export ships it verbatim at the site root.
//
// Why copy instead of import: Cloudflare Pages silently drops any directory
// named `node_modules` from a deploy. Expo's exporter vendors package-relative
// assets into `dist/assets/node_modules/…`, which is exactly what that drop eats
// — it already cost this project its SQLite wasm and its icon fonts (see
// scripts/fix-web-export.mjs). `public/` never goes near that path.
//
// The worker is loaded by URL at runtime, not bundled, so it has to be a real
// file on the server: see src/lib/latex/pdf-render.web.ts.
//
// Runs from `postinstall` (so the dev server has it too) and again before every
// web export.

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'public', 'pdfjs');
const source = join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');

if (!existsSync(source)) {
  console.error('✗ pdfjs-dist is not installed — run `npm install` first.');
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
copyFileSync(source, join(dest, 'pdf.worker.min.mjs'));

console.log('✓ copied pdf.js worker to public/pdfjs/');
