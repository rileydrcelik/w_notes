// Stop: if files this session edited (see track-edits.mjs) still have
// uncommitted changes, block the stop once and have Claude commit them.
// Commit only — pushing stays a separate, explicit request, because a push
// runs the pre-push APK build.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

// Second stop in a row: Claude already saw the reminder and chose to stop
// (unfinished work, a question for the user). Don't loop.
if (input?.stop_hook_active) process.exit(0);

const session = String(input?.session_id ?? '').replace(/[^\w-]/g, '');
const list = join(tmpdir(), 'claude-autocommit', `${session}.txt`);
if (!session || !existsSync(list)) process.exit(0);

const isDirty = (file) => {
  try {
    const out = execFileSync('git', ['-C', dirname(file), 'status', '--porcelain', '--', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    // Not inside a git repo (memory dir, scratchpad) or the dir is gone.
    return false;
  }
};

const files = readFileSync(list, 'utf8').split('\n').filter(Boolean);
const dirty = files.filter(isDirty);
writeFileSync(list, dirty.map((f) => `${f}\n`).join(''));
if (dirty.length === 0) process.exit(0);

const reason = [
  'Auto-commit: files you edited this session are not committed yet:',
  ...dirty.map((f) => `  - ${f}`),
  '',
  'If the task is finished, commit them now on the current branch: stage exactly',
  'these paths (never `git add -A` / `git add .` — the tree carries unrelated work),',
  "write a message in the repo's style, and end it with the Co-Authored-By trailer.",
  'Do NOT push. If the work is unfinished or broken, or you stopped to ask the user',
  'something, do not commit — just end your turn.',
].join('\n');

process.stdout.write(JSON.stringify({ decision: 'block', reason }));
