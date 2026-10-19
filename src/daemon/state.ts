// The one machine daemon's state record (`<home>/.config/team/daemon.state.json`, mode 0600).
// The daemon writes it at start and refreshes `heartbeatAt` while it serves; `team status`,
// `team check` and the daemon's own health answer read it through this module.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pidAlive } from '../state.ts';
import type { HostedWatchState } from '../watch/hosted.ts';
import { daemonStatePath, machineConfigDir } from './paths.ts';

/** Which features the running build actually carries. `absent` means the handler is not built;
 *  it is not the policy value `off`. */
export type DaemonFeatures = { broker: 'on' | 'off' | 'absent' };

/** A request the daemon has been working on longer than its stuck threshold. */
export type DaemonStuckRequest = { id: string; op: string; since: string; ageMs: number };

/** One checkout this process hosts, recorded so a later `team daemon status` can tell a running
 *  daemon from a running daemon that silently hosts nothing for a checkout. */
export type DaemonRootState = {
  root: string;
  team: string | null;
  send: 'serving' | 'already-running' | 'failed';
  bus: 'serving' | 'failed';
  why: string | null;
  /**
   * The route's hosted watch, present only when the daemon was started to carry one. A reader
   * may treat a stopped or failed phase as a check failure only when this field exists and
   * says `required`; a route without it was never started to carry a watch.
   */
  watch?: HostedWatchState;
};

export type DaemonState = {
  format: 1;
  pid: number;
  uid: number;
  since: string;
  /** `service-manager`, `manual` or `team-up`: the kind of thing that started it, never the
   *  platform's own name for its service manager. */
  startedBy: string;
  version: string;
  heartbeatAt: string;
  socket: string;
  features: DaemonFeatures;
  stuck: DaemonStuckRequest[];
  roots: DaemonRootState[];
};

export type DaemonStateRead =
  | { kind: 'missing' }
  | { kind: 'unreadable'; why: string }
  | { kind: 'ok'; state: DaemonState };

/** The machine folder, created 0700 when a daemon writes its record. */
export function ensureMachineDir(home: string): string {
  const dir = machineConfigDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function readDaemonState(home: string): DaemonStateRead {
  const path = daemonStatePath(home);
  if (!existsSync(path)) return { kind: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { kind: 'unreadable', why: 'the daemon state record is not readable JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unreadable', why: 'the daemon state record is not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  const state = stateOf(record);
  if (state === null) return { kind: 'unreadable', why: 'the daemon state record is missing required fields' };
  return { kind: 'ok', state };
}

function stateOf(record: Record<string, unknown>): DaemonState | null {
  if (record.format !== 1) return null;
  if (!positiveInt(record.pid)) return null;
  if (typeof record.uid !== 'number' || !Number.isInteger(record.uid)) return null;
  for (const key of ['since', 'startedBy', 'version', 'heartbeatAt', 'socket'] as const) {
    if (typeof record[key] !== 'string' || record[key] === '') return null;
  }
  const features = record.features;
  if (!features || typeof features !== 'object' || Array.isArray(features)) return null;
  if (!['on', 'off', 'absent'].includes((features as Record<string, unknown>).broker as string)) return null;
  const stuck = record.stuck;
  if (!Array.isArray(stuck)) return null;
  const requests: DaemonStuckRequest[] = [];
  for (const item of stuck) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || typeof entry.op !== 'string') return null;
    if (typeof entry.since !== 'string' || typeof entry.ageMs !== 'number') return null;
    requests.push({ id: entry.id, op: entry.op, since: entry.since, ageMs: entry.ageMs });
  }
  const roots = rootsOf(record.roots);
  if (roots === null) return null;
  return {
    format: 1,
    pid: record.pid as number,
    uid: record.uid,
    since: record.since as string,
    startedBy: record.startedBy as string,
    version: record.version as string,
    heartbeatAt: record.heartbeatAt as string,
    socket: record.socket as string,
    features: { broker: (features as Record<string, unknown>).broker as DaemonFeatures['broker'] },
    stuck: requests,
    roots,
  };
}

/** `roots` was added after the first state records were written: a record without it reads as
 *  "no checkout recorded", while a malformed one makes the whole record unreadable rather than
 *  inventing hosting facts. */
function rootsOf(raw: unknown): DaemonRootState[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const roots: DaemonRootState[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry.root !== 'string' || entry.root === '') return null;
    if (!(entry.team === null || typeof entry.team === 'string')) return null;
    if (!['serving', 'already-running', 'failed'].includes(entry.send as string)) return null;
    if (!['serving', 'failed'].includes(entry.bus as string)) return null;
    if (!(entry.why === null || typeof entry.why === 'string')) return null;
    const watch = watchOf(entry.watch);
    roots.push({
      root: entry.root,
      team: entry.team as string | null,
      send: entry.send as DaemonRootState['send'],
      bus: entry.bus as DaemonRootState['bus'],
      why: entry.why as string | null,
      ...(watch === null ? {} : { watch }),
    });
  }
  return roots;
}

/**
 * A watch record is display data, not a hosting fact: a malformed one is left out rather than
 * making the whole daemon record unreadable, and an absent one means the route was not started
 * to carry a hosted watch.
 */
function watchOf(raw: unknown): HostedWatchState | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.routeId !== 'string' || entry.routeId === '') return null;
  if (typeof entry.root !== 'string' || entry.root === '') return null;
  if (typeof entry.team !== 'string' || typeof entry.session !== 'string') return null;
  if (!['starting', 'running', 'standby', 'stopping', 'stopped', 'failed'].includes(entry.phase as string)) return null;
  if (typeof entry.startedAt !== 'string') return null;
  if (!(entry.lastCycleAt === null || typeof entry.lastCycleAt === 'string')) return null;
  if (![null, 'pass', 'failed'].includes(entry.lastCycleOutcome as string | null)) return null;
  if (!Number.isInteger(entry.cycles) || (entry.cycles as number) < 0) return null;
  if (!Number.isInteger(entry.failures) || (entry.failures as number) < 0) return null;
  if (!['blocked', 'open'].includes(entry.effects as string)) return null;
  if (typeof entry.required !== 'boolean') return null;
  if (!(entry.why === null || typeof entry.why === 'string')) return null;
  return {
    routeId: entry.routeId,
    root: entry.root,
    team: entry.team,
    session: entry.session,
    phase: entry.phase as HostedWatchState['phase'],
    startedAt: entry.startedAt,
    lastCycleAt: entry.lastCycleAt as string | null,
    lastCycleOutcome: entry.lastCycleOutcome as HostedWatchState['lastCycleOutcome'],
    cycles: entry.cycles as number,
    failures: entry.failures as number,
    effects: entry.effects as HostedWatchState['effects'],
    required: entry.required,
    why: entry.why as string | null,
  };
}

function positiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Writes the state record atomically, 0600, in a 0700 machine folder. */
export function writeDaemonState(home: string, state: DaemonState): void {
  ensureMachineDir(home);
  const path = daemonStatePath(home);
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/** Whether the recorded process still exists. A dead pid makes the record stale. */
export function daemonStateAlive(state: DaemonState): boolean {
  return pidAlive(state.pid);
}
