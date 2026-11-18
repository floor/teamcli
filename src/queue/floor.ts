// The activation floor (rfc-event-comms §3, step E6).
//
// Every new fence (exposure claims §3, wake-attempt states §5) is written in shadow and enforced
// by nobody until the root is ACTIVE. Builds already installed never read a marker, so activation
// is proved, not declared: every live actor of the root must report a capability level at or above
// the floor. This build enforces level 2: both fence families.
//
// Files, under `<root>/.agents/queues/`:
//   activation.lock  the root's activation lock (the seat lock's rule)
//   PROTOCOL         the floor marker {v, level}; written first
//   ACTIVATION       the signed activation record {root, level, build, actors, at}; written second
//   FENCED           written when an actor below the floor is seen after activation
//
// The activation transaction, under the activation lock (each step durable before the next):
//   A0 recover:  PROTOCOL without a verifying ACTIVATION is a cut-off activation: remove PROTOCOL
//                (folder fsynced). ACTIVATION without PROTOCOL is not a state any order makes:
//                `unknown`, fail closed (no new fence, an alert), never repaired by guessing.
//   A1 prove:    every live actor reports a level >= FLOOR_LEVEL; any older or unknown actor means
//                no activation, nothing written. The proof is taken last before A2: nothing awaits
//                between them.
//   A2 marker:   PROTOCOL created exclusively, durable (file and folder fsynced).
//   A3 record:   ACTIVATION created exclusively, signed, durable.
//   A4 active:   from here a fence writer may create fences; each one reads the record first.
// A crash after A2 and before A3 leaves the root dark, and A0 removes the marker on the next pass.
//
// After activation an actor below the floor flips the root to FENCED: no new fence is created,
// every existing fence stays honoured by every floor actor, and the state names the actor. A later
// activation check that proves every live actor at the floor again removes FENCED (under the lock).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLockAt } from '../launch/seat-lock.ts';
import { messageKeyOf, messageKeyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { createExclusive, ensureFolder, readFence, removeDurable, type DurableFaults } from './durable.ts';

/** The capability level this build enforces: exposure claims and wake-attempt states. */
export const ACTOR_LEVEL = 2;
/** The level a root is activated at by this build. A later fence family raises it (§3). */
export const FLOOR_LEVEL = 2;

export const ACTIVATION_DOMAIN = 'team-activation-v1\n';
const PROTOCOL = 'PROTOCOL';
const ACTIVATION = 'ACTIVATION';
const FENCED = 'FENCED';
const LOCK = 'activation.lock';

export function queuesFolder(root: string): string {
  return join(root, '.agents', 'queues');
}

/** One live process that reads, adapts or retries for the root, with the level it reports.
 *  `level: null` is an actor that reports none (a build before E6): unknown, never assumed. */
export type FloorActor = { kind: 'daemon' | 'inbox-server' | 'other'; name: string; pid: number; build: string | null; level: number | null };

export type ActivationPayload = {
  v: 1;
  kind: 'activation';
  root: string;
  level: number;
  build: string | null;
  actors: { kind: string; name: string; pid: number; level: number }[];
  at: string;
};

export type FloorState =
  | { kind: 'dark' }
  | { kind: 'active'; level: number; at: string }
  | { kind: 'fenced'; level: number; why: string }
  | { kind: 'unknown'; why: string };

/** The steps the fault grid crashes between. */
export type ActivationStep = 'recover' | 'prove' | 'marker' | 'record';

export type ActivationOptions = {
  home: string;
  build: string | null;
  /** The live actors, read fresh by the caller's probe each time it is called. */
  actors: () => FloorActor[] | null;
  now?: () => Date;
  /** Test seam: runs after a step completes; a crash test exits here. */
  after?: (step: ActivationStep) => void;
  faults?: DurableFaults;
  /** The managed launch boundary (§3 step 4): managed launches take the activation lock and refuse
   *  a binary below the floor. E6 does not wire it yet, so no production caller passes this and the
   *  root stays dark: the fences are written in shadow and enforced by nobody. */
  launchBoundary?: true;
};

export type ActivationOutcome =
  | { kind: 'activated'; level: number }
  | { kind: 'already'; level: number }
  | { kind: 'refused'; why: string; below: FloorActor[] }
  | { kind: 'busy' }
  | { kind: 'failed'; why: string };

function readJson(path: string): { kind: 'absent' } | { kind: 'unknown' } | { kind: 'ok'; value: unknown } {
  const text = readFence(path);
  if (text === null) return { kind: 'unknown' };
  if (text === '') return { kind: 'absent' };
  try {
    return { kind: 'ok', value: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'unknown' };
  }
}

/** The activation record, verified against this home's message key and bound to `root`. */
function readActivation(root: string, home: string): { kind: 'absent' } | { kind: 'unknown'; why: string } | { kind: 'ok'; payload: ActivationPayload } {
  const read = readJson(join(queuesFolder(root), ACTIVATION));
  if (read.kind === 'absent') return { kind: 'absent' };
  if (read.kind === 'unknown') return { kind: 'unknown', why: 'the activation record cannot be read' };
  const record = read.value as { payload?: ActivationPayload; signature?: unknown };
  const payload = record.payload;
  if (!payload || payload.kind !== 'activation' || payload.v !== 1 || typeof record.signature !== 'string') {
    return { kind: 'unknown', why: 'the activation record has no shape this build reads' };
  }
  if (payload.root !== root) return { kind: 'unknown', why: 'the activation record names another root' };
  const key = messageKeyState(home);
  if (key.kind !== 'key') return { kind: 'unknown', why: 'the message key cannot be read, so the activation record cannot be verified' };
  if (!verifyDomain(ACTIVATION_DOMAIN, payload as unknown as Json, record.signature, key.key)) {
    return { kind: 'unknown', why: 'the activation record does not verify' };
  }
  if (!Number.isInteger(payload.level) || payload.level < 1) return { kind: 'unknown', why: 'the activation record names no level' };
  return { kind: 'ok', payload };
}

/**
 * The root's floor state. `active` only when PROTOCOL and a verifying ACTIVATION both stand and no
 * FENCED stands. Every unreadable or contradictory read is `unknown`: a fence writer creates no new
 * fence then, and every reader still honours the fences that exist.
 */
export function floorState(root: string, home: string): FloorState {
  const marker = readJson(join(queuesFolder(root), PROTOCOL));
  const record = readActivation(root, home);
  if (marker.kind === 'unknown') return { kind: 'unknown', why: 'the floor marker cannot be read' };
  if (record.kind === 'unknown') return { kind: 'unknown', why: record.why };
  if (marker.kind === 'absent' && record.kind === 'absent') return { kind: 'dark' };
  if (marker.kind === 'absent') return { kind: 'unknown', why: 'an activation record stands without its floor marker' };
  if (record.kind === 'absent') return { kind: 'dark' }; // a cut-off activation: A0 removes the marker
  const fenced = readJson(join(queuesFolder(root), FENCED));
  if (fenced.kind === 'unknown') return { kind: 'unknown', why: 'the fenced marker cannot be read' };
  if (fenced.kind === 'ok') {
    const why = typeof (fenced.value as { why?: unknown }).why === 'string' ? (fenced.value as { why: string }).why : 'an actor below the floor was seen';
    return { kind: 'fenced', level: record.payload.level, why };
  }
  return { kind: 'active', level: record.payload.level, at: record.payload.at };
}

/** Whether a new fence may be created now. Only an active root at a level that carries the family. */
export function mayCreateFence(root: string, home: string, family: 'exposure' | 'wake-attempt'): boolean {
  const state = floorState(root, home);
  if (state.kind !== 'active') return false;
  return family === 'exposure' || family === 'wake-attempt' ? state.level >= 2 : false;
}

/** Whether existing fences are enforced: on an active or fenced root (a fenced root keeps honouring
 *  every fence it has), and on an unknown state (fail closed). Only a proven-dark root ignores them. */
export function fencesEnforced(root: string, home: string): boolean {
  return floorState(root, home).kind !== 'dark';
}

function belowFloor(actors: FloorActor[], level: number): FloorActor[] {
  return actors.filter(actor => actor.level === null || actor.level < level);
}

function withActivationLock<T>(root: string, run: () => T): T | { kind: 'busy' } | { kind: 'failed'; why: string } {
  const folder = queuesFolder(root);
  if (!ensureFolder(folder)) return { kind: 'failed', why: 'the queues folder cannot be made' };
  let lock;
  try {
    lock = acquireLockAt(join(folder, LOCK), folder, undefined, { waitMs: 2000, pollMs: 25 });
  } catch (error) {
    return { kind: 'failed', why: `the activation lock cannot be taken (${(error as Error).message})` };
  }
  if (!('release' in lock)) return { kind: 'busy' };
  try {
    return run();
  } finally {
    lock.release();
  }
}

/** A0: removes a floor marker that no verifying activation record follows. Under the lock. */
function recoverUnderLock(root: string, home: string): { kind: 'ok' } | { kind: 'failed'; why: string } {
  const marker = readJson(join(queuesFolder(root), PROTOCOL));
  if (marker.kind !== 'ok') return { kind: 'ok' };
  const record = readActivation(root, home);
  if (record.kind !== 'absent') return { kind: 'ok' };
  return removeDurable(join(queuesFolder(root), PROTOCOL)) === 'removed'
    ? { kind: 'ok' }
    : { kind: 'failed', why: 'a cut-off floor marker could not be removed' };
}

/**
 * Runs the activation transaction for `root` (A0–A3). Refuses, writing nothing, while any live
 * actor reports a level below the floor or none. An already active root stays as it is; a fenced
 * root whose actors are all at the floor again has FENCED removed.
 */
export function activate(root: string, options: ActivationOptions): ActivationOutcome {
  if (options.launchBoundary !== true) return { kind: 'refused', why: 'the managed launch boundary is not wired yet; the root stays dark', below: [] };
  const result = withActivationLock(root, (): ActivationOutcome => {
    const recovered = recoverUnderLock(root, options.home);
    if (recovered.kind === 'failed') return recovered;
    options.after?.('recover');
    const state = floorState(root, options.home);
    if (state.kind === 'unknown') return { kind: 'failed', why: state.why };
    // A1: the proof, fresh, immediately before the first write.
    const actors = options.actors();
    if (actors === null) return { kind: 'refused', why: 'the live actors cannot be read', below: [] };
    // The daemon runs the check and hosts the workers: without a live daemon at the floor there is
    // nobody to enforce the fences, so the root stays dark.
    if (!actors.some(actor => actor.kind === 'daemon')) return { kind: 'refused', why: 'no live daemon reports a level', below: [] };
    const below = belowFloor(actors, FLOOR_LEVEL);
    if (below.length > 0) return { kind: 'refused', why: 'an actor below the floor is live', below };
    options.after?.('prove');
    if (state.kind === 'active') return { kind: 'already', level: state.level };
    if (state.kind === 'fenced') {
      return removeDurable(join(queuesFolder(root), FENCED)) === 'removed'
        ? { kind: 'activated', level: state.level }
        : { kind: 'failed', why: 'the fenced marker could not be removed' };
    }
    // A2: the marker.
    const marker = createExclusive(join(queuesFolder(root), PROTOCOL), `${JSON.stringify({ v: 1, level: FLOOR_LEVEL })}\n`, options.faults);
    if (marker === 'failed') {
      // A marker that may stand without being durable is taken back now (A0 would on the next pass).
      removeDurable(join(queuesFolder(root), PROTOCOL));
      return { kind: 'failed', why: 'the floor marker could not be made durable' };
    }
    options.after?.('marker');
    // A3: the signed record.
    const payload: ActivationPayload = {
      v: 1,
      kind: 'activation',
      root,
      level: FLOOR_LEVEL,
      build: options.build,
      actors: actors.map(actor => ({ kind: actor.kind, name: actor.name, pid: actor.pid, level: actor.level as number })),
      at: (options.now?.() ?? new Date()).toISOString(),
    };
    let signature: string;
    try {
      signature = signDomain(ACTIVATION_DOMAIN, payload as unknown as Json, messageKeyOf(options.home));
    } catch (error) {
      return { kind: 'failed', why: `the activation record cannot be signed (${(error as Error).message})` };
    }
    const record = createExclusive(join(queuesFolder(root), ACTIVATION), `${JSON.stringify({ payload, signature })}\n`, options.faults);
    if (record === 'failed') {
      // A record that became visible is never taken back: a reader may already have acted on
      // `active`, and a root never returns from enforcing to dark. A fault before the link leaves no
      // record (the root stays dark, A0 removes the marker); a fault after it leaves the root active.
      return { kind: 'failed', why: 'the activation record could not be confirmed durable' };
    }
    options.after?.('record');
    return { kind: 'activated', level: FLOOR_LEVEL };
  });
  return result;
}

/**
 * The post-activation watch: on an active root, any live actor below the floor flips it to FENCED.
 * Returns the state after the check. Never activates; never removes FENCED (only `activate` does,
 * after a fresh proof).
 */
export function checkActors(root: string, home: string, actors: FloorActor[] | null): FloorState {
  const state = floorState(root, home);
  if (state.kind !== 'active') return state;
  const below = actors === null ? null : belowFloor(actors, state.level);
  if (below !== null && below.length === 0) return state;
  const why = below === null ? 'fenced: the live actors cannot be read' : `fenced: legacy actor present (${(below ?? []).map(actor => `${actor.name} pid ${String(actor.pid)} level ${actor.level === null ? 'unknown' : String(actor.level)}`).join(', ')})`;
  const made = createExclusive(join(queuesFolder(root), FENCED), `${JSON.stringify({ v: 1, why, at: new Date().toISOString() })}\n`);
  return made === 'failed' ? { kind: 'unknown', why: 'the fenced marker could not be written' } : { kind: 'fenced', level: state.level, why };
}

/** Managed launch admission (§3 step 4): after activation, a binary below the floor is refused. */
export function launchAdmission(root: string, home: string, level: number = ACTOR_LEVEL): string | null {
  const state = floorState(root, home);
  if (state.kind === 'dark') return null;
  if (state.kind === 'unknown') return null; // the launch itself is this build, at ACTOR_LEVEL
  return level >= state.level ? null : `this build enforces level ${String(level)}, below the root's floor ${String(state.level)}`;
}

/** Lists the folders a root's live actors leave markers in: one per seat drop folder. */
export function seatDropFolders(root: string): string[] {
  const base = join(root, '.agents', 'send-drops');
  const out: string[] = [];
  let sessions: string[];
  try {
    sessions = readdirSync(base);
  } catch {
    return out;
  }
  for (const session of sessions) {
    if (session.startsWith('.')) continue;
    let seats: string[];
    try {
      seats = readdirSync(join(base, session));
    } catch {
      continue;
    }
    for (const seat of seats) if (!seat.startsWith('.')) out.push(join(base, session, seat));
  }
  return out;
}

const lastFloorPass = new Map<string, number>();

/**
 * The daemon-side floor pass for one root, at most once a minute: on a dark or fenced root it runs
 * the activation transaction (which proves every live actor first); on an active root it watches
 * for an actor below the floor. Never throws.
 */
export function floorPass(root: string, home: string, nowMs: number, actors: () => FloorActor[] | null, build: string | null): FloorState {
  try {
    const last = lastFloorPass.get(root);
    if (last !== undefined && nowMs - last < 60_000) return floorState(root, home);
    lastFloorPass.set(root, nowMs);
    const state = floorState(root, home);
    if (state.kind === 'active') return checkActors(root, home, actors());
    // E6 never activates: activation waits for the managed launch boundary (see `launchBoundary`).
    void build;
    return state;
  } catch {
    return { kind: 'unknown', why: 'the floor pass failed' };
  }
}
