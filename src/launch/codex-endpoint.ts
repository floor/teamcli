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
// the endpoint as unknown rather than reusing it (`daemon/presence/endpoint-record.ts`).
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
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isPresenceBinding } from '../daemon/presence/contract.ts';
import {
  codexEndpointPath,
  readCodexEndpointRecord,
  readRecordedCodexEndpoint,
  type CodexEndpointRecord,
} from '../daemon/presence/endpoint-record.ts';
import { isPresenceSeatName, presenceSessionFolder } from '../daemon/presence/spool.ts';
import { readState, updateState } from '../state.ts';

/** The longest unix socket path this build will ask Codex to bind: macOS refuses paths over 104
 *  bytes, and a shorter bound leaves room for the OS's own accounting. */
const MAX_SOCKET_PATH_BYTES = 100;

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

/** The explicit endpoint a managed launch would give this seat incarnation. Null when the state
 *  folder, the session or the seat cannot name one this build can bind to. */
export function codexEndpointSocket(
  dir: string,
  session: string,
  seat: string,
  binding: string,
): { url: string; path: string } | null {
  const folder = endpointFolder(dir, session, seat);
  if (folder === null || !isPresenceBinding(binding)) return null;
  const path = join(folder, `${binding}.sock`);
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) return null;
  return { url: `unix://${path}`, path };
}

/** The path a record names, when it is one this seat's own launch folder owns. Both the record's
 *  binding and the file name are checked: a record pointing anywhere else is never touched. */
function ownedSocketPath(
  dir: string,
  session: string,
  seat: string,
  record: CodexEndpointRecord,
): string | null {
  const folder = endpointFolder(dir, session, seat);
  if (folder === null) return null;
  const path = codexEndpointPath(record);
  if (path === null) return null;
  if (dirname(path) !== folder) return null;
  if (basename(path) !== `${record.binding}.sock`) return null;
  return path;
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
function codexCommandOf(pid: number): string | null {
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
function processStartOf(pid: number): number | null {
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

function isSocketFile(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
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
  spawn?: (input: { url: string; cwd?: string }) => { pid: number } | null;
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
};

function spawnAppServer(input: { url: string; cwd?: string }): { pid: number } | null {
  const child = nodeSpawn('codex', ['app-server', '--listen', input.url], {
    detached: true,
    stdio: 'ignore',
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  });
  // A spawn failure arrives as an event, never as a thrown error from `spawn`; without a listener
  // it would crash the launch. The pid is absent in that case, and the caller falls back.
  child.on('error', () => {});
  child.unref();
  return child.pid === undefined ? null : { pid: child.pid };
}

/** The one ownership proof both the stop and the reuse paths require: the live process at the
 *  recorded pid is the `codex` binary, its command line carries exactly this record's
 *  `app-server --listen <url>`, and its own start instant sits in the window in which the launch
 *  wrote the record. The start instant is what a reused pid fails: the process the OS handed the
 *  pid to started after the record was written, so it is never the one the record describes. The
 *  recorded `started_at` is quoted exactly as written; it is compared, never trusted as truth. */
function provenOwner(
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
  if (started === null) return false;
  const recordedAt = Date.parse(record.started_at);
  if (!Number.isFinite(recordedAt)) return false;
  return started <= recordedAt + START_SKEW_MS && started >= recordedAt - START_WINDOW_MS;
}

/** Stops the process a record names, only after proving it is the app-server the launch started:
 *  a live `codex` command line carrying the exact `app-server --listen <url>` of this record, a
 *  plain (non-symlink) seat folder, and a socket file (not a symlink) at the owned path. An
 *  unprovable pid is never signalled; the socket file is removed only when it is that socket. */
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

  const path = ownedSocketPath(input.dir, input.session, input.seat, input.record);
  if (path === null) {
    return { stopped: false, why: 'the record does not name this seat’s own socket' };
  }
  if (!plainDir(dirname(path))) {
    return { stopped: false, why: 'the endpoint folder is not a plain directory; nothing was removed' };
  }
  if (!socket(path)) {
    // No socket file: there is no endpoint at the owned path to stop, and nothing else is touched.
    return { stopped: true };
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
  drop(path);
  return { stopped: true };
}

/** Stops and forgets the endpoint recorded on a seat's current binding, if one is recorded and
 *  provably this launch's. The record is cleared only after the stop succeeded, so an unprovable
 *  predecessor stays visible rather than being erased on a refusal. */
export function stopSeatCodexEndpoint(
  input: { dir: string; session: string; seat: string },
  deps: CodexEndpointDeps = {},
): EndpointStopRead {
  let seatState;
  try {
    seatState = readState(input.dir).sessions[input.session]?.seats[input.seat];
  } catch {
    return { stopped: false, why: 'the team state is unreadable; nothing was stopped' };
  }
  const record = readRecordedCodexEndpoint(seatState?.codex_endpoint, seatState?.presence_binding);
  if (record === null) return { stopped: false, why: 'the seat records no endpoint for its current binding' };
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

/** Starts (or reuses) the seat's managed app-server and records it on the seat state under the
 *  state lock, re-checking the binding the path was built from. The caller attaches the TUI only
 *  when this answers `up`; a `started` server the caller does not attach is its to stop. */
export async function ensureCodexEndpoint(
  input: {
    dir: string;
    session: string;
    seat: string;
    cwd?: string;
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
  const socketPath = codexEndpointSocket(input.dir, input.session, input.seat, binding);
  if (socketPath === null) {
    return { kind: 'unmanaged', why: 'the session or seat cannot name a short enough endpoint path' };
  }

  // A predecessor incarnation's record is read by shape (its binding is not the current one, by
  // definition); consumers read the current binding's record through the strict door.
  const prior = readCodexEndpointRecord(seatState?.codex_endpoint);
  // The same incarnation, still ours and still listening: reuse it rather than start a second
  // server on the same path. The proof is the same one a stop requires.
  if (prior !== null && prior.binding === binding && prior.url === socketPath.url
    && socket(socketPath.path) && provenOwner(prior, { alive, commandOf, startOf })) {
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
  const priorPath = prior === null ? null : ownedSocketPath(input.dir, input.session, input.seat, prior);
  const leftAlone = socketsLeftAlone(folder, [socketPath.path, priorPath], socket);
  if (leftAlone.length > 0) {
    notes.push(`an endpoint socket no record names was left in place: ${leftAlone.join(', ')}; nothing proves its process has gone`);
  }
  const started = spawn({ url: socketPath.url, ...(input.cwd === undefined ? {} : { cwd: input.cwd }) });
  if (started === null) {
    return { kind: 'unmanaged', why: 'the Codex app-server did not start' };
  }

  const deadline = Date.now() + waitMs;
  while (!socket(socketPath.path)) {
    if (Date.now() >= deadline) {
      terminate(started.pid);
      drop(socketPath.path);
      return { kind: 'unmanaged', why: 'the Codex app-server did not create its socket in time' };
    }
    await sleep(25);
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
        started_at: now().toISOString(),
      };
      return true;
    },
    { writeWhen: (ok) => ok },
  );
  if (!recorded) {
    // The server this call started is this call's to clean: it was never attached, and its
    // successor's record must not be overwritten by a stale incarnation.
    terminate(started.pid);
    drop(socketPath.path);
    return { kind: 'unmanaged', why: 'the seat binding changed while the endpoint started' };
  }
  return {
    kind: 'up',
    url: socketPath.url,
    started: true,
    ...(notes.length === 0 ? {} : { notes }),
  };
}
