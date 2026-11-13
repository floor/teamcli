// The process a closed pane's orphans are handed to. When a pane's shell exits, the processes in
// front of it that ignore the hangup are reparented: to pid 1, or — where a service manager runs
// the user's processes — to that manager, which marks itself the reaper of every process it
// starts. `workspaceClose` ends only a process it read in front of the closed pane, and only
// once it has been handed to one of those reapers (src/herdr.ts `endOrphans`).
//
// The manager is never found by its name or by a pattern. The daemon records it once, at its own
// start: when the system's service manager started the daemon, its parent is that manager, and
// the manager states its own pid to every process it starts. The record holds the pid and the
// process's start, so a later reader trusts it only while that same process still runs: a pid
// the system has since handed to another process is not a reaper. Only the Linux adapter records
// one; on every other platform an orphan goes to pid 1 and the list below is empty.
//
// The record is read here from the state file with no other module of the daemon: this file is
// imported by the terminal host's adapter, and the daemon's state module reaches that adapter
// through its own imports, so it is never imported from here.
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { daemonStatePath } from './daemon/paths.ts';

/** The reaper the daemon recorded at its start: the manager's pid, and that process's start as
 *  the system's own process table spells it. */
export type ReaperRecord = { pid: number; start: number };

/**
 * A process's start on Linux: field 22 of `/proc/<pid>/stat`, the clock ticks since boot. The
 * name in parentheses can hold spaces and parentheses, so the fields are counted after the last
 * of them. Null when the process is gone or the line does not read. `proc` is a parameter so a
 * test can read a captured table.
 */
export function linuxProcessStart(pid: number, proc = '/proc'): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let text: string;
  try {
    text = readFileSync(`${proc}/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  // After the name: field 3 (the state) is index 0, so field 22 is index 19.
  const field = text.slice(close + 1).trim().split(/\s+/)[19];
  if (field === undefined || !/^[0-9]+$/.test(field)) return null;
  const start = Number(field);
  return Number.isSafeInteger(start) ? start : null;
}

/**
 * The reaper the daemon records at its start, or null. Only on Linux, only when the system's
 * service manager started the daemon (`--started-by service-manager`), and only when the
 * manager's own word for its pid (`managerPid`) names the daemon's parent: a daemon started from
 * a shell, or under any other parent, records none.
 */
export function serviceReaperAtStart(input: {
  platform: NodeJS.Platform;
  startedBy: string;
  ppid: number;
  managerPid: string | undefined;
  startOf: (pid: number) => number | null;
}): ReaperRecord | null {
  if (input.platform !== 'linux' || input.startedBy !== 'service-manager') return null;
  if (!Number.isInteger(input.ppid) || input.ppid <= 1) return null;
  if (input.managerPid === undefined || input.managerPid !== String(input.ppid)) return null;
  const start = input.startOf(input.ppid);
  return start === null ? null : { pid: input.ppid, start };
}

/** The daemon's own reaper record, read at its start from this process's parent and the
 *  environment the service manager gave it. Never printed: only the manager's pid is read. */
export function daemonReaperAtStart(startedBy: string): ReaperRecord | null {
  return serviceReaperAtStart({
    platform: process.platform,
    startedBy,
    ppid: process.ppid,
    managerPid: process.env.MANAGERPID,
    startOf: (pid) => linuxProcessStart(pid),
  });
}

/**
 * The pids, besides pid 1, an orphan of this machine may have been handed to: the reaper the
 * daemon recorded, while the process at that pid is still the one recorded. Empty on every
 * other platform, and whenever there is no record or it is stale.
 */
export function recordedReapers(input: {
  platform: NodeJS.Platform;
  reaper: ReaperRecord | null | undefined;
  startOf: (pid: number) => number | null;
}): number[] {
  if (input.platform !== 'linux') return [];
  const reaper = input.reaper;
  if (reaper === null || reaper === undefined || reaper.pid <= 1) return [];
  return input.startOf(reaper.pid) === reaper.start ? [reaper.pid] : [];
}

/** A reaper as a state record holds it, or undefined when the field is absent or malformed: a
 *  malformed one is left out, so an orphan is then ended only once pid 1 holds it. */
export function reaperRecordOf(raw: unknown): ReaperRecord | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { pid, start } = raw as Record<string, unknown>;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return undefined;
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) return undefined;
  return { pid, start };
}

/** The reaper field of the daemon's state record, read as the state module reads the record: no
 *  link followed, a regular file of at most 64 KiB. Undefined when there is none to read. */
function recordedReaper(home: string): ReaperRecord | undefined {
  let fd: number;
  try {
    fd = openSync(daemonStatePath(home), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const held = fstatSync(fd);
    if (!held.isFile() || held.size > 64 * 1024) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return reaperRecordOf((parsed as Record<string, unknown>).reaper);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The reapers on this machine, read from the daemon's state record. Never throws. */
export function orphanReapers(home: string = homedir()): number[] {
  if (process.platform !== 'linux') return [];
  return recordedReapers({
    platform: process.platform,
    reaper: recordedReaper(home),
    startOf: (pid) => linuxProcessStart(pid),
  });
}
