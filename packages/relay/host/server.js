// The machine socket's framing, as a standalone host: accept one connection, read one
// newline-terminated JSON line under the daemon's measured frame limit (and an optional
// caller-set frame-assembly deadline), hand the decoded value to the caller as untrusted input,
// write the caller's answer once, and end.
//
// It opens no listener until listen() and starts no service. It owns no path: it never unlinks
// and never chmods `socketPath`, so a stale or unknown socket stays the caller's decision
// (src/daemon/host.ts keeps that ownership). It adds no JSON formatting: the caller returns the
// complete response line, trailing newline included, and those exact characters are written. The
// handler's value is `unknown` data decoded from the line; no field in it, including a caller or
// principal field, is trusted here. TeamCLI keeps admission, signing, health semantics and
// lifecycle.
//
// The frame-limit check runs on the buffered characters before the newline search, which is what
// the daemon does today (src/daemon/host.ts): a line whose characters plus the newline exceed
// the limit is refused, not truncated.
import { createServer } from 'node:net';

/** The daemon protocol's measured request-frame limit, in decoded characters. */
export const HOST_FRAME_LIMIT = 65_536;

/** No deadline by default: the existing daemon socket has no server-side deadline, and the
 *  500 ms figure belongs to its health client probe, not to the server. A caller may set a
 *  frame-assembly deadline; it covers only the wait for the first complete line and is cleared
 *  before the handler runs, so an admitted handler is never cut off and labelled refused while
 *  it may still execute. */
export const HOST_DEADLINE_MS = 0;

export function createHostServer(options) {
  if (options === null || typeof options !== 'object') throw new Error('the host options are missing');
  const { socketPath, onRequest, onRefused } = options;
  if (typeof socketPath !== 'string' || socketPath === '') throw new Error('the socket path is required');
  if (typeof onRequest !== 'function') throw new Error('onRequest must be a function');
  if (typeof onRefused !== 'function') throw new Error('onRefused must be a function');
  const frameLimit = options.frameLimit ?? HOST_FRAME_LIMIT;
  const deadlineMs = options.deadlineMs ?? HOST_DEADLINE_MS;
  if (!Number.isInteger(frameLimit) || frameLimit < 1) throw new Error('the frame limit must be a positive integer');
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0) throw new Error('the deadline must be zero or a positive number');
  const onError = typeof options.onError === 'function' ? options.onError : null;

  const sockets = new Set();
  let server = null;
  let closed = false;

  /** The caller's refusal bytes, exactly. A callback that cannot answer closes the connection
   *  without inventing a protocol line. */
  function refuse(socket, reason, answered) {
    let text;
    try {
      text = onRefused(reason);
    } catch {
      text = undefined;
    }
    if (typeof text !== 'string') {
      answered.value = true;
      if (!socket.destroyed) socket.destroy();
      return;
    }
    writeAnswer(socket, text, answered);
  }

  function writeAnswer(socket, text, answered) {
    if (answered.value) return;
    answered.value = true;
    if (socket.destroyed) return;
    socket.end(text);
  }

  function serveConnection(socket) {
    sockets.add(socket);
    const answered = { value: false };
    let buffer = '';
    let deadline = null;

    const clearDeadline = () => {
      if (deadline !== null) clearTimeout(deadline);
      deadline = null;
    };

    if (deadlineMs > 0) {
      deadline = setTimeout(() => refuse(socket, 'deadline', answered), deadlineMs);
    }

    socket.on('error', () => {
      // A connection that ends early is one unanswered request, never the server's end.
    });
    socket.on('close', () => {
      clearDeadline();
      sockets.delete(socket);
    });
    // Decode across chunk boundaries (as the bus server does), so a multi-byte character split
    // between writes is still one character when the line is measured and parsed.
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      if (answered.value) return;
      buffer += chunk;
      if (buffer.length > frameLimit) {
        clearDeadline();
        refuse(socket, 'frame-limit', answered);
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = '';
      // The deadline covers the frame, not the caller's handler; one request per connection.
      clearDeadline();
      let input;
      try {
        input = JSON.parse(line);
      } catch {
        refuse(socket, 'malformed', answered);
        return;
      }
      let outcome;
      try {
        outcome = Promise.resolve(onRequest(input));
      } catch {
        refuse(socket, 'handler-error', answered);
        return;
      }
      outcome.then(
        (text) => {
          if (typeof text === 'string') writeAnswer(socket, text, answered);
          else refuse(socket, 'handler-error', answered);
        },
        () => refuse(socket, 'handler-error', answered),
      );
    });
  }

  async function listen() {
    if (closed) return { ok: false, reason: 'the host server is closed', code: null };
    const listener = createServer((socket) => serveConnection(socket));
    const failure = await new Promise((done) => {
      const onBindError = (error) => done(error);
      listener.once('error', onBindError);
      listener.listen(socketPath, () => {
        listener.off('error', onBindError);
        done(null);
      });
    });
    if (failure !== null) {
      return {
        ok: false,
        reason: failure instanceof Error ? failure.message : 'the socket could not be bound',
        code: failure instanceof Error && typeof failure.code === 'string' ? failure.code : null,
      };
    }
    listener.on('error', (error) => {
      if (onError === null) return;
      try {
        onError(error);
      } catch {
        // The listener's error is the caller's to report; the callback's own throw is not ours.
      }
    });
    server = listener;
    return { ok: true };
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server === null) return;
    const listener = server;
    server = null;
    await new Promise((done) => listener.close(() => done()));
  }

  return { socketPath, listen, close };
}
