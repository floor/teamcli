// A seat.status reason is quoted. A seat id reads `<seat> reported "<reason>"`. A name that
// is not a seat id reads `a seat reported "<reason>"`. The same words are the reader's note
// and the lead's line. The reason is kept to 200 characters, and [cut] stands outside the
// quotes. DEL, C1, the line separators and a bidi control are escaped inside the quotes.
import { expect, test } from 'bun:test';
import { ownerDeliveryText } from '../src/bus/owner.ts';
import type { EventPayload } from '../src/bus/log.ts';
import { statusEventNote } from '../src/commands/trace.ts';
import { reportedBySeat } from '../src/status/reported-reason.ts';

const SEAT = 'seat-one';

function status(seat: string, reason: string): EventPayload {
  return {
    v: 1,
    seq: 1,
    ts: '2026-11-06T20:00:00.000Z',
    kind: 'seat.status',
    session: 'sandbox',
    record_id: 'status:seat-one:prs_0123456789ab:1',
    seat,
    status_reason: reason,
    status_binding: 'prs_0123456789ab',
    status_seq: 1,
    status_source: 'runtime-hook',
    status_availability: 'correlation-unproven',
    status_advisory: 'unknown',
    status_continuity: 'unproven',
    status_gate: 'unknown',
    status_process_confirmation: 'needed',
  };
}

function labelled(seat: string | undefined, quoted: string, cut = false): string {
  const who = seat === undefined ? 'a seat' : seat;
  return `${who} reported "${quoted}"${cut ? ' [cut]' : ''}`;
}

test('a seat id is named and the reason is quoted', () => {
  expect(reportedBySeat(SEAT, 'kept')).toBe(labelled(SEAT, 'kept'));
});

test('a name that is not a seat id is left out of the label', () => {
  for (const name of ['not a seat', '../seat', '']) {
    const said = reportedBySeat(name, 'kept');
    expect(said).toBe(labelled(undefined, 'kept'));
    if (name !== '') expect(said).not.toContain(name);
  }
});

test('a reason stays whole at 200 characters and is cut after that', () => {
  const whole = 'a'.repeat(200);
  expect(reportedBySeat(SEAT, whole)).toBe(labelled(SEAT, whole));
  const over = 'b'.repeat(201);
  expect(reportedBySeat(SEAT, over)).toBe(labelled(SEAT, 'b'.repeat(200), true));
  expect(reportedBySeat(SEAT, over)).not.toContain('b'.repeat(201));
});

test('DEL, C1, line separators and a bidi control are escaped inside the quotes', () => {
  const raw = 'a\u007f\u009b\u2028\u2029\u202eb';
  const said = reportedBySeat(SEAT, raw);
  expect(said).toBe(labelled(SEAT, 'a\\u007f\\u009b\\u2028\\u2029\\u202eb'));
  for (const mark of ['\u007f', '\u009b', '\u2028', '\u2029', '\u202e']) expect(said).not.toContain(mark);
});

test('the reader note and the lead line use the same reported reason', () => {
  const reason = 'a\u007f\u202eb';
  const event = status(SEAT, reason);
  const said = reportedBySeat(SEAT, reason);
  expect(statusEventNote(event)).toBe(said);
  expect(ownerDeliveryText(event)).toBe(said);
});
