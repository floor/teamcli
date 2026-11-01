// The process adapter beside the watch core. Every platform-specific word, file and command
// lives here; the neutral core (`watchStopRead`'s working-folder source in `pane.ts`) names the
// fact by role and none of these systems. The adapter answers one fact — the working folder of
// the process at a pid — read the way this machine keeps it, and reads nothing else of the
// process: never its arguments and never its environment.
//
// Linux keeps the folder as a link in `/proc`. Every other system is asked through `lsof`, whose
// `-Fn` output names the folder on its `n` line — measured here, `lsof -a -d cwd -p <pid> -Fn`
// printed `p<pid>`, `fcwd`, then one line naming the folder, `n<path>`.
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
