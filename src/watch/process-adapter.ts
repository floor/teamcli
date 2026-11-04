// The process adapter beside the watch core. Every platform-specific word, file and command
// lives here; the neutral core (`watchStopRead`'s working-folder source in `pane.ts`) names the
// facts by role and none of these systems. The adapter answers two facts: the working folder of
// the process at a pid, and the CPU time the machine has charged it. It reads nothing else of the
// process: never its arguments and never its environment.
//
// Linux keeps the folder as a link in `/proc`. Every other system is asked through `lsof`, whose
// `-Fn` output names the folder on its `n` line — measured here, `lsof -a -d cwd -p <pid> -Fn`
// printed `p<pid>`, `fcwd`, then one line naming the folder, `n<path>`.
//
// CPU time comes from the process table's time column, asked for the pid alone: `ps -o time=
// -p <pid>` printed `  0:00.01` for a process a moment old and ` 53:45.87` for one an hour in,
// on this machine. The column is `[[days-]hours:]minutes:seconds`, with an optional fraction of
// a second.
//
// The CPU fact is asked asynchronously: the query starts a process of its own, and a daemon that
// waited for it on its loop would let one slow query hold everything it serves. The probe is
// bounded — a query that has not answered inside its timeout is killed — and the caller hears
// null, which is no evidence either way rather than a reading.
//
// A test hands the core a fake adapter through this same interface; a scene never runs these
// commands.

import { execFile, execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';

/** The one fact this adapter answers: the working folder of the process at `pid`, or null when
 *  the process is gone or the folder cannot be read. */
export type WorkingFolderReader = (pid: number) => string | null;

export const processWorkingFolderOf: WorkingFolderReader = (pid) => {
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  try {
    const line = execFileSync('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const entry of line.split('\n')) {
      if (entry.startsWith('n') && entry.length > 1) return entry.slice(1);
    }
    return null;
  } catch {
    return null;
  }
};

/** One answer to the CPU-time question, or the promise of one. The daemon's probe starts a
 *  process, so it answers later; a scene may answer on the caller's stack. */
export type ProcessCpuTimeReading = number | null | Promise<number | null>;

/** How the CPU-time fact is asked by a caller that must not hold its own loop for it. */
export type ProcessCpuTimeProbe = (pid: number) => ProcessCpuTimeReading;

/** Whether a reading will arrive later. A probe is the only such reader, so the caller decides
 *  once whether to wait for it or to judge on the spot. */
export function isAsyncCpuReading(value: ProcessCpuTimeReading): value is Promise<number | null> {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}

/** How long the probe waits for the process table before it gives up: long enough for a loaded
 *  machine's answer, short enough to arrive inside one daemon beat. Measured on this machine,
 *  `execFile('/bin/sleep', ['5'], { timeout: 300, killSignal: 'SIGKILL' })` answered its callback
 *  after 319 ms with `signal: 'SIGKILL'`, `killed: true` and no exit code: a query that outlives
 *  the timeout is killed and reads as no reading. */
export const CPU_PROBE_TIMEOUT_MS = 2_000;

/** Reads one time-column value as milliseconds. Exported for its own scene: the shapes are fixed
 *  by the query, so the parser needs no process behind it. */
export function parseCpuTime(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const dash = trimmed.indexOf('-');
  const dayText = dash === -1 ? null : trimmed.slice(0, dash);
  const rest = dash === -1 ? trimmed : trimmed.slice(dash + 1);
  if (dayText !== null && !/^\d+$/.test(dayText)) return null;
  const parts = rest.split(':');
  if (parts.length > 3) return null;
  const secondText = parts[parts.length - 1]!;
  if (!/^\d+(?:\.\d+)?$/.test(secondText)) return null;
  for (const part of parts.slice(0, -1)) {
    if (!/^\d+$/.test(part)) return null;
  }
  const days = dayText === null ? 0 : Number(dayText);
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  const minutes = parts.length >= 2 ? Number(parts[parts.length - 2]) : 0;
  const seconds = Number(secondText);
  return ((days * 24 + hours) * 60 + minutes) * 60_000 + Math.round(seconds * 1000);
}

export const processCpuTimeAsync: ProcessCpuTimeProbe = (pid) =>
  new Promise((resolve) => {
    try {
      execFile(
        'ps',
        ['-o', 'time=', '-p', String(pid)],
        { encoding: 'utf8', timeout: CPU_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' },
        (error, stdout) => {
          resolve(error === null ? parseCpuTime(stdout) : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
