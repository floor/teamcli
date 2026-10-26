// A live subscription to the project's event bus: one socket held open on `.agents/bus.sock`,
// `follow: true`, so each event the bus routes to this seat arrives as it is appended instead of
// on the next read. The first answer is the backlog at the subscriber's cursor; a follower that
// only wants what happens after it connects passes `skipBacklog` and starts from the batch's
// cursor. A closed, refused or absent bus calls `onDown` once and the caller falls back to its
// own reading; nothing here retries on its own.
import { connect, type Socket } from 'node:net';
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
  const socket: Socket = connect(busSocket(root));
  const fail = (why: string): void => {
    if (closed || down) return;
    down = true;
    socket.destroy();
    handlers.onDown(why);
  };
  socket.setEncoding('utf8');
  socket.once('connect', () => socket.write(encodeBusLine(full)));
  socket.on('data', (chunk: string) => {
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
      if (parsed.kind === 'gap') return fail('the bus no longer holds this cursor');
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
  });
  socket.once('error', () => fail(BUS_ABSENT));
  socket.on('close', () => fail(BUS_ABSENT));
  return {
    close: () => {
      closed = true;
      socket.destroy();
    },
  };
}

export const BUS_ABSENT = 'the event bus is not running or closed the subscription';
