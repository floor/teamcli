// The reminder schedule, driven with instants and a named zone so the machine's own clock never
// decides a case: every scene below passes an explicit UTC `now` and reads the wall-clock key the
// decision names. Europe/Paris is the zone the owner's reminders run in, and its two transition
// days are the ones the design calls out.
import { describe, expect, test } from 'bun:test';
import {
  CLOCK_BACK_MS,
  decideDue,
  instantsOf,
  latestDue,
  nextDueAfter,
  wallKey,
  type ReminderStored,
} from '../src/reminder/schedule.ts';

const ZONE = 'Europe/Paris';
const HOUR = 3_600_000;

/** A stored entry from a key and its UTC instant. */
function stored(key: string, instant: string): ReminderStored {
  return { key, instant: Date.parse(instant) };
}

describe('the reminder schedule', () => {
  test('a tick just after the due instant fires for it, with the half-gap window', () => {
    const decision = decideDue({
      at: ['07:00', '19:00'],
      now: new Date('2026-11-02T18:00:02.000Z'),
      zone: ZONE,
      stored: stored('2026-11-02T07:00', '2026-11-02T06:00:00.000Z'),
    });
    expect(decision).toEqual({
      kind: 'fire',
      due: { key: '2026-11-02T19:00', instant: Date.parse('2026-11-02T18:00:00.000Z') },
      lateMs: 2_000,
      windowMs: 6 * HOUR,
    });
  });

  test('a stored key at or past the latest due instant does nothing', () => {
    const decision = decideDue({
      at: ['07:00', '19:00'],
      now: new Date('2026-11-02T18:00:30.000Z'),
      zone: ZONE,
      stored: stored('2026-11-02T19:00', '2026-11-02T18:00:00.000Z'),
    });
    expect(decision).toEqual({ kind: 'none' });
  });

  test('a first run remembers the latest instant without firing', () => {
    const decision = decideDue({
      at: ['07:00', '19:00'],
      now: new Date('2026-11-02T20:00:00.000Z'),
      zone: ZONE,
      stored: null,
    });
    expect(decision).toEqual({
      kind: 'first-run',
      due: { key: '2026-11-02T19:00', instant: Date.parse('2026-11-02T18:00:00.000Z') },
    });
  });

  test('an instant past its window is recorded and not sent', () => {
    const decision = decideDue({
      at: ['07:00'],
      now: new Date('2026-11-02T20:00:00.000Z'),
      zone: ZONE,
      stored: stored('2026-11-01T07:00', '2026-11-01T06:00:00.000Z'),
    });
    expect(decision).toEqual({
      kind: 'missed',
      due: { key: '2026-11-02T07:00', instant: Date.parse('2026-11-02T06:00:00.000Z') },
      lateMs: 14 * HOUR,
      windowMs: 6 * HOUR,
    });
  });

  test('the window is half the gap to the next instant, capped at six hours', () => {
    const before = decideDue({
      at: ['08:00'],
      now: new Date('2026-11-02T12:59:59.000Z'),
      zone: ZONE,
      stored: stored('2026-11-01T08:00', '2026-11-01T07:00:00.000Z'),
    });
    expect(before.kind).toBe('fire');
    if (before.kind !== 'fire') return;
    expect(before.windowMs).toBe(6 * HOUR);

    const after = decideDue({
      at: ['08:00'],
      now: new Date('2026-11-02T13:00:01.000Z'),
      zone: ZONE,
      stored: stored('2026-11-01T08:00', '2026-11-01T07:00:00.000Z'),
    });
    expect(after.kind).toBe('missed');
  });

  test('a skipped hour resolves to the first instant after the gap', () => {
    // 2026-03-29: 02:00 CET jumps to 03:00 CEST; 02:30 never occurs.
    expect(instantsOf('2026-03-29T02:30', ZONE)).toEqual([Date.parse('2026-03-29T01:00:00.000Z')]);
    const decision = decideDue({
      at: ['02:30'],
      now: new Date('2026-03-29T01:00:20.000Z'),
      zone: ZONE,
      stored: stored('2026-03-28T02:30', '2026-03-28T01:30:00.000Z'),
    });
    expect(decision).toEqual({
      kind: 'fire',
      due: { key: '2026-03-29T02:30', instant: Date.parse('2026-03-29T01:00:00.000Z') },
      lateMs: 20_000,
      windowMs: 6 * HOUR,
    });
  });

  test('a repeated hour fires once: the first occurrence is the scheduled instant', () => {
    // 2026-10-25: 03:00 CEST falls back to 02:00 CET; 02:30 occurs twice.
    expect(instantsOf('2026-10-25T02:30', ZONE)).toEqual([
      Date.parse('2026-10-25T00:30:00.000Z'),
      Date.parse('2026-10-25T01:30:00.000Z'),
    ]);
    const first = decideDue({
      at: ['02:30'],
      now: new Date('2026-10-25T00:30:02.000Z'),
      zone: ZONE,
      stored: stored('2026-10-24T02:30', '2026-10-24T00:30:00.000Z'),
    });
    expect(first.kind).toBe('fire');
    if (first.kind !== 'fire') return;
    expect(first.due.instant).toBe(Date.parse('2026-10-25T00:30:00.000Z'));

    const second = decideDue({
      at: ['02:30'],
      now: new Date('2026-10-25T01:30:10.000Z'),
      zone: ZONE,
      stored: first.due,
    });
    expect(second).toEqual({ kind: 'none' });
  });

  test('a clock moved back more than five minutes never refires', () => {
    const storedAt = Date.parse('2026-11-02T18:00:00.000Z');
    const decision = decideDue({
      at: ['19:00'],
      now: new Date('2026-11-02T17:50:00.000Z'),
      zone: ZONE,
      stored: stored('2026-11-02T19:00', '2026-11-02T18:00:00.000Z'),
    });
    expect(decision).toEqual({ kind: 'clock-back', stored: storedAt, now: Date.parse('2026-11-02T17:50:00.000Z') });

    // A clock moved back less than the threshold is not a clock change: the stored key still
    // covers today's earlier instant, so nothing fires.
    const small = decideDue({
      at: ['19:00'],
      now: new Date('2026-11-02T17:57:00.000Z'),
      zone: ZONE,
      stored: stored('2026-11-02T19:00', '2026-11-02T18:00:00.000Z'),
    });
    expect(small).toEqual({ kind: 'none' });
    expect(CLOCK_BACK_MS).toBe(5 * 60_000);
  });

  test('with catch-up off only an on-time tick fires', () => {
    const late = decideDue({
      at: ['19:00'],
      now: new Date('2026-11-02T18:02:00.000Z'),
      zone: ZONE,
      stored: stored('2026-11-02T07:00', '2026-11-02T06:00:00.000Z'),
      catchUp: false,
    });
    expect(late).toEqual({
      kind: 'missed',
      due: { key: '2026-11-02T19:00', instant: Date.parse('2026-11-02T18:00:00.000Z') },
      lateMs: 2 * 60_000,
      windowMs: 5_000,
    });
  });

  test('only the latest due instant is considered: three missed days send one reminder', () => {
    const decision = decideDue({
      at: ['07:00', '19:00'],
      now: new Date('2026-11-02T18:20:00.000Z'),
      zone: ZONE,
      stored: stored('2026-10-30T19:00', '2026-10-30T18:00:00.000Z'),
    });
    expect(decision.kind).toBe('fire');
    if (decision.kind !== 'fire') return;
    expect(decision.due.key).toBe('2026-11-02T19:00');
  });

  test('the status surface reads the next instant and the wall key of an instant', () => {
    expect(nextDueAfter(['07:00', '19:00'], new Date('2026-11-02T18:30:00.000Z'), ZONE)).toEqual({
      key: '2026-11-03T07:00',
      instant: Date.parse('2026-11-03T06:00:00.000Z'),
    });
    expect(latestDue(['07:00', '19:00'], new Date('2026-11-02T18:30:00.000Z'), ZONE)).toEqual({
      key: '2026-11-02T19:00',
      instant: Date.parse('2026-11-02T18:00:00.000Z'),
    });
    expect(wallKey(new Date('2026-11-02T18:30:00.000Z'), ZONE)).toBe('2026-11-02T19:30');
  });
});
