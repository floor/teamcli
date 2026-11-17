// The sessions a machine restart took down, brought back by the first daemon after the restart.
//
// The terminal host resumes only the sessions the owner attaches, so after a restart every other
// team's session stays stopped until he opens it: its seats get no restore and no mail. The
// daemon keeps a small record of which sessions run (`sessions-running.json`, rewritten every
// minute). The first daemon after a restart finds that record older than the machine's boot:
// it names exactly the sessions that ran when the machine went down. Those, and only those, that
// now read stopped are started again, detached, one at a time, each only while the load reads
// under the guard. A session the owner had stopped before the restart is not in the record and
// stays stopped; a daemon restarted later in the same boot finds a record newer than the boot and
// starts nothing.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { renameSync, writeFileSync } from '../../host/guarded-fs.ts';
import { machineConfigDir } from '../paths.ts';

export const SESSIONS_RUNNING_FILE = 'sessions-running.json';

/** The record: when it was written, and the sessions the terminal host listed as running. */
export type SessionsRunning = { at: number; running: string[] };

export function sessionsRunningPath(home: string): string {
  return join(machineConfigDir(home), SESSIONS_RUNNING_FILE);
}

/** The record, or null when it is absent or not one this version wrote. */
export function readSessionsRunning(home: string): SessionsRunning | null {
  let text: string;
  try {
    text = readFileSync(sessionsRunningPath(home), 'utf8');
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const { at, running } = value as { at?: unknown; running?: unknown };
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    if (!Array.isArray(running) || !running.every((name) => typeof name === 'string' && name !== '')) return null;
    return { at, running: [...new Set(running as string[])].sort() };
  } catch {
    return null;
  }
}

/** Writes the record whole (temp file, then rename). False when it could not be written. */
export function writeSessionsRunning(home: string, running: readonly string[], at: number): boolean {
  const path = sessionsRunningPath(home);
  const temp = `${path}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ at, running: [...new Set(running)].sort() })}\n`, { mode: 0o600 });
    renameSync(temp, path);
    return true;
  } catch {
    return false;
  }
}

/** The machine's boot time in ms, or null when it cannot be read. macOS and BSD name it in
 *  `kern.boottime` (`{ sec = N, usec = M } …`); elsewhere null, and nothing is started. */
export function bootTimeMs(read: () => string = () => execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 2_000 })): number | null {
  let text: string;
  try {
    text = read();
  } catch {
    return null;
  }
  const match = /sec\s*=\s*(\d+)/.exec(text);
  if (match === null) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : null;
}

/** The sessions to start again: those the record names, only when the record was written before
 *  this boot. Empty when either reading is missing, or the record is from this boot. */
export function bootSessionsToStart(record: SessionsRunning | null, bootMs: number | null): string[] {
  if (record === null || bootMs === null) return [];
  if (record.at >= bootMs) return [];
  return record.running;
}

/** The load per core now, as the launch gate reads it. */
export function loadPerCore(): number {
  const cores = Math.max(1, cpus().length);
  return (loadavg()[0] ?? 0) / cores;
}
