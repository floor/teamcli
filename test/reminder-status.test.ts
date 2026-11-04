// What the reminder chore looks like from outside: one reading per configured reminder, taken
// from the same schedule the daemon decides with and the same state record the tick writes, and
// the `team daemon status --json` document that carries it. None of these scenes starts a daemon
// or sends anything.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon } from '../src/commands/daemon.ts';
import type { ReminderSpec } from '../src/reminder/run.ts';
import {
  readRemindersState,
  recordReminder,
  remindersStatePath,
  type ReminderDelivery,
  type ReminderRecord,
} from '../src/reminder/state.ts';
import { reminderStatus } from '../src/reminder/status.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-02T18:00:02.000Z');
const ZONE = 'Europe/Paris';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'team-reminder-status-'));
  homes.push(home);
  return home;
}

function spec(name = 'daily', at: readonly string[] = ['07:00', '19:00']): ReminderSpec {
  return {
    name,
    at,
    zone: ZONE,
    targets: [{ recipient: { root: '/work/one', session: 's1', seat: 'lead' }, text: 'text' }],
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
    key: '2026-11-02T19:00',
    instant: Date.parse('2026-11-02T18:00:00.000Z'),
    firedAt: '2026-11-02T18:00:01.000Z',
    lateMs: 1_000,
    finishedAt: '2026-11-02T18:00:02.000Z',
    deliveries: [delivery(), delivery({ seat: 'helper', ok: false, id: 'msg-2', why: 'the socket refused' })],
    ...over,
  };
}

describe('the reminders a status reading carries', () => {
  test('a settled send, a skipped instant, a first run, a walk in flight and no record at all', () => {
    const home = scratchHome();
    recordReminder(home, 'settled', record());
    recordReminder(home, 'skipped', record({
      key: '2026-11-02T07:00',
      instant: Date.parse('2026-11-02T06:00:00.000Z'),
      firedAt: null,
      lateMs: 12 * 3_600_000,
      finishedAt: '2026-11-02T18:00:00.000Z',
      deliveries: [],
    }));
    recordReminder(home, 'first', record({ firedAt: null, lateMs: null, deliveries: [] }));
    recordReminder(home, 'walking', record({ finishedAt: null, deliveries: [] }));

    const status = reminderStatus(
      [spec('settled'), spec('skipped'), spec('first'), spec('walking'), spec('silent')],
      readRemindersState(home),
      NOW,
    );

    expect(status.unreadable).toBeNull();
    expect(status.reminders.map((one) => [one.name, one.nextAt, one.lastDue, one.missed])).toEqual([
      ['settled', '2026-11-03T06:00:00.000Z', '2026-11-02T19:00', false],
      ['skipped', '2026-11-03T06:00:00.000Z', '2026-11-02T19:00', true],
      ['first', '2026-11-03T06:00:00.000Z', '2026-11-02T19:00', false],
      ['walking', '2026-11-03T06:00:00.000Z', '2026-11-02T19:00', false],
      ['silent', '2026-11-03T06:00:00.000Z', '2026-11-02T19:00', false],
    ]);
    expect(status.reminders[0]?.lastResult).toEqual({
      kind: 'sent',
      due: '2026-11-02T19:00',
      sent: 1,
      refused: 1,
      lateMs: 1_000,
      at: '2026-11-02T18:00:02.000Z',
    });
    expect(status.reminders[1]?.lastResult).toEqual({
      kind: 'missed',
      due: '2026-11-02T07:00',
      sent: 0,
      refused: 0,
      lateMs: 12 * 3_600_000,
      at: '2026-11-02T18:00:00.000Z',
    });
    expect(status.reminders[2]?.lastResult).toMatchObject({ kind: 'first-run', due: '2026-11-02T19:00', lateMs: null });
    expect(status.reminders[3]?.lastResult).toMatchObject({ kind: 'pending', at: null });
    expect(status.reminders[4]?.lastResult).toBeNull();
  });

  test('a state record that cannot be read is named and no entry invents a result', () => {
    const home = scratchHome();
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(remindersStatePath(home), '{"format":1,"reminders":{"daily":{"key":"nonsense"}}}');

    const status = reminderStatus([spec()], readRemindersState(home), NOW);

    expect(status.unreadable).toContain('daily');
    expect(status.reminders).toEqual([{
      name: 'daily',
      nextAt: '2026-11-03T06:00:00.000Z',
      lastDue: '2026-11-02T19:00',
      lastResult: null,
      missed: false,
    }]);
  });

  test('no configured reminder means no reading', () => {
    const home = scratchHome();
    expect(reminderStatus([], readRemindersState(home), NOW)).toEqual({ reminders: [], unreadable: null });
  });
});

describe('team daemon status --json', () => {
  test('carries one reminder reading beside the daemon reading', async () => {
    const home = scratchHome();
    recordReminder(home, 'daily', record());
    const io = testIo(home);

    const code = await runDaemon(['status', '--json'], io, {
      home,
      now: () => NOW,
      reminders: () => ({ specs: [spec()] }),
    });

    expect(code).toBe(0);
    const doc = JSON.parse(io.out) as Record<string, unknown>;
    expect(doc).toMatchObject({
      schema: { name: 'team.daemon-status', version: 1 },
      format: 1,
      daemon: { state: 'not-running' },
    });
    expect(doc.reminders).toEqual([{
      name: 'daily',
      nextAt: '2026-11-03T06:00:00.000Z',
      lastDue: '2026-11-02T19:00',
      lastResult: {
        kind: 'sent',
        due: '2026-11-02T19:00',
        sent: 1,
        refused: 1,
        lateMs: 1_000,
        at: '2026-11-02T18:00:02.000Z',
      },
      missed: false,
    }]);
  });

  test('a config reader that throws is named and the daemon reading still prints', async () => {
    const home = scratchHome();
    const io = testIo(home);

    const code = await runDaemon(['status', '--json'], io, {
      home,
      now: () => NOW,
      reminders: () => {
        throw new Error('line 3: unknown key "when"');
      },
    });

    expect(code).toBe(0);
    const doc = JSON.parse(io.out) as Record<string, unknown>;
    expect(doc.daemon).toMatchObject({ state: 'not-running' });
    expect(doc.reminders).toEqual([]);
    expect(doc.remindersError).toBe('line 3: unknown key "when"');
  });

  test('without an injected reader, the entity record is read and a refused entry is named', async () => {
    const home = scratchHome();
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'team', 'entities.yaml'),
      [
        'acme:',
        '  reminders:',
        '    - name: daily',
        '      at: ["07:00", "19:00"]',
        '      zone: Europe/Paris',
        '      to: [orchestrator@acme]',
        '      text: "Do the thing."',
        '    - name: broken',
        '      at: ["25:00"]',
        '      to: [lead@acme]',
      ].join('\n'),
    );
    const io = testIo(home);

    const code = await runDaemon(['status', '--json'], io, { home, now: () => NOW });

    expect(code).toBe(0);
    const doc = JSON.parse(io.out) as Record<string, unknown>;
    expect(doc.reminders).toEqual([{
      name: 'daily',
      nextAt: '2026-11-03T06:00:00.000Z',
      lastDue: '2026-11-02T19:00',
      lastResult: null,
      missed: false,
    }]);
    expect(doc.remindersError).toContain('at holds a value that is not an HH:MM time');
  });
});
