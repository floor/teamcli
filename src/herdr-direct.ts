// The terminal host's read-only calls asked over its own socket API instead of starting the
// `herdr` CLI for each one. The CLI is a thin client of that same API: it sends one JSON request
// line and prints the response line, and `run` reads only its `result`. A direct call sends the
// same request and returns the same `result` (byte-equal on herdr 0.9.5, probed 2026-11-17 for
// every method below), without a process start per read, which under load cost tens of ms each.
//
// Scope, kept narrow so nothing changes but the transport:
// - Only the read methods in METHODS; every other command keeps the CLI.
// - Only where the socket the CLI would use is certain: an explicit `--session` (the session's
//   own socket under the herdr config folder, which `HERDR_SOCKET_PATH` does not override), or
//   no session with `HERDR_SOCKET_PATH` set (which wins over `HERDR_SESSION`) to a herdr socket
//   under this `$HOME`. Any other setting (`XDG_CONFIG_HOME` naming another folder than
//   `$HOME/.config`, a session name the CLI would refuse, a socket elsewhere, no hint at all)
//   keeps the CLI.
// - Synchronous like the CLI read it replaces, bound through `bun:ffi` (socket/connect/write/
//   read with the CLI read's own 10 s limit). No binding, no socket file, a refused connect, a
//   short write or an unreadable answer: `undefined`, and the caller starts the CLI exactly as
//   before. An error answer throws, as the CLI's non-zero exit throws.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Request = { method: string; params: Record<string, string | number> };

/** The CLI argument shapes answered directly, and the API request each one sends. */
export function directRequestOf(args: readonly string[]): Request | null {
  const [a, b, c, d] = args;
  if (args.length === 2 && a === 'agent' && b === 'list') return { method: 'agent.list', params: {} };
  if (args.length === 2 && a === 'workspace' && b === 'list') return { method: 'workspace.list', params: {} };
  if (args.length === 4 && a === 'pane' && b === 'process-info' && c === '--pane' && typeof d === 'string' && d !== '') {
    return { method: 'pane.process_info', params: { pane_id: d } };
  }
  if (args.length === 3 && a === 'pane' && b === 'get' && typeof c === 'string' && c !== '' && !c.startsWith('-')) {
    return { method: 'pane.get', params: { pane_id: c } };
  }
  if (args.length === 4 && a === 'pane' && b === 'list' && c === '--workspace' && typeof d === 'string' && d !== '') {
    return { method: 'pane.list', params: { workspace_id: d } };
  }
  // The styled screen read (`paneRead`): its `result.read.text` is the CLI's stdout byte for byte
  // (herdr 0.9.5, compared on a live pane 2026-11-21). Only this exact shape; the plain retry
  // without `--format` keeps the CLI.
  const [, , , , e, f, g, h, i] = args;
  if (args.length === 9 && a === 'pane' && b === 'read' && typeof c === 'string' && c !== '' && !c.startsWith('-')
    && d === '--source' && e === 'visible' && f === '--lines' && /^[0-9]{1,6}$/.test(g ?? '') && h === '--format' && i === 'ansi') {
    return { method: 'pane.read', params: { pane_id: c, source: 'visible', lines: Number(g), format: 'ansi' } };
  }
  return null;
}

const SESSION_NAME = /^[A-Za-z0-9._-]+$/;

/** The socket the `herdr` CLI itself would use for this call, or null when that is not certain.
 *  Both forms stay under this process's own `$HOME/.config/herdr`: a socket path pointing
 *  anywhere else (another home, a test's scratch home with the real socket inherited) keeps the
 *  CLI, whatever `herdr` that PATH names. */
export function directSocketOf(session: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir();
  // The daemon's service unit sets XDG_CONFIG_HOME to `$HOME/.config` (service-darwin.ts), which
  // names the very folder the CLI uses without it. Only that exact spelling (trailing slashes
  // aside) is taken: a `..` or `.` component could name another folder through a link. Any other
  // value keeps the CLI.
  if (env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.replace(/\/+$/, '') !== `${home.replace(/\/+$/, '')}/.config`) return null;
  const base = join(home, '.config', 'herdr');
  if (session !== undefined) {
    if (!SESSION_NAME.test(session) || session === '.' || session === '..') return null;
    return join(base, 'sessions', session, 'herdr.sock');
  }
  const path = env.HERDR_SOCKET_PATH;
  if (path === undefined || path === '') return null;
  if (path === join(base, 'herdr.sock')) return path;
  const prefix = `${join(base, 'sessions')}/`;
  if (!path.startsWith(prefix) || !path.endsWith('/herdr.sock')) return null;
  const name = path.slice(prefix.length, path.length - '/herdr.sock'.length);
  return SESSION_NAME.test(name) && name !== '.' && name !== '..' ? path : null;
}

type Call = (socketPath: string, line: string, timeoutMs: number) => string | undefined;

let bound: Call | null | undefined;

// macOS <sys/socket.h>, <sys/un.h>.
const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SOL_SOCKET = 0xffff;
const SO_SNDTIMEO = 0x1005;
const SO_RCVTIMEO = 0x1006;
const SUN_PATH_MAX = 104;
const MAX_ANSWER = 64 << 20;

export class HerdrDirectTimeout extends Error {
  readonly code = 'ETIMEDOUT';
  constructor() {
    super('the terminal host did not answer in time');
  }
}

function bind(): Call | null {
  if (process.platform !== 'darwin' || process.versions.bun === undefined) return null;
  try {
    const req = createRequire(import.meta.url);
    const ffi = req('bun:ffi') as {
      dlopen: (
        library: string,
        symbols: Record<string, { args: unknown[]; returns: unknown }>,
      ) => { symbols: Record<string, (...args: unknown[]) => number> };
      FFIType: Record<string, unknown>;
      ptr: (view: ArrayBufferView) => unknown;
      toArrayBuffer: (at: number, offset: number, length: number) => ArrayBuffer;
    };
    const T = ffi.FFIType;
    const lib = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
      socket: { args: [T.i32, T.i32, T.i32], returns: T.i32 },
      connect: { args: [T.i32, T.ptr, T.u32], returns: T.i32 },
      setsockopt: { args: [T.i32, T.i32, T.i32, T.ptr, T.u32], returns: T.i32 },
      write: { args: [T.i32, T.ptr, T.u64], returns: T.i64 },
      read: { args: [T.i32, T.ptr, T.u64], returns: T.i64 },
      close: { args: [T.i32], returns: T.i32 },
      __error: { args: [], returns: T.ptr },
    });
    const s = lib.symbols;
    const EAGAIN = 35;
    const EINTR = 4;
    const errno = (): number => {
      const at = s.__error!() as unknown as number;
      return new Int32Array(ffi.toArrayBuffer(at, 0, 4))[0] ?? 0;
    };
    return (socketPath, line, timeoutMs) => {
      const path = Buffer.from(socketPath, 'utf8');
      if (path.length >= SUN_PATH_MAX) return undefined;
      const fd = s.socket!(AF_UNIX, SOCK_STREAM, 0);
      if (fd < 0) return undefined;
      try {
        // One deadline for the whole call: every send and receive wait is bounded by the time
        // left before it, and an answer that completes after it is refused as late.
        const deadline = Date.now() + timeoutMs;
        // struct timeval on arm64 and x86_64 macOS: an 8-byte tv_sec, a 4-byte tv_usec, padded to 16.
        const tvBytes = new Uint8Array(16);
        const tv = new DataView(tvBytes.buffer);
        const bound = (option: number): boolean => {
          const left = Math.max(1, deadline - Date.now());
          tv.setBigInt64(0, BigInt(Math.floor(left / 1000)), true);
          tv.setInt32(8, (left % 1000) * 1000, true);
          tv.setInt32(12, 0, true);
          return s.setsockopt!(fd, SOL_SOCKET, option, ffi.ptr(tvBytes), 16) === 0;
        };
        if (!bound(SO_RCVTIMEO) || !bound(SO_SNDTIMEO)) return undefined;
        const addr = new Uint8Array(2 + SUN_PATH_MAX);
        addr[0] = addr.length; // sun_len
        addr[1] = AF_UNIX; // sun_family
        addr.set(path, 2);
        if (s.connect!(fd, ffi.ptr(addr), addr.length) !== 0) return undefined;
        const out = Buffer.from(line, 'utf8');
        let sent = 0;
        while (sent < out.length) {
          if (Date.now() >= deadline) throw new HerdrDirectTimeout();
          if (!bound(SO_SNDTIMEO)) return undefined;
          const n = Number(s.write!(fd, ffi.ptr(out.subarray(sent)), out.length - sent));
          if (n > 0) { sent += n; continue; }
          if (n < 0 && errno() === EINTR) continue;
          return undefined;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        const page = new Uint8Array(1 << 16);
        for (;;) {
          if (Date.now() >= deadline) throw new HerdrDirectTimeout();
          if (!bound(SO_RCVTIMEO)) return undefined;
          const n = Number(s.read!(fd, ffi.ptr(page), page.length));
          if (Date.now() > deadline) throw new HerdrDirectTimeout();
          if (n > 0) {
            const chunk = Buffer.from(page.subarray(0, n));
            chunks.push(chunk);
            total += n;
            if (total > MAX_ANSWER) return undefined;
            if (chunk[chunk.length - 1] === 0x0a) break;
            continue;
          }
          if (n < 0) {
            const code = errno();
            if (code === EINTR) continue;
            if (code === EAGAIN) throw new HerdrDirectTimeout();
          }
          // The host closed before a full line: nothing this read can trust.
          return undefined;
        }
        return Buffer.concat(chunks, total).toString('utf8');
      } finally {
        s.close!(fd);
      }
    };
  } catch {
    return null;
  }
}

let nextId = 1;

/**
 * The `result` the CLI would print for `args`, read over the socket; `undefined` when this call
 * is not one answered directly or the socket could not be used (the caller then starts the CLI).
 * Throws when the host answered with an error, or did not answer within `timeoutMs`.
 */
export function herdrDirect(args: readonly string[], session: string | undefined, timeoutMs = 10_000): { result: unknown } | undefined {
  const request = directRequestOf(args);
  if (request === null) return undefined;
  const socketPath = directSocketOf(session);
  if (socketPath === null) return undefined;
  if (bound === undefined) bound = bind();
  if (bound === null) return undefined;
  const id = `team:direct:${String(process.pid)}:${String(nextId++)}`;
  const line = `${JSON.stringify({ id, method: request.method, params: request.params })}\n`;
  const text = bound(socketPath, line, timeoutMs);
  if (text === undefined) return undefined;
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return undefined;
  const record = answer as { id?: unknown; result?: unknown; error?: unknown };
  if (record.id !== id) return undefined;
  if (record.error !== undefined) {
    const error = record.error as { code?: unknown; message?: unknown } | null;
    const message = typeof error?.message === 'string' ? error.message : 'the terminal host refused the call';
    throw new Error(message);
  }
  if (!('result' in record)) return undefined;
  return { result: record.result };
}

/** The connect-only probe's raw outcome: 'absent' only for a connect refused with ENOENT (no
 *  socket file) or ECONNREFUSED (a socket file nothing listens on: a server a restart killed);
 *  'listening' when the connect succeeds; 'unknown' for every other failure. */
type Probe = (socketPath: string) => 'absent' | 'listening' | 'unknown';
let probing: Probe | null | undefined;

const ENOENT = 2;
const ECONNREFUSED = 61;

function bindProbe(): Probe | null {
  if (process.platform !== 'darwin' || process.versions.bun === undefined) return null;
  try {
    const req = createRequire(import.meta.url);
    const ffi = req('bun:ffi') as {
      dlopen: (library: string, symbols: Record<string, { args: unknown[]; returns: unknown }>) => { symbols: Record<string, (...args: unknown[]) => number> };
      FFIType: Record<string, unknown>;
      ptr: (view: ArrayBufferView) => unknown;
      toArrayBuffer: (at: number, offset: number, length: number) => ArrayBuffer;
    };
    const T = ffi.FFIType;
    const lib = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
      socket: { args: [T.i32, T.i32, T.i32], returns: T.i32 },
      connect: { args: [T.i32, T.ptr, T.u32], returns: T.i32 },
      close: { args: [T.i32], returns: T.i32 },
      __error: { args: [], returns: T.ptr },
    });
    const s = lib.symbols;
    const errno = (): number => {
      const at = s.__error!() as unknown as number;
      return new Int32Array(ffi.toArrayBuffer(at, 0, 4))[0] ?? 0;
    };
    return (socketPath) => {
      const path = Buffer.from(socketPath, 'utf8');
      if (path.length >= SUN_PATH_MAX) return 'unknown';
      const fd = s.socket!(AF_UNIX, SOCK_STREAM, 0);
      if (fd < 0) return 'unknown';
      try {
        const addr = new Uint8Array(2 + SUN_PATH_MAX);
        addr[0] = addr.length;
        addr[1] = AF_UNIX;
        addr.set(path, 2);
        // A unix-socket connect to a local listener completes at once or is refused at once.
        if (s.connect!(fd, ffi.ptr(addr), addr.length) === 0) return 'listening';
        const code = errno();
        return code === ENOENT || code === ECONNREFUSED ? 'absent' : 'unknown';
      } finally {
        s.close!(fd);
      }
    };
  } catch {
    return null;
  }
}

/**
 * Whether a session's server is listening on its own socket right now, read synchronously (a
 * boot start's last look before its spawn). 'silent' only on proven absence: no socket file, or
 * a connect refused with nothing listening. 'answers' when a connect succeeds (a listener exists,
 * whatever it would answer). 'unknown' for anything else: no reader, an uncertain socket path, a
 * socket that could not be made, or any other connect error. A caller that must not start a
 * second server spawns only on 'silent'.
 */
export function sessionAnswersNow(session: string, probe?: Probe): 'answers' | 'silent' | 'unknown' {
  const socketPath = directSocketOf(session);
  if (socketPath === null) return 'unknown';
  let look = probe;
  if (look === undefined) {
    if (probing === undefined) probing = bindProbe();
    if (probing === null) return 'unknown';
    look = probing;
  }
  const seen = look(socketPath);
  return seen === 'absent' ? 'silent' : seen === 'listening' ? 'answers' : 'unknown';
}

/** The probe this process binds, for a test that runs it against a real socket. */
export function socketProbe(): Probe | null {
  if (probing === undefined) probing = bindProbe();
  return probing;
}

/** Whether the socket reader is bound in this process (for tests). */
export function herdrDirectBound(): boolean {
  if (bound === undefined) bound = bind();
  return bound !== null;
}
