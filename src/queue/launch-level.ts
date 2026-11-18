// The launch-level record (rfc-event-comms E7b, the coordinator's decision on the actor proof).
//
// A seat whose inbox-listener marker is absent is not an actor only on positive evidence that any
// inbox server it has was started by this build or later: its current managed launch signed its
// build level and names the seat's live CLI process. Each managed launch, under the seat lock:
//   L1 pending  before the CLI starts, any earlier record is removed (durably) and a pending record
//               is written, signed, naming the pane's shell. A pending record proves nothing.
//   L2 proven   once the CLI's idle prompt is up, the record is replaced (durably) by one that names
//               the CLI's pid and that process's start instant, signed with the build's level.
// The proof holds only when the record verifies with this home's key, is bound to this root,
// session and seat, is proven (not pending), carries a level >= the floor, and its CLI pid is alive
// with the same start instant. Anything missing, unreadable, pending or naming another process is
// no proof (the seat stays unknown: fail closed). An older build writes no record: its launch in
// the same pane leaves the seat with a pending or earlier record whose CLI pid is gone or another
// process, so it is unknown.
//
// File: <root>/.agents/queues/launches/<session>.<seat>.json
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { messageKeyOf, messageKeyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { ensureFolder, fsyncFolder, readFence, removeDurable } from './durable.ts';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, writeSync } from 'node:fs';
import { openSync, renameSync } from '../host/guarded-fs.ts';
import { ACTOR_LEVEL, queuesFolder, withActivationLock } from './floor.ts';

export const LAUNCH_LEVEL_DOMAIN = 'team-launch-level-v1\n';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type LaunchLevelPayload = {
  v: 1; kind: 'launch-level'; root: string; session: string; seat: string; level: number;
  state: 'pending' | 'proven'; shell: number | null; cli: number | null; cli_start: number | null; at: string;
};

function recordPath(root: string, session: string, seat: string): string | null {
  if (!NAME.test(session) || !NAME.test(seat)) return null;
  return join(queuesFolder(root), 'launches', `${session}.${seat}.json`);
}

function write(root: string, home: string, payload: LaunchLevelPayload): boolean {
  const path = recordPath(root, payload.session, payload.seat);
  if (path === null) return false;
  let signature: string;
  try {
    signature = signDomain(LAUNCH_LEVEL_DOMAIN, payload as unknown as Json, messageKeyOf(home));
  } catch {
    return false;
  }
  if (!ensureFolder(dirname(path))) return false;
  // Under the root's activation lock, for this write only (never the whole launch): the activation
  // proof, which runs under the same lock, sees the record before or after, never in between. The
  // record is replaced in one step (a durable temp file renamed over the old one, then the folder
  // fsynced), so the earlier evidence stands until its replacement is durable.
  const text = `${JSON.stringify({ payload, signature })}\n`;
  const done = withActivationLock(root, () => replaceDurable(path, text));
  return done === true;
}

function replaceDurable(path: string, text: string): boolean {
  const temp = `${path}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
    fsyncFolder(dirname(path));
    return true;
  } catch {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* closed */ }
    }
    removeDurable(temp);
    return false;
  }
}

/** On a launch positively known not to have submitted its line (no pane, a channel lease no longer
 *  current, a terminal that did not take the line), its own pending record is retired, under the
 *  activation lock, and only if it is still the pending record (a proven or later one stays). */
export function launchRetire(root: string, home: string, session: string, seat: string): boolean {
  const path = recordPath(root, session, seat);
  if (path === null) return false;
  const done = withActivationLock(root, () => {
    if (readLaunchRecord(root, home, session, seat).kind !== 'pending') return true;
    return removeDurable(path) === 'removed';
  });
  return done === true;
}

/** L1, before the CLI starts: the earlier record goes, and a pending one (proving nothing) stands. */
export function launchPending(root: string, home: string, session: string, seat: string, shell: number | null, now: Date = new Date()): boolean {
  return write(root, home, { v: 1, kind: 'launch-level', root, session, seat, level: ACTOR_LEVEL, state: 'pending', shell, cli: null, cli_start: null, at: now.toISOString() });
}

/** L2, at the idle prompt: the record names the CLI's pid and its start instant. */
export function launchProven(root: string, home: string, session: string, seat: string, cli: number, cliStart: number, now: Date = new Date()): boolean {
  return write(root, home, { v: 1, kind: 'launch-level', root, session, seat, level: ACTOR_LEVEL, state: 'proven', shell: null, cli, cli_start: cliStart, at: now.toISOString() });
}

/** A seat's launch-level record, read once and fully verified: `absent` (no file), `pending`
 *  (a verified L1), `proven` (a verified L2, with its CLI pid and start), or `unknown` (anything
 *  that does not verify, is bound elsewhere, is malformed or cannot be read). The state word is
 *  read only from a verified record. */
export type LaunchRecord =
  | { kind: 'absent' }
  | { kind: 'pending' }
  | { kind: 'proven'; level: number; cli: number; cliStart: number }
  | { kind: 'unknown'; why: string };

export function readLaunchRecord(root: string, home: string, session: string, seat: string): LaunchRecord {
  const path = recordPath(root, session, seat);
  if (path === null) return { kind: 'unknown', why: 'the seat cannot name a launch record' };
  const text = readFence(path);
  if (text === '') return { kind: 'absent' };
  if (text === null) return { kind: 'unknown', why: 'the launch record cannot be read' };
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return { kind: 'unknown', why: 'the launch record does not parse' };
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return { kind: 'unknown', why: 'the launch record is not an envelope' };
  const envelope = record as { payload?: LaunchLevelPayload; signature?: unknown };
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || payload.kind !== 'launch-level' || payload.v !== 1 || typeof envelope.signature !== 'string') {
    return { kind: 'unknown', why: 'the launch record has no shape this build reads' };
  }
  const key = messageKeyState(home);
  if (key.kind !== 'key' || !verifyDomain(LAUNCH_LEVEL_DOMAIN, payload as unknown as Json, envelope.signature, key.key)) {
    return { kind: 'unknown', why: 'the launch record does not verify' };
  }
  if (payload.root !== root || payload.session !== session || payload.seat !== seat) return { kind: 'unknown', why: 'the launch record is bound elsewhere' };
  if (payload.state === 'pending') return { kind: 'pending' };
  if (payload.state !== 'proven' || typeof payload.cli !== 'number' || typeof payload.cli_start !== 'number' || typeof payload.level !== 'number') {
    return { kind: 'unknown', why: 'the launch record names no proven process' };
  }
  return { kind: 'proven', level: payload.level, cli: payload.cli, cliStart: payload.cli_start };
}

/** The launch records under `root`, enumerated from their verified contents: each file must hold
 *  a verified record whose own session and seat encode to its name. A file that does not (cannot
 *  be read, does not verify, names another seat than its file name) is returned as `unknown` by
 *  file name. Null when the folder cannot be listed (unknown, never none). */
export function launchRecordSeats(root: string, home: string): ({ session: string; seat: string } | { unknown: string })[] | null {
  const folder = join(queuesFolder(root), 'launches');
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  const out: ({ session: string; seat: string } | { unknown: string })[] = [];
  const key = messageKeyState(home);
  for (const name of names.sort()) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    const text = readFence(join(folder, name));
    let payload: LaunchLevelPayload | null = null;
    try {
      const envelope = text === null || text === '' ? null : JSON.parse(text) as { payload?: LaunchLevelPayload; signature?: unknown } | null;
      if (envelope !== null && typeof envelope === 'object' && envelope.payload && typeof envelope.signature === 'string'
        && key.kind === 'key' && verifyDomain(LAUNCH_LEVEL_DOMAIN, envelope.payload as unknown as Json, envelope.signature, key.key)) payload = envelope.payload;
    } catch {
      payload = null;
    }
    if (text === '') continue;
    if (payload === null || typeof payload.session !== 'string' || typeof payload.seat !== 'string'
      || recordPath(root, payload.session, payload.seat) !== join(folder, name)) {
      out.push({ unknown: name });
      continue;
    }
    out.push({ session: payload.session, seat: payload.seat });
  }
  return out;
}

/** Whether the seat's current managed launch proves level >= `floor` for its live CLI process. */
export function launchLevelProves(
  root: string, home: string, session: string, seat: string, floor: number,
  probe: { alive(pid: number): boolean; startOf(pid: number): number | null },
  /** The seat state's current CLI identity (`launched.cli`): the signed pid must be one of them,
   *  so a surviving earlier process can never vouch for a later launch. */
  currentCli: readonly number[],
): boolean {
  const record = readLaunchRecord(root, home, session, seat);
  if (record.kind !== 'proven' || !(record.level >= floor)) return false;
  if (!currentCli.includes(record.cli)) return false;
  if (!probe.alive(record.cli)) return false;
  return probe.startOf(record.cli) === record.cliStart;
}
