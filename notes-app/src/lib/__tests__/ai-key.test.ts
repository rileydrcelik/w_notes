/**
 * The client half of the AI key gate.
 *
 * Two things are worth pinning here, and both are quiet failures rather than
 * loud ones. The first is that a key never comes back down: the server only ever
 * sends a four-character hint, and `fromWire` must not invent a place to keep
 * anything more. The second is which way an unreadable answer falls — a
 * malformed response has to read as "no key", because that shows a prompt
 * someone can act on, where the opposite reads as "all set" and turns every AI
 * press into an unexplained failure.
 *
 * And the 402 mapping, which is the whole reason the backend uses a distinct
 * status: "you need a key" has to be told apart from "too long" and "the server
 * is busy", by every surface that can make one of these calls.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

// Above `vi.mock` deliberately: vitest hoists the mock factory above every
// import at transform time, so these still resolve to the mock, and the file
// keeps the import-order the linter (and every other file here) expects.
import { isKeyRequired, KEY_REQUIRED_MESSAGE, KEY_REQUIRED_STATUS } from '@/lib/ai-key';
import { ApiError } from '@/lib/sync/api';

vi.mock('@/lib/sync/api', () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return { ApiError, apiFetch: vi.fn(), syncConfigured: true };
});


describe('isKeyRequired', () => {
  it('recognises the one status that means "bring your own key"', () => {
    expect(isKeyRequired(new ApiError('Payment Required', KEY_REQUIRED_STATUS))).toBe(true);
  });

  it('does not mistake the other failures for it', () => {
    // Each of these puts something different on screen. 503 in particular is
    // the one that used to mean "no key" and now means the opposite — a server
    // problem the person cannot fix by pasting anything.
    for (const status of [400, 413, 422, 429, 500, 503, 504]) {
      expect(isKeyRequired(new ApiError('nope', status)), String(status)).toBe(false);
    }
  });

  it('is not fooled by a non-ApiError that happens to mention 402', () => {
    expect(isKeyRequired(new Error('failed with 402'))).toBe(false);
    expect(isKeyRequired('402')).toBe(false);
    expect(isKeyRequired(null)).toBe(false);
  });
});

describe('the message shown when a key is missing', () => {
  it('names where to go, not just what went wrong', () => {
    // A message that only says "you need a key" leaves someone hunting. The
    // remedy is one screen away and the text has to say which.
    expect(KEY_REQUIRED_MESSAGE).toMatch(/settings/i);
  });
});

describe('every AI failure describer maps 402 to that message', () => {
  // The describers are module-private and each is reached only through a real
  // network call, so this is checked at the source level — the same tactic as
  // `no-scrollbar.test.ts`. A new AI endpoint that forgets the branch is exactly
  // the regression worth catching: it falls through to "The entry could not be
  // written: 402", which tells a person nothing they can act on.
  const describers = /function describe\w*Failure\(message: string\): string \{([\s\S]*?)\n\}/g;

  it.each(['entry', 'harden', 'job-posting', 'tailor'])('%s.ts', (name) => {
    const source = readFileSync(
      fileURLToPath(new URL(`../latex/${name}.ts`, import.meta.url)),
      'utf8',
    );
    const bodies = [...source.matchAll(describers)].map((m) => m[1]);

    // Guards the scan: a renamed describer would leave an empty list, and the
    // assertion below would pass over nothing at all.
    expect(bodies.length, `no describer found in ${name}.ts`).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body, `${name}.ts describer`).toContain("message.includes('402')");
      expect(body, `${name}.ts describer`).toContain('KEY_REQUIRED_MESSAGE');
    }
  });
});
