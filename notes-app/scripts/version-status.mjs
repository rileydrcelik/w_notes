// What version is actually live, versus what the repo claims.
//
// The version gate makes `expo.version` move whenever shipped code changes, but
// nothing makes the move *reach anyone*: web is a hand-run export + wrangler
// deploy, mobile is a hand-run `eas update`. So the repo can sit at 1.1.2 for a
// day with both surfaces still serving 1.1.0, and the only way anyone noticed
// was opening Settings on a phone and reading the number.
//
// A version in git is a claim that something shipped. This checks the claim.
//
// Read-only and best-effort: a network failure or a missing eas-cli reports
// "unknown" rather than failing, because this is a status command, not a gate.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const WEB_ORIGIN = 'https://w-notes.app';
const CHANNEL = 'production';

const repo = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo
  .version;

/** The version embedded in the manifest of the bundle the live site serves. */
async function webVersion() {
  const html = await fetch(WEB_ORIGIN, { redirect: 'follow' }).then((r) => r.text());
  const src = /\/_expo\/static\/js\/web\/entry-[a-f0-9]+\.js/.exec(html)?.[0];
  if (!src) return 'unknown (no entry bundle in index.html)';
  const js = await fetch(WEB_ORIGIN + src).then((r) => r.text());
  return /\\"version\\":\\"([0-9]+\.[0-9]+\.[0-9]+)\\"/.exec(js)?.[1] ?? 'unknown';
}

/** The newest update published to the channel, via eas-cli. */
function mobileVersion() {
  const raw = execFileSync(
    // `shell: true` because on Windows the executable is `npx.cmd`, and
    // execFileSync without a shell does not resolve PATHEXT — it just ENOENTs.
    'npx',
    // `--branch`, not `--channel`: update:list has no channel flag. The publish
    // lands on a branch of the same name, which is what the channel points at.
    ['--yes', 'eas-cli@latest', 'update:list', '--branch', CHANNEL, '--limit', '1', '--json',
     '--non-interactive'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true },
  );
  const group = JSON.parse(raw)?.currentPage?.[0];
  if (!group) return 'unknown (no updates on the channel)';
  // The message is what `update:prod` stamps; the runtime is the real boundary.
  // eas already quotes the message in its JSON, so don't add another pair.
  return `runtime ${group.runtimeVersion} — ${group.message ?? '(no message)'}`;
}

const settle = async (label, fn) => {
  try {
    return [label, await fn()];
  } catch (e) {
    return [label, `unknown (${e.message.split('\n')[0]})`];
  }
};

const rows = [
  ['repo (app.json)', repo],
  ...(await Promise.all([settle('web (live)', webVersion), settle('mobile (OTA)', mobileVersion)])),
];

const w = Math.max(...rows.map(([k]) => k.length));
for (const [k, v] of rows) console.log(`${k.padEnd(w)}  ${v}`);

const web = rows.find(([k]) => k.startsWith('web'))?.[1];
if (web && web !== repo && !web.startsWith('unknown')) {
  console.log(`\n! web is serving ${web}, repo says ${repo} — run \`npm run ship:web\`.`);
}
