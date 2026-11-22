// A live subscription to the project's event bus: one socket held open on `.agents/bus.sock`,
// `follow: true`, so each event the bus routes to this seat arrives as it is appended instead of
// on the next read. The first answer is the backlog at the subscriber's cursor; a follower that
// only wants what happens after it connects passes `skipBacklog` and starts from the batch's
// cursor. A closed, refused or absent bus calls `onDown` once and the caller falls back to its
// own reading; nothing here retries on its own.
import { dialing, socketRuntime } from '../runtime/bun-socket.ts';
import type { EventKind } from './kinds.ts';
import type { SignedEventRecord } from './log.ts';
import { busSocket, encodeBusLine, MAX_BUS_ANSWER_BYTES, parseBusAnswer, type BusSubscribeRequest } from './server.ts';

export type BusFollow = {
  /** Ends the subscription. `onDown` is not called for a close the caller asked for. */
  close(): void;
};

export type FollowHandlers = {
  /** One routed event, in log order. */
  onEvent: (event: SignedEventRecord) => void;
  /** The subscription is live: the bus answered the backlog. */
  onUp?: () => void;
  /** The bus is absent, refused the subscriber, sent a gap or closed the socket. */
  onDown: (why: string) => void;
};

export function followBus(
  root: string,
  request: { seat: string; pane?: string; cursor?: number; kinds?: EventKind[]; skipBacklog?: boolean },
  handlers: FollowHandlers,
): BusFollow {
  const full: BusSubscribeRequest = {
    op: 'subscribe',
    seat: request.seat,
    ...(request.pane === undefined ? {} : { pane: request.pane }),
    cursor: request.cursor ?? 0,
    ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
    follow: true,
  };
  let closed = false;
  let down = false;
  let first = true;
  let buffer = '';
  let next: BusFollow | null = null;
  const fail = (why: string): void => {
    if (closed || down) return;
    down = true;
    conn.destroy();
    handlers.onDown(why);
  };
  const read = (chunk: string): void => {
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf('\n');
      if (at < 0) {
        if (buffer.length > MAX_BUS_ANSWER_BYTES) fail('the bus answer exceeded the maximum frame size');
        return;
      }
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const parsed = parseBusAnswer(line);
      if (!parsed) return fail('the bus answered something this build cannot read');
      if (!parsed.ok) return fail(parsed.message);
      if (parsed.kind === 'gap') {
        // A follower that skips its backlog asked for no history, so a backlog too long for one
        // answer (a long-lived team's log at cursor 0) is no missed event: it dials once more
        // from the bus's newest record. Without this a seat's server never came up on a live bus
        // and every push waited for the folder watch (2026-11-21: 63-98 ms instead of ~10 ms).
        if (first && request.skipBacklog === true && (request.cursor ?? 0) < parsed.newest_seq) {
          down = true;
          conn.destroy();
          if (!closed) next = followBus(root, { ...request, cursor: parsed.newest_seq }, handlers);
          return;
        }
        return fail('the bus no longer holds this cursor');
      }
      if (parsed.kind === 'events') {
        const backlog = first && request.skipBacklog === true;
        first = false;
        handlers.onUp?.();
        if (!backlog) for (const event of parsed.events) handlers.onEvent(event);
        continue;
      }
      if (parsed.kind === 'event') {
        handlers.onEvent(parsed.event);
        continue;
      }
      return fail('the bus answered something this build cannot read');
    }
  };
  const Bun = socketRuntime();
  const { conn, options, refused } = dialing(busSocket(root), { text: read, close: () => fail(BUS_ABSENT) });
  // Queued until the connection opens.
  conn.write(encodeBusLine(full));
  Bun.connect(options).catch(refused);
  return {
    close: () => {
      closed = true;
      conn.destroy();
      next?.close();
    },
  };
}

export const BUS_ABSENT = 'the event bus is not running or closed the subscription';

/** The first wait before a dropped follower dials the bus again, and the longest. */
export const FOLLOW_RETRY_MIN_MS = 250;
export const FOLLOW_RETRY_MAX_MS = 10_000;

/**
 * A follower that comes back: when the bus is absent or drops the subscription, `onDown` is
 * called (the caller falls back to its own reading), and the bus is dialled again after a wait
 * that doubles from `minMs` up to `maxMs`. A subscription that the bus answers resets the wait
 * and calls `onUp`, so a seat returns from polling to events without restarting. Each new
 * subscription skips its backlog when the request asks, so a reconnect never replays old events;
 * the caller's own safety read covers what arrived while it was down.
 */
export function followBusRetrying(
  root: string,
  request: Parameters<typeof followBus>[1],
  handlers: FollowHandlers,
  options: { minMs?: number; maxMs?: number; follow?: typeof followBus } = {},
): BusFollow {
  const minMs = options.minMs ?? FOLLOW_RETRY_MIN_MS;
  const maxMs = options.maxMs ?? FOLLOW_RETRY_MAX_MS;
  const follow = options.follow ?? followBus;
  let wait = minMs;
  let stopped = false;
  let current: BusFollow | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wasUp = false;
  const dial = (): void => {
    timer = null;
    if (stopped) return;
    current = follow(root, request, {
      onEvent: handlers.onEvent,
      onUp: () => {
        wait = minMs;
        wasUp = true;
        handlers.onUp?.();
      },
      onDown: (why) => {
        current = null;
        if (stopped) return;
        if (wasUp) {
          wasUp = false;
          handlers.onDown(why);
        }
        timer = setTimeout(dial, wait);
        wait = Math.min(maxMs, wait * 2);
      },
    });
  };
  dial();
  return {
    close: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      current?.close();
      current = null;
    },
  };
}

/** Whether a bus answers on this checkout's socket: a connection that opens within `ms`. A
 *  socket file left by a bus that died refuses the connection, so it reads as no bus. */
export function busAnswers(root: string, ms = 300): Promise<boolean> {
  return new Promise((done) => {
    let settled = false;
    const finish = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      done(answer);
    };
    const Bun = socketRuntime();
    const { conn, options, refused } = dialing(busSocket(root), { open: () => finish(true), close: () => finish(false) });
    const timer = setTimeout(() => finish(false), ms);
    Bun.connect(options).catch(refused);
  });
}
