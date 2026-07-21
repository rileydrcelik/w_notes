/**
 * Every `.web` / `.native` module must export the same names as its base module.
 *
 * Metro picks the variant by platform, so a name added to one side and not the
 * other is `undefined` at runtime on the platform that missed out — and nothing
 * else notices. TypeScript checks each file in isolation and sees nothing wrong.
 * Tests that only run one platform exercise only that platform's file.
 *
 * This is not hypothetical: `whenDbOwner` and `subscribeDbRole` were added to
 * `web-db-lock.ts` with callers that run everywhere, but never to
 * `web-db-lock.native.ts`. On device `await whenDbOwner()` threw, SQLite never
 * opened, and the app crashed on launch — for three days, with the whole suite
 * green. It took a real Android build to find. This test would have caught it in
 * milliseconds, on the commit that introduced it.
 *
 * Pairs are discovered from the filesystem, so a new one is covered the moment
 * it's created rather than when someone remembers to add it here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../..', import.meta.url));

/** Every file under `src`, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Exported names declared in a module. Covers the forms this codebase uses:
 * `export function|async function|const|type|class|interface X`, and the
 * `export { a, b }` list form. Deliberately not a full TS parse — it only has to
 * be consistent between the two files being compared.
 */
function exportedNames(source: string): Set<string> {
  const names = new Set<string>();

  const declaration = /^export\s+(?:async\s+)?(?:function|const|let|var|type|class|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of source.matchAll(declaration)) names.add(m[1]);

  // `export { a, b as c }` — the exported name is what follows `as`, else the name itself.
  const list = /^export\s*\{([^}]*)\}/gm;
  for (const m of source.matchAll(list)) {
    for (const part of m[1].split(',')) {
      const cleaned = part.trim().replace(/^type\s+/, '');
      if (!cleaned) continue;
      const asMatch = cleaned.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      names.add(asMatch ? asMatch[1] : cleaned);
    }
  }

  if (/^export\s+default\b/m.test(source)) names.add('default');
  return names;
}

/** `foo.web.ts` -> `foo.ts`; returns null for a non-variant file. */
function baseModuleOf(file: string): string | null {
  const ext = extname(file);
  const withoutExt = file.slice(0, -ext.length);
  const platform = extname(withoutExt); // '.web' | '.native' | ''
  if (platform !== '.web' && platform !== '.native') return null;
  return withoutExt.slice(0, -platform.length) + ext;
}

const pairs = walk(SRC)
  .map((variant) => ({ variant, base: baseModuleOf(variant) }))
  .filter((p): p is { variant: string; base: string } => p.base !== null)
  // A variant with no base module is only reachable via an explicit `.web`
  // import (e.g. rich-html.web.ts), so there's no counterpart to diverge from.
  .filter((p) => existsSync(p.base));

const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');

/**
 * Divergences that are deliberate, keyed by variant module.
 *
 * The bar for adding an entry: the missing export must be unreachable on that
 * platform — nothing the platform actually runs may import it from the shared
 * specifier. If shared code imports it, it is a bug, not an exception.
 *
 * Keeping these explicit is the point. A parity check that fires on intentional
 * differences gets switched off within a week, and then it catches nothing.
 */
const ALLOWED_MISSING: Record<string, { names: string[]; reason: string }> = {
  'lib/copa-files.web.ts': {
    names: ['copaDestination', 'generateVideoThumbnail'],
    reason:
      'Native-only filesystem concepts (a destination File, a video thumbnail). ' +
      'Their only caller is lib/sync/files.ts — the *native* variant. ' +
      'files.web.ts never imports them, so they are unreachable on web.',
  },
};

describe('platform-split modules export the same names', () => {
  it('finds the pairs to check', () => {
    // Guards the discovery itself: if a refactor moved these, the assertions
    // below would silently pass over an empty list.
    expect(pairs.length).toBeGreaterThanOrEqual(6);
  });

  it.each(pairs.map((p) => [rel(p.base), p]))('%s', (_label, pair) => {
    const baseNames = exportedNames(readFileSync(pair.base, 'utf8'));
    const variantNames = exportedNames(readFileSync(pair.variant, 'utf8'));

    const allowed = new Set(ALLOWED_MISSING[rel(pair.variant)]?.names ?? []);

    const missingFromVariant = [...baseNames]
      .filter((n) => !variantNames.has(n) && !allowed.has(n))
      .sort();
    const missingFromBase = [...variantNames].filter((n) => !baseNames.has(n)).sort();

    expect(
      missingFromVariant,
      `${rel(pair.variant)} is missing exports that ${rel(pair.base)} has — ` +
        `they will be undefined at runtime on that platform`,
    ).toEqual([]);

    expect(
      missingFromBase,
      `${rel(pair.base)} is missing exports that ${rel(pair.variant)} has`,
    ).toEqual([]);
  });
});
