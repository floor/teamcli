// The take's pure half: which records this seat may take, and in what order. Both the command
// (`team next`, `team plan`) and the daemon's next handler ask these same functions, so the two
// readers of one source cannot drift. Nothing here reads a file, claims a lease or prints.
import type { TaskRecord } from './adapter.ts';

/** The records a claim would consider for this seat — `team plan` shows what this returns. */
export function takeable(records: readonly TaskRecord[], seat: string, pull: 'self' | 'any', mine: boolean): TaskRecord[] {
  return records.filter((record) => {
    if (record.blockedBy && record.blockedBy.length) return false;
    if (record.repos && record.repos.length) return false;
    if (record.needs && record.needs.length) return false;
    if (mine) return record.assignee === seat;
    if (pull === 'self') return record.assignee === undefined || record.assignee === seat;
    return true;
  });
}

/** The claim order both commands show: priority first, then `fallback`. */
export function order(records: readonly TaskRecord[], fallback: 'file' | 'id'): TaskRecord[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const left = rank(a.record);
      const right = rank(b.record);
      if (left.kind !== right.kind) return left.kind - right.kind;
      if (left.kind === 0 && right.kind === 0 && left.n !== right.n) return left.n - right.n;
      if (left.kind === 1 && right.kind === 1 && left.text !== right.text) return left.text.localeCompare(right.text);
      if (left.kind === 2 && fallback === 'id' && a.record.id !== b.record.id) return a.record.id < b.record.id ? -1 : 1;
      return a.index - b.index;
    })
    .map((item) => item.record);
}

function rank(record: TaskRecord): { kind: 0; n: number } | { kind: 1; text: string } | { kind: 2 } {
  if (typeof record.priority === 'number' && Number.isFinite(record.priority)) return { kind: 0, n: record.priority };
  if (typeof record.priority === 'string') return { kind: 1, text: record.priority };
  return { kind: 2 };
}
