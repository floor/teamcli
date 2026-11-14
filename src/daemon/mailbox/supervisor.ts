import { traceBeatWork } from '../../diagnostics/beat-work.ts';
// One mailbox router for every root. The daemon's beat nudges it and reads its heartbeat.
// The beat never waits on an ask, a reply, or the child: a child that leaves is recorded
// late, and a later beat starts the replacement after a capped backoff.
//
// A heartbeat is the answer to a tick, and the child is only ever asked on a beat. So a child
// is behind when ticks it was sent go unanswered, never when the daemon's own beat comes late:
// a daemon whose beat is delayed (a loaded machine, a long scan elsewhere in the process) sent
// no tick in that gap, and the child had nothing to answer.
import type { MailboxAskResult } from './ask.ts';

/** How the router is doing, for the daemon's status row. */
export type MailboxRouterState = {
  state: 'starting' | 'ok' | 'late' | 'restarting' | 'stopped';
  pid: number | null;
  heartbeatAt: string | null;
  restarts: number;
  why: string | null;
  /** The last ask the child finished: the seat it wrote to, whether the wake was taken, and
   *  whether a verified reply came back. */
  lastAsk: { seat: string | null; wakeTaken: boolean; replyVerified: boolean } | null;
};

export type MailboxHostMessage = { type: 'tick'; at: string };

export type MailboxChildMessage =
  | { type: 'heartbeat'; at: string }
  | { type: 'ask-result'; result: Pick<MailboxAskResult, 'seat' | 'wakeTaken' | 'replyVerified'> };

export type MailboxChildEvent =
  | { kind: 'message'; message: MailboxChildMessage }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null };

/** The daemon's handle on the one child. A beat to a child that has left must not write. */
export type MailboxChild = {
  pid: number | null;
  readonly alive: boolean;
  send(message: MailboxHostMessage): boolean;
  subscribe(listener: (event: MailboxChildEvent) => void): () => void;
  kill(why: string): void;
  readonly exited: Promise<void>;
};

export type MailboxRouterInput = {
  /** The daemon's heartbeat interval. Silence is counted in these beats. */
  beatMs: number;
  now: () => Date;
  log: (text: string) => void;
  /** Starts the child. A test supplies a fixture; the beat does not wait for it. */
  factory: () => MailboxChild;
  /** Ticks a live child may leave unanswered before it is ended. The oldest of them must also
   *  be at least this many beat intervals old, so a burst of beats cannot end a child that has
   *  not had the time to answer. */
  missedBeats?: number;
  /** The longest restart wait. */
  backoffCapMs?: number;
};

export type MailboxRouter = {
  /** One daemon beat. Returns at once. */
  tick(at: Date): void;
  state(): MailboxRouterState;
  /** Answers while the child is down. The probe does not ask the child. */
  health(): { ok: true };
  stop(why: string): Promise<void>;
};

const DEFAULT_MISSED_BEATS = 2;
const DEFAULT_BACKOFF_CAP_MS = 30_000;

type Held = {
  child: MailboxChild | null;
  unsubscribe: (() => void) | null;
  heartbeatAt: string | null;
  /** Ticks sent since the child's last heartbeat, and when the oldest of them was sent. */
  unanswered: number;
  firstUnansweredMs: number | null;
  ready: boolean;
  startedOnce: boolean;
  killing: boolean;
  restarts: number;
  backoff: number;
  beats: number;
  nextStartAtMs: number;
  why: string | null;
  stopping: boolean;
  lastAsk: MailboxRouterState['lastAsk'];
};

function waitMs(backoff: number, cap: number): number {
  return Math.min(cap, 1000 * 2 ** (backoff - 1));
}

export function createMailboxRouter(input: MailboxRouterInput): MailboxRouter {
  const missedBeats = input.missedBeats ?? DEFAULT_MISSED_BEATS;
  const backoffCapMs = input.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const held: Held = {
    child: null,
    unsubscribe: null,
    heartbeatAt: null,
    unanswered: 0,
    firstUnansweredMs: null,
    ready: false,
    startedOnce: false,
    killing: false,
    restarts: 0,
    backoff: 0,
    beats: 0,
    nextStartAtMs: 0,
    why: null,
    stopping: false,
    lastAsk: null,
  };

  const start = (at: Date): void => {
    let child: MailboxChild;
    try {
      child = input.factory();
    } catch (error) {
      held.startedOnce = true;
      held.restarts += 1;
      held.backoff += 1;
      const wait = waitMs(held.backoff, backoffCapMs);
      held.nextStartAtMs = at.getTime() + wait;
      held.why = `the child could not be started: ${error instanceof Error ? error.message : String(error)}`;
      input.log(`mailbox router: ${held.why}; starting again in ${String(wait)} ms`);
      return;
    }
    held.child = child;
    held.heartbeatAt = null;
    held.unanswered = 0;
    held.firstUnansweredMs = null;
    held.ready = false;
    held.killing = false;
    held.beats = 0;
    held.startedOnce = true;
    held.why = null;
    held.unsubscribe = child.subscribe((event) => traceBeatWork('mail child handling (sync)', () => {
      if (event.kind === 'exit') {
        if (held.child !== child) return;
        held.child = null;
        held.unsubscribe?.();
        held.unsubscribe = null;
        held.ready = false;
        held.killing = false;
        held.heartbeatAt = null;
        held.unanswered = 0;
        held.firstUnansweredMs = null;
        if (held.stopping) {
          held.why = held.why ?? 'the daemon is stopping this child';
          return;
        }
        held.restarts += 1;
        held.backoff += 1;
        const wait = waitMs(held.backoff, backoffCapMs);
        held.nextStartAtMs = input.now().getTime() + wait;
        const reason = event.signal !== null
          ? `was ended by ${event.signal}`
          : event.code === null
            ? 'left without an exit code'
            : `exited with code ${String(event.code)}`;
        held.why = `the child ${reason}`;
        input.log(`mailbox router: the child ${reason}; starting a replacement in ${String(wait)} ms`);
        return;
      }
      if (held.child !== child) return;
      if (event.message.type === 'heartbeat') {
        held.heartbeatAt = event.message.at;
        held.unanswered = 0;
        held.firstUnansweredMs = null;
        held.ready = true;
        held.beats += 1;
        held.why = null;
        if (held.beats >= 2) held.backoff = 0;
        return;
      }
      held.lastAsk = {
        seat: event.message.result.seat,
        wakeTaken: event.message.result.wakeTaken,
        replyVerified: event.message.result.replyVerified,
      };
    }));
  };

  return {
    tick(at: Date): void {
      if (held.stopping) return;
      const ms = at.getTime();
      const child = held.child;
      if (child === null) {
        if (ms < held.nextStartAtMs) return;
        start(at);
        return;
      }
      if (held.killing || !child.alive) return;
      const behind = held.unanswered >= missedBeats
        && held.firstUnansweredMs !== null
        && ms - held.firstUnansweredMs >= missedBeats * input.beatMs;
      if (!behind) {
        child.send({ type: 'tick', at: at.toISOString() });
        if (held.unanswered === 0) held.firstUnansweredMs = ms;
        held.unanswered += 1;
        return;
      }
      held.killing = true;
      held.why = `the child missed ${String(missedBeats)} heartbeats`;
      input.log(`mailbox router: ${held.why}; ending it and starting a replacement`);
      child.kill(held.why);
    },
    state(): MailboxRouterState {
      // One tick outstanding is the ordinary wait between a beat and its answer; a second is late.
      const missed = held.child === null || !held.ready ? 0 : Math.max(0, held.unanswered - 1);
      const state: MailboxRouterState['state'] = held.stopping
        ? 'stopped'
        : held.child === null
          ? (held.startedOnce ? 'late' : 'starting')
          : held.killing || missed > 0
            ? 'late'
            : held.ready
              ? 'ok'
              : 'starting';
      return {
        state,
        pid: held.child?.pid ?? null,
        heartbeatAt: held.heartbeatAt,
        restarts: held.restarts,
        why: held.why,
        lastAsk: held.lastAsk,
      };
    },
    health(): { ok: true } {
      return { ok: true };
    },
    async stop(why: string): Promise<void> {
      held.stopping = true;
      held.why = why;
      const child = held.child;
      if (child === null) return;
      child.kill(why);
      await child.exited;
    },
  };
}
