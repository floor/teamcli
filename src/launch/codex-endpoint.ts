// The managed Codex app-server endpoint: the launch side of the runtime presence chain.
//
// A Codex seat's native presence comes from the app-server that hosts its thread. Rather than
// discovering the machine's shared daemon (whose socket lives under a guessed `CODEX_HOME`), a
// managed launch starts its own app-server on an explicit unix socket under the team's state
// folder and records it on the seat's state record. The seat's TUI is attached with
// `--remote unix://<path>` (measured: `codex --help` documents `--remote` with the forms
// `unix://`, `unix://PATH`; `codex app-server --help` documents `--listen unix://PATH`).
//
// The endpoint is binding-scoped: the path carries the seat's current `presence_binding`, and the
// record repeats the binding. A predecessor incarnation's server therefore can never serve a
// successor's TUI or presence source, and a consumer that finds the two bindings disagree treats
// the endpoint as unknown rather than reusing it (`daemon/presence/endpoint-record.ts`). The
// record also names the configuration the server was started with. The measurement recorded at
// `codexEndpointConfig` is why: an attached TUI runs its turns under the app-server's
// configuration, so a live endpoint is reused only when it was started with the configuration
// this launch needs — another line's server is stopped and replaced, never attached to.
//
// The launch owns the process: it starts it detached, records the pid, and stops the previous
// pid before starting a new one. Stopping is never done on a bare pid: the process at that pid
// must be provably the app-server this launch started, by its measured `codex` executable name
// and a command line that carries the exact `app-server --listen <url>` this endpoint records.
// A pid that cannot be proven is left alone and reported; a pid is never recycled into a signal.
// The daemon never starts, stops or removes an endpoint.
//
// Measured on this machine (codex-cli 0.161.0):
//   `CODEX_HOME=<synthetic> codex app-server --listen unix:///private/tmp/<scratch>/app.sock`
//   created that socket within 10 s, its `ps -o comm= -p <pid>` printed `codex`, and SIGTERM
//   ended it with exit 143 and empty stdout/stderr. The launch spawns the same command with the
//   state folder's own path, never a path derived from HOME.
//
// A deep project folder would push `<state>/run/<session>/<seat>/<binding>.sock` past the socket
// path limit above, and a seat in such a folder used to launch unmanaged. When the state folder's
// own path is over the limit, the socket is placed instead in one short per-user runtime folder
// under the machine's temporary folder, named by a hash of exactly what the state-folder path
// named: the state folder, the session, the seat and the binding. The hash means two seats, two
// sessions or two incarnations can never share a name, and the binding is still carried by the
// name — a predecessor's socket is a different file. The state folder keeps the record: the
// seat's `codex_endpoint.url` names the runtime socket, and the runtime folder carries a strict
// owner record beside it that names the state folder, so a walk up from the app-server process
// can find the seat again (`seatOfManagedEndpoint`). The runtime folder is this user's alone:
// a plain directory with no group or other access, its own owner's, checked before every launch
// and made so when it is this user's; the socket is narrowed to 0600 after it appears (measured:
// codex-cli 0.161.0 leaves it 0755), and a launch that cannot narrow it falls back. Sockets whose
// owner record names a process that is gone are removed from that folder on every launch there;
// a socket nothing proves is left where it is, as it always is.
//
// Measured on this machine (2026-11-01): `os.tmpdir()` printed `/tmp` (4 bytes), and the runtime
// folder `/tmp/team-endpoints` was 19 bytes, created 0700 — the same string `join(tmpdir(), …)`
// gives here. The hashed socket name is
// 37 bytes (`<32 lowercase hex>.sock`), so the runtime path is 57 bytes here. The build's 100-byte
// bound is the conservative one: codex-cli 0.161.0 bound and answered a client dial at 132 bytes,
// the next lengths bound but the dial failed with EINVAL, and past 250 the bind itself failed
// ("File name too long", os error 63) — so this platform's own limit is not the bound relied on.
// The other supported platform is unmeasured here: this build asks it for no more than the same
// 100 bytes, and the runtime-folder fallback has not been run there.
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { sessionList } from '../herdr.ts';
import { chmodSync, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isPresenceBinding, isPresenceTime, mintPresenceBinding } from '../daemon/presence/contract.ts';
import {
  codexEndpointPath,
  readCodexEndpointRecord,
  readRecordedCodexEndpoint,
  type CodexEndpointRecord,
} from '../daemon/presence/endpoint-record.ts';
import { isPresenceSeatName, presenceSessionFolder } from '../daemon/presence/spool.ts';
import { readState, updateState, type SeatState, type SessionState, type State } from '../state.ts';
import type { Seat } from '../file/types.ts';

/** The longest unix socket path this build will ask Codex to bind: macOS refuses paths over 104
 *  bytes, and a shorter bound leaves room for the OS's own accounting. */
const MAX_SOCKET_PATH_BYTES = 100;

/** The role-named runtime folder a socket moves to when the state folder's own path is over the
 *  limit, and the machine's temporary folder it is normally under. Measured here: 19 bytes. */
const RUNTIME_FOLDER = 'team-endpoints';

/** The hashed socket name's length: 128 bits in lowercase hex, so a name collision between two
 *  seats, sessions or incarnations is not something any launch or cleanup has to reason about. */
const RUNTIME_STEM = /^[0-9a-f]{32}$/;

/** The strict owner record beside a runtime socket: the state folder the socket's seat lives in.
 *  Never trusted alone — its `dir` is only where a reader starts; the state's own record and the
 *  process proof still decide (`seatOfManagedEndpoint`). */
const OWNER_SUFFIX = '.owner.json';

export type ManagedEndpointRead =
  | {
      kind: 'up';
      url: string;
      /** True when this call started the server; false when it reused one still proven live. */
      started: boolean;
      /** Things the launch must say: a predecessor endpoint that could not be proven and was
       *  therefore left alone. Never a repair claim. */
      notes?: readonly string[];
    }
  /** No endpoint was started or reused. The seat launches on the line it had, and its presence
   *  stays unproven: nothing is guessed in its place. */
  | { kind: 'unmanaged'; why: string };

export type EndpointStopRead = { stopped: boolean; why?: string };

/** The folder holding one seat's managed endpoint sockets: under the team state folder, beside
 *  the presence tree, keyed by the same session encoding so a session name can never escape it
 *  and a seat always owns exactly one folder. Null when either name cannot be a folder. */
function endpointFolder(dir: string, session: string, seat: string): string | null {
  const folder = presenceSessionFolder(session);
  if (folder === null || !isPresenceSeatName(seat)) return null;
  return join(dir, 'run', folder, seat);
}

/** The folders a runtime socket may live in, in the order they are tried: the short runtime
 *  folder both supported platforms name at the same place (measured here: 19 bytes), then this
 *  process's temporary folder. The fixed one comes first because a stop, a restart and a walk up
 *  from the app-server run in other processes, and `TMPDIR` is a per-process reading: a folder
 *  chosen by it could differ between the launch and the reader, while the fixed one cannot. A
 *  machine whose `/tmp` is itself too long for a hashed socket still gets a bindable path. */
function runtimeFolders(): string[] {
  return [...new Set([`/tmp/${RUNTIME_FOLDER}`, join(tmpdir(), RUNTIME_FOLDER)])];
}

/** The runtime socket's name for one seat incarnation: a hash of the state folder, the session,
 *  the seat and the binding — exactly what the state-folder path named. It can never equal another
 *  seat's, another session's or another incarnation's, and it names no project folder. */
function runtimeSocketName(dir: string, session: string, seat: string, binding: string): string {
  const stem = createHash('sha256')
    .update(`team-endpoints\0v1\0${dir}\0${session}\0${seat}\0${binding}`)
    .digest('hex')
    .slice(0, 32);
  return `${stem}.sock`;
}

/** The socket this seat incarnation gets, and why not when it cannot have one. Under the state
 *  folder while that fits the limit; in the short per-user runtime folder otherwise, with the
 *  state-folder path's own words hashed into the name. `runtimeRoot` is a scene's own folder;
 *  the machine's folders are tried when absent. */
export type EndpointSocket =
  | { kind: 'ok'; url: string; path: string; runtime: false }
  | { kind: 'ok'; url: string; path: string; runtime: true; root: string }
  | { kind: 'none'; why: string };

export function endpointSocketOf(
  dir: string,
  session: string,
  seat: string,
  binding: string,
  runtimeRoot?: string,
): EndpointSocket {
  const folder = endpointFolder(dir, session, seat);
  if (folder === null) return { kind: 'none', why: 'the session or seat cannot name an endpoint folder' };
  if (!isPresenceBinding(binding)) return { kind: 'none', why: 'the seat records no valid presence binding' };
  const own = join(folder, `${binding}.sock`);
  const ownBytes = Buffer.byteLength(own);
  if (ownBytes <= MAX_SOCKET_PATH_BYTES) return { kind: 'ok', url: `unix://${own}`, path: own, runtime: false };
  const name = runtimeSocketName(dir, session, seat, binding);
  const roots = runtimeRoot === undefined ? runtimeFolders() : [runtimeRoot];
  let shortest: number | null = null;
  for (const root of roots) {
    const path = join(root, name);
    const bytes = Buffer.byteLength(path);
    shortest = shortest === null || bytes < shortest ? bytes : shortest;
    if (bytes <= MAX_SOCKET_PATH_BYTES) return { kind: 'ok', url: `unix://${path}`, path, runtime: true, root };
  }
  return {
    kind: 'none',
    why: `the state folder’s socket path would be ${String(ownBytes)} bytes and the runtime folder’s ${String(shortest)}; this build binds at most ${String(MAX_SOCKET_PATH_BYTES)}`,
  };
}

/** The explicit endpoint a managed launch would give this seat incarnation. Null when the state
 *  folder, the session or the seat cannot name one this build can bind to. */
export function codexEndpointSocket(
  dir: string,
  session: string,
  seat: string,
  binding: string,
  runtimeRoot?: string,
): { url: string; path: string } | null {
  const read = endpointSocketOf(dir, session, seat, binding, runtimeRoot);
  return read.kind === 'ok' ? { url: read.url, path: read.path } : null;
}

/** The path a record names, when it is one this seat incarnation's own launch owns, and whether
 *  it is the runtime folder's. The whole path is recomputed from the record's binding and must
 *  equal what the record names: a record pointing anywhere else is never touched. */
export function ownedSocketPath(
  dir: string,
  session: string,
  seat: string,
  record: CodexEndpointRecord,
  runtimeRoot?: string,
): { path: string; runtime: boolean } | null {
  const expected = endpointSocketOf(dir, session, seat, record.binding, runtimeRoot);
  if (expected.kind !== 'ok') return null;
  const path = codexEndpointPath(record);
  if (path === null || path !== expected.path) return null;
  return { path, runtime: expected.runtime };
}

/** The strict owner record beside a runtime socket: its path, its state folder, its binding and
 *  the process the launch recorded. Read only through this door: a plain file this user owns with
 *  no group or other access, small, and every field shaped as a launch writes it. */
export type EndpointOwnerRecord = { dir: string; binding: string; pid: number; at: string };

function ownerRecordPathOf(socketPath: string): string {
  return join(dirname(socketPath), `${basename(socketPath, '.sock')}${OWNER_SUFFIX}`);
}

export function readEndpointOwnerRecord(
  path: string,
  uid: number | undefined = process.getuid?.(),
): EndpointOwnerRecord | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return null;
    if (uid !== undefined && stat.uid !== uid) return null;
    if ((stat.mode & 0o077) !== 0) return null;
    if (stat.size > 4_096) return null;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const one = value as Partial<EndpointOwnerRecord>;
    if (typeof one.dir !== 'string' || !isAbsolute(one.dir) || /[\u0000-\u001f\u007f]/.test(one.dir)) return null;
    if (typeof one.binding !== 'string' || !isPresenceBinding(one.binding)) return null;
    if (typeof one.pid !== 'number' || !Number.isSafeInteger(one.pid) || one.pid <= 0) return null;
    if (typeof one.at !== 'string' || !isPresenceTime(one.at)) return null;
    return { dir: one.dir, binding: one.binding, pid: one.pid, at: one.at };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The recorded pid's command line, when the process is the Codex binary; null otherwise. This is
 *  the ownership proof a signal requires: a pid alone is never proof, because pids are reused. */
export function codexCommandOf(pid: number): string | null {
  try {
    const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (basename(comm) !== 'codex') return null;
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** The instant the process at `pid` started, in epoch milliseconds, or null when it is gone or
 *  its start line does not read. Measured on this machine: `ps -o lstart= -p <pid>` prints
 *  `Tue Oct 20 05:19:15 2026` (one-second resolution, local time), which `Date.parse` reads as
 *  that instant. `ps` here has no `etimes` keyword; `etime` is formatted, so the start line is
 *  the field to read. */
export function processStartOf(pid: number): number | null {
  try {
    const line = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const at = Date.parse(line);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** How much later than its record a process may have started. The record is written after the
 *  socket appears, so the process always starts first; the slack is clock granularity. */
const START_SKEW_MS = 2_000;
/** How much earlier than its record a process may have started: the wait for the socket, the
 *  state lock, and the write itself. */
const START_WINDOW_MS = 120_000;

function isPlainDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The endpoint's socket is there: a socket at the path, or (measured on codex-cli 0.161.0, whose
 *  `app-server --listen unix://PATH` hands the listen to its app-server daemon) a link this user
 *  owns at the path, resolving to a socket this user owns in a folder only this user can enter. */
export function isSocketFile(path: string, uid: number | undefined = process.getuid?.()): boolean {
  try {
    const at = lstatSync(path);
    if (at.isSocket()) return true;
    if (!at.isSymbolicLink() || (uid !== undefined && at.uid !== uid)) return false;
    // One link, read rather than resolved: a resolver that opens the target refuses a socket.
    const named = readlinkSync(path);
    const target = isAbsolute(named) ? named : join(dirname(path), named);
    const socket = statSync(target);
    const folder = statSync(dirname(target));
    if (!socket.isSocket()) return false;
    if (uid !== undefined && (socket.uid !== uid || folder.uid !== uid)) return false;
    return (folder.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function dropFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or never there.
  }
}

/** The binding-named socket files in this seat's own folder that this launch neither binds nor
 *  can tie to a record: left where they are, never removed, because no record proves their
 *  process has gone. A socket is only ever unlinked through the record that names it. */
function socketsLeftAlone(
  folder: string,
  accounted: readonly (string | null)[],
  isSocket: (path: string) => boolean,
): string[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const known = new Set(accounted.filter((path): path is string => path !== null));
  const left: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.sock')) continue;
    const binding = name.slice(0, -'.sock'.length);
    if (!isPresenceBinding(binding)) continue;
    const path = join(folder, name);
    if (known.has(path) || !isSocket(path)) continue;
    left.push(name);
  }
  return left.sort();
}

export type CodexEndpointDeps = {
  /** Starts `codex app-server --listen <url>` detached; null when the process did not start. */
  spawn?: (input: { url: string; cwd?: string; config?: string[]; env?: Record<string, string> }) => { pid: number } | null;
  /** The herdr hook environment for the seat's pane, or null when herdr cannot name it. */
  herdrEnv?: (session: string, pane: string) => Record<string, string> | null;
  alive?: (pid: number) => boolean;
  /** The proof a signal requires: the pid's full command line, or null when its executable name
   *  is not `codex`. Injected in scenes so no test reads another process. */
  commandOf?: (pid: number) => string | null;
  /** The pid's own start instant, epoch ms, or null when unreadable. The second half of the
   *  ownership proof: a pid the OS reused names a process that started after the record. */
  startOf?: (pid: number) => number | null;
  terminate?: (pid: number) => void;
  isPlainDir?: (path: string) => boolean;
  isSocket?: (path: string) => boolean;
  drop?: (path: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  waitMs?: number;
  /** The runtime folder a deep state folder's socket moves to. The machine's own folders when
   *  absent; a scene hands its own so no test writes outside its scratch folder. */
  runtimeRoot?: string;
};

/** Makes `root` this user's own plain folder with no group or other access, and returns why not
 *  when it cannot. A folder this user already owns is narrowed; a folder anyone else owns, or a
 *  link, is refused rather than used or replaced. */
function ensureRuntimeRoot(root: string, plainDir: (path: string) => boolean): string | null {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch {
    return 'the runtime folder could not be made';
  }
  if (!plainDir(root)) return 'the runtime folder is not a plain directory';
  let at;
  try {
    at = lstatSync(root);
  } catch {
    return 'the runtime folder cannot be read';
  }
  const uid = process.getuid?.();
  if (uid !== undefined && at.uid !== uid) return 'the runtime folder is not this user’s own';
  if ((at.mode & 0o077) !== 0) {
    try {
      chmodSync(root, 0o700);
      at = lstatSync(root);
    } catch {
      return 'the runtime folder cannot be made owner-only';
    }
    if ((at.mode & 0o077) !== 0) return 'the runtime folder cannot be made owner-only';
  }
  return null;
}

/** Narrows a runtime socket to this user alone (measured: codex-cli 0.161.0 leaves it 0755), or
 *  says why it could not. */
function lockDownSocket(path: string): string | null {
  try {
    chmodSync(path, 0o600);
  } catch {
    return 'the endpoint socket could not be made owner-only';
  }
  return null;
}

/** An entry's identity as the filesystem reports it, without following a link: two reads name the
 *  same object exactly when they agree on both. Used to tell the object a launch made from one
 *  that stood at the same pathname before it, and from a successor that took the name after. */
type EntryIdentity = { dev: number; ino: number };

function entryIdentity(path: string): EntryIdentity | null {
  try {
    const at = lstatSync(path);
    return { dev: at.dev, ino: at.ino };
  } catch {
    return null;
  }
}

function sameEntry(a: EntryIdentity, b: EntryIdentity | null): boolean {
  return b !== null && a.dev === b.dev && a.ino === b.ino;
}

type OwnerRecordWrite =
  | { ok: true; entry: EntryIdentity }
  | { ok: false; why: string };

/** Writes the strict owner record beside a runtime socket, owner-only, or says why not. The writer
 *  meets the reader's contract on both ends: an entry already at the record's name is refused
 *  unless the strict reader accepts it as this user's own plain record, and the bytes go to an
 *  exclusive temporary file in the same folder, published by rename. No write ever follows a link
 *  planted at the final name, and the record's identity is returned so cleanup can tell the file
 *  this call published from one that took its name afterwards. */
function writeOwnerRecord(socketPath: string, record: EndpointOwnerRecord): OwnerRecordWrite {
  const path = ownerRecordPathOf(socketPath);
  let occupied = false;
  try {
    lstatSync(path);
    occupied = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, why: 'the record beside the endpoint socket cannot be read' };
    }
  }
  if (occupied && readEndpointOwnerRecord(path) === null) {
    // An entry the strict reader would not accept is not this launch's to replace: it may be a
    // link planted while the folder was wide, and writing through its name could reach anywhere.
    return { ok: false, why: 'the record beside the endpoint socket is not a plain record this user wrote; it was left in place' };
  }
  const temp = join(dirname(path), `.${basename(path)}.${String(process.pid)}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number | null = null;
  let entry: EntryIdentity | null = null;
  try {
    fd = openSync(temp, 'wx', 0o600);
    // The open's mode is masked by the process umask; the reader's contract is exact.
    fchmodSync(fd, 0o600);
    const at = fstatSync(fd);
    entry = { dev: at.dev, ino: at.ino };
    writeSync(fd, `${JSON.stringify(record)}\n`);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
  } catch {
    return { ok: false, why: 'the record beside the endpoint socket could not be written' };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    dropFile(temp);
  }
  if (entry === null || !sameEntry(entry, entryIdentity(path))) {
    return { ok: false, why: 'the record beside the endpoint socket changed while it was written' };
  }
  return { ok: true, entry };
}

/** Removes the runtime sockets and owner records whose recorded process is gone. A socket whose
 *  owner record is absent or unreadable, or whose process is still alive, is left exactly where
 *  it is: nothing here proves its server has ended. */
function sweepRuntimeSockets(
  root: string,
  deps: Pick<CodexEndpointDeps, 'alive' | 'isSocket' | 'drop'>,
): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const alive = deps.alive ?? pidAlive;
  const socket = deps.isSocket ?? isSocketFile;
  const drop = deps.drop ?? dropFile;
  for (const name of names) {
    if (name.endsWith('.sock')) {
      const stem = name.slice(0, -'.sock'.length);
      if (!RUNTIME_STEM.test(stem)) continue;
      const path = join(root, name);
      const owner = readEndpointOwnerRecord(ownerRecordPathOf(path));
      if (owner === null || alive(owner.pid) || !socket(path)) continue;
      drop(path);
      drop(ownerRecordPathOf(path));
    } else if (name.endsWith(OWNER_SUFFIX)) {
      const stem = name.slice(0, -OWNER_SUFFIX.length);
      if (!RUNTIME_STEM.test(stem) || names.includes(`${stem}.sock`)) continue;
      const owner = readEndpointOwnerRecord(join(root, name));
      if (owner === null || alive(owner.pid)) continue;
      drop(join(root, name));
    }
  }
}

/**
 * The environment herdr's Codex hook needs to report the seat's turns. Measured: with the TUI
 * attached by `--remote`, Codex runs its hooks in the app-server process, and herdr's hook
 * (`~/.codex/herdr-agent-state.sh`, integration 6) exits unless `HERDR_ENV=1`,
 * `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` are set; an endpoint started outside the pane left the
 * seat reading `working` after its first turn, so restart refused it. The values are herdr's own
 * listing of the session's socket and the pane the launch placed the seat in.
 */
export function herdrHookEnv(session: string, pane: string): Record<string, string> | null {
  const listed = sessionList()?.find((one) => one.name === session);
  if (listed === undefined || typeof listed.socketPath !== 'string' || listed.socketPath === '') return null;
  return { HERDR_ENV: '1', HERDR_SOCKET_PATH: listed.socketPath, HERDR_PANE_ID: pane };
}

function spawnAppServer(input: { url: string; cwd?: string; config?: string[]; env?: Record<string, string> }): { pid: number } | null {
  // The seat's configuration follows the listen words, so the ownership proof's exact
  // `app-server --listen <url>` still reads from the command line.
  const child = nodeSpawn('codex', ['app-server', '--listen', input.url, ...(input.config ?? [])], {
    detached: true,
    stdio: 'ignore',
    ...(input.env === undefined ? {} : { env: { ...process.env, ...input.env } }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  });
  // A spawn failure arrives as an event, never as a thrown error from `spawn`; without a listener
  // it would crash the launch. The pid is absent in that case, and the caller falls back.
  child.on('error', () => {});
  child.unref();
  return child.pid === undefined ? null : { pid: child.pid };
}

/** Whether a live process's start instant sits in the window in which the launch wrote `record`. */
export function recordStartMatches(record: CodexEndpointRecord, started: number): boolean {
  const recordedAt = Date.parse(record.started_at);
  if (!Number.isFinite(recordedAt)) return false;
  return started <= recordedAt + START_SKEW_MS && started >= recordedAt - START_WINDOW_MS;
}

/** The one ownership proof both the stop and the reuse paths require: the live process at the
 *  recorded pid is the `codex` binary, its command line carries exactly this record's
 *  `app-server --listen <url>`, and its own start instant sits in the window in which the launch
 *  wrote the record. The start instant is what a reused pid fails: the process the OS handed the
 *  pid to started after the record was written, so it is never the one the record describes. The
 *  recorded `started_at` is quoted exactly as written; it is compared, never trusted as truth. */
export function provenOwner(
  record: CodexEndpointRecord,
  proof: {
    alive(pid: number): boolean;
    commandOf(pid: number): string | null;
    startOf(pid: number): number | null;
  },
): boolean {
  if (!proof.alive(record.pid)) return false;
  const command = proof.commandOf(record.pid);
  if (command === null || !command.includes(`app-server --listen ${record.url}`)) return false;
  const started = proof.startOf(record.pid);
  return started !== null && recordStartMatches(record, started);
}

/** Whether the configuration recorded beside an endpoint is the one this launch needs. A record
 *  that names none — one an older build wrote — is never this launch's, so its endpoint is
 *  stopped rather than reused. The words are compared as the launch passed them, order and
 *  quoting included, because that is what the server was started with. */
export function sameEndpointConfig(recorded: readonly string[] | undefined, needed: readonly string[]): boolean {
  if (recorded === undefined || recorded.length !== needed.length) return false;
  return recorded.every((word, at) => word === needed[at]);
}

function stripOuterQuotes(token: string): string {
  if (
    token.length >= 2
    && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

/** Whether the live `codex app-server` command line carries the exact start flags planned for the
 *  seat after `app-server --listen <url>`. */
export function sameLiveEndpointFlags(
  command: string | null,
  url: string,
  needed: readonly string[],
): boolean {
  if (command === null) return false;
  const needle = `app-server --listen ${url}`;
  const at = command.indexOf(needle);
  if (at < 0) return false;
  const after = command.slice(at + needle.length);
  if (after !== '' && !/^\s/.test(after)) return false;
  const tail = after.trim();
  if (needed.length === 0) return tail === '';
  if (tail === needed.join(' ')) return true;
  const tokens = tail.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(stripOuterQuotes);
  if (tokens !== undefined && tokens.length === needed.length && tokens.every((word, idx) => word === needed[idx])) {
    return true;
  }
  return false;
}

/** Stops the process a record names, only after proving it is the app-server the launch started:
 *  a live `codex` command line carrying the exact `app-server --listen <url>` of this record, a
 *  plain (non-symlink) seat folder, and — before anything is removed — a socket file (not a
 *  symlink) at the owned path. An unprovable pid is never signalled. A missing socket file is no
 *  proof the server is gone: an app-server that lost or could not create its socket still owns
 *  the pid, so a live pid is proved and stopped by pid whether or not the socket is there, and
 *  the socket file is removed only when it is that socket. */
export function stopRecordedCodexEndpoint(
  input: {
    dir: string;
    session: string;
    seat: string;
    record: CodexEndpointRecord;
  },
  deps: CodexEndpointDeps = {},
): EndpointStopRead {
  const alive = deps.alive ?? pidAlive;
  const commandOf = deps.commandOf ?? codexCommandOf;
  const startOf = deps.startOf ?? processStartOf;
  const terminate = deps.terminate ?? ((pid: number) => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } });
  const plainDir = deps.isPlainDir ?? isPlainDir;
  const socket = deps.isSocket ?? isSocketFile;
  const drop = deps.drop ?? dropFile;

  const owned = ownedSocketPath(input.dir, input.session, input.seat, input.record, deps.runtimeRoot);
  if (owned === null) {
    return { stopped: false, why: 'the record does not name this seat’s own socket' };
  }
  const path = owned.path;
  if (!plainDir(dirname(path))) {
    return { stopped: false, why: 'the endpoint folder is not a plain directory; nothing was removed' };
  }
  const pid = input.record.pid;
  if (alive(pid)) {
    if (!provenOwner(input.record, { alive, commandOf, startOf })) {
      // A live pid that cannot be proven to be this endpoint's server stays untouched: a pid is
      // reused by the OS, and a signal to the wrong process is unrecoverable.
      return { stopped: false, why: 'the recorded process cannot be proven to serve this endpoint; it was not signalled' };
    }
    terminate(pid);
  }
  // Only the socket this record owns is removed; a path that holds something else is left as it is.
  if (socket(path)) {
    drop(path);
    // A runtime socket's owner record is the pointer to this seat; it goes with the socket.
    if (owned.runtime) drop(ownerRecordPathOf(path));
  }
  return { stopped: true };
}

/** Stops and forgets the endpoint recorded on a seat's current binding, if one is recorded and
 *  provably this launch's. The record is cleared only after the stop succeeded, so an unprovable
 *  predecessor stays visible rather than being erased on a refusal. */
export function stopSeatCodexEndpoint(
  input: { dir: string; session: string; seat: string; expectedUrl?: string },
  deps: CodexEndpointDeps = {},
): EndpointStopRead {
  let seatState;
  try {
    seatState = readState(input.dir).sessions[input.session]?.seats[input.seat];
  } catch {
    return { stopped: false, why: 'the team state is unreadable; nothing was stopped' };
  }
  const value = seatState?.codex_endpoint;
  const record = readRecordedCodexEndpoint(value, seatState?.presence_binding);
  if (record === null) {
    // A record that is present but unreadable is unproven, not absent: the process it names may
    // be alive, so the stop says why it cannot act instead of reading as "nothing recorded".
    if (value !== undefined && value !== null && readCodexEndpointRecord(value) === null) {
      return {
        stopped: false,
        why: 'the seat’s endpoint record cannot be read; the process it names cannot be proved, so it was not stopped',
      };
    }
    return { stopped: false, why: 'the seat records no endpoint for its current binding' };
  }
  if (input.expectedUrl !== undefined && record.url !== input.expectedUrl) {
    return { stopped: false, why: 'the recorded endpoint is not the one this launch started; nothing was stopped' };
  }
  const stopped = stopRecordedCodexEndpoint({ ...input, record }, deps);
  if (!stopped.stopped) return stopped;
  updateState(input.dir, (file) => {
    const current = file.sessions[input.session]?.seats[input.seat];
    const same = readRecordedCodexEndpoint(current?.codex_endpoint, current?.presence_binding);
    if (current !== undefined && same !== null && same.pid === record.pid && same.url === record.url) {
      delete current.codex_endpoint;
    }
  });
  return stopped;
}

/** Whether the seat records a managed endpoint it must account for: the strict read a stop acts
 *  on for a record this build can read, and true for a record that is present but unreadable —
 *  the same unproven state a stop reports, never "no record" — so the stop is attempted and says
 *  why. A seat that records no value — every seat whose launch managed no endpoint — has nothing
 *  to stop, and no notice is owed for it. A state that cannot be read answers true, so the stop
 *  itself says why nothing was stopped. */
export function seatRecordsCodexEndpoint(input: { dir: string; session: string; seat: string }): boolean {
  let seatState;
  try {
    seatState = readState(input.dir).sessions[input.session]?.seats[input.seat];
  } catch {
    return true;
  }
  const value = seatState?.codex_endpoint;
  if (value === undefined || value === null) return false;
  // A record the shape reader cannot use is present all the same: unproven, not absent.
  if (readCodexEndpointRecord(value) === null) return true;
  return readRecordedCodexEndpoint(value, seatState?.presence_binding) !== null;
}

/** Starts (or reuses) the seat's managed app-server and records it on the seat state under the
 *  state lock, re-checking the binding the path was built from. The caller attaches the TUI only
 *  when this answers `up`; a `started` server the caller does not attach is its to stop. */
export async function ensureCodexEndpoint(
  input: {
    dir: string;
    session: string;
    seat: string;
    cwd?: string;
    /** `-c key=value` words from the seat's line (`codexEndpointConfig`). */
    config?: string[];
    /** The herdr pane the seat runs in, for the hook environment. */
    pane?: string;
    deps?: CodexEndpointDeps;
  },
): Promise<ManagedEndpointRead> {
  const deps = input.deps ?? {};
  const alive = deps.alive ?? pidAlive;
  const commandOf = deps.commandOf ?? codexCommandOf;
  const startOf = deps.startOf ?? processStartOf;
  const terminate = deps.terminate ?? ((pid: number) => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } });
  const plainDir = deps.isPlainDir ?? isPlainDir;
  const socket = deps.isSocket ?? isSocketFile;
  const drop = deps.drop ?? dropFile;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((settle) => setTimeout(settle, ms)));
  const now = deps.now ?? (() => new Date());
  const waitMs = deps.waitMs ?? 5_000;
  const spawn = deps.spawn ?? spawnAppServer;

  let state;
  try {
    state = readState(input.dir);
  } catch {
    return { kind: 'unmanaged', why: 'the team state is unreadable; the managed endpoint cannot be recorded' };
  }
  const seatState = state.sessions[input.session]?.seats[input.seat];
  const binding = seatState?.presence_binding;
  if (!isPresenceBinding(binding)) {
    return { kind: 'unmanaged', why: 'the seat records no valid presence binding' };
  }
  const socketPath = endpointSocketOf(input.dir, input.session, input.seat, binding, deps.runtimeRoot);
  if (socketPath.kind !== 'ok') {
    return { kind: 'unmanaged', why: socketPath.why };
  }
  if (socketPath.runtime) {
    // The runtime folder is this user's own, with no group or other access, before anything is
    // placed in it; the sweep before every launch there removes only sockets and records whose
    // recorded process has gone.
    const rootProblem = ensureRuntimeRoot(socketPath.root, plainDir);
    if (rootProblem !== null) return { kind: 'unmanaged', why: rootProblem };
    sweepRuntimeSockets(socketPath.root, deps);
  }

  // A predecessor incarnation's record is read by shape (its binding is not the current one, by
  // definition); consumers read the current binding's record through the strict door.
  const prior = readCodexEndpointRecord(seatState?.codex_endpoint);
  const config = input.config ?? [];
  // The same incarnation, still ours, still listening, and started with this launch's
  // configuration: reuse it rather than start a second server on the same path. The process
  // proof is the same one a stop requires, and the config is the second half: the endpoint's
  // configuration governs the attached TUI's turns (`codexEndpointConfig`), so a server started
  // for another line would leave this seat without its own `-c` pairs and permissions. A record
  // that names no config is never reused; the endpoint is stopped and a fresh one started.
  if (prior !== null && prior.binding === binding && prior.url === socketPath.url
    && socket(socketPath.path) && provenOwner(prior, { alive, commandOf, startOf })
    && sameEndpointConfig(prior.config, config)
    && sameLiveEndpointFlags(commandOf(prior.pid), prior.url, config)
    // A reused runtime socket is narrowed again before it serves this launch: a server is
    // reused only while it is the one the launch started and only while it stays its owner's.
    && (!socketPath.runtime || lockDownSocket(socketPath.path) === null)) {
    return { kind: 'up', url: socketPath.url, started: false };
  }

  const notes: string[] = [];
  if (prior !== null) {
    const stopped = stopRecordedCodexEndpoint(
      { dir: input.dir, session: input.session, seat: input.seat, record: prior },
      deps,
    );
    if (!stopped.stopped) {
      if (prior.url === socketPath.url) {
        return {
          kind: 'unmanaged',
          why: `the previous endpoint cannot be proven and stopped: ${stopped.why ?? 'unknown reason'}`,
        };
      }
      notes.push(`the previous endpoint was left alone: ${stopped.why ?? 'unknown reason'}`);
    } else if (alive(prior.pid)) {
      // The signal was sent; give it a moment to leave before binding the same path again.
      const deadline = Date.now() + 500;
      while (alive(prior.pid) && Date.now() < deadline) await sleep(25);
    }
  }

  // A runtime socket's root was checked and swept above; the state folder has nothing of this
  // seat's to leave in place, because this seat's path was never short enough for a socket there.
  if (!socketPath.runtime) {
    const folder = endpointFolder(input.dir, input.session, input.seat);
    if (folder === null) {
      return { kind: 'unmanaged', why: 'the session or seat cannot name an endpoint folder' };
    }
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
    } catch {
      return { kind: 'unmanaged', why: 'the endpoint folder could not be made' };
    }
    if (!plainDir(folder)) {
      return { kind: 'unmanaged', why: 'the endpoint folder is not a plain directory' };
    }
    // A socket is only ever removed through the record that names it, before the new server binds.
    // A socket no record names is reported and left: nothing proves its process has gone.
    const priorPath = prior === null
      ? null
      : ownedSocketPath(input.dir, input.session, input.seat, prior, deps.runtimeRoot)?.path ?? null;
    const leftAlone = socketsLeftAlone(folder, [socketPath.path, priorPath], socket);
    if (leftAlone.length > 0) {
      notes.push(`an endpoint socket no record names was left in place: ${leftAlone.join(', ')}; nothing proves its process has gone`);
    }
  }
  const hookEnv = input.pane === undefined ? null : (deps.herdrEnv ?? herdrHookEnv)(input.session, input.pane);
  if (input.pane !== undefined && hookEnv === null) notes.push('herdr did not name the session\'s socket, so its turn hooks cannot report this seat');
  // The entry standing at the endpoint path when this launch starts its server, if any: the wait
  // below cannot tell a socket this launch made from one that was already there, so what stood
  // here beforehand decides whether the socket that answers is this call's to take or to leave.
  const before = entryIdentity(socketPath.path);
  const started = spawn({ url: socketPath.url, ...(input.cwd === undefined ? {} : { cwd: input.cwd }), config, ...(hookEnv === null ? {} : { env: hookEnv }) });
  if (started === null) {
    return { kind: 'unmanaged', why: 'the Codex app-server did not start' };
  }

  // What this call started is this call's to clean — the process, and only the objects at the
  // endpoint and record paths that this call observed appear. An entry that stood at either name
  // before this launch, and any successor object there, is left exactly where it is: a pathname
  // alone proves nothing about who made what stands at it.
  const recordPath = socketPath.runtime ? ownerRecordPathOf(socketPath.path) : null;
  let made: EntryIdentity | null = null;
  let ours = false;
  let recordWritten: EntryIdentity | null = null;
  const discard = () => {
    terminate(started.pid);
    if (ours && (made === null || sameEntry(made, entryIdentity(socketPath.path)))) drop(socketPath.path);
    if (recordPath !== null && recordWritten !== null && sameEntry(recordWritten, entryIdentity(recordPath))) drop(recordPath);
  };

  const deadline = Date.now() + waitMs;
  while (!socket(socketPath.path)) {
    if (Date.now() >= deadline) {
      made = entryIdentity(socketPath.path);
      // An entry that stood here before this launch, or a name left empty after one did, is not
      // this call's to remove; an entry that appeared where nothing stood is.
      ours = before === null || (made !== null && !sameEntry(before, made));
      discard();
      return { kind: 'unmanaged', why: 'the Codex app-server did not create its socket in time' };
    }
    await sleep(25);
  }
  made = entryIdentity(socketPath.path);
  if (before !== null && (made === null || sameEntry(before, made))) {
    // The socket the wait saw was already at the path when this launch started its server (or the
    // name was left empty): it is not this launch's to narrow, record or remove. Only the process
    // this launch started is stopped; the socket and the record beside it stay as they were, for
    // whichever launch made them to account for.
    terminate(started.pid);
    return {
      kind: 'unmanaged',
      why: made === null
        ? 'the endpoint socket vanished before this launch could check it; nothing was removed'
        : 'an endpoint socket this launch did not make is already at its path; it was left in place',
    };
  }
  ours = true;

  const startedAt = now().toISOString();
  if (socketPath.runtime) {
    // The socket the server made is this user's alone (measured: codex-cli 0.161.0 leaves it
    // 0755), and the record beside it is what lets a walk up from the process find the seat
    // again. Either failing means this launch has no owner-only endpoint to hand the TUI.
    const narrowed = lockDownSocket(socketPath.path);
    if (narrowed !== null) {
      discard();
      return { kind: 'unmanaged', why: narrowed };
    }
    const pointed = writeOwnerRecord(socketPath.path, {
      dir: input.dir,
      binding,
      pid: started.pid,
      at: startedAt,
    });
    if (!pointed.ok) {
      discard();
      return { kind: 'unmanaged', why: pointed.why };
    }
    recordWritten = pointed.entry;
  }

  const recorded = updateState(
    input.dir,
    (file) => {
      const current = file.sessions[input.session]?.seats[input.seat];
      // The seat must still be the incarnation this endpoint was started for. A binding that
      // moved while the socket was coming up belongs to a successor launch, never this process.
      if (current === undefined || current.presence_binding !== binding) return false;
      current.codex_endpoint = {
        url: socketPath.url,
        binding,
        pid: started.pid,
        started_at: startedAt,
        // What this server was started with, so a later launch can tell whether this very
        // incarnation can serve its line or must be replaced.
        config,
      };
      return true;
    },
    { writeWhen: (ok) => ok },
  );
  if (!recorded) {
    // The server this call started is this call's to clean: it was never attached, and its
    // successor's record must not be overwritten by a stale incarnation.
    discard();
    return { kind: 'unmanaged', why: 'the seat binding changed while the endpoint started' };
  }
  return {
    kind: 'up',
    url: socketPath.url,
    started: true,
    ...(notes.length === 0 ? {} : { notes }),
  };
}

/**
 * The launch side of a managed Codex seat: this launch is a new incarnation, so it mints and
 * records the seat's presence binding first, then ensures the endpoint under it. A Claude seat
 * gets its binding from the settings file its launch installs; a Codex seat has no such file,
 * and without this it never held a binding, so no managed endpoint could ever start for it and
 * its thread stayed out of the native queue's reach. A state that cannot be written mints
 * nothing, and the launch fails managed: the binding the seat still records belongs to the
 * predecessor incarnation, and reusing the endpoint under it would attach this launch's seat to
 * a server started for the old pane's hook environment. The seat launches unmanaged instead,
 * with the line saying why.
 */
export async function launchCodexEndpoint(
  input: { dir: string; session: string; seat: string; cwd?: string; config?: string[]; pane?: string; deps?: CodexEndpointDeps },
): Promise<ManagedEndpointRead> {
  if (isPresenceSeatName(input.seat)) {
    try {
      const binding = mintPresenceBinding();
      updateState(input.dir, (state) => {
        const one = state.sessions[input.session];
        const current = one?.seats[input.seat];
        if (current !== undefined) current.presence_binding = binding;
      });
    } catch {
      const why = "the seat's fresh presence binding could not be recorded; the endpoint under an older binding is not reused";
      rememberEndpointFallback(input, why);
      return { kind: 'unmanaged', why };
    }
  }
  const read = await ensureCodexEndpoint(input);
  rememberEndpointFallback(input, read.kind === 'unmanaged' ? read.why : null);
  return read;
}

/** Writes the launch's answer where `team status` and `team check` read it: the reason this
 *  launch's managed endpoint was not started, or nothing once one is. Best effort: a state that
 *  cannot be written keeps the previous answer, and the launch's own line still says why. */
function rememberEndpointFallback(
  input: { dir: string; session: string; seat: string; deps?: CodexEndpointDeps },
  why: string | null,
): void {
  const now = input.deps?.now ?? (() => new Date());
  try {
    updateState(
      input.dir,
      (state) => {
        const current = state.sessions[input.session]?.seats[input.seat];
        if (current === undefined) return false;
        if (why === null) {
          if (current.codex_endpoint_unmanaged === undefined) return false;
          delete current.codex_endpoint_unmanaged;
          return true;
        }
        if (current.codex_endpoint_unmanaged?.why === why) return false;
        current.codex_endpoint_unmanaged = { why, at: now().toISOString() };
        return true;
      },
      { writeWhen: (wrote) => wrote },
    );
  } catch {
    // Status and check say nothing rather than guess; the launch's own answer still carries why.
  }
}

/** The seat a recorded managed endpoint serves, read from the process at `pid`; null unless the
 *  full ownership proof holds. With the TUI attached by `--remote`, a Codex seat's tools run as
 *  children of its app-server, which the launch started outside the seat's pane, so the walk up
 *  from a seat's own `team` call meets that app-server and no herdr server. The app-server is
 *  placed as its seat only when its command line is `app-server --listen <url>` for a path this
 *  seat incarnation's own launch gives it — its run folder, or the runtime folder's hash of it,
 *  whose strict owner record names the state folder the search starts in — the team state records
 *  that very url and pid for the seat's current presence binding, and the process started in the
 *  window the record was written in (the proof a stop needs). The state's own record and the
 *  process proof decide; the owner record is only where the search starts. */
export function seatOfManagedEndpoint(
  pid: number,
  deps: Pick<CodexEndpointDeps, 'alive' | 'commandOf' | 'startOf' | 'runtimeRoot'> = {},
): { dir: string; session: string; seat: string; pane?: string } | null {
  const commandOf = deps.commandOf ?? codexCommandOf;
  const command = commandOf(pid);
  if (command === null) return null;
  const listen = /(?:^|\s)app-server --listen unix:\/\/(\/\S+?\.sock)(?:\s|$)/.exec(command);
  if (listen === null) return null;
  const socketPath = (listen as unknown as [string, string])[1];
  const proof = { alive: deps.alive ?? pidAlive, commandOf, startOf: deps.startOf ?? processStartOf };
  const seatProof = (
    dir: string,
    session: string,
    seat: string,
    binding: string,
    seatState: SeatState | undefined,
  ): { dir: string; session: string; seat: string; pane?: string } | null => {
    if (seatState?.presence_binding !== binding) return null;
    const record = readCodexEndpointRecord(seatState.codex_endpoint);
    const expected = endpointSocketOf(dir, session, seat, binding, deps.runtimeRoot);
    if (record === null || expected.kind !== 'ok' || expected.path !== socketPath || expected.url !== record.url) return null;
    if (record.pid !== pid || record.binding !== binding) return null;
    if (!provenOwner(record, proof)) return null;
    return { dir, session, seat, ...(typeof seatState.pane === 'string' ? { pane: seatState.pane } : {}) };
  };

  // The state folder's own shape: `<dir>/run/<folder>/<seat>/<binding>.sock`.
  const own = /^(.*)\/run\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\.sock$/.exec(socketPath);
  if (own !== null) {
    const [, dir, folder, seat, binding] = own as unknown as [string, string, string, string, string];
    if (isPresenceBinding(binding) && isPresenceSeatName(seat)) {
      const state = readStateOrNull(dir);
      if (state !== null) {
        for (const [session, one] of Object.entries(state.sessions)) {
          if (presenceSessionFolder(session) !== folder) continue;
          const found = seatProof(dir, session, seat, binding, one.seats[seat]);
          if (found !== null) return found;
        }
      }
    }
  }
  // The runtime folder's shape, `<root>/<hash>.sock`: the strict owner record beside the socket
  // names the state folder the seat lives in. It is only a pointer — the seat's own record, the
  // recomputed socket path and the process proof still decide, exactly as for the folder shape.
  const owner = readEndpointOwnerRecord(ownerRecordPathOf(socketPath));
  if (owner === null || owner.pid !== pid) return null;
  const state = readStateOrNull(owner.dir);
  if (state === null) return null;
  for (const [session, one] of Object.entries(state.sessions)) {
    for (const seat of Object.keys(one.seats)) {
      if (one.seats[seat]?.presence_binding !== owner.binding) continue;
      const found = seatProof(owner.dir, session, seat, owner.binding, one.seats[seat]);
      if (found !== null) return found;
    }
  }
  return null;
}

/** The state at `dir`, or null when it cannot be read: a walk up names no seat it cannot prove. */
function readStateOrNull(dir: string): State | null {
  try {
    return readState(dir);
  } catch {
    return null;
  }
}

/** The seats whose launch could not start their managed endpoint, one line each, in the same
 *  words for `team status` and `team check`. A declared Codex seat is noted only when its last
 *  launch recorded a fallback and the seat holds no usable endpoint record: a newer launch that
 *  did start an endpoint is the answer that stands, and its record is the proof. */
export function unmanagedEndpointNotes(seats: readonly Seat[], state: SessionState): string[] {
  const notes: string[] = [];
  for (const seat of seats) {
    if (seat.cli !== 'codex') continue;
    const one = state.seats[seat.name];
    const fell = one?.codex_endpoint_unmanaged;
    if (fell === undefined) continue;
    if (readRecordedCodexEndpoint(one?.codex_endpoint, one?.presence_binding) !== null) continue;
    notes.push(`${seat.name}: the managed Codex endpoint did not start at its last launch: ${fell.why}`);
  }
  return notes;
}
