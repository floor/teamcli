// The part of Bun's socket API this CLI uses, declared once, and the one connection shape every
// unix socket of the CLI is driven through. The build compiles against the node types alone
// (tsconfig.build.json), so no module may name Bun's own types; every socket takes its types and
// its runtime from here.
//
// A caller binds the runtime to a local named `Bun` (`const Bun = bunSockets()`), so a call reads
// `Bun.connect(…)` or `Bun.listen(…)` at its own site and the host's effect inventory lists it
// there.

/** A connected socket: an unbuffered, non-blocking writer. */
export type BunSocket = {
  /** Writes what the kernel takes now: the byte count written, which can be less than asked
   *  (wait for `drain`), or -1 once the socket is closed or shutting down. */
  write(data: string | Uint8Array, byteOffset?: number, byteLength?: number): number;
  /** Closes the socket once what is written has gone; this side reads nothing more. */
  end(): void;
  /** Closes the write side only (a FIN); this side still reads. */
  shutdown(): void;
  /** Closes the socket at once. */
  terminate(): void;
  /** Lets the process exit while this socket is open. */
  unref(): void;
  /** The descriptor under the socket. */
  readonly fd: number;
  /** The caller's own value for this socket. */
  data: unknown;
};

/** The handlers a socket calls. `data` is handed the bytes as they came, never a string. */
export type BunSocketHandler = {
  open?(socket: BunSocket): void;
  data?(socket: BunSocket, data: Uint8Array): void;
  drain?(socket: BunSocket): void;
  end?(socket: BunSocket): void;
  close?(socket: BunSocket, error?: Error): void;
  error?(socket: BunSocket, error: Error): void;
  connectError?(socket: BunSocket, error: Error): void;
};

/** A unix-socket listener. */
export type BunListener = {
  /** Stops accepting and removes the socket file; `true` also closes every open connection. */
  stop(closeActiveConnections?: boolean): void;
};

/** What a connect or listen is given. `allowHalfOpen` keeps a socket open after the peer's FIN,
 *  so `Conn` can finish its own writes first (node's default behaviour). */
export type BunSocketOptions = { unix: string; allowHalfOpen?: boolean; socket: BunSocketHandler };

export type BunSockets = {
  /** Connects to a unix socket. The promise rejects when the connection is refused, after the
   *  handler's `connectError`. */
  connect(options: BunSocketOptions): Promise<BunSocket>;
  /** Binds and listens on a unix socket. Throws at once when it cannot (`EADDRINUSE` for a path
   *  that exists, live or stale). The file is made with the process umask. */
  listen(options: BunSocketOptions): BunListener;
};

/** Bun's socket runtime, or null when this process does not run under Bun. */
export function bunSockets(): BunSockets | null {
  const runtime = (globalThis as { Bun?: { connect?: unknown } }).Bun;
  return runtime !== undefined && typeof runtime.connect === 'function' ? (runtime as BunSockets) : null;
}

/** Bun's socket runtime; off Bun, one whose every connect is refused and every listen throws, so a
 *  caller reads the missing runtime as an absent socket. */
export function socketRuntime(): BunSockets {
  const runtime = bunSockets();
  if (runtime !== null) return runtime;
  const missing = (): Error & { code: string } => Object.assign(new Error('this runtime has no Bun sockets'), { code: 'ENOTSUP' });
  return {
    connect: () => Promise.reject(missing()),
    listen: () => {
      throw missing();
    },
  };
}

/** A socket error as node named it: `code` is the errno name (`ECONNREFUSED`, `ENOENT`, …). */
export type SocketError = Error & { code?: string };

/** One connection with the buffering node's sockets gave: a write the kernel did not take whole
 *  keeps its rest and writes it on drain, in order; `end` sends what is queued, then a FIN. */
export type Conn = {
  /** Queues the bytes. True when the kernel took all of them now; false when some wait for
   *  drain (the `drain` event follows once they are written) or the socket is closed. */
  write(data: string | Uint8Array): boolean;
  /** Writes `data` if given, then closes the write side once everything queued is written. The
   *  socket closes when the peer has ended too. */
  end(data?: string | Uint8Array): void;
  /** Closes at once; what is queued is dropped. */
  destroy(): void;
  /** Calls `onIdle` after `ms` without a byte read or written; 0 turns it off. */
  setTimeout(ms: number, onIdle?: () => void): void;
  /** Lets the process exit while this connection is open. */
  unref(): void;
  /** Calls `listener` once, at close (or now, after the current call, if already closed). */
  onClose(listener: (error?: SocketError) => void): void;
  /** Calls `listener` once, the next time queued bytes are all written after a `false` write. */
  onDrain(listener: () => void): void;
  /** True once the connection is closed or destroyed. */
  readonly destroyed: boolean;
  /** The descriptor under the socket, or null before it is open or after it is closed. */
  readonly fd: number | null;
};

/** What one connection reports. `text` is the UTF-8 decoding of what arrived (a character split
 *  across reads is held for the next); `bytes` is what arrived as is. `close` comes once, last,
 *  on every ending — a refused connect, an error, the peer, or `destroy` — and carries the error
 *  if there was one. It never runs inside the call that caused it. */
export type ConnEvents = {
  open?(conn: Conn): void;
  text?(chunk: string): void;
  bytes?(chunk: Uint8Array): void;
  drain?(): void;
  end?(): void;
  close?(error?: SocketError): void;
};

type ConnState = { conn: Conn; handler: BunSocketHandler };

function connOf(events: ConnEvents): ConnState {
  let socket: BunSocket | null = null;
  let destroyed = false;
  let closed = false;
  let ending = false;
  let ended = false;
  let wantUnref = false;
  const queue: Uint8Array[] = [];
  let decoder: TextDecoder | null = null;
  let encoder: TextEncoder | null = null;
  let idleMs = 0;
  let onIdle: (() => void) | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let closeError: SocketError | undefined;
  const closeListeners: ((error?: SocketError) => void)[] = [];
  let drainListeners: (() => void)[] = [];
  const touch = (): void => {
    if (idle !== undefined) clearTimeout(idle);
    idle = idleMs > 0 && !destroyed ? setTimeout(() => onIdle?.(), idleMs) : undefined;
  };
  const closeOnce = (error?: SocketError): void => {
    if (closed) return;
    closed = true;
    destroyed = true;
    queue.length = 0;
    if (idle !== undefined) clearTimeout(idle);
    socket = null;
    closeError = error;
    drainListeners = [];
    queueMicrotask(() => {
      events.close?.(error);
      for (const listener of closeListeners.splice(0)) listener(error);
    });
  };
  const drained = (): void => {
    events.drain?.();
    if (drainListeners.length === 0) return;
    const listeners = drainListeners;
    drainListeners = [];
    for (const listener of listeners) listener();
  };
  const finishEnd = (): void => {
    if (ended || socket === null) return;
    ended = true;
    socket.shutdown();
  };
  /** Writes the queue's head on; false when the kernel stopped taking or the socket closed. */
  const flush = (): boolean => {
    while (queue.length > 0) {
      if (socket === null) return false;
      const head = queue[0]!;
      const count = socket.write(head);
      if (count < 0) return false;
      if (count > 0) touch();
      if (count < head.length) {
        queue[0] = head.subarray(Math.max(0, count));
        return false;
      }
      queue.shift();
    }
    return true;
  };
  const conn: Conn = {
    write(data) {
      if (destroyed || ending) return false;
      if (typeof data === 'string') data = (encoder ??= new TextEncoder()).encode(data);
      if (data.length === 0) return queue.length === 0;
      queue.push(data);
      return socket !== null && queue.length === 1 ? flush() : false;
    },
    end(data) {
      if (destroyed || ending) return;
      if (data !== undefined) conn.write(data);
      ending = true;
      if (queue.length === 0) finishEnd();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      const held = socket;
      if (held !== null) held.terminate();
      closeOnce();
    },
    setTimeout(ms, idleCall) {
      idleMs = ms;
      if (idleCall !== undefined) onIdle = idleCall;
      touch();
    },
    unref() {
      wantUnref = true;
      socket?.unref();
    },
    onClose(listener) {
      if (closed) queueMicrotask(() => listener(closeError));
      else closeListeners.push(listener);
    },
    onDrain(listener) {
      if (!destroyed) drainListeners.push(listener);
    },
    get destroyed() {
      return destroyed;
    },
    get fd() {
      return socket === null ? null : socket.fd;
    },
  };
  const handler: BunSocketHandler = {
    open(opened) {
      if (destroyed) {
        opened.terminate();
        return;
      }
      socket = opened;
      if (wantUnref) opened.unref();
      // Writes made before the connection opened were queued; they go first.
      const waited = queue.length > 0;
      const flushed = flush();
      if (flushed && ending) finishEnd();
      events.open?.(conn);
      if (waited && flushed && !ending) drained();
    },
    data(_socket, chunk) {
      if (destroyed) return;
      touch();
      events.bytes?.(chunk);
      if (events.text !== undefined) events.text((decoder ??= new TextDecoder()).decode(chunk, { stream: true }));
    },
    drain() {
      if (destroyed) return;
      if (!flush()) return;
      if (ending) finishEnd();
      else drained();
    },
    end() {
      if (destroyed) return;
      events.end?.();
      // The peer is done writing: finish this side as node's default does, after what is queued.
      conn.end();
    },
    close(_socket, error) {
      closeOnce(error);
    },
    error(_socket, error) {
      closeOnce(error);
    },
    connectError(_socket, error) {
      closeOnce(error);
    },
  };
  return { conn, handler };
}

/** A client connection to `path`: pass `options` to `Bun.connect` and `refused` to its `.catch`.
 *  Writes made before it opens are queued. */
export function dialing(path: string, events: ConnEvents): { conn: Conn; options: BunSocketOptions; refused: (error: unknown) => void } {
  const { conn, handler } = connOf(events);
  return {
    conn,
    options: { unix: path, allowHalfOpen: true, socket: handler },
    refused: (error) => handler.connectError!(null as unknown as BunSocket, error instanceof Error ? error : new Error(String(error))),
  };
}

/** A listener's options for `Bun.listen`: `accept` is called with each new connection and
 *  answers that connection's events. */
export function serving(path: string, accept: (conn: Conn) => ConnEvents): BunSocketOptions {
  const per = (socket: BunSocket): ConnState | undefined => socket.data as ConnState | undefined;
  return {
    unix: path,
    allowHalfOpen: true,
    socket: {
      open(socket) {
        let events: ConnEvents = {};
        const state = connOf({
          open: (conn) => events.open?.(conn),
          text: (chunk) => events.text?.(chunk),
          bytes: (chunk) => events.bytes?.(chunk),
          drain: () => events.drain?.(),
          end: () => events.end?.(),
          close: (error) => events.close?.(error),
        });
        socket.data = state;
        // Opened first, so `accept` reads the descriptor (a peer check) and writes at once.
        state.handler.open!(socket);
        events = accept(state.conn);
      },
      data: (socket, chunk) => per(socket)?.handler.data!(socket, chunk),
      drain: (socket) => per(socket)?.handler.drain!(socket),
      end: (socket) => per(socket)?.handler.end!(socket),
      close: (socket, error) => per(socket)?.handler.close!(socket, error),
      error: (socket, error) => per(socket)?.handler.error!(socket, error),
    },
  };
}
