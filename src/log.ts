import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { appendStateFile, stateFileStat } from './file-write.ts';
import { dirname, join } from 'node:path';
import { plainLine } from './launch/plain.ts';
import { LOG_FILE } from './state.ts';

const MAX_BYTES = 1_000_000;
const KEPT = 3;
const reported = new Set<string>();

// One line per change: when, which command, called by whom, what changed. Classifications only,
// never the text of a screen.
//
// The line is cleaned here, at the one sink every command logs through, with the same function
// the records' fields are cleaned with (`plainLine`): every caller's or reason's escape
// sequence, bidi override or other invisible format character is removed before it can reach
// the file, so every line of every command's log is clean by construction, whoever calls and
// whatever the text it was given — the terminals and the log agree by construction.
// For ordinary text nothing changes: the cleaning removes or folds characters, it never rewrites
// an ordinary word. A line feed, U+2028/U+2029 and any whitespace run fold to one space, exactly
// as they do in a record's field, so the log stays one `0a`-terminated line per change and holds
// the same words the record said.
//
// The log rotates at 1 MB and keeps three files.
//
// The log is evidence, never a decision: a write that fails — a full disk, a path that is not a
// file, a permission the owner kept — is refused and reported once per path here. Commands
// keep their own result; the diagnostic makes missing evidence visible.
export function logLine(dir: string, command: string, caller: string, what: string, now: Date = new Date()): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, LOG_FILE);
    const root = dirname(dir);
    if ((stateFileStat(path, root)?.size ?? 0) >= MAX_BYTES) rotate(path, root);
    const line = plainLine(`${command} [${caller}] ${what}`).replace(/\s+/g, ' ');
    appendStateFile(path, `${now.toISOString()} ${line}\n`, root);
  } catch {
    const path = join(dir, LOG_FILE);
    if (!reported.has(path)) {
      reported.add(path);
      process.stderr.write('team log: write refused; check the state folder and log file\n');
    }
  }
}

function rotate(path: string, root: string): void {
  for (let n = 0; n < KEPT; n++) stateFileStat(n === 0 ? path : `${path}.${n}`, root);
  const oldest = `${path}.${KEPT - 1}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let n = KEPT - 2; n >= 1; n--) {
    if (existsSync(`${path}.${n}`)) renameSync(`${path}.${n}`, `${path}.${n + 1}`);
  }
  renameSync(path, `${path}.1`);
}
