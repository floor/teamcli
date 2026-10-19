// Wire protocol v1 of the one machine-wide TeamCLI daemon (send, bus, broker and task-next
// merged behind `~/.config/teamcli/daemon.sock`). One newline-delimited JSON request in, one
// response line out, in that order.
//
// This first slice is HEALTH ONLY. The transport bound the socket to one UID (mode 0600 in a
// 0700 folder), but that is not proof that anything a request says about its caller is true:
// the `caller` object, when a later version carries one, is untrusted input. A mutating request
// (send, next, route, receipt, feed, event) is refused here with `daemon.auth-unsupported`
// until the daemon derives a verified principal from the existing caller/placement/session
// binding. No caller self-certification, self-minted owner proof or grant is accepted.
import type { DaemonFeatures, DaemonStuckRequest } from './state.ts';

export const DAEMON_PROTOCOL_VERSION = 1 as const;

/** The largest request line this protocol accepts, in characters. */
export const DAEMON_FRAME_LIMIT = 65_536;

/** Which checkout, team, seat and session a request believes it belongs to. Untrusted data
 *  until a mutating handler verifies it; health reads it only to echo nothing back. */
export type DaemonScope = {
  root?: string;
  team?: string;
  seat?: string;
  session?: string;
  /** The registry agent id (incarnation), when the caller has one. */
  agent?: string;
};

export type DaemonRequest = {
  v: typeof DAEMON_PROTOCOL_VERSION;
  id: string;
  op: string;
  scope?: DaemonScope;
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
};

export type DaemonErrorCode =
  | 'daemon.bad-frame'
  | 'daemon.unsupported-op'
  | 'daemon.auth-unsupported'
  | 'daemon.scope-mismatch'
  | 'daemon.internal';

export type DaemonResponse =
  | { v: typeof DAEMON_PROTOCOL_VERSION; id: string; ok: true; health: DaemonHealthSnapshot }
  | { v: typeof DAEMON_PROTOCOL_VERSION; id: string; ok: false; error: { code: DaemonErrorCode; message: string } };

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
  if (parsed.v !== DAEMON_PROTOCOL_VERSION) {
    return { ok: false, id, error: { code: 'daemon.bad-frame', message: `the request version must be ${String(DAEMON_PROTOCOL_VERSION)}` } };
  }
  if (id === '') {
    return { ok: false, id, error: { code: 'daemon.bad-frame', message: 'the request needs a non-empty id' } };
  }
  if (typeof parsed.op !== 'string' || parsed.op === '') {
    return { ok: false, id, error: { code: 'daemon.bad-frame', message: 'the request needs a non-empty op' } };
  }
  const scope = scopeOf(parsed.scope);
  if (scope === null) {
    return { ok: false, id, error: { code: 'daemon.bad-frame', message: 'scope must be an object of strings when present' } };
  }
  return { ok: true, request: { v: DAEMON_PROTOCOL_VERSION, id, op: parsed.op, ...(scope ? { scope } : {}) } };
}

function scopeOf(raw: unknown): DaemonScope | undefined | null {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return null;
  const scope: DaemonScope = {};
  for (const key of ['root', 'team', 'seat', 'session', 'agent'] as const) {
    const value = optionalString(raw[key]);
    if (value === null) return null;
    if (value !== undefined) scope[key] = value;
  }
  return scope;
}

/**
 * The only request dispatcher this slice has. `health` is answered from the daemon's own state.
 * Every other op fails closed: a known mutating op is `daemon.auth-unsupported` (the daemon has
 * no verified principal for it yet), anything else is `daemon.unsupported-op`. A request that
 * declares a scope is never trusted through this answer — health returns machine facts only.
 */
export function answerDaemonRequest(request: DaemonRequest, health: DaemonHealthSnapshot): DaemonResponse {
  if (request.op === 'health') return { v: DAEMON_PROTOCOL_VERSION, id: request.id, ok: true, health };
  if (DAEMON_MUTATING_OPS.includes(request.op)) {
    return {
      v: DAEMON_PROTOCOL_VERSION,
      id: request.id,
      ok: false,
      error: {
        code: 'daemon.auth-unsupported',
        message: `${request.op}: mutating daemon requests are not accepted until a verified principal binding is implemented; nothing was done`,
      },
    };
  }
  return {
    v: DAEMON_PROTOCOL_VERSION,
    id: request.id,
    ok: false,
    error: { code: 'daemon.unsupported-op', message: `${request.op}: unknown daemon request` },
  };
}

/** One response line, newline included. */
export function formatDaemonResponse(response: DaemonResponse): string {
  return `${JSON.stringify(response)}\n`;
}
