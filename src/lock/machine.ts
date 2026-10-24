// A machine lock: one named directory under `<home>/.config/team/locks/<name>.lock`, taken by a
// plain `mkdir` and released only by the caller the holder file names.
//
// Two slips in the hand-made form are closed here. `mkdir -p` succeeds when the directory
// already exists, so the take must not be recursive on the lock itself — an existing directory
// is a held lock, and this process writes nothing into it. The holder file is written only after
// that `mkdir` succeeds, and written by rename, so a failed take leaves no `who` and a reader
// never sees a half-written one. A held lock is waited out, never cleared and never guessed:
// a missing or unreadable holder stays held, including for the owner.
//
// This is not the session mutator lock (`launch/run-lock.ts`). That one guards a live command
// process, so a dead pid may be taken over. A machine lock guards a person's run, which outlives
// the `team lock` process that took it; the take process's pid is dead immediately and must not
// be read as a stale holder.
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callerOf, describeCaller } from '../caller.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Io } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import { validLockName } from './name.ts';

/** The lock's name rule lives in its own leaf module, so the state can clean a key by it too. */
export { LOCK_NAME, LOCK_NAME_MAX, validLockName } from './name.ts';
/** A wait longer than a day is a mistake, not a hold. */
export const WAIT_MAX_SECONDS = 86_400;
const WHO_FILE = 'who';

export type LockIdentity = { team: string; by: string };
export type Who = LockIdentity & { run: string; at: string };

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
};

export const realLockHome: LockHome = { home: homedir() };

export const realLockSources: LockSources = {
  ...realLockHome,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};

/** `<home>/.config/team/locks`, the same home `lobbyDir` uses, one folder in from it. */
export function locksRoot(home: string): string {
  return join(home, '.config', 'team', 'locks');
}

export function lockDirectory(home: string, name: string): string {
  return join(locksRoot(home), `${name}.lock`);
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
  return `team: ${who.team}\nrun: ${who.run}\nby: ${who.by}\nat: ${who.at}\n`;
}

/** The holder file, or null when it is not the four lines this command writes. */
export function parseWho(text: string): Who | null {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = body.split('\n');
  if (lines.length !== 4) return null;
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
  return values;
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

function takeOnce(input: {
  home: string;
  name: string;
  run: string;
  identity: LockIdentity;
  now: () => Date;
}): Attempt {
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
  const who: Who = { team: input.identity.team, by: input.identity.by, run: input.run, at: lockStamp(input.now()) };
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
 * Takes `name`, or waits up to `waitSeconds` for a holder to release it. A held lock is never
 * removed here. A clock that does not move during the sleep ends the wait, so a frozen clock
 * cannot spin.
 */
export async function takeLock(input: {
  home: string;
  name: string;
  run: string;
  identity: LockIdentity;
  now: () => Date;
  sleep: Sleeper;
  waitSeconds: number;
}): Promise<TakeResult> {
  const start = input.now().getTime();
  const waitMs = input.waitSeconds * 1000;
  for (;;) {
    const outcome = takeOnce(input);
    if (outcome.kind !== 'retry') return outcome;
    const elapsed = input.now().getTime() - start;
    if (elapsed >= waitMs) return { kind: 'held', line: outcome.line };
    const before = input.now().getTime();
    await input.sleep(Math.min(1000, waitMs - elapsed));
    if (input.now().getTime() <= before) return { kind: 'held', line: outcome.line };
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
