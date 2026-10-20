// Types for the machine socket's framing host (server.js). Plain data and Node builtins only;
// no TeamCLI import, no service, no auth, no path ownership.

/** The daemon protocol's measured request-frame limit, in decoded characters. */
export const HOST_FRAME_LIMIT: number;

/** No deadline by default (`0`): the existing daemon socket has none, and its 500 ms health
 *  timeout is a client budget, not a server one. */
export const HOST_DEADLINE_MS: number;

/** Why the host refused a connection without an answer from the caller's handler. */
export type HostRefusalReason = 'malformed' | 'frame-limit' | 'deadline' | 'handler-error';

export type HostServerOptions = {
  /** The caller's socket path. The host binds it and never unlinks or chmods it; Node's listener
   *  removes the path it bound when it closes. */
  socketPath: string;
  /** The decoded request as untrusted data: plain JSON, never a trusted principal, plus the raw
   *  line it was decoded from (newline stripped) for a line-based protocol validator. The caller
   *  returns the complete response line, trailing newline included. */
  onRequest: (input: unknown, line: string) => string | Promise<string>;
  /** The exact refusal line (newline included) for a connection the handler never saw. */
  onRefused: (reason: HostRefusalReason) => string;
  /** Buffered characters allowed before the newline search; defaults to HOST_FRAME_LIMIT. */
  frameLimit?: number;
  /** Milliseconds to the first complete line; 0 disables it. Defaults to HOST_DEADLINE_MS. */
  deadlineMs?: number;
  /** A listener error after a successful bind. */
  onError?: (error: Error) => void;
};

export type HostListenResult =
  | { ok: true }
  | { ok: false; reason: string; code: string | null };

export type HostServer = {
  socketPath: string;
  /** Bind and start accepting. A bind failure is reported, never repaired by unlinking. */
  listen(): Promise<HostListenResult>;
  /** Destroy open connections and stop accepting. The host never unlinks a path; Node removes
   *  the socket path this server bound when its listener closes. */
  close(): Promise<void>;
};

export function createHostServer(options: HostServerOptions): HostServer;
