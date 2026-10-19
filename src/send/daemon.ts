// The `team send` delivery daemon (`<storeDir>/send/daemon.sock` and `daemon.lock`).
//
// Owns the per-seat FIFO queue (`MAX_QUEUE_DEPTH = 32`), retries when a seat is mid-turn
// (`working`) or its per-seat lock (`seat-locks/<session>/<seat>`) is held by `up` or
// `answer`, checks process identity (`paneHoldsShell` and `seatProcessVerdict`) so a trigger
// is never typed into a bare shell, checks composer state (`readScreen`) so a trigger is never
// typed over a dialog screen and unsent text is copied and put back by the delivery, writes `0600`
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
import { agentList, agentStatus, paneProcesses, paneRead, pressEnter, sendKey, typeText, type PaneProcesses } from '../herdr.ts';
import { paneHoldsShell, seatProcessVerdict } from '../launch/identity.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { logLine } from '../log.ts';
import { profileFor } from '../profiles/index.ts';
import { teamIdOf } from '../registry/teams.ts';
import { senderLineFormatInForce } from '../settings/sender-line-policy.ts';
import { readState } from '../state.ts';
import { storePath } from '../store/store.ts';
import { classify, readScreen } from '../watch/screen.ts';
import { appendHistory, type HistoryEntry } from './history.ts';
import { bindPane, deliverTrigger, draftNote, TRIGGER_TAKEN_NOTE } from './deliver.ts';
import { dropMessage, TRIGGER_MAX, triggerLine, type NativePane } from './native.ts';
import { openReplyListener, readReply } from './reply.ts';
import { FRAME_LIMIT, SOCKET_SEND, sendFrame, type SendOutcome } from './uds.ts';
import { frameFor, frameReplyFor } from './frame.ts';
import { declaredInboundOf, inboundIsLive, inboundSkipReason } from './inbound.ts';

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
    // The queue's typed leg is the same delivery `team send` makes: a box holding its owner's
    // unsent text is cleared with the profile's measured keys and the text pasted back.
    sendKey: (session, pane, key) => sendKey(pane, key, session),
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
  /** The legs the caller's walk already tried and could not take the send, each `<leg>:
   *  <reason>`: the daemon writes the history line this send ends in, and the failures travel
   *  with it. Absent when the walk had none. */
  failed?: string[];
  /** The caller's walk holds a leg after the typed leg. A typed leg that finds no live agent
   *  typed nothing, so the daemon writes no history line for that ending and answers
   *  `fall_through`: the caller records the reason and carries the send to that leg. */
  fallthrough?: true;
  /** The address the caller wrote, when it was not the resolved seat's own name — a `@<nickname>`,
   *  a `<seat|nickname>@<team>`, `lead@<team>`, or an agent id — and the registry id it resolved
   *  to. The history line keeps both beside `to`, the seat. */
  spec?: string;
  resolved?: string;
};

export type DaemonRequest =
  | { v: 1; op: 'ping' }
  | { v: 1; op: 'shutdown' }
  | DaemonSendRequest;

export type DaemonSendResponse =
  | {
      v: 1;
      ok: true;
      id: string;
      seat: string;
      /** The daemon's word for a trigger the seat took; the CLI reports it to the sender as
       *  `sent (unconfirmed)`, because no signed read receipt has come back. */
      outcome: 'delivered';
      status: string;
      /** `taken` when the box cleared with no status or transcript evidence inside the window:
       *  the line left the composer, no receipt followed, and it is never typed again. */
      evidence?: 'taken';
      /** What became of unsent text the delivery moved out of the box, when it moved any. */
      draft?: string;
      drop_path: string;
    }
  | { v: 1; ok: true; id: string; seat: string; outcome: 'answered'; reply: string; reply_id: string | null }
  | {
      v: 1;
      ok: false;
      id: string | null;
      seat: string;
      outcome: 'held' | 'unreachable' | 'timeout' | 'refused';
      detail: string;
      drop_path?: string;
      /** The typed leg found no live agent and typed nothing; the caller's walk holds a leg
       *  behind it, which carries the send. No history line was written here: the leg that
       *  takes the send writes the one line. */
      fall_through?: true;
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
      /** What became of unsent text the delivery moved out of the box, when it moved any. */
      draft?: string;
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
    // Defence in depth for a caller that reaches the daemon directly: the file's stopped seat
    // takes nothing, and no worker is started. The CLI refuses earlier, with the same words.
    if (configured.stopped === true) {
      return Promise.resolve({
        v: 1,
        ok: false,
        id: request.id ?? null,
        seat: seatName,
        outcome: 'refused',
        detail: `${seatName} is stopped`,
      });
    }
    // A human's pane takes no trigger, even from a caller that reaches the daemon directly:
    // the queue refuses it and no worker is started. The CLI's walk keeps its typing legs out
    // earlier, with the same words.
    if (configured.human === true) {
      return Promise.resolve({
        v: 1,
        ok: false,
        id: request.id ?? null,
        seat: seatName,
        outcome: 'refused',
        detail: `${seatName}: the pane is a human's, and nothing is typed into it`,
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
  // The log names the caller as it is: `owner`, or the seat that asked — never the seat's role.
  const who = from;
  const body = request.body;
  const msgId = request.id ?? randomUUID();
  // The address as written and the id it resolved to, when the caller wrote a form rather than
  // the seat's own name: every history line this send writes keeps them beside `to`. The
  // sender's team rides with them — the daemon serves the caller's own team, so the root it was
  // started under is where the sender stands.
  const sentAs: Pick<HistoryEntry, 'spec' | 'resolved' | 'from_team'> = {
    spec: request.spec,
    resolved: request.resolved,
    from_team: teamIdOf(root),
  };
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

  // A compose seat's brief is typed through the CLI's own screens by its profile's module,
  // which this daemon does not drive; typing a drop-file trigger there would land in a
  // screen that reads no file. The typed leg in `team send` delivers these seats itself.
  if (profileFor(configured.cli)?.compose != null) {
    return {
      v: 1,
      ok: false,
      id: null,
      seat: seatName,
      outcome: 'refused',
      detail: `${seatName} runs ${configured.cli}: its brief is typed through the CLI's own screens, which this daemon does not drive; nothing was sent`,
    };
  }

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
    return executeSocketSend(dir, root, who, from, team, seatName, body, msgId, request.timeout_s ?? 120, waitMs, pollMs, host, alive, sentAs);
  }

  const found = findSeatAgent(host, team.session, seatName);
  if (!found.ok) {
    if (found.kind === 'refused') {
      return { v: 1, ok: false, id: null, seat: seatName, outcome: 'refused', detail: found.reason };
    }
    // Nothing was typed and no drop file was written here: the caller's walk has a leg behind
    // the typed one, and it records the reason and carries the send there. A typed leg with
    // nothing behind it is the walk's last leg, and its line is written below as before.
    if (request.fallthrough === true) {
      return { v: 1, ok: false, id: msgId, seat: seatName, outcome: 'unreachable', detail: found.reason, fall_through: true };
    }
    appendHistory(team.project, root, host.home, {
      ts: host.now().toISOString(),
      from,
      to: seatName,
      ...sentAs,
      body,
      id: msgId,
      outcome: 'unreachable',
      ms: Date.now() - startedAt,
      failed: request.failed,
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
      ...sentAs,
      body,
      id: msgId,
      outcome: 'unreachable',
      ms: Date.now() - startedAt,
      failed: request.failed,
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
  // This is the store's drop folder, not the project's `.agents/send-drops/<session>/<seat>`
  // that a running watch scans, so no pending record is written beside it and these lines
  // promise no retry. When the daemon is wired in, write the record where the watch reads.
  const candidateDropPath = join(stateDropDir, msgId);

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

  const recordHeld = (detail: string, via?: 'typed'): DaemonSendResponse => {
    const entry: HistoryEntry = {
      ts: host.now().toISOString(),
      from,
      to: seatName,
      ...sentAs,
      body,
      id: msgId,
      outcome: 'held',
      ms: Date.now() - startedAt,
      failed: request.failed,
    };
    // The path is named only once the trigger had been typed, never for a refusal before it.
    if (via !== undefined) entry.via = via;
    appendHistory(team.project, root, host.home, entry);
    // No pending record: the store's drop folder is not where a watch reads, so the line says
    // what happened and promises no retry.
    return { v: 1, ok: false, id: msgId, seat: seatName, outcome: 'held', detail, drop_path: dropPath };
  };

  // The wake names the sender from the send's own record: the caller seat the daemon was asked
  // to deliver for, and the team it runs under. Nothing in the body decides the name. The drop is
  // already written, so a wake that cannot carry the name is refused as held with the drop kept
  // and named, never typed nameless. The team's sender-line policy supplies the words around the
  // two names; one that cannot be read leaves the shipped format, never an unnamed line.
  const format = senderLineFormatInForce({ home: host.home, root, team, now: host.now() });
  const trigger = triggerLine(candidateDropPath, { seat: from, team: team.project, format });
  if (trigger === null) {
    return recordHeld(`${seatName}: the trigger would exceed ${String(TRIGGER_MAX)} characters; nothing was typed`);
  }

  const recordUnreachable = (detail: string, via?: 'typed'): DaemonSendResponse => {
    const entry: HistoryEntry = {
      ts: host.now().toISOString(),
      from,
      to: seatName,
      ...sentAs,
      body,
      id: msgId,
      outcome: 'unreachable',
      ms: Date.now() - startedAt,
      failed: request.failed,
    };
    // The path is named only once the trigger had been typed, never for a refusal before it.
    if (via !== undefined) entry.via = via;
    appendHistory(team.project, root, host.home, entry);
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
        // Unsent text does not hold the drop here: the delivery below copies it beside the drop,
        // clears the box, delivers, and pastes the text back (or holds where this CLI has no
        // measured way into its box).
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
    // typed, and a success only once the trigger has left the box and the seat is working. That
    // success is a trigger sent; the caller words it `sent (unconfirmed)` until a receipt comes.
    const result = await deliverTrigger(bindPane(host.native, team.session), pane, trigger, configured.cli);
    const where = `the drop file is at ${dropPath}`;
    // The draft's receipt travels with every exit that moved an unsent text: the caller, the log
    // line and the history entry all say where the owner's text went.
    const draft = result.draft === undefined ? undefined : draftNote(result.draft);
    const withDraft = (text: string): string => (draft === undefined ? text : `${text}; ${draft}`);
    if (result.dialog !== undefined) return recordHeld(withDraft(`the screen reads ${result.dialog}; ${where}`), 'typed');
    if (result.outcome === 'held') return recordHeld(`${result.reason ?? 'the composer holds text'}; ${where}`, 'typed');
    if (result.outcome === 'unreachable') return recordUnreachable(withDraft(`${result.reason ?? 'the seat was not reached'}; ${where}`), 'typed');
    if (result.outcome === 'not-submitted') {
      appendHistory(team.project, root, host.home, {
        ts: host.now().toISOString(),
        from,
        to: seatName,
        ...sentAs,
        body,
        id: msgId,
        outcome: 'not-submitted',
        ...(draft === undefined ? {} : { note: draft }),
        ms: Date.now() - startedAt,
        via: 'typed',
        failed: request.failed,
      });
      // The trigger was typed and not taken: the drop is still the message, but nothing in
      // this folder is what a watch scans, so the line promises no retry.
      return {
        v: 1,
        ok: false,
        id: msgId,
        seat: seatName,
        outcome: 'not-submitted',
        detail: withDraft(`the seat did not take the trigger; ${where}`),
        box: result.box ?? null,
        tries: result.tries,
        ...(draft === undefined ? {} : { draft }),
        drop_path: dropPath,
      };
    }
    const submittedStatus = result.status ?? 'working';
    const taken = result.evidence === 'taken';
    // A trigger the seat took is a trigger sent, never a message read: no signed receipt has
    // come back. The note says so in every typed success, whatever evidence showed the take.
    const note = [TRIGGER_TAKEN_NOTE, draft].filter((one): one is string => one !== undefined).join('; ');

    logLine(
      dir,
      'send',
      who,
      `${seatName}: sent (unconfirmed) (drop ${String(body.length)} characters, typed, ${taken ? TRIGGER_TAKEN_NOTE : result.evidence === 'transcript' ? 'the transcript shows the drop read' : `herdr status ${submittedStatus}`}${draft === undefined ? '' : `; ${draft}`})`,
      host.now(),
    );
    appendHistory(team.project, root, host.home, {
      ts: host.now().toISOString(),
      from,
      to: seatName,
      ...sentAs,
      body,
      id: msgId,
      outcome: 'sent (unconfirmed)',
      note,
      ms: Date.now() - startedAt,
      via: 'typed',
      failed: request.failed,
    });
    return {
      v: 1,
      ok: true,
      id: msgId,
      seat: seatName,
      outcome: 'delivered',
      status: submittedStatus,
      ...(taken ? { evidence: 'taken' as const } : {}),
      ...(draft === undefined ? {} : { draft }),
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
  /** The address as written, when it was a form: every history line carries it beside the seat. */
  sentAs: Pick<HistoryEntry, 'spec' | 'resolved' | 'from_team'>,
): Promise<DaemonSendResponse> {
  // While SOCKET_SEND is off, the daemon serves no waited send: the frame the reply would ride
  // is one this build does not write, and a caller asking for one anyway — an older CLI — is
  // refused here rather than dialed. Nothing is written, nothing is locked, and no history
  // line is appended: the daemon did not touch the seat.
  // A waited send rides the socket, so it is served only for a receiving Claude session that
  // itself declares `crossSessionInbound: "accept"`: a frame any other receiver would hold at
  // its box is never dialed. The sender this caller may be is not the question — the receiver's
  // own declaration is.
  const receiver = team.seats.find((seat) => seat.name === seatName);
  const inbound = declaredInboundOf({
    dir,
    root,
    session: team.session,
    seat: seatName,
    ...(receiver?.launch !== undefined ? { launch: receiver.launch } : {}),
  });
  if (!SOCKET_SEND || inbound.policy !== 'accept') {
    const why = SOCKET_SEND ? inboundSkipReason(inbound.policy) : 'this build does not carry it';
    return {
      v: 1,
      ok: false,
      id: msgId,
      seat: seatName,
      outcome: 'refused',
      detail: `${seatName}: --wait needs the native leg (team route + your own SendMessage), and ${why}; nothing was sent`,
    };
  }
  // Send to outcome is measured from here: the socket send and, for --wait, the reply's wait.
  const startedAt = Date.now();
  // The reply line rides every frame, built from the sender the request carries and the team
  // this daemon serves; with no team there is no address, and the frame is not dialed.
  const sendingTeam = sentAs.from_team;
  if (sendingTeam === undefined) {
    return {
      v: 1,
      ok: false,
      id: msgId,
      seat: seatName,
      outcome: 'refused',
      detail: `${seatName}: the sending team is not known, so the frame carries no reply address; nothing was sent`,
    };
  }
  const reply = frameReplyFor(host.home, root, from, sendingTeam);
  if ('missing' in reply) {
    return {
      v: 1,
      ok: false,
      id: msgId,
      seat: seatName,
      outcome: 'refused',
      detail: `${seatName}: ${reply.missing}; nothing was sent`,
    };
  }
  const frame = frameFor(body, msgId, reply.line);
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
      ...sentAs,
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
      ...sentAs,
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
      ...sentAs,
      body,
      id: msgId,
      outcome: 'unreachable',
      ms: Date.now() - startedAt,
    });
    return { v: 1, ok: false, id: msgId, seat: seatName, outcome: 'unreachable', detail };
  }
  // A session started before its launcher's declaration was in force would hold the frame; the
  // socket's age answers whether the setting the file declares is the one the session runs with.
  if (!inboundIsLive(inbound, socketPath)) {
    return {
      v: 1,
      ok: false,
      id: msgId,
      seat: seatName,
      outcome: 'refused',
      detail: `${seatName}: the receiving session was started before its crossSessionInbound declaration; restart its CLI host so it accepts; nothing was sent`,
    };
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
      ...sentAs,
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
          ...sentAs,
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
          ...sentAs,
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
        ...sentAs,
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
