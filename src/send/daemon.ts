// The `team send` delivery daemon (`<storeDir>/send/daemon.sock` and `daemon.lock`).
//
// Owns the per-seat FIFO queue (`MAX_QUEUE_DEPTH = 32`), retries when a seat is mid-turn
// (`working`) or its per-seat lock (`seat-locks/<session>/<seat>`) is held by `up` or
// `answer`, checks process identity (`paneHoldsShell` and `seatProcessVerdict`) so a trigger
// is never typed into a bare shell, checks composer state (`boxHoldsText` and `readScreen`)
// so a trigger is never typed over an unsent user draft or a dialog screen, writes `0600`
// drop files under `<storeDir>/drops/<session>/<seat>/<id>`, and appends `0600` JSONL records
// to `<storeDir>/messages.jsonl`.
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TeamFile } from '../file/types.ts';
import { agentList, agentStatus, paneProcesses, paneRead, pressEnter, typeText, type PaneProcesses } from '../herdr.ts';
import { boxHoldsText } from '../launch/deliver.ts';
import { paneHoldsShell, seatProcessVerdict } from '../launch/identity.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { logLine } from '../log.ts';
import { readState } from '../state.ts';
import { storePath } from '../store/store.ts';
import { classify, readScreen } from '../watch/screen.ts';
import { appendHistory } from './history.ts';
import { bindPane, deliverTrigger } from './deliver.ts';
import { dropMessage, TRIGGER_MAX, triggerLine, type NativePane } from './native.ts';
import { openReplyListener, readReply } from './reply.ts';
import { FRAME_LIMIT, sendFrame, type SendOutcome } from './uds.ts';

/** Maximum queued sends waiting per seat before new sends report queue full (`held`). */
export const MAX_QUEUE_DEPTH = 32;

/** Default bounded wait window (ms) when a seat is `working` or its `seat-lock` is held. */
export const DELIVER_WAIT_MS = 15_000;

/** Default poll cadence (ms) while waiting for a seat or its `seat-lock` to become free. */
export const POLL_READY_MS = 250;

const NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
const DIALOG = new Set(['question', 'permission', 'trust', 'vendor notice', 'provider error', 'rate limit']);

export type DaemonHost = {
  agents(session: string): { name: string; pane: string }[] | null;
  processInfo(session: string, pane: string): PaneProcesses | null;
  socketsDir: string;
  deliver(socketPath: string, frame: string): Promise<SendOutcome>;
  native: NativePane;
  now(): Date;
  home: string;
  /** Optional override for the bounded wait window when a seat is `working` or locked. */
  deliverWaitMs?: number;
  /** Optional override for the readiness poll cadence. */
  pollReadyMs?: number;
};

export const realDaemonHost: DaemonHost = {
  agents: (session) => agentList(session)?.map((agent) => ({ name: agent.name ?? '', pane: agent.pane })) ?? null,
  processInfo: (session, pane) => paneProcesses(pane, session),
  socketsDir: join(tmpdir(), 'cc-socks'),
  deliver: (socketPath, frame) => sendFrame(socketPath, frame),
  native: {
    typeText: (session, pane, text) => typeText(pane, text, session),
    pressEnter: (session, pane) => pressEnter(pane, session),
    status: (session, pane) => agentStatus(pane, session),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    paneText: (session, pane) => paneRead(pane, 40, session),
  },
  now: () => new Date(),
  home: homedir(),
};

export type DaemonSendRequest = {
  v: 1;
  op: 'send';
  id?: string;
  session?: string;
  from: string;
  to: string;
  body: string;
  wait?: boolean;
  timeout_s?: number;
};

export type DaemonRequest =
  | { v: 1; op: 'ping' }
  | { v: 1; op: 'shutdown' }
  | DaemonSendRequest;

export type DaemonSendResponse =
  | { v: 1; ok: true; id: string; seat: string; outcome: 'delivered'; status: string; drop_path: string }
  | { v: 1; ok: true; id: string; seat: string; outcome: 'answered'; reply: string; reply_id: string | null }
  | {
      v: 1;
      ok: false;
      id: string | null;
      seat: string;
      outcome: 'held' | 'unreachable' | 'timeout' | 'refused';
      detail: string;
      drop_path?: string;
    }
  | {
      v: 1;
      ok: false;
      id: string;
      seat: string;
      /** The trigger was typed and the seat never took it. `box` is what the input box held, not
       *  counting faint text, or null when it could not be read. */
      outcome: 'not-submitted';
      detail: string;
      box: string | null;
      tries: number;
      drop_path: string;
    };

export type DaemonResponse =
  | { v: 1; ok: true; pong: true; pid: number }
  | { v: 1; ok: true; shutdown: true }
  | DaemonSendResponse;

/** `<storeDir>/send` directory path. */
export function daemonDir(project: string, root: string, home = homedir()): string {
  return join(storePath(project, root, home), 'send');
}

/** `<storeDir>/send/daemon.sock` Unix domain socket path. */
export function daemonSocketPath(project: string, root: string, home = homedir()): string {
  return join(daemonDir(project, root, home), 'daemon.sock');
}

/** `<storeDir>/send/daemon.lock` single-instance lock path. */
export function daemonLockPath(project: string, root: string, home = homedir()): string {
  return join(daemonDir(project, root, home), 'daemon.lock');
}

/** `<storeDir>/drops/<session>/<seat>` directory for `0600` drop files under the state folder. */
export function daemonDropDir(project: string, root: string, home: string, session: string, seat: string): string {
  return join(storePath(project, root, home), 'drops', session, seat);
}

function heldAt(path: string): 'missing' | 'directory' | 'file' | 'socket' | 'symlink' | 'other' {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    if (stat.isSocket()) return 'socket';
    return 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'other';
  }
}

function ensureLadder(home: string, store: string, subdirs: string[]): { ok: true; leaf: string } | { ok: false; reason: string } {
  const configDir = join(home, '.config');
  const teamDir = join(configDir, 'team');
  const ladder = [configDir, teamDir, store];
  let current = store;
  for (const part of subdirs) {
    current = join(current, part);
    ladder.push(current);
  }
  for (const folder of ladder) {
    const seen = heldAt(folder);
    if (seen !== 'missing' && seen !== 'directory') {
      return { ok: false, reason: `the state folder ladder contains a non-directory (${seen})` };
    }
  }
  try {
    mkdirSync(current, { recursive: true, mode: 0o700 });
    chmodSync(store, 0o700);
    let step = store;
    for (const part of subdirs) {
      step = join(step, part);
      chmodSync(step, 0o700);
    }
  } catch {
    return { ok: false, reason: 'the state folder could not be created' };
  }
  for (const folder of ladder) {
    if (heldAt(folder) !== 'directory') {
      return { ok: false, reason: 'the state folder ladder changed while opening' };
    }
  }
  return { ok: true, leaf: current };
}

/** Writes `body` to a `0600` drop file in `directory`, rejecting any symlink or FIFO in place. */
export function writeSecureDrop(directory: string, id: string, body: string): string {
  const dirSeen = heldAt(directory);
  if (dirSeen !== 'missing' && dirSeen !== 'directory') {
    throw new Error(`drop directory is a ${dirSeen}`);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const finalPath = join(directory, id);
  const finalSeen = heldAt(finalPath);
  if (finalSeen !== 'missing' && finalSeen !== 'file') {
    throw new Error(`drop path is a ${finalSeen}`);
  }
  const tmp = `${finalPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('drop temp is not a regular file');
    fchmodSync(fd, 0o600);
    writeSync(fd, Buffer.from(body, 'utf8'));
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, finalPath);
    chmodSync(finalPath, 0o600);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
  return finalPath;
}

export function isAlivePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLockPid(lockPath: string): number {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as { pid?: unknown };
      if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) return parsed.pid;
    }
    const num = Number(raw.split(/\s+/)[0]);
    return Number.isInteger(num) && num > 0 ? num : NaN;
  } catch {
    return NaN;
  }
}

function writeLockFile(lockPath: string, pid: number): boolean {
  const seen = heldAt(lockPath);
  if (seen === 'symlink' || seen === 'directory' || seen === 'other') return false;
  const tmp = `${lockPath}.${pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, `${JSON.stringify({ pid })}\n`, undefined, 'utf8');
    } finally {
      closeSync(fd);
    }
    linkSync(tmp, lockPath);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

function acquireDaemonLock(
  lockPath: string,
  pid: number,
  alive: (pid: number) => boolean,
): { ok: true; release(): void } | { ok: false; holderPid: number | null; reason?: string } {
  const seen = heldAt(lockPath);
  if (seen === 'symlink' || seen === 'directory' || seen === 'other') {
    return { ok: false, holderPid: null, reason: `daemon lock path is a ${seen}` };
  }
  if (writeLockFile(lockPath, pid)) {
    return {
      ok: true,
      release: () => {
        if (readLockPid(lockPath) === pid) {
          try {
            unlinkSync(lockPath);
          } catch {}
        }
      },
    };
  }
  const holder = readLockPid(lockPath);
  if (!Number.isNaN(holder) && !alive(holder)) {
    // Stale lock left by a dead process (ESRCH): remove and reclaim.
    try {
      if (readLockPid(lockPath) === holder) unlinkSync(lockPath);
    } catch {}
    if (writeLockFile(lockPath, pid)) {
      return {
        ok: true,
        release: () => {
          if (readLockPid(lockPath) === pid) {
            try {
              unlinkSync(lockPath);
            } catch {}
          }
        },
      };
    }
  }
  const currentHolder = readLockPid(lockPath);
  return { ok: false, holderPid: Number.isNaN(currentHolder) ? null : currentHolder };
}

/** Probes `<socketPath>` with `{ v: 1, op: 'ping' }`. Resolves `true` when a live daemon answers `pong`. */
export function probeDaemonSocket(socketPath: string, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    if (heldAt(socketPath) !== 'socket') {
      resolve(false);
      return;
    }
    const socket = connect({ path: socketPath });
    let buffer = '';
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('error', () => finish(false));
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ v: 1, op: 'ping' })}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, nl)) as { ok?: unknown; pong?: unknown };
        finish(parsed.ok === true && parsed.pong === true);
      } catch {
        finish(false);
      }
    });
    socket.on('close', () => finish(false));
  });
}

/** Sends one `DaemonRequest` over `<socketPath>` and waits for the `DaemonResponse` line. */
export function requestDaemon(
  socketPath: string,
  request: DaemonRequest,
  timeoutMs = 30_000,
): Promise<DaemonResponse | null> {
  return new Promise((resolve) => {
    if (heldAt(socketPath) !== 'socket') {
      resolve(null);
      return;
    }
    const socket = connect({ path: socketPath });
    let buffer = '';
    let settled = false;
    const finish = (response: DaemonResponse | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('error', () => finish(null));
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, nl)) as DaemonResponse;
        finish(parsed);
      } catch {
        finish(null);
      }
    });
    socket.on('close', () => finish(null));
  });
}

export type StartSendDaemonInput = {
  root: string;
  dir: string;
  team: TeamFile;
  host?: DaemonHost;
  socketPath?: string;
  lockPath?: string;
  pid?: number;
  alive?: (pid: number) => boolean;
};

export type SendDaemonHandle = {
  socketPath: string;
  lockPath: string;
  close(): Promise<void>;
};

export type StartSendDaemonResult =
  | { kind: 'serving'; handle: SendDaemonHandle }
  | { kind: 'already-running'; socketPath: string; pid: number | null }
  | { kind: 'locked'; holderPid: number | null }
  | { kind: 'bind-failed'; reason: string };

type QueuedItem = {
  request: DaemonSendRequest;
  resolve: (response: DaemonSendResponse) => void;
};

/**
 * Starts the per-project `team send` delivery daemon on `<storeDir>/send/daemon.sock` (`0600`)
 * under `<storeDir>/send/daemon.lock` (`0600`).
 */
export async function startSendDaemon(input: StartSendDaemonInput): Promise<StartSendDaemonResult> {
  const host = input.host ?? realDaemonHost;
  const pid = input.pid ?? process.pid;
  const alive = input.alive ?? isAlivePid;
  const store = storePath(input.team.project, input.root, host.home);
  const ladder = ensureLadder(host.home, store, ['send']);
  if (!ladder.ok) return { kind: 'bind-failed', reason: ladder.reason };

  const socketPath = input.socketPath ?? daemonSocketPath(input.team.project, input.root, host.home);
  const lockPath = input.lockPath ?? daemonLockPath(input.team.project, input.root, host.home);

  // If a live daemon is already answering on the socket, exit cleanly without unlinking it.
  if (await probeDaemonSocket(socketPath)) {
    const holder = readLockPid(lockPath);
    return { kind: 'already-running', socketPath, pid: Number.isNaN(holder) ? null : holder };
  }

  const lock = acquireDaemonLock(lockPath, pid, alive);
  if (!lock.ok) {
    if (lock.reason) return { kind: 'bind-failed', reason: lock.reason };
    if (await probeDaemonSocket(socketPath)) {
      return { kind: 'already-running', socketPath, pid: lock.holderPid };
    }
    return { kind: 'locked', holderPid: lock.holderPid };
  }

  // Re-probe under the lock so two concurrent starts never unlink a live socket.
  const socketSeen = heldAt(socketPath);
  if (socketSeen === 'symlink' || socketSeen === 'directory' || socketSeen === 'other' || socketSeen === 'file') {
    lock.release();
    return { kind: 'bind-failed', reason: `the daemon socket path holds a ${socketSeen}` };
  }
  if (socketSeen === 'socket') {
    if (await probeDaemonSocket(socketPath)) {
      lock.release();
      const holder = readLockPid(lockPath);
      return { kind: 'already-running', socketPath, pid: Number.isNaN(holder) ? null : holder };
    }
    try {
      unlinkSync(socketPath);
    } catch {
      lock.release();
      return { kind: 'bind-failed', reason: 'stale daemon socket could not be removed' };
    }
  }

  // Per-seat FIFO queues and active worker flags.
  const queues = new Map<string, QueuedItem[]>();
  const activeWorkers = new Map<string, Promise<void>>();
  const connections = new Set<Socket>();

  const drainSeat = async (seatName: string): Promise<void> => {
    const queue = queues.get(seatName);
    if (!queue) return;
    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        const response = await executeQueuedSend(input.dir, input.root, input.team, host, item.request, alive);
        item.resolve(response);
      } catch {
        item.resolve({
          v: 1,
          ok: false,
          id: item.request.id ?? null,
          seat: seatName,
          outcome: 'unreachable',
          detail: 'delivery interrupted before completion; nothing further was pressed',
        });
      }
    }
    queues.delete(seatName);
    activeWorkers.delete(seatName);
  };

  const enqueueSend = (request: DaemonSendRequest): Promise<DaemonSendResponse> => {
    const seatName = typeof request.to === 'string' ? request.to : '';
    if (request.session !== undefined && request.session !== input.team.session) {
      return Promise.resolve({
        v: 1,
        ok: false,
        id: null,
        seat: seatName,
        outcome: 'refused',
        detail: `${seatName}: session "${request.session}" does not belong to this project's session "${input.team.session}"; nothing was sent`,
      });
    }
    if (request.from !== 'owner' && request.from !== input.team.orchestrator) {
      return Promise.resolve({
        v: 1,
        ok: false,
        id: null,
        seat: seatName,
        outcome: 'refused',
        detail: `a seat may not send (${String(request.from)}): only the owner, or the orchestrator from its own seat, can send`,
      });
    }
    const configured = input.team.seats.find((s) => s.name === seatName);
    if (!configured) {
      const names = input.team.seats.map((s) => s.name);
      const seatList = names.length === 0 ? '(none)' : names.join(', ');
      return Promise.resolve({
        v: 1,
        ok: false,
        id: null,
        seat: seatName,
        outcome: 'refused',
        detail: `${seatName}: it is not a declared seat; the file's seats are ${seatList}`,
      });
    }
    let queue = queues.get(seatName);
    if (!queue) {
      queue = [];
      queues.set(seatName, queue);
    }
    if (queue.length >= MAX_QUEUE_DEPTH) {
      return Promise.resolve({
        v: 1,
        ok: false,
        id: request.id ?? null,
        seat: seatName,
        outcome: 'held',
        detail: `${seatName}: send queue is full (${String(MAX_QUEUE_DEPTH)} messages waiting)`,
      });
    }
    return new Promise<DaemonSendResponse>((resolve) => {
      queue.push({ request, resolve });
      if (!activeWorkers.has(seatName)) {
        const worker = drainSeat(seatName);
        activeWorkers.set(seatName, worker);
      }
    });
  };

  let closed = false;
  let server: Server;

  const closeHandle = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.allSettled([...activeWorkers.values()]);
    for (const sock of connections) sock.destroy();
    connections.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      if (heldAt(socketPath) === 'socket') unlinkSync(socketPath);
    } catch {}
    lock.release();
  };

  server = createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    let handled = false;
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      handled = true;
      const line = buffer.slice(0, nl);
      let req: DaemonRequest;
      try {
        req = JSON.parse(line) as DaemonRequest;
      } catch {
        socket.end(
          `${JSON.stringify({ v: 1, ok: false, id: null, seat: '', outcome: 'refused', detail: 'invalid daemon request' })}\n`,
        );
        return;
      }
      if (req.op === 'ping') {
        socket.end(`${JSON.stringify({ v: 1, ok: true, pong: true, pid })}\n`);
        return;
      }
      if (req.op === 'shutdown') {
        socket.end(`${JSON.stringify({ v: 1, ok: true, shutdown: true })}\n`, () => {
          void closeHandle();
        });
        return;
      }
      if (req.op === 'send') {
        void enqueueSend(req).then((res) => {
          if (!socket.destroyed) {
            socket.end(`${JSON.stringify(res)}\n`);
          }
        });
      }
    });
  });

  const bound = await new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
    const onError = (error: Error) => {
      resolve({ ok: false, reason: error.message });
    };
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      try {
        chmodSync(socketPath, 0o600);
      } catch {}
      resolve({ ok: true });
    });
  });

  if (!bound.ok) {
    lock.release();
    return { kind: 'bind-failed', reason: bound.reason };
  }

  return {
    kind: 'serving',
    handle: {
      socketPath,
      lockPath,
      close: closeHandle,
    },
  };
}

/** Stops a running send daemon for `(project, root, home)` via `{ op: 'shutdown' }` and cleans stale lock/socket files. */
export async function stopSendDaemon(project: string, root: string, home = homedir()): Promise<boolean> {
  const socketPath = daemonSocketPath(project, root, home);
  const lockPath = daemonLockPath(project, root, home);
  const res = await requestDaemon(socketPath, { v: 1, op: 'shutdown' }, 1_000);
  if (res && 'shutdown' in res && res.shutdown === true) {
    return true;
  }
  const holder = readLockPid(lockPath);
  if (!Number.isNaN(holder) && !isAlivePid(holder)) {
    try {
      unlinkSync(lockPath);
    } catch {}
    try {
      if (heldAt(socketPath) === 'socket') unlinkSync(socketPath);
    } catch {}
  }
  return false;
}

function dialogKind(cli: string, screen: string | null): string | null {
  if (screen === null) return null;
  const kind = classify(cli, screen.split('\n')).kind;
  return DIALOG.has(kind) ? kind : null;
}

function findSeatAgent(
  host: DaemonHost,
  session: string,
  seatName: string,
): { ok: true; pane: string } | { ok: false; kind: 'unreachable' | 'refused'; reason: string } {
  const agents = host.agents(session);
  if (agents === null) return { ok: false, kind: 'unreachable', reason: `the session "${session}" could not be read` };
  const named = agents.filter((agent) => agent.name === seatName);
  if (named.length === 0) return { ok: false, kind: 'unreachable', reason: 'no live agent carries that name in the session' };
  if (named.length > 1) {
    return { ok: false, kind: 'refused', reason: `${seatName}: herdr lists more than one agent of this name; nothing was sent` };
  }
  return { ok: true, pane: (named[0] as { pane: string }).pane };
}

function socketOf(host: DaemonHost, processes: PaneProcesses): string | null {
  const pids = [...processes.foreground, processes.shell].filter((pid, index, all) => all.indexOf(pid) === index);
  for (const pid of pids) {
    const path = join(host.socketsDir, `${String(pid)}.sock`);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Checks whether the target pane is at a bare shell (`paneHoldsShell`) or its recorded process
 * exited (`seatProcessVerdict === 'gone'`).
 */
export function isBareShellPane(dir: string, session: string, seatName: string, procs: PaneProcesses | null): boolean {
  if (!procs) return false;
  if (paneHoldsShell(procs)) return true;
  try {
    const state = readState(dir);
    const recorded = state.sessions[session]?.seats[seatName]?.launched;
    if (recorded && seatProcessVerdict(recorded, procs) === 'gone') return true;
  } catch {}
  return false;
}

async function acquireSeatLockWithRetry(
  dir: string,
  session: string,
  seatName: string,
  waitMs: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void>,
  alive: (pid: number) => boolean,
): Promise<{ ok: true; release(): void } | { ok: false; held: number }> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    // Reclaim stale seat lock if holder PID is dead according to `alive`.
    const lock = acquireSeatLock(dir, session, seatName);
    if ('release' in lock) return { ok: true, release: lock.release };
    if (lock.held > 0 && !alive(lock.held)) {
      try {
        unlinkSync(join(dir, 'seat-locks', session, seatName));
      } catch {}
      const retried = acquireSeatLock(dir, session, seatName);
      if ('release' in retried) return { ok: true, release: retried.release };
    }
    if (Date.now() >= deadline) return { ok: false, held: lock.held };
    await sleep(pollMs);
  }
}

async function executeQueuedSend(
  dir: string,
  root: string,
  team: TeamFile,
  host: DaemonHost,
  request: DaemonSendRequest,
  alive: (pid: number) => boolean,
): Promise<DaemonSendResponse> {
  const seatName = request.to;
  const from = request.from;
  const who = from === 'owner' ? 'owner' : from === team.orchestrator ? 'orchestrator' : 'seat';
  const body = request.body;
  const msgId = request.id ?? randomUUID();
  // Send to outcome is measured from here: the daemon's own handling, not the requester's wait.
  const startedAt = Date.now();
  const configured = team.seats.find((s) => s.name === seatName);
  if (!configured) {
    const names = team.seats.map((s) => s.name);
    return {
      v: 1,
      ok: false,
      id: null,
      seat: seatName,
      outcome: 'refused',
      detail: `${seatName}: it is not a declared seat; the file's seats are ${names.length === 0 ? '(none)' : names.join(', ')}`,
    };
  }

  const waitMs = host.deliverWaitMs ?? DELIVER_WAIT_MS;
  const pollMs = host.pollReadyMs ?? POLL_READY_MS;

  if (request.wait) {
    if (configured.cli !== 'claude-code') {
      return {
        v: 1,
        ok: false,
        id: null,
        seat: seatName,
        outcome: 'refused',
        detail: `${seatName} runs ${configured.cli}: this build confirms that a native CLI submitted and does not carry its reply; nothing was sent`,
      };
    }
    return executeSocketSend(dir, root, who, from, team, seatName, body, msgId, request.timeout_s ?? 120, waitMs, pollMs, host, alive);
  }

  const found = findSeatAgent(host, team.session, seatName);
  if (!found.ok) {
    if (found.kind === 'refused') {
      return { v: 1, ok: false, id: null, seat: seatName, outcome: 'refused', detail: found.reason };
    }
    appendHistory(team.project, root, host.home, {
      ts: host.now().toISOString(),
      from,
      to: seatName,
      body,
      id: msgId,
      outcome: 'unreachable',
      ms: Date.now() - startedAt,
    });
    return { v: 1, ok: false, id: msgId, seat: seatName, outcome: 'unreachable', detail: found.reason };
  }

  const pane = found.pane;
  const initialProcs = host.processInfo(team.session, pane);
  if (isBareShellPane(dir, team.session, seatName, initialProcs)) {
    const detail = 'the seat is back at its shell; nothing was typed';
    appendHistory(team.project, root, host.home, {
      ts: host.now().toISOString(),
      from,
      to: seatName,
      body,
      id: msgId,
      outcome: 'unreachable',
      ms: Date.now() - startedAt,
    });
    return { v: 1, ok: false, id: msgId, seat: seatName, outcome: 'unreachable', detail };
  }

  // Write the 0600 drop file under the project state folder `<storeDir>/drops/<session>/<seat>/<id>`
  // (after checking the state folder ladder with lstat + O_NOFOLLOW).
  const store = storePath(team.project, root, host.home);
  const dropLadder = ensureLadder(host.home, store, ['drops', team.session, seatName]);
  if (!dropLadder.ok) {
    return {
      v: 1,
      ok: false,
      id: null,
      seat: seatName,
      outcome: 'refused',
      detail: `${seatName}: the drop file could not be written (${dropLadder.reason}); nothing was typed`,
    };
  }
  const stateDropDir = dropLadder.leaf;
  const candidateDropPath = join(stateDropDir, msgId);
  const trigger = triggerLine(candidateDropPath);
  if (trigger === null) {
    return {
      v: 1,
      ok: false,
      id: null,
      seat: seatName,
      outcome: 'refused',
      detail: `${seatName}: the trigger would exceed ${String(TRIGGER_MAX)} characters; nothing was sent`,
    };
  }

  let dropPath: string;
  try {
    dropPath = writeSecureDrop(stateDropDir, msgId, body);
  } catch {
    return {
      v: 1,
      ok: false,
      id: null,
      seat: seatName,
      outcome: 'refused',
      detail: `${seatName}: the drop file could not be written; nothing was typed`,
    };
  }

  const recordHeld = (detail: string): DaemonSendResponse => {
    appendHistory(team.project, root, host.home, {
      ts: host.now().toISOString(),
      from,
      to: seatName,
      body,
      id: msgId,
      outcome: 'held',
      ms: Date.now() - startedAt,
    });
    return { v: 1, ok: false, id: msgId, seat: seatName, outcome: 'held', detail, drop_path: dropPath };
  };

  const recordUnreachable = (detail: string): DaemonSendResponse => {
    appendHistory(team.project, root, host.home, {
      ts: host.now().toISOString(),
      from,
      to: seatName,
      body,
      id: msgId,
      outcome: 'unreachable',
      ms: Date.now() - startedAt,
    });
    return { v: 1, ok: false, id: msgId, seat: seatName, outcome: 'unreachable', detail, drop_path: dropPath };
  };

  // Bounded wait loop: wait for `acquireSeatLock` and for the seat to finish any running turn (`working`).
  const deadline = Date.now() + waitMs;
  let lock: { release(): void } | null = null;

  try {
    for (;;) {
      const remaining = Math.max(0, deadline - Date.now());
      const acquired = await acquireSeatLockWithRetry(
        dir,
        team.session,
        seatName,
        remaining,
        pollMs,
        (ms) => host.native.wait(ms),
        alive,
      );
      if (!acquired.ok) {
        return recordHeld(`another command holds the seat (pid ${String(acquired.held)}); the drop file is at ${dropPath}`);
      }
      lock = acquired;

      if (isBareShellPane(dir, team.session, seatName, host.processInfo(team.session, pane))) {
        return recordUnreachable('the seat is back at its shell; nothing was typed');
      }

      const status = host.native.status(team.session, pane);
      if (status === null) {
        return recordUnreachable(`the seat's status could not be read; the drop file is at ${dropPath}`);
      }

      const rawScreen = host.native.paneText?.(team.session, pane) ?? null;
      if (rawScreen !== null) {
        const dialog = dialogKind(configured.cli, rawScreen);
        if (dialog !== null) {
          return recordHeld(`the screen reads ${dialog}; the drop file is at ${dropPath}`);
        }
        const screenKind = readScreen(configured.cli, rawScreen).kind;
        if (screenKind === 'unsent' && !boxHoldsText(configured.cli, trigger, rawScreen)) {
          return recordHeld(`the composer already holds unsent text; the drop file is at ${dropPath}`);
        }
        if (status === 'working' || screenKind === 'working') {
          lock.release();
          lock = null;
          if (Date.now() >= deadline) {
            return recordHeld(`the seat is working; the drop file is at ${dropPath}`);
          }
          await host.native.wait(pollMs);
          continue;
        }
      } else if (status === 'working') {
        lock.release();
        lock = null;
        if (Date.now() >= deadline) {
          return recordHeld(`the seat is working; the drop file is at ${dropPath}`);
        }
        await host.native.wait(pollMs);
        continue;
      }

      break;
    }

    // The last mile is the one `team send` itself takes: the box read with its styling, the line
    // typed, and `delivered` only once the trigger has left the box and the seat is working.
    const result = await deliverTrigger(bindPane(host.native, team.session), pane, trigger, configured.cli);
    const where = `the drop file is at ${dropPath}`;
    if (result.dialog !== undefined) return recordHeld(`the screen reads ${result.dialog}; ${where}`);
    if (result.outcome === 'held') return recordHeld(`${result.reason ?? 'the composer holds text'}; ${where}`);
    if (result.outcome === 'unreachable') return recordUnreachable(`${result.reason ?? 'the seat was not reached'}; ${where}`);
    if (result.outcome === 'not-submitted') {
      appendHistory(team.project, root, host.home, {
        ts: host.now().toISOString(),
        from,
        to: seatName,
        body,
        id: msgId,
        outcome: 'not-submitted',
        ms: Date.now() - startedAt,
        via: 'typed',
      });
      return {
        v: 1,
        ok: false,
        id: msgId,
        seat: seatName,
        outcome: 'not-submitted',
        detail: `the seat did not take the trigger; ${where}`,
        box: result.box ?? null,
        tries: result.tries,
        drop_path: dropPath,
      };
    }
    const submittedStatus = result.status ?? 'working';

    logLine(
      dir,
      'send',
      who,
      `${seatName}: delivered (drop ${String(body.length)} characters, ${result.evidence === 'transcript' ? 'the transcript shows the drop read' : `herdr status ${submittedStatus}`})`,
      host.now(),
    );
    appendHistory(team.project, root, host.home, {
      ts: host.now().toISOString(),
      from,
      to: seatName,
      body,
      id: msgId,
      outcome: 'delivered',
      ms: Date.now() - startedAt,
      via: 'typed',
    });
    return {
      v: 1,
      ok: true,
      id: msgId,
      seat: seatName,
      outcome: 'delivered',
      status: submittedStatus,
      drop_path: dropPath,
    };
  } catch {
    return recordUnreachable(`delivery interrupted before completion; the drop file is at ${dropPath}`);
  } finally {
    lock?.release();
  }
}

async function executeSocketSend(
  dir: string,
  root: string,
  who: string,
  from: string,
  team: TeamFile,
  seatName: string,
  body: string,
  msgId: string,
  timeoutS: number,
  waitMs: number,
  pollMs: number,
  host: DaemonHost,
  alive: (pid: number) => boolean,
): Promise<DaemonSendResponse> {
  // Send to outcome is measured from here: the socket send and, for --wait, the reply's wait.
  const startedAt = Date.now();
  const frame = `${JSON.stringify({ type: 'user', message: { role: 'user', content: body }, msg_id: msgId })}\n`;
  if (frame.length > FRAME_LIMIT) {
    return {
      v: 1,
      ok: false,
      id: msgId,
      seat: seatName,
      outcome: 'refused',
      detail: `${seatName}: the message is too large for this channel: the frame is ${String(frame.length)} characters and the socket's measured limit is ${String(FRAME_LIMIT)}; nothing was sent`,
    };
  }

  const found = findSeatAgent(host, team.session, seatName);
  if (!found.ok) {
    if (found.kind === 'refused') {
      return { v: 1, ok: false, id: msgId, seat: seatName, outcome: 'refused', detail: found.reason };
    }
    appendHistory(team.project, root, host.home, {
      ts: host.now().toISOString(),
      from,
      to: seatName,
      body,
      id: msgId,
      outcome: 'unreachable',
      ms: Date.now() - startedAt,
    });
    return { v: 1, ok: false, id: msgId, seat: seatName, outcome: 'unreachable', detail: found.reason };
  }

  const processes = host.processInfo(team.session, found.pane);
  if (processes === null) {
    appendHistory(team.project, root, host.home, {
      ts: host.now().toISOString(),
      from,
      to: seatName,
      body,
      id: msgId,
      outcome: 'unreachable',
      ms: Date.now() - startedAt,
    });
    return { v: 1, ok: false, id: msgId, seat: seatName, outcome: 'unreachable', detail: "the pane's processes could not be read" };
  }
  const socketPath = socketOf(host, processes);
  if (socketPath === null) {
    const detail = `no cross-session socket was found for its pane's processes (looked in ${host.socketsDir})`;
    appendHistory(team.project, root, host.home, {
      ts: host.now().toISOString(),
      from,
      to: seatName,
      body,
      id: msgId,
      outcome: 'unreachable',
      ms: Date.now() - startedAt,
    });
    return { v: 1, ok: false, id: msgId, seat: seatName, outcome: 'unreachable', detail };
  }

  const lock = await acquireSeatLockWithRetry(
    dir,
    team.session,
    seatName,
    waitMs,
    pollMs,
    (ms) => host.native.wait(ms),
    alive,
  );
  if (!lock.ok) {
    const detail = `another command holds the seat (pid ${String(lock.held)})`;
    appendHistory(team.project, root, host.home, {
      ts: host.now().toISOString(),
      from,
      to: seatName,
      body,
      id: msgId,
      outcome: 'held',
      ms: Date.now() - startedAt,
    });
    return { v: 1, ok: false, id: msgId, seat: seatName, outcome: 'held', detail };
  }

  try {
    const opened = await openReplyListener(host.socketsDir, process.pid);
    if (!opened.ok) {
      return { v: 1, ok: false, id: msgId, seat: seatName, outcome: 'refused', detail: `${seatName}: ${opened.reason}` };
    }
    const listener = opened.listener;
    try {
      const taken = await host.deliver(socketPath, frame);
      if (!taken.ok) {
        appendHistory(team.project, root, host.home, {
          ts: host.now().toISOString(),
          from,
          to: seatName,
          body,
          id: msgId,
          outcome: 'unreachable',
          ms: Date.now() - startedAt,
          via: 'socket',
        });
        return { v: 1, ok: false, id: msgId, seat: seatName, outcome: 'unreachable', detail: taken.reason };
      }
      logLine(dir, 'send', who, `${seatName}: sent on the socket (${String(frame.length)} characters)`, host.now());
      const outcome = await listener.wait(timeoutS * 1000);
      if (outcome.kind === 'answered') {
        const read = readReply(outcome.line);
        logLine(dir, 'send', who, `${seatName}: answered (reply ${String(read.reply.length)} characters)`, host.now());
        appendHistory(team.project, root, host.home, {
          ts: host.now().toISOString(),
          from,
          to: seatName,
          body,
          id: msgId,
          outcome: 'answered',
          ms: Date.now() - startedAt,
          via: 'socket',
        });
        return { v: 1, ok: true, id: msgId, seat: seatName, outcome: 'answered', reply: read.reply, reply_id: read.msg_id };
      }
      logLine(dir, 'send', who, `${seatName}: timeout (sent, no reply within ${String(timeoutS)}s)`, host.now());
      appendHistory(team.project, root, host.home, {
        ts: host.now().toISOString(),
        from,
        to: seatName,
        body,
        id: msgId,
        outcome: 'timeout',
        ms: Date.now() - startedAt,
        via: 'socket',
      });
      return {
        v: 1,
        ok: false,
        id: msgId,
        seat: seatName,
        outcome: 'timeout',
        detail: `sent, no reply within ${String(timeoutS)}s; a seat which does not accept messages from other sessions holds the frame until a person lets it through`,
      };
    } finally {
      listener.close();
    }
  } finally {
    lock.release();
  }
}
