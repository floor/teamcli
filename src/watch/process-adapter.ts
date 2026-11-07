// The process adapter beside the watch core. Every platform-specific word, file and command
// lives here; the neutral core (`watchStopRead`'s working-folder source in `pane.ts`) names the
// facts by role and none of these systems. The adapter answers only these facts — the working
// folder of the process at a pid, the CPU time charged to it, the name the system holds for it, the instant it started, and
// the table of every process the caller can see — read the way this machine keeps them, and
// reads nothing else of the process: never its arguments and never its environment.
//
// Linux keeps the folder as a link in `/proc`. Every other system is asked through `lsof`, whose
// `-Fn` output names the folder on its `n` line — measured here, `lsof -a -d cwd -p <pid> -Fn`
// printed `p<pid>`, `fcwd`, then one line naming the folder, `n<path>`. The same query takes many
// pids at once, which is how the orphan reading asks about every process it may name.
//
// The table is the time column's query widened and scoped to this user: `ps -U <uid>
// -o pid=,comm=,lstart=`. Its shapes are measured in the parser's own comment; a row the query did
// not print whole is skipped.
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

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { syncChildTimeout } from '../child.ts';

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
      timeout: syncChildTimeout(2_000),
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

// The folder read for many pids at once: the one query takes the whole pid list — measured here
// on 2026-11-04, `lsof -a -d cwd -p <55 comma-joined pids> -Fn` printed 55 `p<pid>`/`fcwd`/`n<path>`
// blocks in 57 ms, where one query per pid cost 63 ms each. A pid the query could not answer
// stays null in the map: dead, or its folder cannot be read. The query answers exit status 1 when
// one requested pid is already gone while still printing the blocks for the rest (measured: one
// live and one dead pid printed the live block, empty stderr, status 1), so the output is read
// whatever the status; only a query that could not start at all is null.
export function processFoldersOf(pids: readonly number[]): Map<number, string | null> | null {
  const folders = new Map<number, string | null>();
  for (const pid of pids) folders.set(pid, null);
  if (pids.length === 0) return folders;
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        folders.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        /* stays null: gone, or the folder cannot be read */
      }
    }
    return folders;
  }
  const result = spawnSync('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fn'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) return null;
  let at: number | null = null;
  for (const line of (result.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      at = Number.isInteger(pid) && folders.has(pid) ? pid : null;
      continue;
    }
    if (line.startsWith('n') && at !== null && line.length > 1) folders.set(at, line.slice(1));
  }
  return folders;
}

/** One row of the process table: the pid, the name the system holds for the process (a full path
 *  where the system keeps one, a short name where it does not), and the instant it started. */
export type ProcessEntry = { pid: number; comm: string; startedAtMs: number };

/** The table's own line, as the query prints it: the pid, the name, then the start instant last.
 *  The name may hold spaces (a display name) or be a full path; the instant is
 *  `Day Mon DD hh:mm:ss YYYY`, whose tokens anchor the tail, so a name that merely looks like a
 *  date cannot steal it. Measured here on 2026-11-04, `ps -axo pid=,comm=,lstart=` printed
 *  `  12446 codex           Wed Nov  4 13:47:44 2026    ` and
 *  `  28734 Grok Bot        Mon Nov  2 05:06:41 2026    ` — 1270 lines in 98 ms. A line that does
 *  not read whole is skipped, never guessed: the reading is only ever used to name processes a
 *  person may then stop, so a half-read row is no row. */
const TABLE_LINE = /^\s*(\d+)\s+(.*?)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/;

/** Reads the query's text into rows. Exported for its own scene: the shapes are fixed by the
 *  query, so the parser needs no process behind it. */
export function parseProcessTable(text: string): ProcessEntry[] {
  const rows: ProcessEntry[] = [];
  for (const line of text.split('\n')) {
    const match = TABLE_LINE.exec(line);
    if (match === null) continue;
    const startedAtMs = Date.parse(match[3]!);
    if (!Number.isFinite(startedAtMs)) continue;
    rows.push({ pid: Number(match[1]), comm: match[2]!, startedAtMs });
  }
  return rows;
}

/** Every process this user runs, or null when the table cannot be read — or when the system
 *  cannot say who this user is. The read is scoped to this user on purpose: the orphan reading
 *  names processes a person may then stop, and it must never name or probe a process another user
 *  owns. Measured here on 2026-11-04, `ps -axo pid=,comm=,lstart=` printed 1283 rows including
 *  uid 0's `/sbin/launchd`, while `ps -U 501 -o pid=,comm=,lstart=` printed 1060 rows starting at
 *  pid 643 — this user's own, in the same line shape the parser reads. */
export const processTable = (): ProcessEntry[] | null => {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  try {
    const text = execFileSync('ps', ['-U', String(uid), '-o', 'pid=,comm=,lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseProcessTable(text);
  } catch {
    return null;
  }
};

/** The name the system holds for the process at `pid`, or null when it is gone or cannot be read. */
export const processCommOf = (pid: number): string | null => {
  try {
    const line = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return line === '' ? null : line;
  } catch {
    return null;
  }
};

/** The instant the process at `pid` started, in epoch milliseconds, or null when it is gone or
 *  its start line does not read. Measured on this machine: `ps -o lstart= -p <pid>` prints
 *  `Tue Oct 20 05:19:15 2026` (one-second resolution, local time), which `Date.parse` reads as
 *  that instant. */
export const processStartOf = (pid: number): number | null => {
  try {
    const line = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const at = Date.parse(line);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
};
