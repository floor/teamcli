import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoredReading, StoredSpend } from './budgets/readings.ts';
import { validLockName } from './lock/name.ts';
import type { LaunchedIdentity } from './launch/identity.ts';
import { cleanClassification, type Classification } from './launch/progress.ts';

// What a team keeps: the live session's seats, worktrees and watch, and the project's last
// readings, which outlive every session (§ 4.4). It lives beside the team file and is written by
// team alone: every write holds the lock and goes through a temporary file.

export const SEAT_ID_PATTERN = /^seat_[0-9a-f]{12}$/;

export function isSeatId(value: unknown): value is string {
  return typeof value === 'string' && SEAT_ID_PATTERN.test(value);
}

export function mintSeatId(): string {
  return `seat_${randomBytes(6).toString('hex')}`;
}

export type RetainedSeat = {
  id: string;
  last_active?: string;
};

export type SeatState = {
  /** Stable seat handle (`seat_<12 lowercase hex>`), minted when the seat is first recorded. */
  id?: string;
  stage: 'launched' | 'named' | 'ready';
  /** The CLI the seat was launched with: `down` stops it under it when the file renamed it. */
  cli?: string;
  /** ISO 8601 timestamp when the seat last reached ready or was seen working. */
  last_active?: string;
  pane?: string;
  /** The herdr workspace, so a later command can close it without listing agents. */
  workspace?: string;
  /**
   * The folder the seat's launch line was run in, when the state records it. A resumed seat's
   * pane keeps that folder, so its launch line is checked there, never against the file's.
   */
  start_cwd?: string;
  cli_version?: string;
  rules?: 'option' | 'message' | 'undelivered';
  worked?: boolean;
  /**
   * The process `team` launched for this seat, read after its idle prompt appeared: the pane's
   * shell pid and the foreground pids that are not the shell. A pane that no longer holds them
   * is not the seat (`src/launch/identity.ts`). Absent on a seat launched before this was
   * recorded, and on one herdr could not tell about: both keep today's behaviour.
   */
  launched?: LaunchedIdentity;
  /**
   * The agent session herdr reported for this seat when its idle prompt appeared, beside the
   * process ids. A later pane whose pids differ and whose live session equals this one is the
   * seat (`replacedSeat`). Absent when the launch's reading had none.
   */
  agent_session?: string;
  /**
   * What this launch declared, written when the idle prompt appears and left in place when a
   * later ready write merges onto the record. A skip of a seat that is already ready does not
   * set them: the file may have drifted, and the record has to stay the launch. Absent on a
   * seat launched before they were stored.
   */
  model?: string;
  version?: string;
  /** Absent when the launch set no effort word. A later launch that sets none removes it. */
  effort?: string;
  /** The launch command of that idle record. Stored for the registry; reload does not compare it. */
  launch_line?: string;
  // `own_commits` is the home for a temporary seat whose end is `merged:` and that has no worktree.
  // A seat in a worktree keeps that record on the worktree instead.
  temporary?: { like: string; until: string; task?: string; own_commits?: boolean };
  /**
   * Set when a launch left the pane at a dialog. `waiting-owner` is the stored name
   * even when the orchestrator may answer: it is waiting for an authorised human path.
   */
  waiting?: {
    state: 'waiting-owner' | 'trust-sent-recovery';
    classification: Classification;
    manual?: true;
    sentAt?: string;
    version?: string;
    folder?: string;
  };
};

/** A seat's waiting record, as the seat shape above stores it. Named for the plan and the
 *  pause, which carry it between the state and the prompt. */
export type WaitingRecord = NonNullable<SeatState['waiting']>;

/**
 * Whether a state seat's record is one the team file still speaks for: a seat the file
 * declares, or a temporary seat — `team add --temporary` never writes one into the file, so
 * its record is the only place it exists. Any other record names a seat the file no longer
 * has, and the commands that resolve who holds a pane read past it: the file is the truth,
 * and only `team check --repair` drops the record.
 */
export function seatOfFile(name: string, seat: SeatState, declared: ReadonlySet<string>): boolean {
  return seat.temporary !== undefined || declared.has(name);
}

export type WorktreeState = {
  path: string;
  branch: string;
  own_commits?: boolean;
  seat?: string;
  setup: 'ok' | 'failed';
};

export type SwapRecord = { by: string; at: string };

/**
 * A hold on the team's work: the reason it was placed, who placed it and when, and the instant
 * it lapses (`until` absent: it stands until released). A hold past its `until` reads as no
 * hold at all (`liveHold`), so an expired record needs no writer to clear it.
 */
export type HoldRecord = { reason: string; by: string; at: string; until?: string };

/**
 * One process a seat started, recorded by `team proc add`: who recorded it, when, the pid to
 * watch, and what it is. Nothing here launches or signals a process — a record is a seat's
 * note that something of its own is running, and a pid is how the note goes out on its own.
 */
export type ProcRecord = {
  /** The seat's herdr name, or `owner` for the owner at a terminal. */
  by: string;
  /** ISO 8601, printed as stored, one shape everywhere. */
  at: string;
  /** The process id to watch. Absent when the caller recorded no pid: the note then stands
   *  until `done` clears it. */
  pid?: number;
  /** One cleaned line: what the process is. */
  note?: string;
};

export type SessionState = {
  started?: { at: string; by: string };
  seats: Record<string, SeatState>;
  /**
   * Seat handles retained across `remove --keep`, `down`, and `up` repair so a declared seat keeps
   * its `id` and `last_active` when relaunched, while `seats` holds only active runtime records.
   */
  retained_seats?: Record<string, RetainedSeat>;
  /**
   * A lead seat (the orchestrator's or the operator's) stopped for a replacement by `team remove
   * <lead> --keep`: who stopped it and when. The file is not edited — a lead is never `stopped:` —
   * so this record is what tells `doctor`, `status` and the next `add` that the gap is a swap in
   * progress and not a crash. `team add <lead>` (or `up`) clears it once the seat runs again.
   */
  swapping?: Record<string, SwapRecord>;
  worktrees: Record<string, WorktreeState>;
  /**
   * The watch: the pane and workspace it runs in, the process once a pass has recorded one, and
   * the last heartbeat. `pid` is absent from the moment `up` — or an owner's own run — starts the
   * watch until that pane's first pass records its process; `pane` is absent only on a record an
   * older detached watch left.
   */
  watch?: { pid?: number; heartbeat: string; pane?: string; workspace?: string };
  /**
   * The team file this session was launched from. A lead in the lobby resolves it from a pane
   * the state records, and from no other path. Absent on a session started before it was written.
   */
  launched_file?: string;
  /**
   * The team file `up` resolved, and who may read it. Written before the watch's pane runs its
   * command, because a flagless watch started in the project folder would miss this file or read
   * another one. The pane the record names, or the process a pass records on `watch.pid`, may
   * read it. Any other non-owner is refused.
   */
  watchdog?: { file: string; pane?: string };
  nudge?: { pending_since: string | null };
  /**
   * The processes this session's seats recorded with `team proc add`, by name. A record with a
   * `pid` is live while that pid is; one without a pid lives until `done`. Readers never tidy
   * the map — a dead record is skipped where it is read and leaves the file at the next write
   * to it (`add`, `done`), because expiry is a reading, never a timer.
   */
  procs?: Record<string, ProcRecord>;
};

export type State = {
  format: 1;
  last_valid?: { read_at: string; file: string };
  /**
   * The project's last readings, whatever session saw them: a screen reading keyed by account,
   * window and seat, a check reading by account and window (§ 4.4).
   */
  budgets?: Record<string, StoredReading>;
  /** The project's last spend check readings, keyed by account. */
  spend?: Record<string, StoredSpend>;
  /**
   * The team's own hold: `team hold`'s one record, cleared by `team hold --release` and read as
   * absent once `until` has passed. A hold is the project's, not one session's.
   */
  hold?: HoldRecord;
  sessions: Record<string, SessionState>;
};

export const STATE_FILE = 'team.state.json';
export const LOCK_FILE = 'team.lock';
export const LOG_FILE = 'team.log';

export function emptySession(): SessionState {
  return { seats: {}, worktrees: {} };
}

/** Whether a value from the state file is the record `team hold` writes: a reason with text, a
 *  name and an instant that parse, and an `until`, when present, that parses too. Anything else
 *  is dropped at the read door, so a hand-edited file can never print what it made up. */
function isHoldRecord(value: unknown): value is HoldRecord {
  if (value === null || typeof value !== 'object') return false;
  const hold = value as Partial<HoldRecord>;
  if (typeof hold.reason !== 'string' || hold.reason === '') return false;
  if (typeof hold.by !== 'string' || typeof hold.at !== 'string') return false;
  if (Number.isNaN(Date.parse(hold.at))) return false;
  if (hold.until !== undefined && (typeof hold.until !== 'string' || Number.isNaN(Date.parse(hold.until)))) return false;
  return true;
}

/** The hold in force at `now`: the stored record, or null when none stands — none stored, or
 *  one past its `until`. The record itself is left where it is; the next hold write replaces
 *  it. Every reader goes through here, so the expiry is one rule in one place. */
export function liveHold(state: State, now: Date): HoldRecord | null {
  const hold = state.hold;
  if (hold === undefined) return null;
  if (hold.until !== undefined && Date.parse(hold.until) <= now.getTime()) return null;
  return hold;
}

/** The hold as its readers print it — `team hold`'s own line, `status`'s note and `doctor`'s
 *  line: `hold until <instant>: <reason>`, or `hold: <reason>` when it names no end. One
 *  shape for every reader, so the three can never drift apart. */
export function holdText(hold: HoldRecord): string {
  return hold.until === undefined ? `hold: ${hold.reason}` : `hold until ${hold.until}: ${hold.reason}`;
}

// The state in `dir` (the folder of the team file). A missing file is an empty state; a file
// that can't be read as a state is an error, never silently replaced.
export function readState(dir: string): State {
  const path = join(dir, STATE_FILE);
  if (!existsSync(path)) return { format: 1, sessions: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON; move it aside and run the command again`);
  }
  const state = parsed as Partial<State> | null;
  if (!state || typeof state !== 'object' || state.format !== 1 || typeof state.sessions !== 'object' || !state.sessions) {
    throw new Error(`${path} is not a team state of format 1; move it aside and run the command again`);
  }
  // The hold, cleaned at the same door: a record that is not the one `team hold` writes is
  // dropped here, so the reason, the name and the instants later readers print are the ones
  // the command wrote, never a hand-edited file's.
  if (state.hold !== undefined && !isHoldRecord(state.hold)) delete state.hold;
  for (const session of Object.values(state.sessions)) {
    session.seats ??= {};
    session.worktrees ??= {};
    // A stored classification is validated here, at the one door a value from outside the program
    // enters through: one of the closed list, or `unknown` for anything else. Every later reader —
    // the log line a waiting seat writes, the status row and its `difference:` line, the prompt a
    // resumed wait draws — takes the reading from here, so a hand-edited or corrupted record can
    // never print whatever it holds.
    const seenIds = new Set<string>();
    for (const seat of Object.values(session.seats)) {
      if (seat.id !== undefined && (!isSeatId(seat.id) || seenIds.has(seat.id))) delete seat.id;
      else if (seat.id !== undefined) seenIds.add(seat.id);
      if (seat.model !== undefined && typeof seat.model !== 'string') delete seat.model;
      if (seat.version !== undefined && typeof seat.version !== 'string') delete seat.version;
      if (seat.effort !== undefined && typeof seat.effort !== 'string') delete seat.effort;
      if (seat.launch_line !== undefined && typeof seat.launch_line !== 'string') delete seat.launch_line;
      if (seat.last_active !== undefined && typeof seat.last_active !== 'string') delete seat.last_active;
      if (seat.waiting && typeof seat.waiting === 'object') {
        seat.waiting.classification = cleanClassification(seat.waiting.classification);
      }
    }
    if (session.retained_seats && typeof session.retained_seats === 'object') {
      for (const [name, retained] of Object.entries(session.retained_seats)) {
        if (!retained || typeof retained !== 'object' || !isSeatId(retained.id) || seenIds.has(retained.id)) {
          delete session.retained_seats[name];
          continue;
        }
        seenIds.add(retained.id);
        if (retained.last_active !== undefined && typeof retained.last_active !== 'string') {
          delete retained.last_active;
        }
      }
    } else if (session.retained_seats !== undefined) {
      delete session.retained_seats;
    }
    if (session.swapping && typeof session.swapping === 'object') {
      for (const [name, swap] of Object.entries(session.swapping)) {
        if (!swap || typeof swap !== 'object' || typeof swap.by !== 'string' || typeof swap.at !== 'string') {
          delete session.swapping[name];
        }
      }
    } else if (session.swapping !== undefined) {
      delete session.swapping;
    }
    // A proc record enters from the file like every other value, and is cleaned here at the same
    // door: a key that is not a name by the lock's rule is dropped, and so is a record that does
    // not name who recorded it and when; a pid or note of the wrong shape goes with it. Only
    // `add` writes a key, and it refuses anything but `validLockName` — a key that survives this
    // door is a name that was printed by a reader, never a path.
    if (session.procs && typeof session.procs === 'object') {
      for (const [name, proc] of Object.entries(session.procs)) {
        if (
          !validLockName(name) ||
          !proc ||
          typeof proc !== 'object' ||
          typeof proc.by !== 'string' ||
          proc.by === '' ||
          typeof proc.at !== 'string'
        ) {
          delete session.procs[name];
          continue;
        }
        if (proc.pid !== undefined && !(Number.isInteger(proc.pid) && proc.pid > 0)) delete proc.pid;
        if (proc.note !== undefined && typeof proc.note !== 'string') delete proc.note;
      }
    } else if (session.procs !== undefined) {
      delete session.procs;
    }
    // Read old, write new: readings used to be held under a session. They are the project's
    // (§ 4.4), so every session's records are merged to the top level here — no reader loses one,
    // and the next write persists the new shape.
    const held = session as SessionState & { budgets?: Record<string, StoredReading>; spend?: Record<string, StoredSpend> };
    if (held.budgets) {
      state.budgets = mergeReadings(state.budgets, held.budgets);
      delete held.budgets;
    }
    if (held.spend) {
      state.spend = mergeSpend(state.spend, held.spend);
      delete held.spend;
    }
  }
  return state as State;
}

/**
 * One record per slot when two sessions hold the same account, window and seat: the reading that
 * counts wins — a confirmed one, and among those the newest change (§ 4.3).
 */
function mergeReadings(
  top: Record<string, StoredReading> | undefined,
  held: Record<string, StoredReading>,
): Record<string, StoredReading> {
  const merged = top ?? {};
  for (const [key, reading] of Object.entries(held)) {
    const current = merged[key];
    merged[key] = !current
      || (reading.confirmed && !current.confirmed)
      || (reading.confirmed === current.confirmed && Date.parse(reading.changedAt) > Date.parse(current.changedAt))
      ? reading
      : current;
  }
  return merged;
}

/** The same for spend: one record per account, the reading whose check ran last winning. */
function mergeSpend(
  top: Record<string, StoredSpend> | undefined,
  held: Record<string, StoredSpend>,
): Record<string, StoredSpend> {
  const merged = top ?? {};
  for (const [key, reading] of Object.entries(held)) {
    const current = merged[key];
    merged[key] = !current || Date.parse(reading.at) > Date.parse(current.at) ? reading : current;
  }
  return merged;
}

/**
 * The `team proc` records of one session a reader may show, in name order: a record with a `pid`
 * while that pid is alive, and one without a pid until `done`. A dead record is skipped here and
 * taken out of the file by the next write (`pruneProcs`), never by a reader.
 */
export function liveProcs(session: SessionState, alive: (pid: number) => boolean = pidAlive): Array<[string, ProcRecord]> {
  const procs = session.procs ?? {};
  return Object.entries(procs)
    .filter(([, proc]) => proc.pid === undefined || alive(proc.pid))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Drops one session's records whose pid is dead — what `add` and `done` do before they write,
 *  so a record a reader skipped is gone from the file too. */
export function pruneProcs(session: SessionState, alive: (pid: number) => boolean = pidAlive): void {
  if (!session.procs) return;
  for (const [name, proc] of Object.entries(session.procs)) {
    if (proc.pid !== undefined && !alive(proc.pid)) delete session.procs[name];
  }
}

// Reads the state, lets `change` edit it, and writes it back, all under the lock.
export function updateState<T>(dir: string, change: (state: State) => T): T {
  return withLock(dir, () => {
    const state = readState(dir);
    const result = change(state);
    writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    return result;
  });
}

export function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/** Whether a process with this pid exists. A pid owned by another user counts as alive
 *  (`EPERM`), which is also what the lock's stale-holder rule wants. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Removes a lock whose holder is dead. Two commands may see the same dead holder: the lock is
// moved aside first, which only one of them can do, and put back if it turns out to be a fresh
// one that another command took in between.
function takeOver(path: string, holder: number): boolean {
  const aside = `${path}.${process.pid}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return false;
  }
  const found = Number(readFileSync(aside, 'utf8').trim());
  if (found !== holder && Number.isInteger(found) && found > 0 && pidAlive(found)) {
    try {
      renameSync(aside, path);
    } catch {}
    return false;
  }
  unlinkSync(aside);
  return true;
}

// One writer at a time. The lock file holds its holder's pid; a lock whose holder is dead is
// taken over, and `onStale` is told.
export function withLock<T>(dir: string, work: () => T, options: { waitMs?: number; onStale?: (pid: number) => void } = {}): T {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  const deadline = Date.now() + (options.waitMs ?? 5000);
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder = NaN;
      try {
        holder = Number(readFileSync(path, 'utf8').trim());
      } catch {
        continue; // released between the two calls
      }
      if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
        if (Date.now() > deadline) throw new Error(`another team command (pid ${holder}) holds ${path}; try again when it is done`);
        pause(50);
        continue;
      }
      // A dead holder, or a lock file too young to hold its pid yet.
      if (!Number.isInteger(holder) && Date.now() - statSync(path).mtimeMs < 1000) {
        pause(20);
        continue;
      }
      if (takeOver(path, holder)) options.onStale?.(holder);
    }
  }
  try {
    return work();
  } finally {
    try {
      unlinkSync(path);
    } catch {}
  }
}
