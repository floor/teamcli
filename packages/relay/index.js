// The message transport, as a client and a durable-copy writer.
//
// One rule holds the package together: the durable signed copy is what survives, and a route
// attempt is what the caller asked for. `stage` writes the copy; `deliver` makes exactly one
// attempt, in the order the caller resolved, and never falls back on its own. Outcomes name what
// the transport can prove: a taken socket write is `delivered` (the socket has no
// acknowledgement, so it is transport, never a read), a stored copy with no live route is
// `held`, and `read` is reserved for a signed receipt this package never writes.
//
// The socket client here is the same measured client TeamCLI carried in src/send/uds.ts: UTF-8
// JSON lines, newline-terminated, a first-complete-line deadline, and a write callback as the
// whole proof. The listener belongs to the receiving session's host; this package opens no
// server.
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

/** The listener's measured buffer limit, in characters. A longer frame is refused before any
 *  connection is made — never truncated. */
export const FRAME_LIMIT = 1_048_576;

/** How long the socket has to take the frame: connecting and writing it. */
export const SEND_TIMEOUT_MS = 5_000;

/**
 * Writes one frame to the socket at `socketPath` and reports whether it was taken.
 *
 * `frame` is the complete line, its trailing newline included; this function writes those bytes
 * as given and nothing else. The answer is `ok` when the write reached the kernel (the write
 * callback): with no acknowledgement on this channel, that is the whole of what a client can
 * know.
 */
export function dial(socketPath, frame, timeoutMs = SEND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => done({ ok: false, reason: `the socket did not take the frame within ${String(timeoutMs / 1000)}s` }),
      timeoutMs,
    );
    socket.on('error', (error) => done({ ok: false, reason: reasonOf(error) }));
    socket.on('connect', () => {
      socket.write(frame, (error) => {
        if (error) done({ ok: false, reason: reasonOf(error) });
        else done({ ok: true });
      });
    });
  });
}

function reasonOf(error) {
  const code = error.code;
  if (code === 'ENOENT') return 'nothing is listening there (the socket is gone)';
  if (code === 'ECONNREFUSED') return 'nothing is listening there (the connection was refused)';
  // Measured on this platform: a plain file left at the socket's path answers ENOTSOCK.
  if (code === 'ENOTSOCK') return 'nothing is listening there (the path is not a socket)';
  if (code === 'EPIPE' || code === 'ECONNRESET') return 'the session closed the connection before it took the frame';
  return `the socket could not be written (${code ?? 'unknown error'})`;
}

/** Pure, synchronous, no I/O. */
export function capabilities(runtime, version) {
  void version;
  return {
    routes: ['socket', 'durable-copy'],
    socket: {
      runtime,
      supported: runtime === 'claude-code',
      frameLimit: FRAME_LIMIT,
      timeoutMs: SEND_TIMEOUT_MS,
      ack: false,
    },
    durableCopy: { supported: true },
  };
}

/**
 * Writes the durable signed copy — whole, mode 0600, never through a link — and reports where it
 * landed. A regular file already at the name is `existing`: the relay does not read it and does
 * not replace it, because whether that file is this message's record is the caller's admission
 * to make. A link, FIFO, folder or other holder at the name is refused.
 */
export async function stage(copy, message, options = {}) {
  const at = nowOf(options);
  if (copy === null || typeof copy !== 'object' || typeof copy.dir !== 'string' || copy.dir === '' || typeof copy.name !== 'string') {
    return { outcome: 'refused', reason: 'the copy target is missing' };
  }
  if (!nameOk(copy.name)) return { outcome: 'refused', reason: 'the record id cannot be a file name' };
  if (message === null || typeof message !== 'object' || typeof message.record !== 'string') {
    return { outcome: 'refused', reason: 'the signed record is missing' };
  }
  const path = copyPath(copy);
  const held = heldAt(path);
  if (held === 'file') return { outcome: 'stored', receipt: { copy: path, existing: true, at } };
  if (held !== 'missing') return { outcome: 'refused', reason: 'a file that is not a record already holds that id' };
  try {
    writeCopy(copy.dir, path, message.record);
  } catch {
    return { outcome: 'refused', reason: 'the record could not be written' };
  }
  return { outcome: 'stored', receipt: { copy: path, at } };
}

/** One route attempt. Never falls back, never reorders. */
export async function deliver(target, message, options = {}) {
  if (target === null || typeof target !== 'object') throw new TypeError('the relay target is missing');
  if (target.route === 'durable-copy') {
    const staged = await stage(target.copy, message, options);
    if (staged.outcome === 'refused') return { route: 'durable-copy', ...staged };
    return {
      route: 'durable-copy',
      outcome: 'held',
      reason: 'the durable copy is stored; no live route delivered it',
      receipt: staged.receipt,
    };
  }
  if (target.route !== 'socket') throw new TypeError(`the relay carries no route named ${String(target.route)}`);

  const at = nowOf(options);
  const copy = copyReceipt(target.copy, at);
  if (message === null || typeof message !== 'object' || typeof message.frame !== 'string' || message.frame === '') {
    return { route: 'socket', outcome: 'refused', reason: 'the socket frame is missing', ...(copy === null ? {} : { receipt: copy }) };
  }
  const caps = capabilities(target.runtime);
  if (!caps.socket.supported) {
    return {
      route: 'socket',
      outcome: 'refused',
      reason: `${target.runtime} sessions have no cross-session socket`,
      ...(copy === null ? {} : { receipt: copy }),
    };
  }
  if (message.frame.length > caps.socket.frameLimit) {
    return {
      route: 'socket',
      outcome: 'refused',
      reason: `the frame is ${String(message.frame.length)} characters, past the socket's measured limit of ${String(caps.socket.frameLimit)}`,
      ...(copy === null ? {} : { receipt: copy }),
    };
  }
  const send = typeof options.dial === 'function' ? options.dial : dial;
  let taken;
  try {
    taken = await send(target.socket, message.frame, options.timeoutMs ?? caps.socket.timeoutMs);
  } catch (error) {
    taken = { ok: false, reason: error instanceof Error ? error.message : 'the socket could not be written' };
  }
  if (taken === null || typeof taken !== 'object' || taken.ok !== true) {
    const reason = taken !== null && typeof taken === 'object' && typeof taken.reason === 'string' ? taken.reason : 'the socket did not take the frame';
    return { route: 'socket', outcome: 'refused', reason, ...(copy === null ? {} : { receipt: copy }) };
  }
  return {
    route: 'socket',
    outcome: 'delivered',
    receipt: { ...(copy === null ? {} : { copy: copy.copy }), bytes: message.frame.length, at },
  };
}

function nowOf(options) {
  const now = options !== null && typeof options === 'object' && typeof options.now === 'function' ? options.now() : new Date();
  return now.toISOString();
}

function copyPath(copy) {
  return join(copy.dir, copy.name);
}

/** The receipt's copy field for a socket attempt: the caller already staged it. */
function copyReceipt(copy, at) {
  if (copy === null || typeof copy !== 'object' || typeof copy.dir !== 'string' || copy.dir === '' || typeof copy.name !== 'string' || !nameOk(copy.name)) {
    return null;
  }
  return { copy: copyPath(copy), at };
}

/** An id that can name one file in a folder: no separator, no traversal, no NUL. */
function nameOk(name) {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}

/** What sits at a path, without following anything: `missing`, `file`, `link`, `fifo`, `folder`,
 *  `other`. */
function heldAt(path) {
  let held;
  try {
    held = lstatSync(path);
  } catch {
    return 'missing';
  }
  if (held.isSymbolicLink()) return 'link';
  if (held.isFIFO()) return 'fifo';
  if (held.isDirectory()) return 'folder';
  if (held.isFile()) return 'file';
  return 'other';
}

/** Writes the record whole: a temporary file at mode 0600 in the record's own folder, renamed
 *  onto its name. The folder is created and kept at 0700. */
function writeCopy(dir, path, record) {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, record, { flag: 'wx', mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The rename's error is the one the caller sees.
    }
    throw error;
  }
}
