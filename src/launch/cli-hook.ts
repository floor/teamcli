// The seat's own state signal, written by its CLI: a per-launch settings file installs two
// command hooks — turn start and turn end — that keep one small file per seat under the
// project state folder (`.agents/seat-state/<session>/<seat>.json`). The reader is
// `src/labels/state.ts` through `src/commands/seats.ts`, as the `cli-hook` source. Both files
// are keyed by session as well as seat: two sessions may each hold a seat of the same name, and
// neither session's file may answer for the other's seat.
//
// Only a CLI whose own per-launch settings file reaches command hooks is served here
// (`supportsCliHook`). Nothing under the owner's CLI home is read or written: the settings file
// is one this run names on the seat's launch line, and the hooks take nothing from the CLI's
// stdin — no session id, no transcript path, no environment.
import {
  closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync,
  writeSync, type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { SEAT_NAME } from '../file/sections/seats.ts';
import type { CliHookReading } from '../labels/state.ts';
import { shellQuote, supportsCliHook } from '../profiles/profile.ts';

/** `O_NOFOLLOW` is POSIX: a platform without it gets 0, and the `lstat` checks above every open
 *  still refuse a link. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** What a launch needs to decide on a hook: the seat's name, its CLI, and the line it runs. */
export type CliHookSeat = { name: string; cli: string; launch: string };

/** Whether a seat's name can become a file name: the team file's own rule (one path segment,
 *  no `/`, no leading `.` or `..`), and a `.json` name within the filesystem's limit. */
function seatFileName(seat: string): boolean {
  return SEAT_NAME.test(seat) && Buffer.byteLength(`${seat}.json`) <= 255;
}

/** A session name as one folder name: ASCII letters, digits, `_` and `-` kept as they are, every
 *  other byte of its UTF-8 form written `%XX`. The encoding is injective — `%` itself is always
 *  escaped — so two session names never share a folder, no name can read as `.` or `..`, and the
 *  folder is always one path segment, whatever the name holds (a session name is any string but
 *  `default`: `src/file/sections/session.ts`). Null when the encoded name cannot be a folder,
 *  the filesystem's 255-byte limit; the hook is then simply not installed for that session. */
function sessionFolderName(session: string): string | null {
  if (session.length === 0) return null;
  let encoded = '';
  for (const byte of Buffer.from(session, 'utf8')) {
    const kept = (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f || byte === 0x2d;
    encoded += kept ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return Buffer.byteLength(encoded) <= 255 ? encoded : null;
}

/** The settings file the launch of one seat in one session names, under the project state
 *  folder. */
export function cliHookSettingsPath(dir: string, session: string, seat: string): string | null {
  const folder = sessionFolderName(session);
  if (folder === null || !seatFileName(seat)) return null;
  return join(dir, 'hooks', folder, `${seat}.json`);
}

/** The state file the hooks write for one seat in one session. */
export function cliHookStatePath(dir: string, session: string, seat: string): string | null {
  const folder = sessionFolderName(session);
  if (folder === null || !seatFileName(seat)) return null;
  return join(dir, 'seat-state', folder, `${seat}.json`);
}

/** Where this version's predecessor kept a seat's state file: one per seat, keyed by no session,
 *  so every session read the same word. A read claims such a file for the session reading it;
 *  a reset takes it away with the rest. */
function legacyStatePath(dir: string, seat: string): string | null {
  if (!seatFileName(seat)) return null;
  return join(dir, 'seat-state', `${seat}.json`);
}

/** The launch line already sets its own settings: the seat is left alone — no file is written
 *  and no flag appended. `--settings <file>` and `--settings=<file>` both count. */
function setsSettings(launch: string): boolean {
  return /(^|\s)--settings(=|\s|$)/.test(launch);
}

/** One hook command: the state file, replaced whole. The word goes to a temp file beside it and
 *  is renamed over the name, so a link planted at the state path is replaced, never written
 *  through — plain `> path` would follow it. The temp name comes from `mktemp`, which creates it
 *  exclusively in the same folder (the rename never crosses a filesystem and cannot land on a
 *  planted link); the mode comes from the hook's own umask, and the command reads nothing from
 *  its stdin. */
function hookCommand(statePath: string, state: 'working' | 'idle'): string {
  return `umask 077; f=$(mktemp ${shellQuote(`${statePath}.new.XXXXXX`)}) && printf '{"state":"${state}","since":"%s"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$f" && mv -f "$f" ${shellQuote(statePath)}`;
}

/** The settings text one seat's launch loads: `working` at turn start, `idle` at turn end. */
export function cliHookSettings(statePath: string): string {
  const hook = (state: 'working' | 'idle'): unknown => ({
    hooks: [{ type: 'command', command: hookCommand(statePath, state) }],
  });
  return `${JSON.stringify({
    hooks: { UserPromptSubmit: [hook('working')], Stop: [hook('idle')] },
  }, null, 2)}\n`;
}

/** What this run would install, without touching anything: the settings path per seat whose CLI
 *  supports the hook and whose launch line does not set its own settings. A dry run prints the
 *  launch line the real run types. */
export function plannedCliHooks(dir: string, session: string, seats: readonly CliHookSeat[]): Record<string, string> {
  const planned: Record<string, string> = {};
  for (const seat of seats) {
    if (!supportsCliHook(seat.cli) || setsSettings(seat.launch)) continue;
    const path = cliHookSettingsPath(dir, session, seat.name);
    if (path !== null) planned[seat.name] = path;
  }
  return planned;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function mine(held: Stats): boolean {
  return process.getuid === undefined || held.uid === process.getuid();
}

/** A folder the writer keeps: made at `0700` when absent, and otherwise a real directory of this
 *  user's at that exact mode — a link, a file, another owner or a wider mode refuses the install. */
function ensureFolder(path: string): boolean {
  const held = lstatOrNull(path);
  if (held === null) {
    try {
      mkdirSync(path, { mode: 0o700 });
      return true;
    } catch {
      return false;
    }
  }
  return held.isDirectory() && mine(held) && (held.mode & 0o777) === 0o700;
}

/** Writes one settings file without following a link: the name may hold this user's regular
 *  file or nothing at all, the open carries `O_NOFOLLOW`, and the mode is set on the descriptor
 *  so an existing wider file comes out `0600`. False on every fault — the seat then launches
 *  without the flag, exactly as it does today. */
function writeSettings(path: string, text: string): boolean {
  const held = lstatOrNull(path);
  if (held !== null && (!held.isFile() || !mine(held))) return false;
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o600);
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.from(text, 'utf8');
    for (let wrote = 0; wrote < buffer.length;) {
      wrote += writeSync(fd, buffer, wrote, buffer.length - wrote);
    }
    // `O_CREAT` leaves an existing file's mode alone: the descriptor sets the one we keep.
    fchmodSync(fd, 0o600);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** Installs one settings file per planned seat. Returns the settings path of every seat whose
 *  file landed; a seat that failed is absent, and its launch goes without the flag. */
export function installCliHooks(dir: string, session: string, seats: readonly CliHookSeat[]): Record<string, string> {
  const planned = plannedCliHooks(dir, session, seats);
  if (Object.keys(planned).length === 0) return {};
  const folder = sessionFolderName(session);
  if (folder === null) return {};
  const hooks = join(dir, 'hooks', folder);
  const states = join(dir, 'seat-state', folder);
  if (!ensureFolder(join(dir, 'hooks')) || !ensureFolder(join(dir, 'seat-state'))
    || !ensureFolder(hooks) || !ensureFolder(states)) return {};
  const landed: Record<string, string> = {};
  for (const [seat, settingsPath] of Object.entries(planned)) {
    const statePath = cliHookStatePath(dir, session, seat);
    if (statePath === null) continue;
    if (!writeSettings(settingsPath, cliHookSettings(statePath))) continue;
    landed[seat] = settingsPath;
  }
  return landed;
}

/** Clears the state file of the seats a run is about to launch: a `working` left by a killed
 *  turn must not outlive its relaunch. The file kept before the session keying is cleared with
 *  it: it answered for every session, and this run launches the seat in one. A seat the run
 *  leaves running keeps its reading, and the next turn's own hook writes the file again. */
export function resetCliHookState(dir: string, session: string, seats: readonly string[]): void {
  for (const seat of seats) {
    for (const path of [cliHookStatePath(dir, session, seat), legacyStatePath(dir, seat)]) {
      if (path === null) continue;
      try {
        unlinkSync(path);
      } catch {
        // Nothing was there, or it is not ours to take: the first prompt writes it again.
      }
    }
  }
}

/** Reads one state file: a regular file of this user's holding
 *  `{"state":"working"|"idle","since":"<ISO>"}`. Null — no file, an unreadable one, another
 *  owner, or a shape this version does not know — so the reading falls through to the screen. */
function readHookFile(path: string): CliHookReading | null {
  const held = lstatOrNull(path);
  if (held === null || !held.isFile() || !mine(held)) return null;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  let text: string;
  try {
    const parts: Buffer[] = [];
    const buffer = Buffer.alloc(4096);
    for (;;) {
      const took = readSync(fd, buffer, 0, buffer.length, null);
      if (took === 0) break;
      parts.push(Buffer.from(buffer.subarray(0, took)));
    }
    text = Buffer.concat(parts).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as { state?: unknown; since?: unknown };
  if ((record.state !== 'working' && record.state !== 'idle') || typeof record.since !== 'string') return null;
  return { state: record.state, since: record.since };
}

/** Moves a state file written before the session keying into the reading session's folder, best
 *  effort: a folder that cannot be made or a move that fails leaves the file where it was, and
 *  the reading stands either way. */
function claimLegacyState(older: string, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    renameSync(older, path);
  } catch {
    // The reading has already happened; the file is left for the next reader.
  }
}

/** One seat's state reading, in one session: the seat's own file under the session's folder, or
 *  — a seat launched before the session keying — the file that version wrote. The older file is
 *  claimed by the first session that reads it: moved into that session's folder, so one shared
 *  word can answer once and never for two sessions. A file of the session's own that does not
 *  read is final; the older one is never consulted behind it. */
export function readCliHook(dir: string, session: string, seat: string): CliHookReading | null {
  const path = cliHookStatePath(dir, session, seat);
  if (path === null) return null;
  const own = readHookFile(path);
  if (own !== null || lstatOrNull(path) !== null) return own;
  const older = legacyStatePath(dir, seat);
  if (older === null) return null;
  const inherited = readHookFile(older);
  if (inherited !== null) claimLegacyState(older, path);
  return inherited;
}
