/**
 * Nothing may write `fontStyle: 'italic'` directly — it must come from the
 * `Italic` style in `constants/theme.ts`.
 *
 * On Android `fontStyle` only asks for the italic *face of the family the text
 * inherits*, and React Native never fakes one on the span path: `CustomStyleSpan`
 * hands the request to `Typeface.create(base, weight, italic)` and draws
 * whatever comes back. No component in this app sets a `fontFamily`, so text
 * inherits the device default, and plenty of Android defaults ship no italic
 * face — Samsung's One UI font among them. The result is text that renders
 * upright with no error, no warning, and a toolbar button that lights up as if
 * it worked. It shipped that way in the finance grid and was only caught on a
 * real device.
 *
 * `Italic` pins the family to `sans-serif` on Android so the lookup lands on
 * Roboto, which has the face. This test exists because the failure is invisible
 * to every other check: it typechecks, it lints, it renders correctly on web,
 * and it renders correctly on a Pixel.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../..', import.meta.url));

/** Where `Italic` is defined, and so the one place the raw property belongs. */
const DEFINITION = join('constants', 'theme.ts');

const RAW_ITALIC = /fontStyle\s*:\s*['"]italic['"]/;

/** Every `.ts`/`.tsx` file under `src`, excluding tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') sourceFiles(p, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe('italic styling', () => {
  it('is only declared in the theme', () => {
    const offenders = sourceFiles(SRC)
      .map((p) => relative(SRC, p))
      .filter((rel) => rel !== DEFINITION)
      .filter((rel) => RAW_ITALIC.test(readFileSync(join(SRC, rel), 'utf8')));

    expect(
      offenders,
      `Use \`Italic\` from '@/constants/theme' instead of a raw fontStyle — ` +
        `a bare 'italic' silently does nothing on Android devices whose default ` +
        `font has no italic face.`,
    ).toEqual([]);
  });

  it('pins a font family on Android, where the default one may have no italic face', async () => {
    const source = readFileSync(join(SRC, DEFINITION), 'utf8');
    // Read as text rather than importing: `Platform.select` resolves once, at
    // load, for whichever platform the test runner reports — so importing can
    // only ever see one of the two branches, and never the Android one.
    const android = source.slice(source.indexOf('export const Italic'));
    expect(android).toMatch(/android:\s*\{[^}]*fontFamily:\s*'sans-serif'/);
  });
});
