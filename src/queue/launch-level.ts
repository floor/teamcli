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
import { createExclusive, ensureFolder, readFence, removeDurable } from './durable.ts';
import { ACTOR_LEVEL, queuesFolder } from './floor.ts';

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
  if (removeDurable(path) === 'failed') return false;
  return createExclusive(path, `${JSON.stringify({ payload, signature })}\n`) === 'created';
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

/** The seats that have a launch record under `root`, as `[session, seat]` (an unlistable folder
 *  is null: unknown, never none). */
export function launchRecordSeats(root: string): [string, string][] | null {
  const folder = join(queuesFolder(root), 'launches');
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  const out: [string, string][] = [];
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    const stem = name.slice(0, -'.json'.length);
    const dot = stem.indexOf('.');
    if (dot <= 0) continue;
    out.push([stem.slice(0, dot), stem.slice(dot + 1)]);
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
