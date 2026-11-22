// The seat's half of the broker boundary: one request line, one answer line, a deadline. This
// module holds no credential and imports no keychain, no network wiring and no child process —
// the module-source scan the release slice's tests already carry is pinned for it. It runs after
// the S2 gate, where the seat and pane exist, and answers in outcomes the command maps to its
// exits; nothing here claims anything.
import { connect } from 'node:net';
import type { TaskRead } from '../tasks/adapter.ts';
import { MAX_ANSWER_BYTES, brokerSocket, encodeLine, parseAnswer, type BrokerRequest } from './protocol.ts';
import { hostedCommit } from '../host/request-scope.ts';

/** The `TIMEOUT_MS = 5000` shape from the release check's wiring: a hung broker must not hang
 *  the seat. */
export const BROKER_DEADLINE_MS = 5000;

/** No broker answered — nothing listening, or a stale file left by an unclean stop. */
export const NOT_RUNNING = 'the broker is not running; the owner starts it with `team broker`';

/** An answer this build does not know — a stale broker process, or a broken connection. Fails
 *  safe: refused, nonzero, nothing claimed. */
export const WRONG_ANSWER = "the broker's answer is not one this build knows; the owner restarts it";

/** The deadline fired: the broker accepted the request and did not answer in time. */
export const DEADLINE = 'the broker accepted the request and did not answer; nothing is claimed';

export type BrokerOutcome =
  | { kind: 'read'; read: TaskRead; notice?: string }
  | { kind: 'refused'; at: 'caller' | 'read'; message: string }
  | { kind: 'unavailable' }
  | { kind: 'wrong' }
  | { kind: 'deadline' };

/** One request on the clone's socket. The first answer line wins; a connection that ends or
 *  breaks before one — and an answer past the cap — is `wrong`, the same fail-safe. */
export function askBroker(root: string, request: BrokerRequest, options: { deadlineMs?: number } = {}): Promise<BrokerOutcome> {
  const deadlineMs = options.deadlineMs ?? BROKER_DEADLINE_MS;
  return new Promise((done) => {
    let settled = false;
    let connected = false;
    let buffer = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    hostedCommit('node:net.connect');
    const socket = connect(brokerSocket(root));
    const finish = (outcome: BrokerOutcome) => {
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
      socket.write(encodeLine(request));
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at < 0) {
        if (buffer.length > MAX_ANSWER_BYTES) finish({ kind: 'wrong' });
        return;
      }
      const value = parseAnswer(buffer.slice(0, at));
      if (!value) {
        finish({ kind: 'wrong' });
        return;
      }
      if (!value.ok) {
        finish({ kind: 'refused', at: value.at, message: value.message });
        return;
      }
      finish(value.notice === undefined ? { kind: 'read', read: value.read } : { kind: 'read', read: value.read, notice: value.notice });
    });
    // A connection that never came up is the no-broker case; one that broke after connecting is
    // the fail-safe one — the broker was there and stopped answering.
    socket.once('error', () => finish(connected ? { kind: 'wrong' } : { kind: 'unavailable' }));
    socket.on('close', () => finish(connected ? { kind: 'wrong' } : { kind: 'unavailable' }));
  });
}
