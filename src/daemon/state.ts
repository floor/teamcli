// The one machine daemon's state record (`<home>/.config/teamcli/daemon.state.json`, mode 0600).
// The daemon writes it at start and refreshes `heartbeatAt` while it serves; `team status`,
// `team check` and the daemon's own health answer read it through this module.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pidAlive } from '../state.ts';
import { daemonStatePath, machineConfigDir } from './paths.ts';

/** Which features the running build actually carries. `absent` means the handler is not built;
 *  it is not the policy value `off`. */
export type DaemonFeatures = { broker: 'on' | 'off' | 'absent' };

/** A request the daemon has been working on longer than its stuck threshold. */
export type DaemonStuckRequest = { id: string; op: string; since: string; ageMs: number };

export type DaemonState = {
  format: 1;
  pid: number;
  uid: number;
  since: string;
  /** `launchd`, `manual` or `team-up`, from the process that started it. */
  startedBy: string;
  version: string;
  heartbeatAt: string;
  socket: string;
  features: DaemonFeatures;
  stuck: DaemonStuckRequest[];
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
