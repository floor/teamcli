// The reminder state record on real files in a scratch home: what a reader accepts, what it
// refuses to trust, and the two writes the chore makes — the reserve before a send walks and the
// settle after it. Every home here is a fixture, so nothing touches the machine's own folder.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineConfigDir } from '../src/daemon/paths.ts';
import {
  readRemindersState,
  recordReminder,
  remindersStatePath,
  settleReminder,
  writeRemindersState,
  type ReminderRecord,
  type RemindersState,
} from '../src/reminder/state.ts';

const homes: string[] = [];

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'team-reminder-state-'));
  homes.push(home);
  return home;
}

afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function entry(over: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    key: '2026-11-02T19:00',
    instant: Date.parse('2026-11-02T18:00:00.000Z'),
    firedAt: '2026-11-02T18:00:01.000Z',
    lateMs: 1_000,
    finishedAt: null,
    deliveries: [],
    ...over,
  };
}

function write(home: string, text: string): void {
  mkdirSync(machineConfigDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(remindersStatePath(home), text);
}

describe('the reminder state record', () => {
  test('a home with no record reads as a first run', () => {
    expect(readRemindersState(scratchHome())).toEqual({ kind: 'missing' });
  });

  test('a written state reads back, 0600 in a 0700 folder, with no temporary left behind', () => {
    const home = scratchHome();
    const state: RemindersState = {
      format: 1,
      reminders: {
        daily: entry(),
        cadence: entry({
          key: '2026-11-02T20:00',
          instant: Date.parse('2026-11-02T19:00:00.000Z'),
          firedAt: null,
          lateMs: null,
          finishedAt: '2026-11-02T19:00:05.000Z',
        }),
      },
    };
    writeRemindersState(home, state);
    expect(readRemindersState(home)).toEqual({ kind: 'ok', state });
    expect(statSync(remindersStatePath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(machineConfigDir(home)).mode & 0o777).toBe(0o700);
    expect(readdirSync(machineConfigDir(home))).toEqual(['reminders.state.json']);
    expect(readFileSync(remindersStatePath(home), 'utf8').endsWith('\n')).toBe(true);
  });

  test('a record that is not JSON, not format 1, or has no reminders object is unreadable', () => {
    const notJson = scratchHome();
    write(notJson, 'not json at all');
    expect(readRemindersState(notJson)).toEqual({
      kind: 'unreadable',
      why: 'the reminder state record is not readable JSON',
    });

    const wrongFormat = scratchHome();
    write(wrongFormat, '{"format":2,"reminders":{}}');
    expect(readRemindersState(wrongFormat)).toEqual({
      kind: 'unreadable',
      why: 'the reminder state record does not have format 1',
    });

    const noReminders = scratchHome();
    write(noReminders, '{"format":1}');
    expect(readRemindersState(noReminders)).toEqual({
      kind: 'unreadable',
      why: 'the reminder state record has no reminders object',
    });
  });

  test('a malformed entry is unreadable and names the reminder it could not trust', () => {
    const home = scratchHome();
    write(home, JSON.stringify({ format: 1, reminders: { daily: { key: '19:00', instant: 0 } } }));
    expect(readRemindersState(home)).toEqual({
      kind: 'unreadable',
      why: 'the reminder state record\'s "daily" entry is malformed',
    });
  });

  test('an entry with a field this build does not know still reads', () => {
    const home = scratchHome();
    write(home, JSON.stringify({ format: 1, reminders: { daily: { ...entry(), note: 'later' } } }));
    const read = readRemindersState(home);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.state.reminders.daily).toEqual(entry());
  });

  test('a first record creates the file; a newer key replaces the older one', () => {
    const home = scratchHome();
    expect(recordReminder(home, 'daily', entry())).toMatchObject({ ok: true });
    const newer = entry({ key: '2026-11-03T07:00', instant: Date.parse('2026-11-03T06:00:00.000Z') });
    expect(recordReminder(home, 'daily', newer)).toMatchObject({ ok: true });
    const read = readRemindersState(home);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.state.reminders.daily?.key).toBe('2026-11-03T07:00');
  });

  test('a key at or before the recorded one is refused and the file is untouched', () => {
    const home = scratchHome();
    recordReminder(home, 'daily', entry());
    const before = readFileSync(remindersStatePath(home), 'utf8');
    const refused = recordReminder(home, 'daily', entry());
    expect(refused).toEqual({
      ok: false,
      why: '"daily" already satisfied 2026-11-02T19:00, and 2026-11-02T19:00 is not newer',
    });
    expect(readFileSync(remindersStatePath(home), 'utf8')).toBe(before);
  });

  test('an unreadable record is refused and never overwritten', () => {
    const home = scratchHome();
    write(home, '{broken');
    expect(recordReminder(home, 'daily', entry())).toEqual({
      ok: false,
      why: 'the reminder state record is not readable JSON',
    });
    expect(readFileSync(remindersStatePath(home), 'utf8')).toBe('{broken');
  });

  test('recording a malformed entry is refused before anything is written', () => {
    const home = scratchHome();
    const bad = { ...entry(), key: 'tonight' };
    expect(recordReminder(home, 'daily', bad).ok).toBe(false);
    expect(readRemindersState(home)).toEqual({ kind: 'missing' });
  });

  test('a settle records every recipient against the reserved key', () => {
    const home = scratchHome();
    recordReminder(home, 'daily', entry());
    const settled = settleReminder(home, 'daily', {
      key: '2026-11-02T19:00',
      finishedAt: '2026-11-02T18:00:03.000Z',
      deliveries: [
        { seat: 'orchestrator', root: '/floor/one', ok: true, id: 'msg-1', why: null, at: '2026-11-02T18:00:02.000Z' },
        { seat: 'iris', root: '/floor/two', ok: false, id: null, why: 'not admitted', at: '2026-11-02T18:00:03.000Z' },
      ],
    });
    expect(settled).toMatchObject({ ok: true });
    const read = readRemindersState(home);
    if (read.kind !== 'ok') throw new Error('the record must read back');
    expect(read.state.reminders.daily).toEqual(
      entry({
        finishedAt: '2026-11-02T18:00:03.000Z',
        deliveries: [
          { seat: 'orchestrator', root: '/floor/one', ok: true, id: 'msg-1', why: null, at: '2026-11-02T18:00:02.000Z' },
          { seat: 'iris', root: '/floor/two', ok: false, id: null, why: 'not admitted', at: '2026-11-02T18:00:03.000Z' },
        ],
      }),
    );
  });

  test('a settle for a key the record no longer holds is refused and writes nothing', () => {
    const home = scratchHome();
    recordReminder(home, 'daily', entry());
    const before = readFileSync(remindersStatePath(home), 'utf8');
    expect(
      settleReminder(home, 'daily', { key: '2026-11-03T07:00', finishedAt: '2026-11-03T06:00:02.000Z', deliveries: [] }),
    ).toEqual({ ok: false, why: '"daily" holds 2026-11-02T19:00, not the settled 2026-11-03T07:00' });
    expect(
      settleReminder(home, 'weekly', { key: '2026-11-02T19:00', finishedAt: '2026-11-02T18:00:02.000Z', deliveries: [] }),
    ).toEqual({ ok: false, why: 'the reminder state record has no "weekly"' });
    expect(readFileSync(remindersStatePath(home), 'utf8')).toBe(before);
  });

  test('a reminder named like an object key stays an own key and never reaches the prototype', () => {
    const home = scratchHome();
    const name = '__proto__';
    expect(recordReminder(home, name, entry()).ok).toBe(true);
    const read = readRemindersState(home);
    if (read.kind !== 'ok') throw new Error('the record must read back');
    expect(Object.hasOwn(read.state.reminders, name)).toBe(true);
    expect(({} as Record<string, unknown>).key).toBeUndefined();
    expect(Object.getPrototypeOf(read.state.reminders)).toBe(Object.prototype);
    // A second record for the same name is still guarded by its own prior entry.
    expect(recordReminder(home, name, entry()).ok).toBe(false);
  });
});
