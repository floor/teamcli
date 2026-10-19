// The local task queue: the source a team reads when its file declares none, and the one file
// `team queue add` writes. It is a YAML list in the checkout, read by the file adapter — the
// same records, the same refusals, the same id rule — so `team next` treats a local queue and a
// declared file identically. A team that declares a file source is written at its own path; a
// team that declares a broker source has no local queue at all, and this module is never asked
// to write one.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { taskPathStaysInside } from '../file/sections/tasks.ts';
import type { TeamFile } from '../file/types.ts';
import { withLock } from '../state.ts';
import type { TaskRead, TaskRecord } from './adapter.ts';
import { fileAdapter } from './file.ts';

/** Where the local queue lives when the team file declares no task source. Relative to the
 *  team root, so it travels with the checkout. */
export const LOCAL_QUEUE = '.agents/queue.yaml';

/** The tasks value `team next` and its listing commands read for a team with no task source:
 *  the local queue as a file source, with the file source's defaults. Typed as the team file's
 *  own tasks union so a command that falls back to it reads `pull`, `fallback` and `cadence`
 *  exactly as it reads a declared section's. */
export const LOCAL_TASKS: NonNullable<TeamFile['tasks']> = { source: 'file', path: LOCAL_QUEUE };

/** The file source one command reads: the owner's declared path, or the local queue when the
 *  team file declares no tasks section. Null only when a tracker is declared. */
export type FileSource = { path: string; local: boolean };

/** The file source for this team, or null when a broker source is declared. */
export function fileSourceOf(team: TeamFile): FileSource | null {
  if (!team.tasks) return { path: LOCAL_QUEUE, local: true };
  if (team.tasks.source === 'linear') return null;
  return { path: team.tasks.path, local: false };
}

/** The file adapter's read of a resolved source, with the fallback's one difference: a local
 *  queue that is not there yet is an empty list, not a missing source. A declared file that is
 *  missing keeps `missing`, and its own command's refusal. */
export function readFileSource(root: string, source: FileSource): TaskRead {
  const read = fileAdapter.read({ root, path: source.path });
  if (source.local && read.kind === 'missing') return { kind: 'records', records: [], refusals: [] };
  return read;
}

/** The file adapter's id rule (`src/tasks/file.ts`), repeated here so a command can refuse a
 *  bad `--id` before a file is read. The adapter judges the same token again on the way in. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export function isTaskId(value: string): boolean {
  return TASK_ID.test(value);
}

export type QueueAddResult =
  | { kind: 'added'; record: TaskRecord; path: string; records: readonly TaskRecord[]; refusals: readonly { index: number; id?: string; reason: string }[] }
  | { kind: 'present'; record: TaskRecord; path: string; records: readonly TaskRecord[]; refusals: readonly { index: number; id?: string; reason: string }[] }
  | { kind: 'duplicate'; record: TaskRecord; path: string }
  | { kind: 'outside' }
  | { kind: 'missing' }
  | { kind: 'not-a-list' }
  | { kind: 'unreadable'; message: string };

/**
 * Add one record to the source under the state's lock. The add is a read, an append and a
 * validated replacement: the candidate text is written to a sibling temporary file, read back
 * through the file adapter, and only then renamed over the queue, so a file the adapter would
 * refuse is never installed. An id already present is not rewritten: the same record is
 * `present` and a different one is `duplicate`. A missing local queue is created; a missing
 * declared file is `missing`, and an unreadable or flow-sequence file is refused rather than
 * replaced.
 */
export function addToQueue(root: string, source: FileSource, record: TaskRecord): QueueAddResult {
  if (!taskPathStaysInside(source.path, root)) return { kind: 'outside' };
  return withLock(join(root, '.agents'), () => {
    const read = readFileSource(root, source);
    if (read.kind === 'outside') return { kind: 'outside' };
    if (read.kind === 'not-a-list') return { kind: 'not-a-list' };
    if (read.kind === 'missing') return { kind: 'missing' };
    const existing = read.records.find((item) => item.id === record.id);
    if (existing) {
      if (isDeepStrictEqual(existing, record)) {
        return { kind: 'present', record: existing, path: source.path, records: read.records, refusals: read.refusals };
      }
      return { kind: 'duplicate', record: existing, path: source.path };
    }
    const full = resolve(root, source.path);
    const text = candidateText(full, record);
    const temporary = `${full}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, text);
      const checked = fileAdapter.read({ root, path: relative(root, temporary) });
      const found = checked.kind === 'records' ? checked.records.find((item) => item.id === record.id) : undefined;
      if (checked.kind !== 'records' || found === undefined) {
        return { kind: 'unreadable', message: 'the added record did not read back as a task' };
      }
      renameSync(temporary, full);
      return { kind: 'added', record: found, path: source.path, records: checked.records, refusals: checked.refusals };
    } catch {
      return { kind: 'unreadable', message: 'the queue file could not be written' };
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // The rename took the temporary file; there is nothing to remove.
      }
    }
  });
}

/** The whole file after the add: the current text with one block item appended, and the empty
 *  flow list `[]` — the one flow spelling the adapter reads — replaced by the block form. Any
 *  other flow list is `not-a-list` on the read before this is called. */
function candidateText(full: string, record: TaskRecord): string {
  let current: string;
  try {
    current = readFileSync(full, 'utf8');
  } catch {
    current = '';
  }
  const trimmed = current.trim();
  const block = blockText(record);
  if (trimmed === '' || trimmed === '[]') return block;
  return `${current.endsWith('\n') ? current : `${current}\n`}${block}`;
}

/** One block item, byte for byte. Text is double-quoted with the parser's escapes; a numeric
 *  priority is written as a number, so `team next`'s numeric order reads it as one. */
function blockText(record: TaskRecord): string {
  const lines = [`- id: ${quoted(record.id)}`, `  title: ${quoted(record.title)}`];
  if (record.priority !== undefined) {
    lines.push(`  priority: ${typeof record.priority === 'number' && Number.isFinite(record.priority) ? String(record.priority) : quoted(String(record.priority))}`);
  }
  if (record.assignee !== undefined) lines.push(`  assignee: ${quoted(record.assignee)}`);
  return `${lines.join('\n')}\n`;
}

function quoted(text: string): string {
  const escaped = text.replace(/[\\"\x00-\x1f\x7f]/g, (char) => {
    if (char === '\\') return '\\\\';
    if (char === '"') return '\\"';
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
  return `"${escaped}"`;
}
