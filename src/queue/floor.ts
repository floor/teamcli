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
//   PUBLISHED        written third, after the record's folder fsync; readers trust `active` only with it
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
//   A4 publish:  PUBLISHED created exclusively, only after the record's folder fsync. Readers act
//                on `active` only when PUBLISHED stands, so a visible PUBLISHED implies a durable
//                record (E7 gate 2: no link-to-fsync publication window).
//   A5 active:   from here a fence writer may create fences; each one reads the record first.
// A crash after A2 and before A3 leaves the root dark, and A0 removes the marker on the next pass.
// A crash after A3 and before A4 leaves the record unpublished: `unknown` (existing fences
// honoured, none created) until A0 makes the record durable and publishes it.
//
// After activation an actor below the floor flips the root to FENCED: no new fence is created,
// every existing fence stays honoured by every floor actor, and the state names the actor. A later
// activation check that proves every live actor at the floor again removes FENCED (under the lock).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLockAt } from '../launch/seat-lock.ts';
import { messageKeyOf, messageKeyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { createExclusive, ensureFolder, fsyncFolder, readFence, removeDurable, type DurableFaults } from './durable.ts';

/** The capability level this build reports: exposure claims, wake-attempt states, and (E7b) the
 *  at-least-once hand-over of stamped records with numbered copies. */
export const ACTOR_LEVEL = 3;
/** The level a root is activated at by this build (E7b, at-least-once): every live actor must
 *  report it, and the reader switch (READER_LEVEL 3) can then go on. */
export const FLOOR_LEVEL = 3;

export const ACTIVATION_DOMAIN = 'team-activation-v1\n';
const PROTOCOL = 'PROTOCOL';
const ACTIVATION = 'ACTIVATION';
const FENCED = 'FENCED';
const PUBLISHED = 'PUBLISHED';
/** The rollback's own marker (E7b): created first and removed last by `deactivate`. */
const DEACTIVATING = 'DEACTIVATING';
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
export type ActivationStep = 'recover' | 'prove' | 'marker' | 'record' | 'publish';

export type ActivationOptions = {
  home: string;
  build: string | null;
  /** The live actors, read fresh by the caller's probe each time it is called. */
  actors: () => FloorActor[] | null;
  now?: () => Date;
  /** Test seam: runs after a step completes; a crash test exits here. */
  after?: (step: ActivationStep) => void;
  faults?: DurableFaults;
  /** The floor this run activates at; FLOOR_LEVEL by default. */
  level?: number;
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
  // E7b: a rollback that has begun and not finished. No new fence; rerunning `deactivate` finishes it.
  const rolling = readJson(join(queuesFolder(root), DEACTIVATING));
  if (rolling.kind === 'unknown') return { kind: 'unknown', why: 'the rollback marker cannot be read' };
  if (rolling.kind === 'ok') return { kind: 'unknown', why: 'a rollback to dark is in progress; finish it with `team queues deactivate`' };
  const marker = readJson(join(queuesFolder(root), PROTOCOL));
  const record = readActivation(root, home);
  if (marker.kind === 'unknown') return { kind: 'unknown', why: 'the floor marker cannot be read' };
  if (record.kind === 'unknown') return { kind: 'unknown', why: record.why };
  if (marker.kind === 'absent' && record.kind === 'absent') return { kind: 'dark' };
  if (marker.kind === 'absent') return { kind: 'unknown', why: 'an activation record stands without its floor marker' };
  if (record.kind === 'absent') return { kind: 'dark' }; // a cut-off activation: A0 removes the marker
  // A4 publication. A reader acts on `active` only once PUBLISHED stands, and PUBLISHED is created
  // only after the record's folder fsync: a visible PUBLISHED implies a durable record. A record
  // without PUBLISHED (its publication was cut off) is `unknown` until recovery republishes it:
  // existing fences are honoured, no new fence is created (E7 gate 2).
  const published = readJson(join(queuesFolder(root), PUBLISHED));
  if (published.kind === 'unknown') return { kind: 'unknown', why: 'the activation publication cannot be read' };
  if (published.kind === 'absent') return { kind: 'unknown', why: 'the activation record is not published yet' };
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

export function withActivationLock<T>(root: string, run: () => T): T | { kind: 'busy' } | { kind: 'failed'; why: string } {
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

/** A0: removes a floor marker that no verifying activation record follows, and republishes a
 *  verifying record whose publication was cut off. Under the lock. */
function recoverUnderLock(root: string, home: string, faults?: DurableFaults): { kind: 'ok' } | { kind: 'failed'; why: string } {
  const marker = readJson(join(queuesFolder(root), PROTOCOL));
  if (marker.kind !== 'ok') return { kind: 'ok' };
  const record = readActivation(root, home);
  if (record.kind === 'absent') {
    return removeDurable(join(queuesFolder(root), PROTOCOL)) === 'removed'
      ? { kind: 'ok' }
      : { kind: 'failed', why: 'a cut-off floor marker could not be removed' };
  }
  // A verifying record whose publication was cut off is NOT published here: publication is A4 of a
  // run whose A1 proof holds today (an actor that appeared since the cut must still refuse it).
  void faults;
  return { kind: 'ok' };
}

/** Whether a verifying activation record stands without its publication (a cut after A3). */
function unpublishedRecord(root: string, home: string): boolean {
  const marker = readJson(join(queuesFolder(root), PROTOCOL));
  if (marker.kind !== 'ok') return false;
  if (readActivation(root, home).kind !== 'ok') return false;
  return readJson(join(queuesFolder(root), PUBLISHED)).kind === 'absent';
}

function publishUnderLock(root: string, faults?: DurableFaults): { kind: 'ok' } | { kind: 'failed'; why: string } {
  try {
    fsyncFolder(queuesFolder(root));
  } catch {
    return { kind: 'failed', why: 'the activation record could not be made durable' };
  }
  const made = createExclusive(join(queuesFolder(root), PUBLISHED), `${JSON.stringify({ v: 1 })}\n`, faults);
  return made === 'failed' ? { kind: 'failed', why: 'the activation could not be published' } : { kind: 'ok' };
}

/**
 * Runs the activation transaction for `root` (A0–A3). Refuses, writing nothing, while any live
 * actor reports a level below the floor or none. An already active root stays as it is; a fenced
 * root whose actors are all at the floor again has FENCED removed.
 */
export function activate(root: string, options: ActivationOptions): ActivationOutcome {
  const result = withActivationLock(root, (): ActivationOutcome => {
    const rolling = readJson(join(queuesFolder(root), DEACTIVATING));
    if (rolling.kind !== 'absent') return { kind: 'refused', why: 'a rollback to dark is in progress; finish it first with `team queues deactivate`', below: [] };
    const recovered = recoverUnderLock(root, options.home, options.faults);
    if (recovered.kind === 'failed') return recovered;
    options.after?.('recover');
    const state = floorState(root, options.home);
    const resume = state.kind === 'unknown' && unpublishedRecord(root, options.home);
    if (state.kind === 'unknown' && !resume) return { kind: 'failed', why: state.why };
    // A1: the proof, fresh, immediately before the first write.
    const actors = options.actors();
    if (actors === null) return { kind: 'refused', why: 'the live actors cannot be read', below: [] };
    // The daemon runs the check and hosts the workers: without a live daemon at the floor there is
    // nobody to enforce the fences, so the root stays dark.
    if (!actors.some(actor => actor.kind === 'daemon')) return { kind: 'refused', why: 'no live daemon reports a level', below: [] };
    const floorLevel = options.level ?? FLOOR_LEVEL;
    const below = belowFloor(actors, floorLevel);
    if (below.length > 0) return { kind: 'refused', why: 'an actor below the floor is live', below };
    options.after?.('prove');
    if (resume) {
      // A4 for a record cut off before its publication, now that today's proof holds.
      const published = publishUnderLock(root, options.faults);
      if (published.kind === 'failed') return published;
      options.after?.('publish');
      return { kind: 'already', level: floorLevel };
    }
    if (state.kind === 'active') return { kind: 'already', level: state.level };
    if (state.kind === 'fenced') {
      return removeDurable(join(queuesFolder(root), FENCED)) === 'removed'
        ? { kind: 'activated', level: state.level }
        : { kind: 'failed', why: 'the fenced marker could not be removed' };
    }
    // A2: the marker.
    const marker = createExclusive(join(queuesFolder(root), PROTOCOL), `${JSON.stringify({ v: 1, level: floorLevel })}\n`, options.faults);
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
      level: floorLevel,
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
    // A4: publication, after the record is durable. Only now may a reader act on `active`.
    const published = publishUnderLock(root, options.faults);
    if (published.kind === 'failed') return published;
    options.after?.('publish');
    return { kind: 'activated', level: floorLevel };
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
  // E7b (the coordinator's decision after design round 4): an actor below the floor, of unknown level, or an actor
  // list that cannot be read, rolls the root back to dark. Stamped records keep their contract
  // through the rollback (they are settled only by their recipient, whatever the floor), and an
  // older build refuses a stamped record as unsupported, so it never presents a stamped body.
  const why = below === null ? 'the live actors cannot be read' : `an actor below the floor is live (${below.map(actor => `${actor.name} pid ${String(actor.pid)} level ${actor.level === null ? 'unknown' : String(actor.level)}`).join(', ')})`;
  const rolled = deactivate(root, home);
  if (rolled.kind === 'dark') return { kind: 'dark' };
  return { kind: 'unknown', why: `rolling back to dark (${why}): ${rolled.kind === 'failed' ? rolled.why : 'the activation lock is busy'}` };
}

export type DeactivationStep = 'begin' | 'reader' | 'published' | 'record' | 'marker' | 'fenced' | 'end';

export type DeactivationOutcome = { kind: 'dark' } | { kind: 'busy' } | { kind: 'failed'; why: string };

/**
 * The one-command rollback to dark (E7b §3, `team queues deactivate`), under the activation lock,
 * each removal durable before the next: D1 DEACTIVATING, D2 READER, D3 PUBLISHED (from here no
 * reader trusts `active` and no new fence is created), D4 ACTIVATION, D5 PROTOCOL, D6 FENCED, D7
 * DEACTIVATING removed. A cut-off run leaves DEACTIVATING (`unknown`); running it again resumes at
 * the first file still standing. Idempotent: a dark root answers dark and writes nothing.
 */
export function deactivate(root: string, home: string, options: { after?: (step: DeactivationStep) => void; faults?: DurableFaults; removeFaults?: { before?: (step: 'unlink' | 'folder-fsync', path: string) => void } } = {}): DeactivationOutcome {
  void home;
  const result = withActivationLock(root, (): DeactivationOutcome => {
    const folder = queuesFolder(root);
    const names = [PROTOCOL, ACTIVATION, PUBLISHED, FENCED, DEACTIVATING, 'READER'];
    const standing = names.map(name => readFence(join(folder, name)));
    if (standing.some(text => text === null)) return { kind: 'failed', why: 'a floor file cannot be read' };
    if (standing.every(text => text === '')) return { kind: 'dark' };
    const begun = createExclusive(join(folder, DEACTIVATING), `${JSON.stringify({ v: 1, at: new Date().toISOString() })}\n`, options.faults);
    if (begun === 'failed') return { kind: 'failed', why: 'the rollback marker could not be made durable' };
    options.after?.('begin');
    const steps: [string, DeactivationStep][] = [['READER', 'reader'], [PUBLISHED, 'published'], [ACTIVATION, 'record'], [PROTOCOL, 'marker'], [FENCED, 'fenced'], [DEACTIVATING, 'end']];
    for (const [name, step] of steps) {
      if (removeDurable(join(folder, name), options.removeFaults) === 'failed') return { kind: 'failed', why: `${name} could not be removed` };
      options.after?.(step);
    }
    return { kind: 'dark' };
  });
  return result;
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
    // The daemon never activates on its own: activation is the explicit `team queues activate`
    // (E7), which runs the same transaction with the launch boundary wired (`admitManagedLaunch`).
    void build;
    return state;
  } catch {
    return { kind: 'unknown', why: 'the floor pass failed' };
  }
}

function readFolder(folder: string): string[] | null {
  try {
    return readdirSync(folder);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
}

/** Every seat drop folder of the root, or null when any level cannot be listed (an unreadable
 *  session or seat folder is never an empty one). */
export function seatDropFoldersStrict(root: string): string[] | null {
  const base = join(root, '.agents', 'send-drops');
  const sessions = readFolder(base);
  if (sessions === null) return null;
  const out: string[] = [];
  for (const session of sessions) {
    if (session.startsWith('.')) continue;
    const seats = readFolder(join(base, session));
    if (seats === null) return null;
    for (const seat of seats) if (!seat.startsWith('.')) out.push(join(base, session, seat));
  }
  return out;
}
