// The one request the warm send host is running (docs: briefs rfc-bus-send-server §2.4).
//
// The host runs one `send`, `reply` or `ack` line at a time for a client process the kernel named
// (the socket peer). While a request runs, the caller's ancestor walk starts at that client's
// kernel parent instead of this process's own parent, and the walk's parent-changed check reads
// that client's parent again. No other module reads this scope except the authority verifiers,
// which refuse while it is set: a hosted line never carries the daemon's or a watch's authority,
// even though the host is a process the daemon started.

export type HostedRequest = {
  /** The client process (the socket peer, from `LOCAL_PEERPID`). */
  readonly peerPid: number;
  /** Where the walk starts: the client's parent as the kernel named it when the request came in. */
  readonly startPid: number;
  /** The client's parent as the kernel names it now; null when the client is gone or unreadable. */
  readonly currentParent: () => number | null;
};

let active: HostedRequest | null = null;

/** The request the host is running, or null outside the host (every ordinary CLI run). */
export function hostedRequest(): HostedRequest | null {
  return active;
}

/** Runs `fn` as `request`. Requests never nest: the host serves one at a time. */
export async function runAsHostedRequest<T>(request: HostedRequest, fn: () => Promise<T>): Promise<T> {
  if (active !== null) throw new Error('a hosted request is already running');
  active = request;
  try {
    return await fn();
  } finally {
    active = null;
  }
}

/** The refusal every authority verifier gives while a hosted request runs. */
export const HOSTED_NO_AUTHORITY = 'a line the send host runs for a client carries no daemon or watch authority';

/** Thrown at a fallback point while nothing has been done yet: the host hands the line back to
 *  the client, which runs it in-process exactly as it would without the host. */
export class HostedFallback extends Error {
  readonly why: string;
  constructor(why: string) {
    super(`handed back to the client: ${why}`);
    this.why = why;
    this.name = 'HostedFallback';
  }
}

/** Thrown at a fallback point reached after the line's first effect: the line stops there and is
 *  never handed back, so nothing is done twice. */
export class HostedStoppedAfterEffect extends Error {
  readonly why: string;
  readonly first: string;
  constructor(why: string, first: string) {
    super(`the send host stopped this line after it began (${first}); nothing more was done: ${why}`);
    this.why = why;
    this.first = first;
    this.name = 'HostedStoppedAfterEffect';
  }
}

type GuardState = { first: string | null; fellBack: string | null; check: () => string | null };
let guard: GuardState | null = null;

/** Arms the effect guard for the running request; `check` re-reads the peer's identity and names
 *  what changed, or null when it still holds. */
export function armHostedGuard(check: () => string | null): void {
  guard = { first: null, fellBack: null, check };
}

/** Disarms the guard: the first effect's name (null when the line did nothing) and the fallback
 *  point that fired (null when none did). A fallback point a command caught and went past still
 *  counts: the line is handed back, and no effect was let through after it. */
export function disarmHostedGuard(): { first: string | null; fellBack: string | null } {
  const out = { first: guard?.first ?? null, fellBack: guard?.fellBack ?? null };
  guard = null;
  return out;
}

/** A point where the host must not go on: hands the line back while nothing has been done,
 *  stops it after. A no-op outside the host. */
export function hostedFallbackPoint(why: string): void {
  if (active === null || guard === null) return;
  if (guard.first === null) {
    guard.fellBack ??= why;
    throw new HostedFallback(why);
  }
  throw new HostedStoppedAfterEffect(why, guard.first);
}

/** Called by an effect funnel before it acts. The first call checks the peer again and fails
 *  closed when it no longer holds. A no-op outside the host. */
export function hostedCommit(what: string): void {
  if (active === null || guard === null) return;
  // A fallback point fired and the command went on (it caught the throw): no effect may follow.
  if (guard.fellBack !== null) throw new HostedFallback(guard.fellBack);
  if (guard.first !== null) return;
  const changed = guard.check();
  if (changed !== null) {
    guard.fellBack = `the client changed before the first effect: ${changed}`;
    throw new HostedFallback(guard.fellBack);
  }
  guard.first = what;
}

/** How long the host waits, after a line's `main` returns, for the work that line left running
 *  (rfc-bus-send-server §2.4, "Deferred callbacks"). */
export const DEFERRED_WAIT_MS = 200;

const deferred = new Set<Promise<unknown>>();

/** Registers work a hosted line leaves running after its command returns (a late webhook
 *  continuation). The host waits for it, bounded, before it restores the environment, and recycles
 *  when it is still pending. A no-op outside the host: an in-process run's process simply stays
 *  alive until the work settles, as it always has. The audit of every such site is
 *  test/host/send-host-deferred.test.ts. */
export function deferHosted(work: Promise<unknown>): void {
  if (active === null) return;
  const held = work.then(() => undefined, () => undefined);
  deferred.add(held);
  void held.then(() => { deferred.delete(held); });
}

/** Waits up to `ms` for every registered deferred work to settle; the count still pending. */
export async function settleHostedDeferred(ms: number = DEFERRED_WAIT_MS): Promise<number> {
  if (deferred.size === 0) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all([...deferred]),
    new Promise<void>((settle) => { timer = setTimeout(settle, ms); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return deferred.size;
}
