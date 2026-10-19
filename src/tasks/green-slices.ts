// A journal of green slices: a seat's finished, green commit waiting for the installer, and the
// installer's acknowledgment that a commit is installed. Only metadata is stored here — the task,
// the seat, the commit, the version, the installer and instants. No brief body, message text or
// free-form note is ever written: the recorders take these fields and nothing else, so a journal
// read can never hand a consumer words a person did not put in a task or a commit.
//
// A slice is pending until an install event names the same task and commit. Nothing else is
// evidence of an install: not a version, not a ready, not the clock. A malformed install entry is
// dropped at the read door, which leaves its slice pending — the safe direction, since the watch
// may repeat an alert but can never claim an install that was not recorded.
//
// The file lives in the team's `.agents` directory and is written under its own lock with an
// atomic rename, the same way the team state is. It is bounded: installed history is dropped before
// anything a person is still waiting on, and a journal that is nothing but pending slices refuses a
// new record explicitly instead of silently losing an alert.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock, writeAtomic } from '../state.ts';

export const GREEN_SLICES_FILE = 'green-slices.json';
/** The newest events kept. Installed history is dropped first; pending slices are never evicted. */
export const GREEN_SLICES_MAX = 256;
const LOCK_DIR = 'green-slices.lock';

/** One task id, seat name or installer name: a single token, never whitespace or a control byte. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A git commit as the journal accepts it: 7-40 lowercase hex, short or full. */
const COMMIT = /^[0-9a-f]{7,40}$/;
/** One version token, as the release lines spell it (`0.5.3-hotfix.9`). */
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** A seat's finished, green commit awaiting install. */
export type GreenSliceReady = {
  kind: 'ready';
  task: string;
  seat: string;
  commit: string;
  version: string;
  /** ISO 8601: when the slice was recorded ready. */
  at: string;
};

/** The installer's acknowledgment that a task's commit is installed. */
export type GreenSliceInstall = {
  kind: 'install';
  task: string;
  commit: string;
  version: string;
  /** The installer that acknowledged it (`builder-1` on this team). */
  installedBy: string;
  /** ISO 8601: when the install was acknowledged. */
  at: string;
};

export type GreenSliceEvent = GreenSliceReady | GreenSliceInstall;

/** What the watch needs for a waiting slice: the ready metadata and when it started waiting. */
export type PendingGreenSlice = {
  task: string;
  seat: string;
  commit: string;
  version: string;
  readyAt: string;
};

/** A refused recorder answers with the field that is not one; nothing is written. */
export type GreenSliceRecorded<E extends GreenSliceEvent> =
  | { ok: true; added: boolean; event: E }
  | { ok: false; why: string };

/** Where the journal is, so a status or check reader can name the file it read. */
export function greenSlicesPath(dir: string): string {
  return join(dir, GREEN_SLICES_FILE);
}

/**
 * Records a seat's green slice. A second record of the same task, commit and version is the same
 * fact and returns the event already held with `added: false`; the first record's seat and instant
 * stand. The caller's own admission (the queue handler's caller and lease gate) is the command
 * layer's job: this store checks the metadata, never who called it.
 */
export function recordGreenSliceReady(
  dir: string,
  input: { task: string; seat: string; commit: string; version: string; at?: Date },
): GreenSliceRecorded<GreenSliceReady> {
  const task = tokenProblem(input.task, 'task');
  if (task) return { ok: false, why: task };
  const seat = tokenProblem(input.seat, 'seat');
  if (seat) return { ok: false, why: seat };
  const commit = commitProblem(input.commit);
  if (commit) return { ok: false, why: commit };
  const version = versionProblem(input.version);
  if (version) return { ok: false, why: version };
  const instant = instantProblem(input.at);
  if (instant) return { ok: false, why: instant };
  const event: GreenSliceReady = {
    kind: 'ready',
    task: input.task,
    seat: input.seat,
    commit: input.commit,
    version: input.version,
    at: (input.at ?? new Date()).toISOString(),
  };
  return append(dir, event, sameFact);
}

/**
 * Records the installer's acknowledgment that a task's commit is installed. It is the only event
 * the readers treat as an install, and a second acknowledgment of the same task, commit and
 * version is a no-op.
 *
 * This store checks the metadata, never who called it. The command layer owns the acknowledgment:
 * the install may be recorded only when the designated installer (builder-1) or the owner itself
 * acknowledged it — not because some seat holds a lease of its own. `installedBy` names that
 * acknowledging installer.
 */
export function recordGreenSliceInstall(
  dir: string,
  input: { task: string; commit: string; version: string; installedBy: string; at?: Date },
): GreenSliceRecorded<GreenSliceInstall> {
  const task = tokenProblem(input.task, 'task');
  if (task) return { ok: false, why: task };
  const commit = commitProblem(input.commit);
  if (commit) return { ok: false, why: commit };
  const version = versionProblem(input.version);
  if (version) return { ok: false, why: version };
  const installedBy = tokenProblem(input.installedBy, 'installer');
  if (installedBy) return { ok: false, why: installedBy };
  const instant = instantProblem(input.at);
  if (instant) return { ok: false, why: instant };
  const event: GreenSliceInstall = {
    kind: 'install',
    task: input.task,
    commit: input.commit,
    version: input.version,
    installedBy: input.installedBy,
    at: (input.at ?? new Date()).toISOString(),
  };
  return append(dir, event, sameFact);
}

/** Every well-formed event, oldest first. A hand-edited entry of the wrong shape is dropped. */
export function readGreenSliceJournal(dir: string): GreenSliceEvent[] {
  return readJournal(dir);
}

/**
 * The slices the watch alerts on: a ready event with no install event naming the same task and
 * commit, oldest first, one per task and commit (the earliest ready says how long it has waited).
 * An install recorded before its ready still covers it — the commit is in an installed build.
 */
export function pendingGreenSlices(dir: string): PendingGreenSlice[] {
  const events = readJournal(dir);
  const installed = new Set<string>();
  for (const event of events) {
    if (event.kind === 'install') installed.add(factKey(event.task, event.commit));
  }
  const seen = new Set<string>();
  const pending: PendingGreenSlice[] = [];
  for (const event of events) {
    if (event.kind !== 'ready') continue;
    const key = factKey(event.task, event.commit);
    if (installed.has(key) || seen.has(key)) continue;
    seen.add(key);
    pending.push({
      task: event.task,
      seat: event.seat,
      commit: event.commit,
      version: event.version,
      readyAt: event.at,
    });
  }
  return pending.sort((left, right) => Date.parse(left.readyAt) - Date.parse(right.readyAt));
}

// ---- the file ------------------------------------------------------------------------------

function readJournal(dir: string): GreenSliceEvent[] {
  const path = greenSlicesPath(dir);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON; move it aside and run the command again`);
  }
  const document = parsed as { format?: unknown; events?: unknown } | null;
  if (document === null || typeof document !== 'object' || document.format !== 1 || !Array.isArray(document.events)) {
    throw new Error(`${path} is not a green-slice journal of format 1; move it aside and run the command again`);
  }
  return document.events.filter(isEvent);
}

function append<E extends GreenSliceEvent>(
  dir: string,
  candidate: E,
  same: (left: GreenSliceEvent, right: GreenSliceEvent) => boolean,
): GreenSliceRecorded<E> {
  return withLock(join(dir, LOCK_DIR), () => {
    const events = readJournal(dir);
    const existing = events.find((event) => same(event, candidate)) as E | undefined;
    if (existing) return { ok: true, added: false, event: existing };
    const next = fit(events, candidate);
    if (next === null) {
      const what = candidate.kind === 'ready' ? 'a new green slice' : 'this install';
      return {
        ok: false,
        why: `${greenSlicesPath(dir)} holds ${GREEN_SLICES_MAX} pending green slices and recording ${what} would drop one of them; install a pending slice before recording another`,
      };
    }
    writeAtomic(greenSlicesPath(dir), `${JSON.stringify({ format: 1, events: next }, null, 2)}\n`);
    return { ok: true, added: true, event: candidate };
  });
}

/**
 * The journal with `candidate` appended, dropping installed history when it is at its bound. A
 * pending ready is never dropped: an install from this journal keeps its ready while it is held,
 * and the pair is dropped together. When nothing but pending slices is left and the candidate
 * still does not fit, the answer is null and the caller refuses the record — the alert stays.
 *
 * An incoming install covers the ready it names: if room must be made, that ready may be dropped
 * like any other installed history.
 */
function fit(events: GreenSliceEvent[], candidate: GreenSliceEvent): GreenSliceEvent[] | null {
  const kept = [...events];
  while (kept.length >= GREEN_SLICES_MAX) {
    const installed = new Set<string>();
    for (const event of kept) {
      if (event.kind === 'install') installed.add(factKey(event.task, event.commit));
    }
    if (candidate.kind === 'install') installed.add(factKey(candidate.task, candidate.commit));
    // A covered ready is installed history. Dropping it first never resurrects an alert.
    let droppable = kept.findIndex((event) => event.kind === 'ready' && installed.has(factKey(event.task, event.commit)));
    // An install is history only once no ready of its task and commit remains to be covered.
    if (droppable === -1) {
      droppable = kept.findIndex((event) => event.kind === 'install'
        && !kept.some((ready) => ready.kind === 'ready' && factKey(ready.task, ready.commit) === factKey(event.task, event.commit)));
    }
    if (droppable === -1) return null;
    kept.splice(droppable, 1);
  }
  kept.push(candidate);
  return kept;
}

/** The idempotency key: the same kind of fact about the same task, commit and version is one
 *  event. A ready recorded again with another seat is still the same fact; the first stands. */
function sameFact(left: GreenSliceEvent, right: GreenSliceEvent): boolean {
  return left.kind === right.kind
    && left.task === right.task
    && left.commit === right.commit
    && left.version === right.version;
}

function factKey(task: string, commit: string): string {
  return `${task}\u0000${commit}`;
}

// ---- validation ----------------------------------------------------------------------------

function tokenProblem(value: string, field: string): string | null {
  if (typeof value !== 'string' || !TOKEN.test(value)) return `the ${field} is not one token`;
  return null;
}

function commitProblem(value: string): string | null {
  if (typeof value !== 'string' || !COMMIT.test(value)) return 'the commit is not 7-40 lowercase hex';
  return null;
}

function versionProblem(value: string): string | null {
  if (typeof value !== 'string' || !VERSION.test(value)) return 'the version is not one version token';
  return null;
}

function instantProblem(value: Date | undefined): string | null {
  if (value === undefined) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return 'the time is not a readable instant';
  return null;
}

// ---- the read door ---------------------------------------------------------------------------

/** A stored entry is handed out only when every field it must hold is the shape the recorders
 *  write. An install whose fields are not those is not an install: dropping it leaves its slice
 *  pending, never installed. */
function isEvent(value: unknown): value is GreenSliceEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (!isToken(event.task) || !isCommit(event.commit) || !isVersion(event.version) || !isInstant(event.at)) return false;
  if (event.kind === 'ready') return isToken(event.seat);
  if (event.kind === 'install') return isToken(event.installedBy);
  return false;
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && COMMIT.test(value);
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION.test(value);
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value));
}
