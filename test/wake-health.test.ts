// Each seat's row in `team status` says when a message last reached it, and flags a seat whose
// last send ended undelivered with no proof since. The reading comes from the project's message
// history, read once for the table.
import { expect, test } from 'bun:test';
import { wakeCell, wakeEvidenceOf, wakeHealthOf, type SeatWake } from '../src/status/wake.ts';

const NOW = new Date('2026-11-15T09:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

test('the outcomes that prove a seat was reached, and those that say it was not', () => {
  for (const outcome of ['delivered', 'delivered (read)', 'delivered (typed wake)', 'delivered (late)', 'answered']) expect(wakeEvidenceOf(outcome)).toBe('proven');
  for (const outcome of ['not delivered', 'unreachable', 'wake not taken']) expect(wakeEvidenceOf(outcome)).toBe('failed');
  for (const outcome of ['held', 'sent (unconfirmed)', 'awaiting receipt', 'delivered-but-blocked']) expect(wakeEvidenceOf(outcome)).toBeNull();
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

test('the status cell names the failure and the last time the seat was reached', () => {
  const wake: SeatWake = {
    class: 'pull-on-turn', wakeable: false, conversation: false, endpoint: false, listener: false,
    unread: 1, oldest_unread_seconds: 2640, last_wake_seconds: 7200, wake_failed_seconds: 2640,
  };
  expect(wakeCell(wake)).toBe('!pull-on-turn (unread 44m, last send not delivered 44m ago, last reached 2h ago)');
});
