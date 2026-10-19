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
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
 * landed. The write is create-or-match: the copy is published under an exclusive hard link, so a
 * regular file already at the name is read without following anything, and only identical bytes
 * are `existing`. Different bytes are refused and left untouched, as is a link, FIFO, folder or
 * other holder. A file that vanishes between the link and the read is retried, not overwritten.
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
  for (let tries = 0; tries < 3; tries += 1) {
    const held = heldAt(path);
    if (held !== 'missing') {
      const matched = matchOrRefuse(path, held, message.record, at);
      // `null` means the holder vanished under us; the next pass publishes again.
      if (matched !== null) return matched;
      continue;
    }
    const made = publishCopy(copy.dir, path, message.record);
    if (made === 'published') return { outcome: 'stored', receipt: { copy: path, at } };
    if (made === 'error') return { outcome: 'refused', reason: 'the record could not be written' };
    // Another writer won the name between the lstat and the link. Judge its bytes; never replace.
    const matched = matchOrRefuse(path, heldAt(path), message.record, at);
    if (matched !== null) return matched;
  }
  return { outcome: 'refused', reason: 'the record could not be written' };
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

/**
 * Judges the holder of a name: identical bytes are `existing`; different bytes, or a holder that
 * is not a regular file, are refused and left untouched. `null` means the holder disappeared
 * between the check and the read — the caller may publish again, never overwrite.
 */
function matchOrRefuse(path, held, record, at) {
  if (held === 'missing') return null;
  if (held !== 'file') return { outcome: 'refused', reason: 'a file that is not a record already holds that id' };
  const read = readHeldRecord(path);
  if (read.kind === 'missing') return null;
  if (read.kind === 'not-file') return { outcome: 'refused', reason: 'a file that is not a record already holds that id' };
  if (read.kind === 'unreadable') return { outcome: 'refused', reason: 'the file that already holds that id could not be read' };
  if (read.bytes.equals(Buffer.from(record, 'utf8'))) {
    return { outcome: 'stored', receipt: { copy: path, existing: true, at } };
  }
  return { outcome: 'refused', reason: 'a different record already holds that id', receipt: { copy: path, at } };
}

/**
 * Reads the holder without following a link, and only if it is a regular file. `O_NONBLOCK` keeps
 * a FIFO swapped in after the lstat from blocking the open; the fstat refuses it as not a file.
 */
function readHeldRecord(path) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  let fd;
  try {
    fd = openSync(path, flags);
  } catch (error) {
    const code = error?.code;
    if (code === 'ENOENT') return { kind: 'missing' };
    if (code === 'ELOOP') return { kind: 'not-file' };
    return { kind: 'unreadable' };
  }
  try {
    if (!fstatSync(fd).isFile()) return { kind: 'not-file' };
    return { kind: 'bytes', bytes: readFileSync(fd) };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The read's answer is the caller's.
    }
  }
}

/**
 * Publishes the record whole: a temporary file at mode 0600 in the record's own folder, linked
 * onto its name. `linkSync` is the no-clobber step — it fails `EEXIST` rather than replacing a
 * winner — and the link only ever exposes complete bytes. The folder is created and kept at 0700.
 */
function publishCopy(dir, path, record) {
  try {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  } catch {
    return 'error';
  }
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    writeFileSync(fd, record);
    chmodSync(tmp, 0o600);
    closeSync(fd);
    fd = undefined;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The write's error is the one reported.
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // The write's error is the one reported.
    }
    return 'error';
  }
  try {
    linkSync(tmp, path);
    return 'published';
  } catch (error) {
    return error?.code === 'EEXIST' ? 'exists' : 'error';
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // The link's answer is the caller's.
    }
  }
}
