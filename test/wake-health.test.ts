// Each seat's row in `team status` says when a message last reached it, and flags a seat whose
// last send ended undelivered with no proof since. The reading comes from the project's message
// history, read once for the table.
import { expect, test } from 'bun:test';
import { wakeCell, wakeEvidenceOf, wakeHealthOf, type SeatWake } from '../src/status/wake.ts';

const NOW = new Date('2026-11-15T09:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

test('the outcomes that prove a seat was reached, and those that say it was not', () => {
  for (const outcome of ['delivered', 'delivered (read)', 'delivered (typed wake)', 'delivered (late)', 'answered']) expect(wakeEvidenceOf(outcome)).toBe('proven');
  for (const outcome of ['not delivered', 'unreachable', 'wake not taken', 'queued, not woken', 'not-submitted']) expect(wakeEvidenceOf(outcome)).toBe('failed');
  for (const outcome of ['held', 'sent (unconfirmed)', 'awaiting receipt', 'delivered-but-blocked', 'timeout']) expect(wakeEvidenceOf(outcome)).toBeNull();
  // A reply wait that timed out after a live leg delivered the message is proof it got there;
  // after the stored inbox alone it is not.
  expect(wakeEvidenceOf('timeout', 'typed')).toBe('proven');
  expect(wakeEvidenceOf('timeout', 'socket')).toBe('proven');
  expect(wakeEvidenceOf('timeout', 'drop')).toBeNull();
  expect(wakeEvidenceOf('timeout', 'mcp-inbox')).toBeNull();
});

test('a failure after the last proof is flagged; a proof after it clears the flag', () => {
  const history = [
    { ts: at(120), to: 'reviewer', outcome: 'delivered (typed wake)' },
    { ts: at(44), to: 'reviewer', outcome: 'not delivered' },
    { ts: at(5), to: 'other', outcome: 'delivered' },
  ];
  expect(wakeHealthOf(history, 'reviewer', NOW)).toEqual({ last_wake_seconds: 7200, wake_failed_seconds: 2640 });
  expect(wakeHealthOf([...history, { ts: at(3), to: 'reviewer', outcome: 'delivered (read)' }], 'reviewer', NOW)).toEqual({ last_wake_seconds: 180 });
  expect(wakeHealthOf(history, 'nobody', NOW)).toEqual({});
});

test('a receipt promoted late for an older message does not clear a newer failure', () => {
  const history = [
    { ts: at(90), to: 'reviewer', outcome: 'not delivered', id: 'old' },
    { ts: at(40), to: 'reviewer', outcome: 'not delivered', id: 'new' },
    // The watch noticed the old message's receipt only now: it proves the old one, not the new.
    { ts: at(2), to: 'reviewer', outcome: 'delivered (read)', id: 'old' },
  ];
  expect(wakeHealthOf(history, 'reviewer', NOW)).toEqual({ last_wake_seconds: 120, wake_failed_seconds: 2400 });
  // The newer message read: the failure is answered.
  expect(wakeHealthOf([...history, { ts: at(1), to: 'reviewer', outcome: 'delivered (read)', id: 'new' }], 'reviewer', NOW)).toEqual({ last_wake_seconds: 60 });
});

test('a send that waited for a reply and timed out after a typed delivery clears an earlier failure', () => {
  const history = [
    { ts: at(30), to: 'reviewer', outcome: 'not delivered', id: 'a' },
    { ts: at(10), to: 'reviewer', outcome: 'timeout', id: 'b', via: 'typed' },
  ];
  expect(wakeHealthOf(history, 'reviewer', NOW)).toEqual({ last_wake_seconds: 600 });
});

test('the status cell names the failure and the last time the seat was reached', () => {
  const wake: SeatWake = {
    class: 'pull-on-turn', wakeable: false, conversation: false, endpoint: false, listener: false,
    unread: 1, oldest_unread_seconds: 2640, last_wake_seconds: 7200, wake_failed_seconds: 2640,
  };
  expect(wakeCell(wake)).toBe('!pull-on-turn (unread 44m, last send not delivered 44m ago, last reached 2h ago)');
});
