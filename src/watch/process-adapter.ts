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
// A test hands the core a fake adapter through this same interface; a scene never runs these
// commands.

import { execFileSync } from 'node:child_process';
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

/** The CPU-time fact: milliseconds this machine has charged the process at `pid`, or null when
 *  the process is gone or its time cannot be read. A caller judges a worker by whether this
 *  number rose between two readings; the probe itself carries no policy. */
export type ProcessCpuTimeReader = (pid: number) => number | null;

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

export const processCpuTimeOf: ProcessCpuTimeReader = (pid) => {
  try {
    const text = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseCpuTime(text);
  } catch {
    return null;
  }
};
