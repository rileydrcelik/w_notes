// PostToolUse (Write|Edit|NotebookEdit): remember every file this session
// edits, so the Stop hook can ask for a commit of exactly those paths — the
// working tree usually carries unrelated in-progress work that must not be
// swept into the commit.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const file = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
const session = String(input?.session_id ?? '').replace(/[^\w-]/g, '');
if (!file || !session) process.exit(0);

const dir = join(tmpdir(), 'claude-autocommit');
const list = join(dir, `${session}.txt`);
mkdirSync(dir, { recursive: true });

const seen = existsSync(list) ? readFileSync(list, 'utf8').split('\n') : [];
if (!seen.includes(file)) appendFileSync(list, `${file}\n`);
