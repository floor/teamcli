// Wire protocol of the one machine-wide TeamCLI daemon (send, bus, broker and task-next
// merged behind `<home>/.config/team/daemon.sock`). One newline-delimited JSON request in, one
// response line out, in that order.
//
// Version 2 adds `scope.pane` and the `op=next` dispatch shape: a next request names the pane
// its caller runs on, and the daemon answers with the task-next handler's own `next` document.
// Version 1 is still parsed exactly as before: it strips every scope key it does not know (so a
// v1 request carries no pane) and its `next` stays `daemon.auth-unsupported`. A response echoes
// the version of the request it answers.
//
// The transport bound the socket to one UID (mode 0600 in a 0700 folder), but that is not proof
// that anything a request says about its caller is true: the `scope` object is untrusted input.
// A mutating request (send, next, route, receipt, feed, event) is refused here with
// `daemon.auth-unsupported` until the daemon derives a verified principal from the existing
// caller/placement/session binding. No caller self-certification, self-minted owner proof or
// grant is accepted; the host only dispatches `next` through an injected verified-principal seam.
import type { NextAction } from './next.ts';
import type { DaemonFeatures, DaemonRootPresenceHealth, DaemonStuckRequest } from './state.ts';

export const DAEMON_PROTOCOL_VERSION = 2 as const;

/** Every version this daemon still answers. v1 is the health client already shipped; v2 is the
 *  task-next dispatch and the pane it names. */
export type DaemonProtocolVersion = 1 | 2;

/** The largest request line this protocol accepts, in characters. */
export const DAEMON_FRAME_LIMIT = 65_536;

/** Which checkout, team, seat, session and pane a request believes it belongs to. Untrusted data
 *  until a mutating handler verifies it; health reads it only to echo nothing back. `pane` is a
 *  v2 field: the v1 parser strips it like every other key it does not know. */
export type DaemonScope = {
  root?: string;
  team?: string;
  seat?: string;
  session?: string;
  /** The registry agent id (incarnation), when the caller has one. */
  agent?: string;
  /** The pane the caller claims to run on; only the verified principal may believe it. */
  pane?: string;
};

/** The one task-next action a request may ask for — the handler's own action, so the wire and
 *  the handler cannot drift apart. The answer carries its own outcome. */
export type DaemonNextAction = NextAction;

export type DaemonRequest = {
  v: DaemonProtocolVersion;
  id: string;
  op: string;
  scope?: DaemonScope;
  /** v2 `op=next` only: the action to take; `claim` when absent. */
  action?: DaemonNextAction;
  /** v2 `op=next` only: claim only work assigned to the caller. False when absent. */
  mine?: boolean;
};

/**
 * One canonical route the answering daemon hosts, derived from its in-memory routes for this
 * request rather than copied from the five-second state record. `root` is the canonical checkout
 * root the daemon accepted; `presence` is present only when this process runs the route's
 * presence pass, so an entry without it means no health is known.
 */
export type DaemonRootHealthSnapshot = {
  root: string;
  presence?: DaemonRootPresenceHealth;
};

/** The daemon facts a health answer carries; the caller adds the probe timing. */
export type DaemonHealthSnapshot = {
  pid: number;
  uid: number;
  since: string;
  startedBy: string;
  version: string;
  heartbeatAt: string;
  stuck: DaemonStuckRequest[];
  features: DaemonFeatures;
  /**
   * The canonical routes and their fresh presence answers. Present while the daemon has routes;
   * the snapshot's `pid` and `since` name the epoch that produced them, and a reader must match
   * that epoch before using an answer. Absent fields, or a root with no entry, mean no health is
   * known and a reader must hold its last projection rather than infer one.
   */
  roots?: DaemonRootHealthSnapshot[];
};

export type DaemonErrorCode =
  | 'daemon.bad-frame'
  | 'daemon.unsupported-op'
  | 'daemon.auth-unsupported'
  | 'daemon.scope-mismatch'
  | 'daemon.internal';

export type DaemonResponse =
  | { v: DaemonProtocolVersion; id: string; ok: true; health: DaemonHealthSnapshot }
  /** The task-next answer; its document belongs to the next handler, not to this transport. */
  | { v: DaemonProtocolVersion; id: string; ok: true; next: unknown }
  | { v: DaemonProtocolVersion; id: string; ok: false; error: { code: DaemonErrorCode; message: string } };

/** The ops the one daemon will own. Every one of them mutates or reads private state and is
 *  refused with `daemon.auth-unsupported` until the verified-principal binding lands. */
export const DAEMON_MUTATING_OPS: readonly string[] = [
  'send',
  'next',
  'route',
  'routes',
  'receipt',
  'receipts',
  'feed',
  'event',
  'events',
  'subscribe',
  'publish',
] as const;

/** True for the one op this slice answers. */
export function isSupportedDaemonOp(op: string): boolean {
  return op === 'health';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Parses one request line. A bad frame names its own error; the id is carried when one was read. */
export function parseDaemonRequest(line: string): { ok: true; request: DaemonRequest } | { ok: false; id: string; error: { code: DaemonErrorCode; message: string } } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, id: '', error: { code: 'daemon.bad-frame', message: 'the request line is not JSON' } };
  }
  if (!isRecord(parsed)) {
    return { ok: false, id: '', error: { code: 'daemon.bad-frame', message: 'the request is not a JSON object' } };
  }
  const id = typeof parsed.id === 'string' ? parsed.id : '';
  const version = parsed.v === 1 || parsed.v === 2 ? parsed.v : null;
  if (version === null) {
    return { ok: false, id, error: { code: 'daemon.bad-frame', message: 'the request version must be 1 or 2' } };
  }
  if (id === '') {
    return { ok: false, id, error: { code: 'daemon.bad-frame', message: 'the request needs a non-empty id' } };
  }
  if (typeof parsed.op !== 'string' || parsed.op === '') {
    return { ok: false, id, error: { code: 'daemon.bad-frame', message: 'the request needs a non-empty op' } };
  }
  const scope = scopeOf(parsed.scope, version);
  if (scope === null) {
    return { ok: false, id, error: { code: 'daemon.bad-frame', message: 'scope must be an object of strings when present' } };
  }
  // The dispatch fields belong to v2. A v1 request that carries them is read exactly as before:
  // they are ignored, and its `next` stays refused. A v2 request that carries them badly is a bad
  // frame rather than a silently different action.
  let action: DaemonNextAction | undefined;
  if (version === 2 && parsed.action !== undefined) {
    if (parsed.action !== 'claim' && parsed.action !== 'release') {
      return { ok: false, id, error: { code: 'daemon.bad-frame', message: 'the action must be claim or release' } };
    }
    action = parsed.action;
  }
  let mine: boolean | undefined;
  if (version === 2 && parsed.mine !== undefined) {
    if (typeof parsed.mine !== 'boolean') {
      return { ok: false, id, error: { code: 'daemon.bad-frame', message: 'mine must be a boolean' } };
    }
    mine = parsed.mine;
  }
  return {
    ok: true,
    request: {
      v: version,
      id,
      op: parsed.op,
      ...(scope ? { scope } : {}),
      ...(action !== undefined ? { action } : {}),
      ...(mine !== undefined ? { mine } : {}),
    },
  };
}

/** The scope keys each version knows. v1 predates `pane`, so it strips it like any other key it
 *  does not know; only a v2 request can name the pane its caller claims. */
const SCOPE_KEYS: Record<DaemonProtocolVersion, readonly (keyof DaemonScope)[]> = {
  1: ['root', 'team', 'seat', 'session', 'agent'],
  2: ['root', 'team', 'seat', 'session', 'agent', 'pane'],
};

function scopeOf(raw: unknown, version: DaemonProtocolVersion): DaemonScope | undefined | null {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return null;
  const scope: DaemonScope = {};
  for (const key of SCOPE_KEYS[version]) {
    const value = optionalString(raw[key]);
    if (value === null) return null;
    if (value !== undefined) scope[key] = value;
  }
  return scope;
}

/**
 * The fallback dispatcher: `health` is answered from the daemon's own state, and every op that is
 * not dispatched through a verified-principal seam fails closed. A known mutating op is
 * `daemon.auth-unsupported` (the daemon has no verified principal for it here), anything else is
 * `daemon.unsupported-op`. A request that declares a scope is never trusted through this answer —
 * health returns machine facts only. The host answers `next` itself, and only through its
 * injected verifier and handler; when either is absent this function answers it.
 */
export function answerDaemonRequest(request: DaemonRequest, health: DaemonHealthSnapshot): DaemonResponse {
  if (request.op === 'health') return { v: request.v, id: request.id, ok: true, health };
  if (DAEMON_MUTATING_OPS.includes(request.op)) {
    return {
      v: request.v,
      id: request.id,
      ok: false,
      error: {
        code: 'daemon.auth-unsupported',
        message: `${request.op}: mutating daemon requests are not accepted until a verified principal binding is implemented; nothing was done`,
      },
    };
  }
  return {
    v: request.v,
    id: request.id,
    ok: false,
    error: { code: 'daemon.unsupported-op', message: `${request.op}: unknown daemon request` },
  };
}

/** One response line, newline included. */
export function formatDaemonResponse(response: DaemonResponse): string {
  return `${JSON.stringify(response)}\n`;
}
