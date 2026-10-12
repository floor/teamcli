import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoredReading, StoredSpend } from './budgets/readings.ts';
import type { LaunchedIdentity } from './launch/identity.ts';
import { cleanClassification, type Classification } from './launch/progress.ts';

// What a team keeps: the live session's seats, worktrees and watch, and the project's last
// readings, which outlive every session (§ 4.4). It lives beside the team file and is written by
// team alone: every write holds the lock and goes through a temporary file.

export type SeatState = {
  stage: 'launched' | 'named' | 'ready';
  /** The CLI the seat was launched with: `down` stops it under it when the file renamed it. */
  cli?: string;
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

export type WorktreeState = {
  path: string;
  branch: string;
  own_commits?: boolean;
  seat?: string;
  setup: 'ok' | 'failed';
};

export type SessionState = {
  started?: { at: string; by: string };
  seats: Record<string, SeatState>;
  worktrees: Record<string, WorktreeState>;
  watch?: { pid: number; heartbeat: string };
  /**
   * The team file this session was launched from. A lead in the lobby resolves it from a pane
   * the state records, and from no other path. Absent on a session started before it was written.
   */
  launched_file?: string;
  nudge?: { pending_since: string | null };
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
  sessions: Record<string, SessionState>;
};

export const STATE_FILE = 'team.state.json';
export const LOCK_FILE = 'team.lock';
export const LOG_FILE = 'team.log';

export function emptySession(): SessionState {
  return { seats: {}, worktrees: {} };
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
  for (const session of Object.values(state.sessions)) {
    session.seats ??= {};
    session.worktrees ??= {};
    // A stored classification is validated here, at the one door a value from outside the program
    // enters through: one of the closed list, or `unknown` for anything else. Every later reader —
    // the log line a waiting seat writes, the status row and its `difference:` line, the prompt a
    // resumed wait draws — takes the reading from here, so a hand-edited or corrupted record can
    // never print whatever it holds.
    for (const seat of Object.values(session.seats)) {
      if (seat.waiting && typeof seat.waiting === 'object') {
        seat.waiting.classification = cleanClassification(seat.waiting.classification);
      }
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

function alive(pid: number): boolean {
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
  if (found !== holder && Number.isInteger(found) && found > 0 && alive(found)) {
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
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
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
