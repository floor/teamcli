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

/** Whether the seat's current managed launch proves level >= `floor` for its live CLI process. */
export function launchLevelProves(
  root: string, home: string, session: string, seat: string, floor: number,
  probe: { alive(pid: number): boolean; startOf(pid: number): number | null },
): boolean {
  const path = recordPath(root, session, seat);
  if (path === null) return false;
  const text = readFence(path);
  if (text === null || text === '') return false;
  let record: { payload?: LaunchLevelPayload; signature?: unknown };
  try {
    record = JSON.parse(text) as typeof record;
  } catch {
    return false;
  }
  const payload = record.payload;
  if (!payload || payload.kind !== 'launch-level' || payload.v !== 1 || typeof record.signature !== 'string') return false;
  const key = messageKeyState(home);
  if (key.kind !== 'key' || !verifyDomain(LAUNCH_LEVEL_DOMAIN, payload as unknown as Json, record.signature, key.key)) return false;
  if (payload.root !== root || payload.session !== session || payload.seat !== seat) return false;
  if (payload.state !== 'proven' || !(payload.level >= floor)) return false;
  if (typeof payload.cli !== 'number' || typeof payload.cli_start !== 'number') return false;
  if (!probe.alive(payload.cli)) return false;
  return probe.startOf(payload.cli) === payload.cli_start;
}
