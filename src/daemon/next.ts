// The machine daemon's `next` boundary: a request names one hosted checkout, an action and the
// caller's claimed (seat, pane); this handler proves that claim against the checkout's recorded
// state, applies the same pause and queued-swap gates `team next` applies, serves a file or local
// source itself, and proxies a tracker source to the checkout's broker with that same claim. It
// prints nothing: the host frames the answer and the caller decides how to say it.
//
// The check is the broker's own S2 reuse — `callerVerdict` against `standingOf` — and it carries
// the same limit the broker documents: integrity against a mistaken agent, not authenticity
// against a hostile one. The host must not call this on a bare frame; a verified principal
// binding is a later layer, and until it lands the protocol keeps refusing every `next` request.
//
// Broker hosting stays off. A tracker source is served only through an injected `askBroker`
// proxy (the checkout's own socket, which re-checks the same claim); with no proxy this handler
// refuses and claims nothing, because the daemon has no tracker reader of its own.
import { join } from 'node:path';
import { DEADLINE, NOT_RUNNING, WRONG_ANSWER, type BrokerOutcome } from '../broker/client.ts';
import type { BrokerRequest } from '../broker/protocol.ts';
import { anotherPaneRefusal, callerVerdict, noPaneRefusal, standingOf, type Caller } from '../caller.ts';
import type { TeamFile } from '../file/types.ts';
import { plainText } from '../launch/plain.ts';
import { pauseText, readState, type State } from '../state.ts';
import { queuedSwap, swapLine } from '../swap/queue.ts';
import type { TaskAdapter, TaskRead, TaskRecord } from '../tasks/adapter.ts';
import { fileRegistry } from '../tasks/file.ts';
import { claimLocal, releaseLocal } from '../tasks/lease.ts';
import { fileSourceOf, LOCAL_TASKS, readFileSource } from '../tasks/queue.ts';
import { order, takeable } from '../tasks/select.ts';
import type { HostedRoute } from './routes.ts';

/** The caller's claim, exactly what a request carries. It is checked against the route's state
 *  before any effect; it is never evidence of who the caller is. */
export type NextClaim = { seat: string; pane: string };

export type NextAction = 'claim' | 'release';

/** The exit ids `team next` already prints. The handler reuses them, so a proxied answer maps
 *  onto the command's own printers and no new contract row is needed. */
export type NextRefusalCode =
  | 'next.caller'
  | 'next.paused'
  | 'next.swap'
  | 'next.file'
  | 'next.missing'
  | 'next.shape'
  | 'next.broker'
  | 'next.read';

type NextAnswerBody =
  | { ok: true; kind: 'claimed'; record: TaskRecord }
  | { ok: true; kind: 'released'; id: string }
  | { ok: true; kind: 'none'; why: 'nothing-takeable' | 'nothing-assigned' | 'nothing-held' }
  | { ok: false; code: NextRefusalCode; message: string; hint?: string };

/** `notice` is the broker's read notice, when it sent one; the caller prints it beside the
 *  answer exactly as the direct broker path does. */
export type NextAnswer = NextAnswerBody & { notice?: string };

export type NextHandlerInput = {
  /** The route `resolveScope` picked. Its root is canonical and its team/session are the
   *  loaded file's own; the handler re-checks the file it is given against both. */
  route: HostedRoute;
  /** The team file the host loaded for this route. */
  team: TeamFile;
  caller: NextClaim;
  action: NextAction;
  mine: boolean;
  /** The host's clock, not a request field: a caller must not choose the instant a lease is
   *  judged at. */
  now: number;
};

export type NextHandlerDeps = {
  /** The file adapter registry, injectable the way `team next` injects it. */
  registry?: Record<string, TaskAdapter>;
  /** The checkout's broker client — the only way a tracker source is read from here. Absent
   *  means no tracker reader: the request refuses and claims nothing. */
  askBroker?: (root: string, request: BrokerRequest, options?: { deadlineMs?: number }) => Promise<BrokerOutcome>;
  /** Injected for a test that must not wait out the client's own deadline. */
  deadlineMs?: number;
};

/**
 * Answers one `next` request against one hosted route. Every refusal happens before any write;
 * a claim writes only the caller's local lease, and only after the claim, the pause, the swap
 * and the source read all passed.
 */
export async function handleNext(input: NextHandlerInput, deps: NextHandlerDeps = {}): Promise<NextAnswer> {
  const { route, team, caller, now } = input;
  if (team.project !== route.team || team.session !== route.session) {
    return refuse('next.file', 'the hosted route and its team file disagree; nothing is claimed');
  }
  if (!team.seats.some((seat) => seat.name === caller.seat)) {
    return refuse('next.caller', `only a declared seat of this team pulls a task; "${caller.seat}" is not one`);
  }
  // The command reads the state before it judges the caller, and `--release` skips the read
  // entirely: releasing is how a paused or waiting seat lets go. The same order stands here.
  let state: State | undefined;
  if (input.action === 'claim') {
    try {
      state = readState(join(route.root, '.agents'));
    } catch (error) {
      return refuse('next.file', plainText(error instanceof Error ? error.message : String(error)));
    }
    if (state.pause !== undefined) {
      return refuse(
        'next.paused',
        `the team is paused (${pauseText(state.pause)}); nothing new is claimed until \`team resume\``,
        'team resume',
      );
    }
  }
  const judged: Caller = { kind: 'seat', name: caller.seat, pane: caller.pane, session: route.session };
  const verdict = callerVerdict(judged, caller.seat, standingOf(join(route.root, '.agents'), route.session, judged));
  if (verdict.kind === 'no-pane') return refuse('next.caller', noPaneRefusal(verdict.name));
  if (verdict.kind === 'another-pane') return refuse('next.caller', anotherPaneRefusal(verdict.name, verdict.recordedPane));
  if (verdict.kind !== 'ok') {
    return refuse('next.caller', `only a declared seat of this team on its recorded pane pulls a task; this claim is not ${caller.seat}`);
  }
  if (state !== undefined) {
    const waiting = queuedSwap(state, caller.seat);
    if (waiting !== null) {
      return refuse(
        'next.swap',
        `${caller.seat} waits on a swap: ${swapLine(caller.seat, waiting, new Date(now))}; nothing new is claimed until it runs or \`team swap cancel ${caller.seat}\``,
        `team swap cancel ${caller.seat}`,
      );
    }
  }
  const tasks = team.tasks ?? LOCAL_TASKS;
  if (tasks.source === 'linear') return nextFromBroker(input, tasks, deps);
  const registry = deps.registry ?? fileRegistry;
  const adapter = registry[tasks.source];
  if (!adapter) return refuse('next.file', 'tasks.source must be file');
  if (input.action === 'release') {
    const result = adapter.release
      ? adapter.release({ root: route.root, seat: caller.seat, pane: caller.pane, now })
      : releaseLocal(route.root, caller.seat, caller.pane, now);
    if (result.kind === 'released') return { ok: true, kind: 'released', id: result.id };
    return { ok: true, kind: 'none', why: 'nothing-held' };
  }
  const source = fileSourceOf(team);
  const read = source !== null && source.local
    ? readFileSource(route.root, source)
    : adapter.read({ root: route.root, path: tasks.path });
  if (read.kind === 'missing') return refuse('next.missing', 'the task file is not there');
  if (read.kind === 'outside') return refuse('next.file', 'tasks.path must stay inside the checkout');
  if (read.kind === 'not-a-list') return refuse('next.shape', 'the task file is not a list');
  const claimFn = adapter.claim;
  const claim = claimFn === undefined
    ? undefined
    : (record: TaskRecord) =>
        claimFn({ root: route.root, path: tasks.path, record, seat: caller.seat, pane: caller.pane, now }).kind === 'held';
  return take(input, tasks, read, claim);
}

/**
 * The tracker source: the same proxy request the seat would send, made with the claim this
 * handler has just verified. The broker checks the claim again, and its answer maps onto the
 * direct path's outcomes line for line.
 */
async function nextFromBroker(
  input: NextHandlerInput,
  tasks: NonNullable<TeamFile['tasks']>,
  deps: NextHandlerDeps,
): Promise<NextAnswer> {
  const { route, caller, now } = input;
  if (input.action === 'release') {
    // The tracker holds no claim: the lease is local, and releasing it never reaches the broker.
    const result = releaseLocal(route.root, caller.seat, caller.pane, now);
    if (result.kind === 'released') return { ok: true, kind: 'released', id: result.id };
    return { ok: true, kind: 'none', why: 'nothing-held' };
  }
  const ask = deps.askBroker;
  if (ask === undefined) {
    return refuse('next.broker', 'this daemon has no tracker reader for the checkout; nothing is claimed');
  }
  const options = deps.deadlineMs === undefined ? {} : { deadlineMs: deps.deadlineMs };
  const outcome = await ask(route.root, { op: 'read', seat: caller.seat, pane: caller.pane }, options);
  if (outcome.kind === 'unavailable') return refuse('next.broker', NOT_RUNNING);
  if (outcome.kind === 'wrong') return refuse('next.broker', WRONG_ANSWER);
  if (outcome.kind === 'deadline') return refuse('next.broker', DEADLINE);
  if (outcome.kind === 'refused') {
    if (outcome.at === 'caller') return refuse('next.caller', outcome.message);
    return refuse('next.read', outcome.message);
  }
  // This build's broker answers records for a tracker source; any other read kind is an answer
  // the caller fails safe on, exactly like an unparseable line.
  if (outcome.read.kind !== 'records') return refuse('next.broker', WRONG_ANSWER);
  const answer = take(input, tasks, outcome.read, undefined);
  return outcome.notice === undefined ? answer : { ...answer, notice: outcome.notice };
}

/**
 * The take itself, identical for both sources once a read exists: order the takeable records,
 * claim one — through the adapter when it carries a tracker-side claim, through the local lease
 * otherwise — and answer. A refused record set that held nothing is the shape refusal, the same
 * way the command prints it.
 */
function take(
  input: NextHandlerInput,
  tasks: NonNullable<TeamFile['tasks']>,
  read: Extract<TaskRead, { kind: 'records' }>,
  claim: ((record: TaskRecord) => boolean) | undefined,
): NextAnswer {
  const { route, caller, now } = input;
  const known = new Map(read.records.map((record) => [record.id, record]));
  const candidates = order(takeable(read.records, caller.seat, tasks.pull ?? 'self', input.mine), tasks.fallback ?? 'file');
  let outcome: { kind: 'held'; record: TaskRecord } | { kind: 'none' } | { kind: 'kept' };
  if (claim) {
    let held: TaskRecord | undefined;
    for (const record of candidates) {
      if (claim(record)) {
        held = record;
        break;
      }
    }
    outcome = held ? { kind: 'held', record: held } : { kind: 'none' };
  } else {
    outcome = claimLocal(route.root, { now, seat: caller.seat, pane: caller.pane, known, candidates });
  }
  if (outcome.kind === 'held') return { ok: true, kind: 'claimed', record: outcome.record };
  if (read.refusals.length) {
    const lines = read.refusals.map((refusal) => `${refusal.id ?? `record ${refusal.index}`} is not a task: ${refusal.reason}`);
    return refuse('next.shape', lines.join('; '));
  }
  return { ok: true, kind: 'none', why: input.mine ? 'nothing-assigned' : 'nothing-takeable' };
}

function refuse(code: NextRefusalCode, message: string, hint?: string): NextAnswer {
  return { ok: false, code, message, ...(hint === undefined ? {} : { hint }) };
}
