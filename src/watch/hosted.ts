// The contract between a watch host and the shared watch loop it runs. A hosted loop has no
// pane, no terminal and no timer of its own: the host owns the heartbeat tick and the
// cancellation signal, and the loop owns one serial pass. These types are internal: nothing a
// command line can spell selects a hosted watch.

/** What a hosted watch loop reads from its host. */
export type HostedLoop = {
  /** Aborted when the host stops; a loop that reads it between passes leaves promptly. */
  signal: AbortSignal;
  /** Resolves true at the first host tick at or after `ms` on the pass clock, and false when
   *  the host stopped — including for a wait registered after the stop. */
  wait(ms: number): Promise<boolean>;
  /** One completed pass, at the pass's own clock. */
  cycled(at: Date): void;
  /** A live pane watch owns the session: leave at the next seam without touching anything. */
  standby(why: string): void;
};

/**
 * The state a hosted watch exposes, for the daemon's record and its readers. `phase` and
 * `effects` are separate on purpose: a watch can be cycling while its outbound effects are
 * closed, and a reader must never print either as fully enforcing.
 */
export type HostedWatchState = {
  routeId: string;
  root: string;
  team: string;
  session: string;
  phase: 'starting' | 'running' | 'standby' | 'stopping' | 'stopped' | 'failed';
  startedAt: string;
  /** The last completed pass's own clock; null until a pass completes, never guessed. */
  lastCycleAt: string | null;
  lastCycleOutcome: 'pass' | 'failed' | null;
  cycles: number;
  failures: number;
  /** `blocked` until a verified admitted sender is injected; `open` when one is. */
  effects: 'blocked' | 'open';
  /**
   * Whether this route was started with a hosted watch on purpose. A reader may flag a
   * stopped or failed watch only when it is required; a host that exists at all is required,
   * and a route with no `watch` record was never started to carry one.
   */
  required: boolean;
  /** The standby reason, the failure, or the stop reason; null while cycling. */
  why: string | null;
};

/** The host half of one hosted watch. */
export type HostedWatchHandle = {
  state(): HostedWatchState;
  /** Releases the waits whose own due instant has passed. Never awaits a pass. */
  tick(now: Date): void;
  /** Aborts, resolves waits false, and awaits the loop's own exit. */
  stop(why: string): Promise<void>;
  /** Settles when the loop has left, however it left. */
  done: Promise<void>;
};
