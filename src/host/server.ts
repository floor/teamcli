// The warm send host's socket server (rfc-bus-send-server §2.1–2.3, §2.6).
//
// One process per machine user, started by the daemon. It answers one JSON line per connection on
// `<machine folder>/send-host.sock` (0600 in the 0700 machine folder). Every request's client is
// proven from the kernel before it is queued: same uid, its pid and parent and start time, its
// current folder equal to the folder it names, not confined by a Seatbelt profile. One request runs
// at a time; a request that waits more than the queue window is removed from the queue first and
// then handed back, so it can never run after its answer. A disconnect while queued removes it; a
// disconnect while running does not cancel it.
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { machineConfigDir } from '../daemon/paths.ts';
import { version } from '../version.ts';
import { clientBuildStamp } from './client.ts';
import { peerReader, socketFd, type PeerReader } from './peer.ts';
import { HOST_PROTOCOL_VERSION, isHostRequest, runHostedLine, type HostAnswer, type HostPeer, type HostRequest, type HostRunDeps } from './run.ts';

/** The largest request line, in bytes. */
export const HOST_FRAME_LIMIT = 1 << 20;
/** How long a request may wait in the queue before it is handed back. */
export const QUEUE_WINDOW_MS = 2_000;
/** The host exits (and the daemon starts another) after this many requests. */
export const RECYCLE_AFTER_REQUESTS = 500;
/** … or after this long without a request. */
export const RECYCLE_IDLE_MS = 30 * 60_000;
/** … or once its resident memory passes this. */
export const RECYCLE_RSS_BYTES = 400 * 1024 * 1024;

export function sendHostSocketPath(home: string): string {
  return join(machineConfigDir(home), 'send-host.sock');
}

/** The build stamp a client and the host compare: the version and the build identity, one digest
 *  over every emitted file (client.ts `clientBuildStamp`). Null when it cannot be read. */
export function buildStampOf(cliEntry: string): string | null {
  return clientBuildStamp(cliEntry);
}

type Entry = {
  request: HostRequest;
  peer: HostPeer;
  socket: Socket;
  state: 'queued' | 'running' | 'dead' | 'done';
  timer: ReturnType<typeof setTimeout> | null;
};

export type SendHostOptions = {
  home: string;
  cliEntry: string;
  main: HostRunDeps['main'];
  ownEnv: Record<string, string | undefined>;
  reader?: PeerReader | null;
  socketPath?: string;
  queueWindowMs?: number;
  /** Tests only: placement sources standing in for the processes (run.ts `callerSources`). */
  callerSources?: HostRunDeps['callerSources'];
  /** Called when the host decides to stop (recycle); the caller exits the process. */
  onStop?: (why: string) => void;
  log?: (line: string) => void;
};

export type SendHost = { server: Server; path: string; close: (why: string) => Promise<void>; served: () => number };

function answer(socket: Socket, value: HostAnswer): void {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify(value)}\n`);
}

const fallbackOf = (why: string): HostAnswer => ({ v: HOST_PROTOCOL_VERSION, kind: 'fallback', why });

/** Whether another live host already answers on `path`. */
async function liveListener(path: string): Promise<boolean> {
  return new Promise((settle) => {
    const probe = connect(path);
    const done = (live: boolean) => { probe.destroy(); settle(live); };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    setTimeout(() => done(false), 500);
  });
}

export async function startSendHost(options: SendHostOptions): Promise<SendHost> {
  const path = options.socketPath ?? sendHostSocketPath(options.home);
  const reader = options.reader === undefined ? peerReader() : options.reader;
  const log = options.log ?? (() => {});
  const window = options.queueWindowMs ?? QUEUE_WINDOW_MS;
  const build = buildStampOf(options.cliEntry);
  if (build === null) throw new Error('the build identity cannot be read; the send host does not start');
  const ownUid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (reader === null) throw new Error('the kernel peer reader cannot be bound here; the send host does not start');

  // A socket another live host answers on is left alone; a stale one is removed.
  const existing = (() => { try { return lstatSync(path); } catch { return null; } })();
  if (existing !== null) {
    if (!existing.isSocket()) throw new Error(`${path} exists and is not a socket; the send host does not start`);
    if (await liveListener(path)) throw new Error('another send host already answers; this one does not start');
    unlinkSync(path);
  }

  const queue: Entry[] = [];
  let running: Entry | null = null;
  let served = 0;
  let stopping: string | null = null;
  let lastAt = Date.now();

  const stop = (why: string): void => {
    if (stopping !== null) return;
    stopping = why;
    log(`send host: stopping (${why})`);
    server.close();
    // Every queued request is removed first, then handed back: none of them can run.
    for (const entry of queue.splice(0)) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.state = 'dead';
      answer(entry.socket, fallbackOf('the send host is stopping'));
    }
    if (running === null) options.onStop?.(why);
  };

  const pump = async (): Promise<void> => {
    if (running !== null) return;
    const next = queue.shift();
    if (next === undefined) {
      if (stopping !== null) options.onStop?.(stopping);
      return;
    }
    if (next.timer !== null) clearTimeout(next.timer);
    next.timer = null;
    next.state = 'running';
    running = next;
    lastAt = Date.now();
    let recycle: string | null = null;
    try {
      const result = await runHostedLine(next.request, next.peer, {
        main: options.main,
        cliEntry: options.cliEntry,
        ownEnv: options.ownEnv,
        ...(options.callerSources !== undefined ? { callerSources: options.callerSources } : {}),
      });
      recycle = result.recycle;
      if (next.socket.destroyed) log(`send host: the client ${String(next.peer.pid)} left before its answer (${result.answer.kind})`);
      answer(next.socket, result.answer);
    } catch (error) {
      // runHostedLine never throws; a throw here is a host fault, and the line may have run.
      log(`send host: fault: ${error instanceof Error ? error.message : String(error)}`);
      next.socket.destroy();
      recycle = 'a fault';
    } finally {
      next.state = 'done';
      running = null;
      served += 1;
    }
    if (recycle !== null) stop(recycle);
    else if (served >= RECYCLE_AFTER_REQUESTS) stop('request count');
    else if (process.memoryUsage().rss > RECYCLE_RSS_BYTES) stop('memory');
    void pump();
  };

  /** The client as the kernel names it the moment the connection is accepted, before any request
   *  byte is read (rfc-bus-send-server §2.3 item 7): its credentials and its process start. Null
   *  when either cannot be read; such a connection is never served. */
  type AtConnect = { cred: { uid: number; pid: number }; first: NonNullable<ReturnType<PeerReader['process']>> } | null;
  const identityOf = (socket: Socket): AtConnect => {
    const fd = socketFd(socket);
    const cred = fd === null ? null : reader.credentials(fd);
    if (cred === null) return null;
    const first = reader.process(cred.pid);
    if (first === null) return null;
    return { cred, first };
  };

  const accept = (socket: Socket, line: string, atConnect: AtConnect): void => {
    if (stopping !== null) { answer(socket, fallbackOf('the send host is stopping')); return; }
    if (atConnect === null) { answer(socket, fallbackOf('the client could not be read from the kernel when it connected')); return; }
    const { cred, first } = atConnect;
    if (cred.uid !== ownUid) { socket.destroy(); return; }
    if (first.uid !== ownUid) { answer(socket, fallbackOf('the client process could not be read')); return; }
    // The same process now as at connect: an inherited socket whose first process is gone, or
    // whose pid was handed to another process before the request arrived, is never served.
    const again = identityOf(socket);
    if (again === null || again.cred.pid !== cred.pid || again.cred.uid !== cred.uid
      || again.first.startSec !== first.startSec || again.first.startUsec !== first.startUsec || again.first.ppid !== first.ppid) {
      answer(socket, fallbackOf('the client is not the process that connected'));
      return;
    }
    if (reader.confined(cred.pid)) { answer(socket, fallbackOf('the client is confined by a sandbox')); return; }
    let request: unknown;
    try { request = JSON.parse(line); } catch { answer(socket, fallbackOf('the request is not JSON')); return; }
    if (!isHostRequest(request)) { answer(socket, fallbackOf('the request is not one this host reads')); return; }
    if (request.build !== build) { answer(socket, fallbackOf('the client is another build')); return; }
    const cwd = reader.cwd(cred.pid);
    let named: string;
    try { named = realpathSync(request.cwd); } catch { answer(socket, fallbackOf('the named folder cannot be resolved')); return; }
    let actual: string | null = null;
    try { actual = cwd === null ? null : realpathSync(cwd); } catch { actual = null; }
    if (actual === null || actual !== named) { answer(socket, fallbackOf("the client's folder is not the one it names")); return; }
    const peer: HostPeer = {
      pid: cred.pid,
      ppid: first.ppid,
      currentParent: () => {
        const now = reader.process(cred.pid);
        return now === null || now.startSec !== first.startSec || now.startUsec !== first.startUsec ? null : now.ppid;
      },
      check: () => {
        const now = reader.process(cred.pid);
        if (now === null) return 'the client is gone';
        if (now.startSec !== first.startSec || now.startUsec !== first.startUsec) return 'the client pid now names another process';
        if (now.ppid !== first.ppid) return "the client's parent changed";
        return null;
      },
    };
    const entry: Entry = { request, peer, socket, state: 'queued', timer: null };
    entry.timer = setTimeout(() => {
      if (entry.state !== 'queued') return;
      const at = queue.indexOf(entry);
      if (at >= 0) queue.splice(at, 1);
      entry.state = 'dead';
      answer(socket, fallbackOf('the send host was busy'));
    }, window);
    socket.once('close', () => {
      if (entry.state !== 'queued') return;
      const at = queue.indexOf(entry);
      if (at >= 0) queue.splice(at, 1);
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.state = 'dead';
    });
    queue.push(entry);
    void pump();
  };

  const server = createServer((socket) => {
    const atConnect = identityOf(socket);
    let buffer = '';
    let taken = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (taken) return;
      buffer += chunk;
      if (buffer.length > HOST_FRAME_LIMIT) { taken = true; answer(socket, fallbackOf('the request is too long')); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      taken = true;
      accept(socket, buffer.slice(0, end), atConnect);
    });
    socket.on('error', () => { /* a client that went away; its entry is cleaned on close */ });
  });

  await new Promise<void>((settle, fail) => {
    server.once('error', fail);
    server.listen(path, () => { server.off('error', fail); settle(); });
  });
  chmodSync(path, 0o600);
  log(`send host: answering on ${path} (build ${build})`);

  const idle = setInterval(() => {
    if (running === null && queue.length === 0 && Date.now() - lastAt > RECYCLE_IDLE_MS) stop('idle');
  }, 60_000);
  idle.unref();

  return {
    server,
    path,
    served: () => served,
    close: async (why) => {
      stop(why);
      clearInterval(idle);
      try { unlinkSync(path); } catch { /* already gone */ }
    },
  };
}
