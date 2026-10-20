// The delivery transport's public surface. TeamCLI keeps admission, signing, history, policy and
// the outcome words; this package stores the one durable copy and makes one route attempt.

export type RelayRoute = 'socket' | 'durable-copy';

/** The durable copy's place: the receiving seat's resolved drop folder and the record's name. */
export type CopyTarget = { dir: string; name: string };

/** The signed record is opaque text: the relay stores and carries it, never parses it. */
export type RelayMessage = {
  id: string;
  /** The signed record exactly as TeamCLI signed it (one JSON text). Required by stage. */
  record: string;
  /** The complete socket frame line, trailing newline included. Required for a socket attempt. */
  frame?: string;
};

export type RelayReceipt = {
  /** The durable copy's path, once it is on disk. */
  copy?: string;
  /** True when a regular file already held the record's name (the caller decides whether it is
   *  this message's record). */
  existing?: boolean;
  /** Frame characters written on the socket (socket route). */
  bytes?: number;
  /** The transport's clock, ISO, from options.now() when given. */
  at: string;
};

export type RelayStage =
  | { outcome: 'stored'; receipt: RelayReceipt }
  | { outcome: 'refused'; reason: string; receipt?: RelayReceipt };

export type RelayAttempt =
  | { route: RelayRoute; outcome: 'delivered'; receipt: RelayReceipt }
  | { route: RelayRoute; outcome: 'read' | 'held' | 'refused'; reason: string; receipt?: RelayReceipt };

/** The dial's answer: the socket took the frame (the write callback), or the reason it did not. */
export type DialOutcome = { ok: true } | { ok: false; reason: string };

/** The raw socket primitive: one connection, one frame line, its trailing newline included.
 *  TeamCLI passes its own host dial through RelayOptions.dial in step 1; this default is the
 *  package's own client and the implementation src/send/uds.ts delegates to. */
export type Dial = (socketPath: string, frame: string, timeoutMs?: number) => Promise<DialOutcome>;

export type RelayOptions = {
  /** Stamps receipts; the caller's clock (TeamCLI passes host.now()). Default: wall clock. */
  now?: () => Date;
  /** Socket deadline for the default dial; default is capabilities().socket.timeoutMs. */
  timeoutMs?: number;
  /** The caller's transport seam. Omitted, the package dials with its own `dial`. */
  dial?: Dial;
};

export type RelayTarget =
  | { route: 'socket'; socket: string; runtime: string; copy: CopyTarget }
  | { route: 'durable-copy'; copy: CopyTarget };

export type RelayCapabilities = {
  routes: readonly RelayRoute[];
  socket: { runtime: string; supported: boolean; frameLimit: number; timeoutMs: number; ack: false };
  durableCopy: { supported: true };
};

export const FRAME_LIMIT: number;
export const SEND_TIMEOUT_MS: number;

/** Writes one frame to the socket at `socketPath`; the write callback is the whole proof. */
export function dial(socketPath: string, frame: string, timeoutMs?: number): Promise<DialOutcome>;

/** Writes the durable signed copy, before any route attempt. */
export function stage(copy: CopyTarget, message: RelayMessage, options?: RelayOptions): Promise<RelayStage>;

/** One route attempt, in the order the caller resolved. Never falls back, never reorders. */
export function deliver(target: RelayTarget, message: RelayMessage, options?: RelayOptions): Promise<RelayAttempt>;

/** Pure, synchronous, no I/O. Socket support: `claude-code` only, ack false. */
export function capabilities(runtime: string, version?: string): RelayCapabilities;
