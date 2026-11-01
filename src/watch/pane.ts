import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paneProcesses, workspaceList, workspacePanes, type PaneProcesses } from '../herdr.ts';
import { emptySession, readState, updateState } from '../state.ts';
import { isWatchEpoch } from './epoch.ts';
import type { WorkingFolderReader } from './process-adapter.ts';

export type WatchPlace = { pane: string; workspace: string };

/** The label of the workspace a watch runs in. One per team, so `team status` and the checks can
 *  tell the watch's own workspace from a seat's, which a display label may repeat. */
export function watchLabel(project: string): string {
  return `Watch · ${project}`;
}

/** The event bus's workspace label for a team, beside the watch's. */
export function busLabel(project: string): string {
  return `Bus · ${project}`;
}

/** A recorded watch's health, from the record and the process table alone. `live` carries a
 *  process that is alive with a heartbeat no older than two in-force intervals, or — before its
 *  pane's first pass records a pid — a pane with a fresh beat. `dead` is a recorded pid that is
 *  not alive. `stale` is a live process whose heartbeat is old or unreadable, or a record with
 *  neither a pid nor a pane to say what runs. `missing` is no record at all. */
export type PaneWatchHealth =
  | { state: 'missing' }
  | { state: 'live'; pid: number | null; heartbeat: string; pane?: string; workspace?: string }
  | { state: 'dead'; pid: number; heartbeat: string | null; pane?: string; workspace?: string }
  | {
      state: 'stale';
      why: 'heartbeat-old' | 'unreadable' | 'no-process';
      pid: number | null;
      heartbeat: string | null;
      pane?: string;
      workspace?: string;
    };

export function paneWatchHealth(
  watch: { pid?: number; heartbeat: string; pane?: string; workspace?: string } | undefined,
  options: { alive(pid: number): boolean; now: number; interval: number },
): PaneWatchHealth {
  if (!watch) return { state: 'missing' };
  const beat = Date.parse(watch.heartbeat);
  const fresh = Number.isFinite(beat) && options.now - beat <= 2 * options.interval * 1000;
  const place = {
    ...(watch.pane ? { pane: watch.pane } : {}),
    ...(watch.workspace ? { workspace: watch.workspace } : {}),
  };
  const heartbeat = Number.isFinite(beat) ? watch.heartbeat : null;
  if (watch.pid !== undefined) {
    if (!options.alive(watch.pid)) return { state: 'dead', pid: watch.pid, heartbeat, ...place };
    if (fresh) return { state: 'live', pid: watch.pid, heartbeat: watch.heartbeat, ...place };
    return {
      state: 'stale',
      why: Number.isFinite(beat) ? 'heartbeat-old' : 'unreadable',
      pid: watch.pid,
      heartbeat,
      ...place,
    };
  }
  // Before the pane's first pass records a pid, its place and beat are the only proof a watch
  // was placed. Without a place there is nothing a reader could repair by pid.
  if (!watch.pane) return { state: 'stale', why: 'no-process', pid: null, heartbeat };
  if (fresh) return { state: 'live', pid: null, heartbeat: watch.heartbeat, ...place };
  return {
    state: 'stale',
    why: Number.isFinite(beat) ? 'heartbeat-old' : 'unreadable',
    pid: null,
    heartbeat,
    ...place,
  };
}

/** Whether a recorded pid is still the watch it claims to be: the process in the pane the watch
 *  itself recorded, read through the pane's own process list. A live pid behind an old heartbeat
 *  cannot tell the watch from a reused pid; a record with no pane, a pane that cannot be read, or
 *  a pane whose process is another one is `unproven`, and nothing may be signalled on it. A pid
 *  that is no longer alive is `gone`: there is nothing to stop before its replacement. */
export type WatchIdentity =
  | { kind: 'verified'; pid: number; pane: string }
  | { kind: 'gone' }
  | { kind: 'unproven'; why: string };

export function watchIdentity(
  watch: { pid: number; pane?: string },
  options: { alive(pid: number): boolean; processInfo(pane: string): PaneProcesses | null },
): WatchIdentity {
  if (!options.alive(watch.pid)) return { kind: 'gone' };
  if (!watch.pane) return { kind: 'unproven', why: `pid ${watch.pid} is recorded with no pane` };
  const info = options.processInfo(watch.pane);
  if (info === null) {
    return { kind: 'unproven', why: `pid ${watch.pid} is recorded in pane ${watch.pane}, which cannot be read` };
  }
  if (info.foreground.includes(watch.pid) || info.shell === watch.pid) {
    return { kind: 'verified', pid: watch.pid, pane: watch.pane };
  }
  return { kind: 'unproven', why: `pid ${watch.pid} is not the process in its recorded pane ${watch.pane}` };
}

/** How much later than its record the watch process may have started. The record's instant is
 *  captured when the watch reaches its loop, after the process is up, so the process always
 *  starts first; the slack is the start line's own one-second resolution. */
export const WATCH_START_SKEW_MS = 2_000;
/** How much earlier than its record the watch process may have started: the CLI's start-up
 *  before the loop captures the instant. */
export const WATCH_START_WINDOW_MS = 120_000;

/** The words of a shell-quoted command line, split the way the shell that ran it would split
 *  them. The watch's own command is built with `shellQuote`; its entry and any session name can
 *  carry spaces, so matching on the raw line would miss its own watch. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\' && ['"', '\\', '$', '`'].includes(line[i + 1] ?? '')) word += line[++i]!;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === '\\' && i + 1 < line.length) {
      word += line[++i]!;
      inWord = true;
    } else if (char === ' ' || char === '\t') {
      if (inWord) {
        words.push(word);
        word = '';
        inWord = false;
      }
    } else {
      word += char;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** The CLI entries this install runs as, each resolved to its real path: the script this process
 *  loaded (`process.argv[1]`), and the CLI entry beside this module in the same install
 *  (`src/cli.ts`, or `dist/cli.js` in a built install). A path that does not resolve is left out:
 *  it names no entry this install runs as. */
export function installCliEntries(): string[] {
  const here = fileURLToPath(import.meta.url);
  const beside = join(dirname(here), '..', here.endsWith('.ts') ? 'cli.ts' : 'cli.js');
  const entries: string[] = [];
  for (const candidate of [process.argv[1], beside]) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    try {
      const real = realpathSync(candidate);
      if (!entries.includes(real)) entries.push(real);
    } catch {
      // No file there (or no path at all): not an entry this install runs as.
    }
  }
  return entries;
}

/** Where a command line names this CLI, if the shape could: the installed executable (or a CLI
 *  entry script) at position 0 with `watch` next, or a node/bun runtime with the entry exactly at
 *  position 1 and `watch` at position 2. The position is fixed before the word is resolved, so a
 *  watch word inside another program's arguments never becomes the entry. */
function entryPosition(words: readonly string[]): { entryAt: number; watchAt: number } | null {
  const first = words[0];
  if (first === undefined) return null;
  const name = basename(first);
  if (name === 'team' || name === 'cli.ts' || name === 'cli.js') return { entryAt: 0, watchAt: 1 };
  if (name === 'node' || name === 'bun') return { entryAt: 1, watchAt: 2 };
  return null;
}

/** Whether a live process's command line is this session's `team watch`. The entry is proved, not
 *  searched for: its position is fixed (`entryPosition`), and its real path must be one of this
 *  install's own CLI entries (`installCliEntries`) — a different install's `cli.js`, or an entry
 *  named later in some other program's arguments, is that other program, not this team's watch.
 *  The next word is `watch`, and the session is named by `--session` — absent only for the
 *  `default` session. */
export function watchCommandLine(
  command: string,
  session: string,
  entries: readonly string[] = installCliEntries(),
): boolean {
  const words = shellWords(command);
  const place = entryPosition(words);
  if (place === null) return false;
  let entry: string;
  try {
    entry = realpathSync(words[place.entryAt]!);
  } catch {
    return false;
  }
  if (!entries.includes(entry)) return false;
  if (words[place.watchAt] !== 'watch') return false;
  const named = valuedFlag(words, 'session', place.watchAt + 1);
  return named === undefined ? session === 'default' : named === session;
}

/** The value a watch line gives a valued option, read the way the CLI's parser reads it: the last
 *  occurrence wins, and `--name=value` spells the same option. Undefined when the line names none
 *  (or names one with no value, which the parser refuses). */
function valuedFlag(words: readonly string[], name: string, from: number): string | undefined {
  let value: string | undefined;
  for (let i = from; i < words.length; i++) {
    const word = words[i]!;
    if (word === `--${name}`) {
      const next = words[i + 1];
      if (next !== undefined) value = next;
      i++;
    } else if (word.startsWith(`--${name}=`)) {
      value = word.slice(name.length + 3);
    }
  }
  return value;
}

/** The team file a watch command line names with `--file`, exactly as written — a relative path is
 *  resolved from the folder that process started in, as its own read would resolve it — or
 *  undefined when it names none. */
export function watchCommandFile(command: string): string | undefined {
  const words = shellWords(command);
  const place = entryPosition(words);
  if (place === null) return undefined;
  return valuedFlag(words, 'file', place.watchAt + 1);
}

/** The team a watch serves, as the run that would stop it reads the same team: the file it read,
 *  resolved to its real path (null when the file is not on disk, as a registry record's is), and
 *  the folders that file is read from — the folder holding it and, for the `.agents` layout, the
 *  project folder above. A launch that names no file reads the team from one of those folders, so
 *  its process's working folder is its side of the identity. */
export type WatchLaunch = { file: string | null; dirs: string[] };

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function watchLaunchOf(path: string | undefined, dir: string): WatchLaunch {
  const folder = realOrNull(dir);
  const dirs = folder === null ? [resolve(dir)] : [folder];
  if (folder !== null && basename(folder) === '.agents') {
    const above = realOrNull(dirname(folder));
    if (above !== null) dirs.push(above);
  }
  return { file: path === undefined ? null : realOrNull(path), dirs };
}

/** The command line of the process at `pid`, or null when it is gone or cannot be read. */
export function processCommandOf(pid: number): string | null {
  try {
    const line = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return line === '' ? null : line;
  } catch {
    return null;
  }
}

/** The instant the process at `pid` started, in epoch milliseconds, or null when it is gone or
 *  its start line does not read. Measured on this machine: `ps -o lstart= -p <pid>` prints
 *  `Tue Oct 20 05:19:15 2026` (one-second resolution, local time), which `Date.parse` reads as
 *  that instant. */
export function processStartOf(pid: number): number | null {
  try {
    const line = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const at = Date.parse(line);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** The file a watch line names, resolved the way that process's own read resolves it: an absolute
 *  path as itself, a relative one from the folder the process started in. Null when it resolves
 *  to nothing readable. */
function namedWatchFile(named: string, cwd: string | null): string | null {
  const path = isAbsolute(named) ? named : cwd === null ? null : resolve(cwd, named);
  return path === null ? null : realOrNull(path);
}

/** What `team down` may do with the watch the state records. A record with a pane is `up`'s to
 *  verify, a record fenced by the session's epoch is the session host's own process, and a pid
 *  that is no longer alive has nothing to stop: all three are `nothing`. A pane-less, live pid is
 *  `proven` only under the full ownership proof: the live process's command line proves this
 *  install's own CLI entry running this team's `team watch` for this session, names this team's
 *  file when it names one (a relative path read from the folder the process started in), and —
 *  when it names no file, so it read the team from its working folder — started in a folder this
 *  team's file is read from; and its start instant matches the one the watch recorded. A pid alone
 *  is never proof — the OS can hand it to an unrelated process after the watch exited, and another
 *  team's watch sharing the session name is the same collision with a matching command line — so
 *  anything less is `unproven` and is never signalled. */
export type WatchStopRead =
  | { kind: 'nothing' }
  | { kind: 'proven'; pid: number }
  | { kind: 'unproven'; pid: number; why: string };

export function watchStopRead(
  watch: { pid?: number; pane?: string; epoch?: string; started_at?: string } | undefined,
  session: string,
  proof: {
    alive(pid: number): boolean;
    commandOf(pid: number): string | null;
    startOf(pid: number): number | null;
    /** The process's working folder; null when it cannot be read. Read only for a line that
     *  names no team file, where it is the launch's side of the identity. Read through the
     *  process adapter (`process-adapter.ts`), never by this module. */
    cwdOf?: WorkingFolderReader;
  },
  launch: WatchLaunch,
): WatchStopRead {
  if (watch === undefined || watch.pid === undefined || watch.pane !== undefined) return { kind: 'nothing' };
  if (isWatchEpoch(watch.epoch)) return { kind: 'nothing' };
  const pid = watch.pid;
  if (!proof.alive(pid)) return { kind: 'nothing' };
  const command = proof.commandOf(pid);
  if (command === null) {
    return { kind: 'unproven', pid, why: `pid ${pid}'s command line cannot be read` };
  }
  if (!watchCommandLine(command, session)) {
    return { kind: 'unproven', pid, why: `pid ${pid} is not running this team's watch for session ${session}` };
  }
  const named = watchCommandFile(command);
  if (named !== undefined) {
    if (launch.file === null || namedWatchFile(named, proof.cwdOf?.(pid) ?? null) !== launch.file) {
      return { kind: 'unproven', pid, why: `pid ${pid} runs a watch for another team file` };
    }
  } else {
    const cwd = proof.cwdOf?.(pid) ?? null;
    const here = cwd === null ? null : realOrNull(cwd);
    if (here === null) {
      return { kind: 'unproven', pid, why: `pid ${pid}'s working folder cannot be read` };
    }
    if (!launch.dirs.includes(here)) {
      return { kind: 'unproven', pid, why: `pid ${pid} is not a watch launched from this team's folder` };
    }
  }
  if (watch.started_at === undefined) {
    return { kind: 'unproven', pid, why: `pid ${pid} has no recorded start instant to match` };
  }
  const recordedAt = Date.parse(watch.started_at);
  const started = proof.startOf(pid);
  if (!Number.isFinite(recordedAt) || started === null) {
    return { kind: 'unproven', pid, why: `pid ${pid}'s start instant cannot be read` };
  }
  if (started > recordedAt + WATCH_START_SKEW_MS || started < recordedAt - WATCH_START_WINDOW_MS) {
    return { kind: 'unproven', pid, why: `pid ${pid} started at a time its record does not match` };
  }
  return { kind: 'proven', pid };
}

/** The hand-over guard's question: whether a recorded watch still holds its pane. It stays
 *  deliberate about a pid — a live process counts even when its heartbeat is old, because another
 *  `team watch` must not hand over to a pane that is still writing there. `paneWatchHealth` is
 *  the reading `up` and `check` use when they decide whether to repair. */
export function watchRunning(
  watch: { pid?: number; heartbeat: string; pane?: string } | undefined,
  options: { alive(pid: number): boolean; now: number; interval: number },
): boolean {
  const health = paneWatchHealth(watch, options);
  return health.state === 'live' || (health.state === 'stale' && health.pid !== null);
}

/** The pane this process is running in, from herdr. The shell that `pane run` typed into is
 *  this process's parent; the foreground pid is this process once the command is up. A hand-run
 *  watch matches neither and comes back `'gone'`. Null means herdr could not say, which is not
 *  a missing pane. */
export function ownWatchPane(session: string, pid: number): WatchPlace | 'gone' | null {
  const aim = session === 'default' ? undefined : session;
  const workspaces = workspaceList(aim);
  if (workspaces === null) return null;
  const parent = process.ppid;
  let unreadable = false;
  for (const workspace of workspaces) {
    const panes = workspacePanes(workspace.id, aim);
    if (panes === null) {
      unreadable = true;
      continue;
    }
    for (const pane of panes) {
      const info = paneProcesses(pane, aim);
      if (!info) {
        unreadable = true;
        continue;
      }
      if (info.foreground.includes(pid) || info.shell === pid || info.shell === parent) {
        return { pane, workspace: workspace.id };
      }
    }
  }
  return unreadable ? null : 'gone';
}

/** Where this pass's heartbeat should record the process. `'end'` is a pane this pid already
 *  recorded and herdr no longer has, on this pass alone. The watch ends only when the next pass
 *  says `'end'` again. A watch that never recorded one — started by hand — keeps going, and so
 *  does a pass where herdr cannot say. */
export function placedWatch(
  dir: string,
  session: string,
  pid: number,
  ownPane: ((session: string, pid: number) => WatchPlace | 'gone' | null) | undefined,
): WatchPlace | 'end' | 'keep' {
  if (!ownPane) return 'keep';
  const found = ownPane(session, pid);
  if (!found || found === 'gone') {
    if (found !== 'gone') return 'keep';
    const prior = readState(dir).sessions[session]?.watch;
    return prior?.pid === pid && prior.pane ? 'end' : 'keep';
  }
  return found;
}

/** The heartbeat. A place found this pass is recorded. `'keep'` leaves a pane this same pid
 *  already recorded, and writes none for a watch that has not seen itself in one. A pane beat
 *  carries no epoch, so it leaves any record holding a well-formed epoch untouched — the same
 *  pid included: only `renewWatchAuthority` with the captured epoch and pid writes a fenced
 *  heartbeat. An ordinary epochless pane record beats as before.
 *
 *  `startedAt` is the instant the watch process captured when it reached its loop. It is written
 *  as `started_at` for the pid that owns the record — once: a later beat of the same pid keeps
 *  the first instant, so the record always names when that process started. `down` proves a
 *  pane-less record by it and by the process's command line before it signals anything. */
export function beatWatch(
  dir: string,
  session: string,
  pid: number,
  heartbeat: string,
  place: WatchPlace | 'keep',
  startedAt?: string,
): void {
  updateState(dir, (state) => {
    const record = (state.sessions[session] ??= emptySession());
    const prior = record.watch;
    if (prior && isWatchEpoch(prior.epoch)) return;
    // `'keep'` preserves the pane this same pid recorded — or, on the first pass, the pane the
    // hand-over recorded with no pid yet: herdr not naming the watch's own pane must not erase
    // where the watch is known to run.
    const kept = place === 'keep'
      ? (prior && (prior.pid === pid || prior.pid === undefined) && prior.pane
        ? { pane: prior.pane, ...(prior.workspace ? { workspace: prior.workspace } : {}) }
        : undefined)
      : place;
    const started = prior !== undefined && prior.pid === pid && prior.started_at !== undefined
      ? prior.started_at
      : startedAt;
    record.watch = {
      pid,
      heartbeat,
      ...(started !== undefined ? { started_at: started } : {}),
      ...(kept?.pane ? { pane: kept.pane } : {}),
      ...(kept?.workspace ? { workspace: kept.workspace } : {}),
    };
  });
}
