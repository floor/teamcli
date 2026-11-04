// A machine lock: one named directory under `<home>/.config/team/locks/<name>.lock`, taken by a
// plain `mkdir` and released only by the caller the holder file names.
//
// Two slips in the hand-made form are closed here. `mkdir -p` succeeds when the directory
// already exists, so the take must not be recursive on the lock itself — an existing directory
// is a held lock, and this process writes nothing into it. The holder file is written only after
// that `mkdir` succeeds, and written by rename, so a failed take leaves no `who` and a reader
// never sees a half-written one.
//
// Waiters queue fairly. A take that waits leaves a ticket in `<name>.queue`, named by its
// arrival so the files sort in order, and only the oldest live ticket may take the lock when it
// frees; a take that does not wait is refused while a queue stands, so nobody jumps it. A
// ticket whose waiter process is gone is pruned by the next waiter to look.
//
// A stale holder is reclaimed only on proof. This is not the session mutator lock
// (`launch/run-lock.ts`): a machine lock guards a person's run, which outlives the `team lock`
// process that took it, so that process's pid is dead immediately and proves nothing. The
// holder file instead records the long-lived shell's pid — the shell the run lives in. When
// that pid is dead, and the holder file re-reads byte for byte as it did before the check, the
// next take clears the lock and takes it. A holder with no recorded pid, a live pid, or a
// missing or unreadable holder file is never cleared and never guessed, including for the owner.
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callerOf, describeCaller } from '../caller.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Io } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import { pidAlive } from '../state.ts';
import { validLockName } from './name.ts';

/** The lock's name rule lives in its own leaf module, so the state can clean a key by it too. */
export { LOCK_NAME, LOCK_NAME_MAX, validLockName } from './name.ts';
/** A wait longer than a day is a mistake, not a hold. */
export const WAIT_MAX_SECONDS = 86_400;
const WHO_FILE = 'who';

export type LockIdentity = { team: string; by: string };
/** One holder (or waiter) record. `pid` is the long-lived shell the run lives in, when the take
 *  could name it; a record written before the pid was recorded has none, and is never stale. */
export type Who = LockIdentity & { run: string; at: string; pid?: number };

export type LockHome = {
  /** The home whose `.config/team/locks` is used. Required, so no test reaches the owner's. */
  home: string;
  /** When set, the caller is this identity and the team file is not read. */
  identity?: LockIdentity;
};

export type Sleeper = (ms: number) => void | Promise<void>;

export type LockSources = LockHome & {
  now: () => Date;
  sleep: Sleeper;
  /** The long-lived shell's pid to record for this take. Absent: no pid is recorded, and the
   *  lock this take leaves can never be read as stale. The real source is the parent process —
   *  the shell that ran `team lock` and goes on to run the work. */
  pid?: () => number;
  /** This waiting process's own pid, carried in its queue ticket's name so a later waiter can
   *  prune a ticket whose waiter is gone. Absent: this process's pid. */
  waiterPid?: () => number;
  /** Whether a pid names a live process. Absent: signal 0. A pid this cannot judge (another
   *  user's process) reads as alive — never as stale. */
  alive?: (pid: number) => boolean;
};

export const realLockHome: LockHome = { home: homedir() };

export const realLockSources: LockSources = {
  ...realLockHome,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  pid: () => process.ppid,
  waiterPid: () => process.pid,
  alive: pidAlive,
};

/** `<home>/.config/team/locks`, the same home `lobbyDir` uses, one folder in from it. */
export function locksRoot(home: string): string {
  return join(home, '.config', 'team', 'locks');
}

export function lockDirectory(home: string, name: string): string {
  return join(locksRoot(home), `${name}.lock`);
}

/** The queue for `name`: one ticket file per waiter, beside the lock it waits for. */
export function queueDirectory(home: string, name: string): string {
  return join(locksRoot(home), `${name}.queue`);
}

/** The stamp the hand-written holder files use: UTC, to the second. */
export function lockStamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 48) return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH === 0 ? `${days}d` : `${days}d ${remH}h`;
}

export function formatWho(who: Who): string {
  const pid = who.pid === undefined ? '' : `pid: ${who.pid}\n`;
  return `team: ${who.team}\nrun: ${who.run}\nby: ${who.by}\nat: ${who.at}\n${pid}`;
}

/** The holder file, or null when it is not the lines this command writes: the four identity
 *  lines, plus the shell pid when the take recorded one. A file from before the pid has four. */
export function parseWho(text: string): Who | null {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = body.split('\n');
  if (lines.length !== 4 && lines.length !== 5) return null;
  const keys = ['team', 'run', 'by', 'at'] as const;
  const values: Record<(typeof keys)[number], string> = { team: '', run: '', by: '', at: '' };
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!key) return null;
    const line = lines[i] ?? '';
    const prefix = `${key}:`;
    if (!line.startsWith(prefix)) return null;
    const rest = line.slice(prefix.length);
    if (rest !== '' && !rest.startsWith(' ')) return null;
    values[key] = rest.startsWith(' ') ? rest.slice(1) : '';
  }
  if (!values.team || !values.by || !values.at) return null;
  if (Number.isNaN(Date.parse(values.at))) return null;
  if (lines.length === 4) return values;
  const pidLine = lines[4] ?? '';
  if (!pidLine.startsWith('pid: ')) return null;
  const pid = Number(pidLine.slice('pid: '.length));
  if (!Number.isInteger(pid) || pid < 1) return null;
  return { ...values, pid };
}

export function takenText(name: string, who: Who): string {
  return `${name}: taken\n${formatWho(who)}`;
}

export function heldLine(name: string, who: Who, now: Date): string {
  const run = who.run === '' ? '' : ` — ${who.run}`;
  const age = formatAge(now.getTime() - Date.parse(who.at));
  return `${name}: held since ${who.at} by ${who.by} (${who.team})${run}, for ${age}`;
}

export function notYoursLine(name: string, who: Who): string {
  const run = who.run === '' ? '' : ` — ${who.run}`;
  return `${name}: held by ${who.by} (${who.team}) since ${who.at}${run}, not you`;
}

/** Who is taking or releasing: the injected identity, or the caller and the project in this folder. */
export function resolveIdentity(io: Io, sources: LockHome): { ok: true; identity: LockIdentity } | { ok: false; message: string } {
  if (sources.identity) return cleaned(sources.identity);
  const by = plainLine(describeCaller(callerOf(io))).trim();
  let loaded;
  try {
    loaded = readTeamConfig(io.cwd, { home: sources.home });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (!loaded.ok) return { ok: false, message: loaded.errors[0]?.message ?? 'the team file can\'t be read' };
  return cleaned({ team: loaded.team.project, by });
}

function cleaned(identity: LockIdentity): { ok: true; identity: LockIdentity } | { ok: false; message: string } {
  const team = plainLine(identity.team).trim();
  const by = plainLine(identity.by).trim();
  if (!team || !by) return { ok: false, message: 'the caller has no project to record' };
  return { ok: true, identity: { team, by } };
}

export type TakeResult =
  | { kind: 'taken'; who: Who }
  | { kind: 'held'; line: string }
  | { kind: 'bad-name' }
  | { kind: 'io'; message: string };

type Attempt = TakeResult | { kind: 'retry'; line: string };

type Seen =
  | { kind: 'absent' }
  | { kind: 'not-directory' }
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'who'; who: Who };

function see(dir: string): Seen {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' };
  }
  // A symlink is not followed: the name would otherwise read and write outside the lock root.
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { kind: 'not-directory' };
  try {
    const text = readFileSync(join(dir, WHO_FILE), 'utf8');
    const who = parseWho(text);
    return who ? { kind: 'who', who } : { kind: 'unreadable' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
  }
}

function heldText(name: string, seen: Exclude<Seen, { kind: 'absent' }>, now: Date): string {
  if (seen.kind === 'who') return heldLine(name, seen.who, now);
  if (seen.kind === 'missing') return `${name}: held; its holder file is not there yet`;
  if (seen.kind === 'not-directory') return `${name}: held; its lock is not a directory`;
  return `${name}: held; its holder file cannot be read`;
}

/** Missing or present holder: the take may be retried. Anything else is final — waiting will not fix it. */
function mayRetry(seen: Seen): boolean {
  return seen.kind === 'missing' || seen.kind === 'who';
}

function writeWho(root: string, name: string, dir: string, text: string): void {
  // Beside the lock, not inside it, so a crash mid-write does not leave a stray file in the
  // directory that is the exclusion. `wx` creates the temp; rename publishes `who` whole.
  const temp = join(root, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(temp, text, { flag: 'wx' });
  try {
    renameSync(temp, join(dir, WHO_FILE));
  } catch (error) {
    try { unlinkSync(temp); } catch { /* already moved, or already gone */ }
    throw error;
  }
}

/** What one take carries, beyond the lock's own name and holder-to-be. */
type TakeInput = {
  home: string;
  name: string;
  run: string;
  identity: LockIdentity;
  now: () => Date;
  pid?: () => number;
  waiterPid?: () => number;
  alive?: (pid: number) => boolean;
};

/** The shell pid worth recording: a whole pid above the init process. Anything else records
 *  nothing — an unrecorded holder is never read as stale, which is the safe side. */
function shellPidOf(input: TakeInput): number | undefined {
  const pid = input.pid?.();
  return pid !== undefined && Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

function aliveOf(input: TakeInput): (pid: number) => boolean {
  return input.alive ?? pidAlive;
}

/** A waiter's place in its ticket's name: arrival instant, then the waiting process's pid, then
 *  a nonce, so the names sort in arrival order and a dead waiter can be told from its name. */
function ticketName(nowMs: number, waiterPid: number): string {
  return `${String(nowMs).padStart(15, '0')}-${waiterPid}-${randomBytes(4).toString('hex')}`;
}

function ticketWaiterPid(file: string): number | null {
  const match = /^[0-9]+-([0-9]+)-/.exec(file);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function listTickets(home: string, name: string): string[] {
  const dir = queueDirectory(home, name);
  try {
    // A symlink is not followed, exactly as at the lock path: the queue would otherwise read
    // and prune outside the lock root. An unreadable queue reads as no queue.
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Removes tickets whose waiter process is gone, never `keep` (the caller's own). A ticket
 *  whose name carries no readable pid is left standing: unknown is live, never pruned. */
function pruneTickets(input: TakeInput, keep: string | null): void {
  const alive = aliveOf(input);
  const dir = queueDirectory(input.home, input.name);
  for (const file of listTickets(input.home, input.name)) {
    if (file === keep) continue;
    const pid = ticketWaiterPid(file);
    if (pid === null || alive(pid)) continue;
    try { unlinkSync(join(dir, file)); } catch { /* another waiter pruned it first */ }
  }
}

/** Leaves this waiter's ticket and returns its file name, or null when it could not be written. */
function enqueue(input: TakeInput, who: Who): string | null {
  const dir = queueDirectory(input.home, input.name);
  const waiterPid = input.waiterPid?.() ?? process.pid;
  const file = ticketName(input.now().getTime(), waiterPid);
  try {
    mkdirSync(dir, { recursive: true });
    if (lstatSync(dir).isSymbolicLink()) return null;
    writeFileSync(join(dir, file), formatWho(who), { flag: 'wx' });
    return file;
  } catch {
    return null;
  }
}

/** Takes this waiter's ticket away; the queue folder goes with the last ticket, best effort. */
function dequeue(home: string, name: string, ticket: string): void {
  const dir = queueDirectory(home, name);
  try { unlinkSync(join(dir, ticket)); } catch { /* already gone */ }
  try { rmdirSync(dir); } catch { /* other waiters remain, or it is already gone */ }
}

/**
 * Clears a holder proven stale, if one stands. Proof
 * is narrow: the holder file records a shell pid, that pid is dead, and the file re-reads byte
 * for byte as it did before the liveness check — so a holder replaced between the reads, a
 * live shell, and a file with no pid all leave the lock exactly as it was.
 */
function clearStaleHolder(input: TakeInput): void {
  const dir = lockDirectory(input.home, input.name);
  const whoPath = join(dir, WHO_FILE);
  const alive = aliveOf(input);
  try {
    // The same refusal `see` makes: a symlink at the lock path is never followed, so a stale
    // proof is never read — or cleared — through one.
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  } catch {
    return;
  }
  let first: string;
  try {
    first = readFileSync(whoPath, 'utf8');
  } catch {
    return;
  }
  const seen = parseWho(first);
  if (seen === null || seen.pid === undefined || alive(seen.pid)) return;
  let again: string;
  try {
    again = readFileSync(whoPath, 'utf8');
  } catch {
    return;
  }
  if (again !== first || alive(seen.pid)) return;
  try {
    unlinkSync(whoPath);
    rmdirSync(dir);
  } catch { /* raced or held open: the take below reads whatever now stands */ }
}

/**
 * One attempt under the queue's rule. A waiter with a live ticket ahead of it — or any live
 * ticket, for a take that holds none — waits its turn; the line it is refused with names the
 * holder, or the queue being served when the lock itself stands free between turns, and how
 * many are waiting. With nobody ahead, a proven-stale holder is cleared and the take is tried.
 */
function tryTake(input: TakeInput, ticket: string | null): Attempt {
  if (!validLockName(input.name)) return { kind: 'bad-name' };
  pruneTickets(input, ticket);
  const live = listTickets(input.home, input.name);
  const ahead = ticket === null ? live : live.filter((file) => file < ticket);
  if (ahead.length > 0) {
    const seen = see(lockDirectory(input.home, input.name));
    const base = seen.kind === 'absent'
      ? `${input.name}: held; its queue is being served`
      : heldText(input.name, seen, input.now());
    return { kind: 'retry', line: `${base}; ${live.length} waiting` };
  }
  clearStaleHolder(input);
  return takeOnce(input);
}

function takeOnce(input: TakeInput): Attempt {
  if (!validLockName(input.name)) return { kind: 'bad-name' };
  const root = locksRoot(input.home);
  const dir = lockDirectory(input.home, input.name);
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    return { kind: 'io', message: (error as Error).message };
  }
  try {
    // The atomic take. No `recursive`: an existing directory is held, and must not look like success.
    mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { kind: 'io', message: (error as Error).message };
    const seen = see(dir);
    if (seen.kind === 'absent') return { kind: 'retry', line: `${input.name}: held; its holder file is not there yet` };
    const line = heldText(input.name, seen, input.now());
    return mayRetry(seen) ? { kind: 'retry', line } : { kind: 'held', line };
  }
  const shell = shellPidOf(input);
  const who: Who = {
    team: input.identity.team, by: input.identity.by, run: input.run, at: lockStamp(input.now()),
    ...(shell === undefined ? {} : { pid: shell }),
  };
  try {
    writeWho(root, input.name, dir, formatWho(who));
  } catch (error) {
    // Our own mkdir, and the holder was never published. Drop the empty directory so the name is
    // free again. `rmdir` does not remove a directory that already holds a file.
    try { rmdirSync(dir); } catch { /* still empty of a holder; the next taker waits it out */ }
    return { kind: 'io', message: (error as Error).message };
  }
  return { kind: 'taken', who };
}

/**
 * Takes `name`, or waits up to `waitSeconds` for its turn. The first attempt is unqueued, so a
 * free lock with nobody waiting is taken at once; a take that must wait leaves its ticket and
 * is served in arrival order, and every ending — taken, timed out, or refused — takes the
 * ticket with it. A held lock is removed here only when its holder is proven stale (see
 * `clearStaleHolder`). A clock that does not move during the sleep ends the wait, so a frozen
 * clock cannot spin.
 */
export async function takeLock(input: TakeInput & {
  sleep: Sleeper;
  waitSeconds: number;
}): Promise<TakeResult> {
  const start = input.now().getTime();
  const waitMs = input.waitSeconds * 1000;
  let ticket: string | null = null;
  const finish = (result: TakeResult): TakeResult => {
    if (ticket !== null) dequeue(input.home, input.name, ticket);
    return result;
  };
  for (;;) {
    const outcome = tryTake(input, ticket);
    if (outcome.kind !== 'retry') return finish(outcome);
    const elapsed = input.now().getTime() - start;
    if (elapsed >= waitMs) return finish({ kind: 'held', line: outcome.line });
    if (ticket === null) {
      const shell = shellPidOf(input);
      ticket = enqueue(input, {
        team: input.identity.team, by: input.identity.by, run: input.run, at: lockStamp(input.now()),
        ...(shell === undefined ? {} : { pid: shell }),
      });
      if (ticket === null) return { kind: 'io', message: `could not write a queue ticket in ${queueDirectory(input.home, input.name)}` };
    }
    const before = input.now().getTime();
    await input.sleep(Math.min(1000, waitMs - elapsed));
    if (input.now().getTime() <= before) return finish({ kind: 'held', line: outcome.line });
  }
}

export type ReleaseResult =
  | { kind: 'released' }
  | { kind: 'not-held' }
  | { kind: 'not-yours'; line: string }
  | { kind: 'unknown'; line: string }
  | { kind: 'bad-name' }
  | { kind: 'io'; message: string };

function unknownLine(name: string, dir: string, seen: Exclude<Seen, { kind: 'absent' | 'who' }>): string {
  if (seen.kind === 'missing') return `${name}: its holder file is not there yet; left ${dir} in place`;
  if (seen.kind === 'not-directory') return `${name}: its lock is not a directory; left ${dir} in place`;
  return `${name}: its holder file cannot be read; left ${dir} in place`;
}

/**
 * Releases `name` only when its holder file names `identity` (the same `team` and `by` the take
 * recorded). Anyone else is refused and the directory is left as it was. The holder file goes
 * first and the directory second: a reader never sees a claimed empty directory, and `rmdir`
 * refuses a directory that still holds something else — that something is put back by rewriting
 * the holder, not by sweeping the directory.
 */
export function releaseLock(input: { home: string; name: string; identity: LockIdentity }): ReleaseResult {
  if (!validLockName(input.name)) return { kind: 'bad-name' };
  const root = locksRoot(input.home);
  const dir = lockDirectory(input.home, input.name);
  const seen = see(dir);
  if (seen.kind === 'absent') return { kind: 'not-held' };
  if (seen.kind !== 'who') return { kind: 'unknown', line: unknownLine(input.name, dir, seen) };
  if (!sameHolder(seen.who, input.identity)) return { kind: 'not-yours', line: notYoursLine(input.name, seen.who) };
  const whoPath = join(dir, WHO_FILE);
  let text: string;
  try {
    text = readFileSync(whoPath, 'utf8');
  } catch {
    return { kind: 'unknown', line: unknownLine(input.name, dir, { kind: 'unreadable' }) };
  }
  const again = parseWho(text);
  if (!again || !sameHolder(again, input.identity)) {
    return again
      ? { kind: 'not-yours', line: notYoursLine(input.name, again) }
      : { kind: 'unknown', line: unknownLine(input.name, dir, { kind: 'unreadable' }) };
  }
  try {
    unlinkSync(whoPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'not-held' };
    return { kind: 'io', message: (error as Error).message };
  }
  try {
    rmdirSync(dir);
  } catch (error) {
    const why = (error as Error).message;
    try {
      writeWho(root, input.name, dir, text);
      return { kind: 'io', message: `could not remove ${dir}: ${why}` };
    } catch {
      return { kind: 'io', message: `removed the holder file but could not remove ${dir}: ${why}` };
    }
  }
  return { kind: 'released' };
}

function sameHolder(who: Who, identity: LockIdentity): boolean {
  return who.team === identity.team && who.by === identity.by;
}
