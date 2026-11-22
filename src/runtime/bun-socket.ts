// The part of Bun's socket API this CLI uses, declared once. The build compiles against the node
// types alone (tsconfig.build.json), so no module may name Bun's own types; every socket that
// moves off node:net onto Bun's takes its types and its runtime from here.
//
// A caller binds the runtime to a local named `Bun` (`const Bun = bunSockets()`), so a call reads
// `Bun.connect(…)` at its own site and the host's effect inventory lists it there.

/** A connected socket: an unbuffered, non-blocking writer. */
export type BunSocket = {
  /** Writes what the kernel takes now: the byte count written, which can be less than asked
   *  (wait for `drain`), or -1 once the socket is closed or shutting down. */
  write(data: string | Uint8Array, byteOffset?: number, byteLength?: number): number;
  /** Closes the write side once what is written has gone. */
  end(): void;
  /** Closes the socket at once. */
  terminate(): void;
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

export type BunSockets = {
  /** Connects to a unix socket. The promise rejects when the connection is refused; with a
   *  `connectError` handler that is the only report a caller needs to read. */
  connect(options: { unix: string; socket: BunSocketHandler }): Promise<BunSocket>;
};

/** Bun's socket runtime, or null when this process does not run under Bun. */
export function bunSockets(): BunSockets | null {
  const runtime = (globalThis as { Bun?: { connect?: unknown } }).Bun;
  return runtime !== undefined && typeof runtime.connect === 'function' ? (runtime as BunSockets) : null;
}
