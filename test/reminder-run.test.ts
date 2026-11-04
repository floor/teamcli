// One beat of the reminder chore, driven with an injected instant and a scripted sender over a
// real state record in a scratch home. The scenes read the decision the tick took, the record it
// left, and the words it logged; no transport is ever reached.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonDirectContext, DaemonDirectRequest, DaemonDirectResult } from '../src/reminder/direct-send.ts';
import { reminderTick, span, type ReminderSpec, type ReminderTarget } from '../src/reminder/run.ts';
import {
  readRemindersState,
  recordReminder,
  remindersStatePath,
  type ReminderDelivery,
  type ReminderRecord,
} from '../src/reminder/state.ts';

const ZONE = 'Europe/Paris';
const AT_19 = Date.parse('2026-11-02T18:00:00.000Z');

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'team-reminder-run-'));
  homes.push(home);
  return home;
}

function target(seat: string, root = '/work/one'): ReminderTarget {
  return { recipient: { root, session: 's1', seat }, text: `text for ${seat}` };
}

function spec(over: Partial<ReminderSpec> = {}): ReminderSpec {
  return {
    name: 'daily',
    at: ['07:00', '19:00'],
    zone: ZONE,
    catchUp: true,
    targets: [target('lead'), target('helper')],
    ...over,
  };
}

function delivery(over: Partial<ReminderDelivery> = {}): ReminderDelivery {
  return {
    seat: 'lead',
    root: '/work/one',
    ok: true,
    id: 'msg-1',
    why: null,
    at: '2026-11-02T18:00:01.000Z',
    ...over,
  };
}

function record(over: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    key: '2026-11-02T07:00',
    instant: Date.parse('2026-11-02T06:00:00.000Z'),
    firedAt: '2026-11-02T06:00:01.000Z',
    lateMs: 1_000,
    finishedAt: '2026-11-02T06:00:02.000Z',
    deliveries: [],
    ...over,
  };
}

type Call = { context: DaemonDirectContext; request: DaemonDirectRequest };

function sender(answer?: (call: Call, index: number) => Promise<DaemonDirectResult> | DaemonDirectResult) {
  const calls: Call[] = [];
  const send = async (context: DaemonDirectContext, request: DaemonDirectRequest): Promise<DaemonDirectResult> => {
    const call = { context, request };
    calls.push(call);
    if (answer !== undefined) return answer(call, calls.length - 1);
    return { ok: true, code: 0, id: request.id ?? `minted-${String(calls.length)}`, staged: true, text: 'delivered' };
  };
  return { calls, send };
}

function lines(): { log: (line: string) => void; said: string[] } {
  const said: string[] = [];
  return { said, log: (line) => said.push(line) };
}

function stateOf(home: string, name = 'daily'): ReminderRecord | null {
  const read = readRemindersState(home);
  if (read.kind !== 'ok') return null;
  return read.state.reminders[name] ?? null;
}

describe('a reminder beat', () => {
  test('a due instant fires to every recipient and records how each answered', async () => {
    const home = scratchHome();
    recordReminder(home, 'daily', record());
    const { calls, send } = sender();
    const said = lines();

    const events = await reminderTick({ home, now: new Date('2026-11-02T18:00:02.000Z'), specs: [spec()], send, log: said.log });

    expect(events).toEqual([{ kind: 'fired', name: 'daily', key: '2026-11-02T19:00', lateMs: 2_000, sent: 2, refused: 0 }]);
    expect(calls.map((call) => call.request.seat)).toEqual(['lead', 'helper']);
    expect(calls[0]?.context).toEqual({
      reminder: 'daily',
      due: '2026-11-02T19:00',
      recipients: [target('lead').recipient, target('helper').recipient],
    });
    expect(said.said).toEqual(['reminder daily 2026-11-02T19:00: sent 2, refused 0; late 2s']);
    const written = stateOf(home);
    expect(written?.key).toBe('2026-11-02T19:00');
    expect(written?.lateMs).toBe(2_000);
    expect(written?.firedAt).toBe('2026-11-02T18:00:02.000Z');
    expect(written?.finishedAt).toBe('2026-11-02T18:00:02.000Z');
    expect(written?.deliveries.map((one) => [one.seat, one.ok, one.id])).toEqual([
      ['lead', true, 'minted-1'],
      ['helper', true, 'minted-2'],
    ]);
  });

  test('a first run remembers the latest instant and sends nothing; the next one fires', async () => {
    const home = scratchHome();
    const { calls, send } = sender();
    const said = lines();

    const first = await reminderTick({ home, now: new Date('2026-11-02T20:00:00.000Z'), specs: [spec()], send, log: said.log });
    expect(first).toEqual([{ kind: 'first-run', name: 'daily', key: '2026-11-02T19:00' }]);
    expect(calls).toEqual([]);
    expect(said.said).toEqual(['reminder daily 2026-11-02T19:00: first run — remembered without firing']);
    expect(stateOf(home)).toMatchObject({ key: '2026-11-02T19:00', firedAt: null, lateMs: null, deliveries: [] });

    const next = await reminderTick({ home, now: new Date('2026-11-03T06:00:03.000Z'), specs: [spec()], send, log: said.log });
    expect(next).toEqual([{ kind: 'fired', name: 'daily', key: '2026-11-03T07:00', lateMs: 3_000, sent: 2, refused: 0 }]);
    expect(calls).toHaveLength(2);
  });

  test('an instant past its window is recorded as missed and not sent', async () => {
    const home = scratchHome();
    // Yesterday's 07:00 is stored; today's 07:00 came due seven hours before this beat.
    recordReminder(home, 'daily', record({ key: '2026-11-01T07:00', instant: Date.parse('2026-11-01T06:00:00.000Z') }));
    const { calls, send } = sender();
    const said = lines();

    const events = await reminderTick({
      home,
      now: new Date('2026-11-02T20:00:00.000Z'),
      specs: [spec({ at: ['07:00'] })],
      send,
      log: said.log,
    });

    expect(events).toEqual([{ kind: 'missed', name: 'daily', key: '2026-11-02T07:00', lateMs: 14 * 3_600_000 }]);
    expect(calls).toEqual([]);
    expect(said.said).toEqual(['reminder daily 2026-11-02T07:00: missed by 14h 0m; skipped']);
    expect(stateOf(home)).toMatchObject({ key: '2026-11-02T07:00', lateMs: 14 * 3_600_000, firedAt: null });
  });

  test('a stored key at the latest instant does nothing at all', async () => {
    const home = scratchHome();
    recordReminder(home, 'daily', record({
      key: '2026-11-02T19:00',
      instant: AT_19,
      deliveries: [delivery(), delivery({ seat: 'helper', id: 'msg-2' })],
    }));
    const { calls, send } = sender();

    const events = await reminderTick({ home, now: new Date('2026-11-02T18:00:30.000Z'), specs: [spec()], send });

    expect(events).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('a clock stepped back is named and never refires', async () => {
    const home = scratchHome();
    recordReminder(home, 'daily', record({ key: '2026-11-02T19:00', instant: AT_19 }));
    const { calls, send } = sender();
    const said = lines();

    const events = await reminderTick({ home, now: new Date('2026-11-02T17:50:00.000Z'), specs: [spec()], send, log: said.log });

    expect(events).toEqual([{ kind: 'clock-back', name: 'daily', stored: AT_19, now: Date.parse('2026-11-02T17:50:00.000Z') }]);
    expect(calls).toEqual([]);
    expect(said.said[0]).toContain('clock moved back');
  });

  test('catch-up off: a two-minute-late beat records the instant as missed', async () => {
    const home = scratchHome();
    recordReminder(home, 'daily', record());
    const { calls, send } = sender();

    const events = await reminderTick({ home, now: new Date('2026-11-02T18:02:00.000Z'), specs: [spec({ catchUp: false })], send });

    expect(events).toEqual([{ kind: 'missed', name: 'daily', key: '2026-11-02T19:00', lateMs: 2 * 60_000 }]);
    expect(calls).toEqual([]);
  });

  test('a failed transport is retried under the id it staged, and a refusal is not', async () => {
    const home = scratchHome();
    recordReminder(home, 'daily', record({
      key: '2026-11-02T19:00',
      instant: AT_19,
      firedAt: '2026-11-02T18:00:01.000Z',
      lateMs: 1_000,
      finishedAt: null,
      deliveries: [delivery({ ok: false, id: 'msg-1', why: 'the socket refused' }), delivery({ seat: 'helper', ok: true, id: 'msg-2' })],
    }));
    const { calls, send } = sender();
    const said = lines();

    const events = await reminderTick({ home, now: new Date('2026-11-02T18:00:30.000Z'), specs: [spec()], send, log: said.log });

    expect(events).toEqual([{ kind: 'retried', name: 'daily', key: '2026-11-02T19:00', sent: 2, refused: 0 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toMatchObject({ seat: 'lead', id: 'msg-1' });
    expect(said.said).toEqual(['reminder daily 2026-11-02T19:00: retried; sent 2, refused 0']);
    const written = stateOf(home);
    expect(written?.finishedAt).toBe('2026-11-02T18:00:30.000Z');
    expect(written?.deliveries.map((one) => [one.seat, one.ok, one.id])).toEqual([
      ['lead', true, 'msg-1'],
      ['helper', true, 'msg-2'],
    ]);

    // A refusal — no id, nothing staged — stands; the next beat sends nothing.
    const refusedHome = scratchHome();
    recordReminder(refusedHome, 'daily', record({
      key: '2026-11-02T19:00',
      instant: AT_19,
      firedAt: '2026-11-02T18:00:01.000Z',
      finishedAt: null,
      deliveries: [delivery({ ok: false, id: null, why: 'not admitted' }), delivery({ seat: 'helper', ok: true, id: 'msg-2' })],
    }));
    const quiet = sender();
    expect(await reminderTick({ home: refusedHome, now: new Date('2026-11-02T18:00:30.000Z'), specs: [spec()], send: quiet.send })).toEqual([]);
    expect(quiet.calls).toEqual([]);
  });

  test('a retry stops when the catch-up window has closed', async () => {
    const home = scratchHome();
    recordReminder(home, 'daily', record({
      key: '2026-11-02T07:00',
      firedAt: '2026-11-02T06:00:01.000Z',
      finishedAt: null,
      deliveries: [delivery({ ok: false, id: 'msg-1', why: 'the socket refused' })],
    }));
    const { calls, send } = sender();

    const events = await reminderTick({ home, now: new Date('2026-11-02T13:00:01.000Z'), specs: [spec({ at: ['07:00'] })], send });

    expect(events).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('a walk interrupted before any recipient was recorded is retried with fresh ids', async () => {
    const home = scratchHome();
    recordReminder(home, 'daily', record({
      key: '2026-11-02T19:00',
      instant: AT_19,
      firedAt: '2026-11-02T18:00:01.000Z',
      finishedAt: null,
      deliveries: [],
    }));
    const { calls, send } = sender();

    const events = await reminderTick({ home, now: new Date('2026-11-02T18:00:30.000Z'), specs: [spec()], send });

    expect(events).toEqual([{ kind: 'retried', name: 'daily', key: '2026-11-02T19:00', sent: 2, refused: 0 }]);
    expect(calls.map((call) => call.request.id)).toEqual([undefined, undefined]);
  });

  test('an unreadable record fires nothing and says why', async () => {
    const home = scratchHome();
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(remindersStatePath(home), '{"format":1,"reminders":{"daily":{"key":"nonsense"}}}');
    const { calls, send } = sender();
    const said = lines();

    const events = await reminderTick({ home, now: new Date('2026-11-02T18:00:02.000Z'), specs: [spec()], send, log: said.log });

    expect(events[0]?.kind).toBe('unreadable');
    expect(calls).toEqual([]);
    expect(said.said[0]).toContain('reminder state unreadable');
  });

  test('a sender that throws is recorded as a refusal with no id, and is not retried', async () => {
    const home = scratchHome();
    recordReminder(home, 'daily', record());
    const { send } = sender((call) => {
      if (call.request.seat === 'lead') throw new Error('the transport blew up');
      return { ok: true, code: 0, id: 'minted-helper', staged: true, text: 'delivered' };
    });
    const said = lines();

    const events = await reminderTick({ home, now: new Date('2026-11-02T18:00:02.000Z'), specs: [spec()], send, log: said.log });

    expect(events).toEqual([{ kind: 'fired', name: 'daily', key: '2026-11-02T19:00', lateMs: 2_000, sent: 1, refused: 1 }]);
    const written = stateOf(home);
    expect(written?.deliveries[0]).toMatchObject({ seat: 'lead', ok: false, id: null, why: 'the transport blew up' });

    const again = sender();
    expect(await reminderTick({ home, now: new Date('2026-11-02T18:00:07.000Z'), specs: [spec()], send: again.send })).toEqual([]);
    expect(again.calls).toEqual([]);
  });

  test("one reminder's failure never stops another one in the same beat", async () => {
    const home = scratchHome();
    recordReminder(home, 'broken', record());
    recordReminder(home, 'steady', record());
    const { send } = sender((call) => {
      if (call.context.reminder === 'broken') throw new Error('no route');
      return { ok: true, code: 0, id: 'ok-1', staged: true, text: 'delivered' };
    });

    const events = await reminderTick({
      home,
      now: new Date('2026-11-02T18:00:02.000Z'),
      specs: [spec({ name: 'broken' }), spec({ name: 'steady' })],
      send,
    });

    expect(events.map((event) => `${event.kind}:${'name' in event ? event.name : ''}`)).toEqual(['fired:broken', 'fired:steady']);
    expect(events[0]).toMatchObject({ sent: 0, refused: 2 });
    expect(events[1]).toMatchObject({ sent: 2, refused: 0 });
  });

  test('an overlapping beat skips a reminder whose send is still walking', async () => {
    const home = scratchHome();
    recordReminder(home, 'daily', record());
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = reminderTick({
      home,
      now: new Date('2026-11-02T18:00:02.000Z'),
      specs: [spec()],
      send: async (_context, request) => {
        await gate;
        return { ok: true, code: 0, id: request.id ?? 'late-1', staged: true, text: 'delivered' };
      },
    });
    // The first beat is inside its walk now; a second beat must not start another one.
    const second = await reminderTick({
      home,
      now: new Date('2026-11-02T18:00:03.000Z'),
      specs: [spec()],
      send: async () => {
        throw new Error('the second beat must not send');
      },
    });
    expect(second).toEqual([{ kind: 'busy', name: 'daily' }]);
    release();
    expect(await first).toEqual([{ kind: 'fired', name: 'daily', key: '2026-11-02T19:00', lateMs: 2_000, sent: 2, refused: 0 }]);
  });
});

test('a span of time reads as the log line says it', () => {
  expect(span(2_000)).toBe('2s');
  expect(span(9 * 60_000 + 12_000)).toBe('9m 12s');
  expect(span(3 * 3_600_000 + 4 * 60_000)).toBe('3h 4m');
  expect(span(2 * 86_400_000 + 5 * 3_600_000)).toBe('2d 5h');
  expect(span(-5)).toBe('0s');
});
