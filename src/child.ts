// One child process, awaited and bounded: the process side of every async read in the watch.
// Each read gets a deadline of its own (the per-call limit, shortened by the pass's remaining
// budget) and the loop's stop signal, so a read can never outlive the pass it was taken for.
//
// Measured in this worktree (Bun 1.4.2, a scratch probe): `execFile` applies `killSignal` both
// when `timeout` fires and when `signal` aborts; the abort rejects with `code: 'ABORT_ERR'`, the
// timeout with `killed: true` and `signal: 'SIGKILL'`, and a child that traps SIGTERM is gone
// after either. A plain non-zero exit reports `code: <status>` and `killed: false`, which is how
// a refusal is told apart from a kill.
import { execFile } from 'node:child_process';

/** What one awaited child takes: its own kill after `timeoutMs`, the loop's stop, and the
 *  environment it runs in (a check command gets PATH and HOME and nothing else). */
export type ChildOptions = { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv };

/** The timeout a read gets when its caller names none: the terminal host's own, as before. */
export const DEFAULT_CHILD_TIMEOUT_MS = 10_000;

/** One child, its stdout, or a rejection. Killed with SIGKILL at its deadline or at the stop. */
export function execText(file: string, args: readonly string[], options: ChildOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.env === undefined ? {} : { env: options.env }),
    }, (error, stdout) => (error === null ? resolve(stdout) : reject(error)));
  });
}

/** A child whose deadline fired: killed with the signal above, whatever it traps. */
export function wasKilled(error: unknown): boolean {
  return (error as { killed?: unknown } | null)?.killed === true;
}

/** A child the loop's stop aborted. It is not a refusal, and a read is never retried past it. */
export function wasAborted(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ABORT_ERR';
}

/** The timeout a synchronous child gets: `defaultMs`, or `TEAM_SYNC_CHILD_TIMEOUT_MS` when a
 *  sleeping-stub test narrows the ceiling so the scene finishes in milliseconds. */
export function syncChildTimeout(defaultMs: number): number {
  const raw = process.env.TEAM_SYNC_CHILD_TIMEOUT_MS;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return defaultMs;
}
