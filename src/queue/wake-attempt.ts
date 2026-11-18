// Wake-attempt states (rfc-event-comms §5, step E6).
//
// Every typed wake is one attempt, identified by (seat, incarnation, n). Its states are files
// created exclusively and durably, each one fsynced before the next step:
//   .agents/wakes/<session>/<seat>/<incarnation>/<n>.prepared   under the seat lock, before any key
//   .agents/wakes/<session>/<seat>/<incarnation>/<n>.emitted    immediately before the FIRST key;
//                                                               its fsync completes before typing
//   .agents/wakes/<session>/<seat>/<incarnation>/<n>.confirmed  the wake landed, or a read arrived
//   .agents/wakes/<session>/<seat>/<incarnation>/<n>.uncertain  keys went out and nothing confirmed
// The highest state standing is the attempt's state. A state file is never removed.
//
// The retry rule, enforced on an active, fenced or unknown root (only a proven-dark root writes the
// states in shadow and enforces nothing):
//   - `prepared` only: no key was sent; a retry is allowed.
//   - `emitted` or `uncertain` with no `confirmed`: NO retype. It resolves only on evidence: a read
//     receipt for the attempt's target, the attempt's token found in the pane's scrollback, or a new
//     seat incarnation (another folder: the process that might hold the input is gone).
//   - An expired verify window never grants permission to type.
// One wake per seat: no new attempt while an unresolved attempt targets an equal or later message.
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { messageKeyOf, messageKeyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { createExclusive, readFence, type DurableFaults } from './durable.ts';
import { floorState } from './floor.ts';

export const WAKE_ATTEMPT_DOMAIN = 'team-wake-attempt-v1\n';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type AttemptStateName = 'prepared' | 'emitted' | 'confirmed' | 'uncertain';
const ORDER: AttemptStateName[] = ['prepared', 'emitted', 'confirmed', 'uncertain'];

export type AttemptScope = { root: string; session: string; seat: string; incarnation: string };

export type AttemptTarget = { msg_id: string; seq: number | null };

export type AttemptPayload = AttemptScope & {
  v: 1;
  kind: 'wake-attempt';
  n: number;
  state: AttemptStateName;
  target: AttemptTarget;
  token: string;
  at: string;
};

/** A stable incarnation name from what identifies one seat process: its launch stamp and pane. */
export function incarnationOf(launched: string | null, pane: string | null): string {
  if (launched === null || pane === null) return 'unknown';
  return `i${createHash('sha256').update(`${launched}\n${pane}`).digest('hex').slice(0, 16)}`;
}

function scopeFolder(scope: AttemptScope): string | null {
  if (!NAME.test(scope.session) || !NAME.test(scope.seat) || !NAME.test(scope.incarnation)) return null;
  return join(scope.root, '.agents', 'wakes', scope.session, scope.seat, scope.incarnation);
}

export type Attempt = { n: number; state: AttemptStateName; target: AttemptTarget; token: string };

/**
 * The attempts of one incarnation with their highest verifying state. Null when the folder or the
 * key cannot be read (unknown: the gate then blocks).
 */
export function attemptsOf(scope: AttemptScope, home: string): Attempt[] | null {
  const folder = scopeFolder(scope);
  if (folder === null) return null;
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  const key = messageKeyState(home);
  if (names.length > 0 && key.kind !== 'key') return null;
  const byN = new Map<number, Attempt>();
  for (const name of names) {
    const match = /^(\d{1,9})\.(prepared|emitted|confirmed|uncertain)$/.exec(name);
    if (!match) continue;
    const text = readFence(join(folder, name));
    if (text === null) return null; // a state file that cannot be read is unknown, never absent
    if (text === '') continue;
    let record: { payload?: AttemptPayload; signature?: unknown };
    try {
      record = JSON.parse(text) as typeof record;
    } catch {
      return null;
    }
    const payload = record.payload;
    if (!payload || payload.kind !== 'wake-attempt' || typeof record.signature !== 'string') return null;
    if (payload.root !== scope.root || payload.session !== scope.session || payload.seat !== scope.seat || payload.incarnation !== scope.incarnation) return null;
    if (payload.n !== Number(match[1]) || payload.state !== match[2]) return null;
    if (key.kind !== 'key' || !verifyDomain(WAKE_ATTEMPT_DOMAIN, payload as unknown as Json, record.signature, key.key)) return null;
    const held = byN.get(payload.n);
    const state = payload.state as AttemptStateName;
    // `confirmed` outranks `uncertain` (evidence resolved it); otherwise the later step stands.
    const rank = (s: AttemptStateName): number => (s === 'confirmed' ? 9 : ORDER.indexOf(s));
    if (held === undefined || rank(state) > rank(held.state)) byN.set(payload.n, { n: payload.n, state, target: payload.target, token: payload.token });
  }
  return [...byN.values()].sort((a, b) => a.n - b.n);
}

function writeState(scope: AttemptScope, attempt: Attempt, state: AttemptStateName, home: string, faults?: DurableFaults): 'created' | 'exists' | 'failed' {
  const folder = scopeFolder(scope);
  if (folder === null) return 'failed';
  const payload: AttemptPayload = { ...scope, v: 1, kind: 'wake-attempt', n: attempt.n, state, target: attempt.target, token: attempt.token, at: new Date().toISOString() };
  let signature: string;
  try {
    signature = signDomain(WAKE_ATTEMPT_DOMAIN, payload as unknown as Json, messageKeyOf(home));
  } catch {
    return 'failed';
  }
  return createExclusive(join(folder, `${String(attempt.n)}.${state}`), `${JSON.stringify({ payload, signature })}\n`, faults);
}

export type GateEvidence = {
  /** A read (or other settling) receipt stands for this message. */
  settled: (msgId: string) => boolean;
  /** The pane's scrollback, read once, or null when it cannot be read. */
  scrollback?: () => string | null;
};

export type GateOutcome =
  | { kind: 'open'; enforced: boolean }
  | { kind: 'blocked'; why: string };

function targets(later: AttemptTarget, earlier: AttemptTarget): boolean {
  if (later.msg_id === earlier.msg_id) return true;
  if (later.seq === null || earlier.seq === null) return true; // unknown order: treat as covered
  return earlier.seq >= later.seq;
}

/**
 * Whether a new attempt for `target` may start. Resolves unresolved attempts on evidence first
 * (a settling receipt or the token in the scrollback writes `confirmed`). On a dark root the gate
 * is open and enforces nothing.
 */
export function attemptGate(scope: AttemptScope, target: AttemptTarget, home: string, evidence: GateEvidence): GateOutcome {
  const state = floorState(scope.root, home);
  const enforced = state.kind !== 'dark';
  if (!enforced) return { kind: 'open', enforced: false };
  if (scope.incarnation === 'unknown') return { kind: 'blocked', why: 'the seat incarnation cannot be read, so a wake could not be told apart from an earlier one' };
  const attempts = attemptsOf(scope, home);
  if (attempts === null) return { kind: 'blocked', why: 'the wake attempts cannot be read' };
  let scroll: string | null | undefined;
  for (const attempt of attempts) {
    if (attempt.state !== 'emitted' && attempt.state !== 'uncertain') continue;
    if (evidence.settled(attempt.target.msg_id)) {
      writeState(scope, attempt, 'confirmed', home);
      continue;
    }
    if (scroll === undefined) scroll = evidence.scrollback?.() ?? null;
    if (scroll !== null && scroll.includes(tokenText(attempt.token))) {
      writeState(scope, attempt, 'confirmed', home);
      continue;
    }
    if (targets(target, attempt.target)) {
      return { kind: 'blocked', why: `blocked: wake uncertain (attempt ${String(attempt.n)})` };
    }
  }
  return { kind: 'open', enforced: true };
}

/** The token text embedded in a wake line, so scrollback can prove the line was typed. */
export function tokenText(token: string): string {
  return `[w:${token}]`;
}

export type AttemptHandle = {
  attempt: Attempt;
  /** Writes `emitted`; must succeed (durable) before the first key. */
  emit(): boolean;
  /** Settles the attempt from the wake's result: `confirmed` when it landed, `uncertain` when a key
   *  went out unconfirmed, nothing more when no key was sent (it stays `prepared`). */
  settle(result: { delivered: boolean; typed: boolean }): void;
};

/**
 * Prepares one attempt (state `prepared`, durable). Null when it cannot be made durable on an
 * enforcing root (fail closed: no wake). On a dark root the attempt is written in shadow and a
 * failure to write it changes nothing.
 */
export function prepareAttempt(scope: AttemptScope, target: AttemptTarget, home: string, enforced: boolean, faults?: DurableFaults): AttemptHandle | null {
  const existing = attemptsOf(scope, home);
  if (existing === null && enforced) return null;
  const n = (existing ?? []).reduce((max, a) => Math.max(max, a.n), 0) + 1;
  const attempt: Attempt = { n, state: 'prepared', target, token: randomBytes(2).toString('hex') };
  const prepared = writeState(scope, attempt, 'prepared', home, faults);
  if (prepared !== 'created' && enforced) return null;
  let emitted = false;
  return {
    attempt,
    emit: () => {
      if (emitted) return true;
      const made = writeState(scope, attempt, 'emitted', home, faults);
      emitted = made === 'created' || made === 'exists';
      return emitted || !enforced;
    },
    settle: (result) => {
      if (result.delivered) {
        writeState(scope, attempt, 'confirmed', home, faults);
      } else if (result.typed || emitted) {
        writeState(scope, attempt, 'uncertain', home, faults);
      }
    },
  };
}
