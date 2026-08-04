/**
 * `lib/welcome-content.ts` places real, keepable content — not seed data — into
 * a brand-new library. `runWelcomeSeed` itself is out of scope here: it needs
 * expo-sqlite and there is no node harness for that in this suite (see
 * `dev-seed.test.ts` for the same call). What's covered instead is the content
 * it writes, because every guarantee the module's own doc comment claims is
 * really a property of these strings and builders:
 *
 *  - every id constant carries `WELCOME_PREFIX`, and they are pairwise
 *    distinct — `db.pluginTypesInUse()` excludes the prefix specifically so
 *    the sample sheet/resume don't switch their own plugins on, and stable
 *    ids are what let two devices that both seed converge on one copy;
 *  - the guide covers the two things it promises to (the press-and-hold/
 *    right-click gesture on the create button, and Settings → Plugins),
 *    checked against the *rendered* text via `htmlToPlainText` rather than
 *    against the markup;
 *  - the guide's body is well-formed rich-text HTML — every `p`/`h2`/`ul`/`li`
 *    it opens, it closes, in the right order — since it's stored as the app's
 *    canonical body format and rendered directly, with no HTML sanitizer in
 *    front of it;
 *  - the sample sheet parses and its `=SUM(D5:D6)` total evaluates correctly,
 *    and it actually contains the "Settings → Plugins → Sheets" instructions
 *    it claims to;
 *  - the sample resume leads with LaTeX comments (so they read on screen but
 *    never compile into the PDF) and still contains the ordinary
 *    `STARTER_RESUME` underneath them, so the sample is a real resume and not
 *    just a how-to.
 *
 * This file exercises exports that don't exist on `welcome-content.ts` yet —
 * `GUIDE_BODY`, `welcomeSheet`, `WELCOME_RESUME_SOURCE` — because the module
 * currently keeps them private. Product code is out of scope for this agent;
 * see the task report for exactly what to add.
 */
import { describe, expect, it } from 'vitest';

import { cellKey } from '@/lib/finance/formula';
import { evaluateSheet, getCell, parseSheet } from '@/lib/finance/sheet';
import { htmlToPlainText } from '@/lib/html-text';
import { STARTER_RESUME } from '@/lib/resume-note';
import {
  GUIDE_BODY,
  WELCOME_FOLDER_ID,
  WELCOME_NOTE_ID,
  WELCOME_PREFIX,
  WELCOME_RESUME_ID,
  WELCOME_RESUME_SOURCE,
  WELCOME_SHEET_ID,
  welcomeSheet,
} from '@/lib/welcome-content';

describe('the prefix contract', () => {
  const ids = [WELCOME_NOTE_ID, WELCOME_FOLDER_ID, WELCOME_SHEET_ID, WELCOME_RESUME_ID];

  it('gives every id constant the WELCOME_PREFIX', () => {
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id.startsWith(WELCOME_PREFIX)).toBe(true);
    }
  });

  it('keeps every id distinct', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the guide', () => {
  const rendered = htmlToPlainText(GUIDE_BODY);

  it('mentions the press-and-hold / right-click gesture on the create button', () => {
    expect(rendered).toMatch(/press and hold/i);
    expect(rendered).toMatch(/right-click/i);
  });

  it('points at Settings → Plugins', () => {
    expect(rendered).toMatch(/Settings\s*→\s*Plugins/);
  });

  it('is well-formed rich-text HTML: every p/h2/ul/li it opens, it closes, in order', () => {
    const tags = GUIDE_BODY.match(/<\/?(p|h2|ul|li)>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    const stack: string[] = [];
    for (const tag of tags) {
      const closing = tag.startsWith('</');
      const name = tag.replace(/[</>]/g, '');
      if (closing) {
        expect(stack.pop()).toBe(name);
      } else {
        stack.push(name);
      }
    }
    expect(stack).toEqual([]);
  });
});

describe('the sample sheet', () => {
  const sheet = parseSheet(welcomeSheet());

  it('parses back with the "Settings → Plugins → Sheets" instruction cell intact', () => {
    const found = [];
    for (let row = 0; row < sheet.rows; row++) {
      for (let col = 0; col < sheet.cols; col++) {
        const raw = getCell(sheet, row, col)?.raw;
        if (raw) found.push(raw);
      }
    }
    expect(found.some((raw) => raw.includes('Settings → Plugins → Sheets'))).toBe(true);
  });

  it('evaluates the =SUM(D5:D6) total to the correct number', () => {
    const computed = evaluateSheet(sheet);
    // Coffee: qty 2 × 4.50 = 9; Beans: qty 1 × 12 = 12; total row sums the two
    // product cells (0-based row 6, col 3 — D7 in A1, summing D5:D6).
    expect(computed.get(cellKey(6, 3))).toBe(21);
  });
});

describe('the sample resume', () => {
  it('leads with LaTeX comment lines explaining how to enable Resumes', () => {
    const firstNonBlank = WELCOME_RESUME_SOURCE.trimStart().split('\n')[0];
    expect(firstNonBlank.startsWith('%')).toBe(true);
    expect(WELCOME_RESUME_SOURCE).toMatch(/Settings.*Plugins.*Resumes/s);
  });

  it('still contains the starter document underneath the comments', () => {
    expect(WELCOME_RESUME_SOURCE).toContain(STARTER_RESUME);
  });

  it('keeps the comment header out of the starter document itself', () => {
    // Guards against a future edit collapsing the two into one blob where the
    // "still contains STARTER_RESUME" check above would pass by accident (e.g.
    // if STARTER_RESUME itself started including commentary).
    expect(STARTER_RESUME.trimStart().startsWith('%')).toBe(false);
  });
});
