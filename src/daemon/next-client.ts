// The caller's half of the daemon's `next` boundary: one request line over the machine socket,
// one answer line back, a deadline. This module holds no credential and opens no tracker: it
// carries the claimed (seat, pane) the daemon verifies, and maps every failure to an outcome the
// command turns into its own exit.
//
// The request shape is protocol v2's. v1's parser keeps only root/team/seat/session/agent, so it
// drops this `pane` and its dispatcher refuses the op with `daemon.auth-unsupported` — which is
// why the shipped default never calls this module. A success answer carries the handler's
// `NextAnswer` under `next`; until the host adds that shape, every v1 answer is a refusal and
// nothing is claimed.
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import type { TaskRecord } from '../tasks/adapter.ts';
import type { NextAnswer, NextClaim, NextRefusalCode } from './next.ts';
import { DAEMON_FRAME_LIMIT, DAEMON_PROTOCOL_VERSION } from './protocol.ts';

/** The broker client's own deadline shape: a hung daemon must not hang the seat. */
export const DAEMON_NEXT_DEADLINE_MS = 5000;

/** What the caller sends. `scope` is a claim, never proof; `action` and `mine` are the request. */
export type DaemonNextRequest = {
  v: typeof DAEMON_PROTOCOL_VERSION;
  id: string;
  op: 'next';
  scope: { root: string; team?: string; session?: string; seat: string; pane: string };
  action: 'claim' | 'release';
  mine: boolean;
};

export type DaemonNextOutcome =
  | { kind: 'answer'; answer: NextAnswer }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'unavailable' }
  | { kind: 'wrong' }
  | { kind: 'deadline' };

export type DaemonNextInput = {
  root: string;
  team: string;
  session: string;
  caller: NextClaim;
  action: 'claim' | 'release';
  mine: boolean;
};

/** One request, with its own id. A caller sends what it resolved for itself — the root it
 *  loaded from, the team and session that file names, and the pane it was placed on. */
export function daemonNextRequest(input: DaemonNextInput): DaemonNextRequest {
  return {
    v: DAEMON_PROTOCOL_VERSION,
    id: randomUUID(),
    op: 'next',
    scope: {
      root: input.root,
      team: input.team,
      session: input.session,
      seat: input.caller.seat,
      pane: input.caller.pane,
    },
    action: input.action,
    mine: input.mine,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

const REFUSAL_CODES: readonly NextRefusalCode[] = [
  'next.caller',
  'next.paused',
  'next.swap',
  'next.file',
  'next.missing',
  'next.shape',
  'next.broker',
  'next.read',
];

/** The record as the wire may carry it: every field the plain output reads, with its type
 *  checked. An unknown key is dropped, not trusted. */
function recordOf(value: unknown): TaskRecord | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const title = text(value.title);
  if (id === null || title === null) return null;
  const record: TaskRecord = { id, title };
  const priority = value.priority;
  if (priority !== undefined) {
    if (typeof priority !== 'number' && typeof priority !== 'string') return null;
    record.priority = priority;
  }
  for (const key of ['assignee', 'milestone', 'deadline', 'description'] as const) {
    const held = value[key];
    if (held === undefined) continue;
    if (typeof held !== 'string') return null;
    record[key] = held;
  }
  for (const key of ['blockedBy', 'repos', 'needs'] as const) {
    const held = value[key];
    if (held === undefined) continue;
    if (!Array.isArray(held) || held.some((item) => typeof item !== 'string')) return null;
    record[key] = [...held] as string[];
  }
  return record;
}

/**
 * One answer body, or null when it is not one this build knows. The strictness is the broker
 * client's: a stale daemon or a broken line must fail safe, never half-claim.
 */
export function nextAnswerOf(value: unknown): NextAnswer | null {
  if (!isRecord(value)) return null;
  const notice = value.notice;
  if (notice !== undefined && typeof notice !== 'string') return null;
  let body: NextAnswer;
  if (value.ok === true && value.kind === 'claimed') {
    const record = recordOf(value.record);
    if (record === null) return null;
    body = { ok: true, kind: 'claimed', record };
  } else if (value.ok === true && value.kind === 'released') {
    const id = text(value.id);
    if (id === null) return null;
    body = { ok: true, kind: 'released', id };
  } else if (value.ok === true && value.kind === 'none') {
    const why = value.why;
    if (why !== 'nothing-takeable' && why !== 'nothing-assigned' && why !== 'nothing-held') return null;
    body = { ok: true, kind: 'none', why };
  } else if (value.ok === false) {
    if (typeof value.code !== 'string' || !REFUSAL_CODES.includes(value.code as NextRefusalCode)) return null;
    if (typeof value.message !== 'string') return null;
    const hint = value.hint;
    if (hint !== undefined && typeof hint !== 'string') return null;
    body = { ok: false, code: value.code as NextRefusalCode, message: value.message, ...(hint === undefined ? {} : { hint }) };
  } else {
    return null;
  }
  return notice === undefined ? body : { ...body, notice };
}

/**
 * One request on the machine socket. The first answer line wins; a connection that ends or
 * breaks before one — and a line past the frame cap — is `wrong`, the same fail-safe the broker
 * client uses. A daemon that is not there is `unavailable`.
 */
export function askDaemonNext(
  socketPath: string,
  request: DaemonNextRequest,
  options: { deadlineMs?: number } = {},
): Promise<DaemonNextOutcome> {
  const deadlineMs = options.deadlineMs ?? DAEMON_NEXT_DEADLINE_MS;
  return new Promise((done) => {
    let settled = false;
    let connected = false;
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const socket = connect(socketPath);
    const finish = (outcome: DaemonNextOutcome) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.destroy();
      done(outcome);
    };
    timer = setTimeout(() => finish(connected ? { kind: 'deadline' } : { kind: 'unavailable' }), deadlineMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at < 0) {
        if (buffer.length > DAEMON_FRAME_LIMIT) finish({ kind: 'wrong' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, at));
      } catch {
        finish({ kind: 'wrong' });
        return;
      }
      if (!isRecord(parsed) || parsed.v !== DAEMON_PROTOCOL_VERSION || parsed.id !== request.id) {
        finish({ kind: 'wrong' });
        return;
      }
      if (parsed.ok === true) {
        const answer = nextAnswerOf(parsed.next);
        finish(answer === null ? { kind: 'wrong' } : { kind: 'answer', answer });
        return;
      }
      if (parsed.ok === false && isRecord(parsed.error) && typeof parsed.error.code === 'string' && typeof parsed.error.message === 'string') {
        finish({ kind: 'refused', code: parsed.error.code, message: parsed.error.message });
        return;
      }
      finish({ kind: 'wrong' });
    });
    socket.once('error', () => finish(connected ? { kind: 'wrong' } : { kind: 'unavailable' }));
    socket.on('close', () => finish(connected ? { kind: 'wrong' } : { kind: 'unavailable' }));
  });
}
