// The reminder chore on the machine daemon's own beat: the daemon is started over a scratch home
// with a pinned clock, the configured list is injected, and the transport is a recorder, so the
// scene reads exactly what the beat ran and what it left behind. The root has no loadable team
// file on purpose: the beat runs whether or not a route was hosted, and this scene tests the
// beat, not endpoint hosting.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { daemonLogPath } from '../src/daemon/paths.ts';
import type { DaemonDirectContext, DaemonDirectRequest } from '../src/reminder/direct-send.ts';
import type { ReminderSpec, ReminderTarget } from '../src/reminder/run.ts';
import { readRemindersState, recordReminder, type ReminderRecord } from '../src/reminder/state.ts';

const NOW = Date.parse('2026-11-02T18:00:02.000Z');
const ZONE = 'Europe/Paris';

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function scratch(): { root: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), 'team-reminder-beat-'));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function target(seat: string, root: string): ReminderTarget {
  return { recipient: { root, session: 'acme', seat }, text: `text for ${seat}` };
}

function spec(root: string): ReminderSpec {
  return {
    name: 'daily',
    at: ['07:00', '19:00'],
    zone: ZONE,
    targets: [target('lead', root), target('helper', root)],
  };
}

function priorRecord(): ReminderRecord {
  return {
    key: '2026-11-02T07:00',
    instant: Date.parse('2026-11-02T06:00:00.000Z'),
    firedAt: '2026-11-02T06:00:01.000Z',
    lateMs: 1_000,
    finishedAt: '2026-11-02T06:00:02.000Z',
    deliveries: [],
  };
}

type Call = { context: DaemonDirectContext; request: DaemonDirectRequest };

function recorder() {
  const calls: Call[] = [];
  const send = async (context: DaemonDirectContext, request: DaemonDirectRequest) => {
    calls.push({ context, request });
    return {
      ok: true,
      code: 0,
      id: request.id ?? `minted-${String(calls.length)}`,
      staged: true,
      text: 'delivered',
    };
  };
  return { calls, send };
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the reminder beat');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the reminder chore on the daemon beat', () => {
  test('a due reminder fires, records its results and logs the line; a bad list is named and skipped', async () => {
    const { root, home } = scratch();
    // Yesterday's cadence stands: the pinned instant is two seconds past today's 19:00.
    recordReminder(home, 'daily', priorRecord());
    const { calls, send } = recorder();
    let reads = 0;
    let specs: readonly ReminderSpec[] = [spec(root)];
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'reminder-beat-test',
      version: '0.0.0-reminder-beat',
      now: () => new Date(NOW),
      heartbeatMs: 20,
      restoreSweep: false,
      reminders: () => {
        reads += 1;
        if (reads === 1) throw new Error('the config line 3 could not be read');
        return specs;
      },
      reminderSend: send,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      await waitFor(() => calls.length === 2);

      expect(calls.map((call) => call.request.seat)).toEqual(['lead', 'helper']);
      expect(calls[0]?.request.id).toBeUndefined();
      expect(calls[0]?.request.body).toBe('text for lead');
      expect(calls[0]?.context).toEqual({
        reminder: 'daily',
        due: '2026-11-02T19:00',
        recipients: [target('lead', root).recipient, target('helper', root).recipient],
      });

      const log = readFileSync(daemonLogPath(home), 'utf8');
      expect(log).toContain('reminders: the configured list could not be read — the config line 3 could not be read; nothing fires this beat');
      expect(log).toContain('reminder daily 2026-11-02T19:00: sent 2, refused 0; late 2s');
      // A settled instant never fires twice on later beats.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(calls).toHaveLength(2);
      expect(readFileSync(daemonLogPath(home), 'utf8').match(/reminder daily/g)).toHaveLength(1);

      const read = readRemindersState(home);
      expect(read.kind).toBe('ok');
      if (read.kind !== 'ok') return;
      expect(read.state.reminders.daily).toMatchObject({
        key: '2026-11-02T19:00',
        firedAt: new Date(NOW).toISOString(),
        finishedAt: new Date(NOW).toISOString(),
      });
      expect(read.state.reminders.daily?.deliveries.map((one) => [one.seat, one.ok])).toEqual([
        ['lead', true],
        ['helper', true],
      ]);
    } finally {
      await started.daemon.close();
    }
  });

  test('a closed daemon starts no reminder, even for one that became due afterwards', async () => {
    const { root, home } = scratch();
    const { calls, send } = recorder();
    let specs: readonly ReminderSpec[] = [];
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'reminder-beat-test',
      version: '0.0.0-reminder-beat',
      now: () => new Date(NOW),
      heartbeatMs: 20,
      restoreSweep: false,
      reminders: () => specs,
      reminderSend: send,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;

    await started.daemon.close();
    // The daemon is closed; a reminder that came due now must not fire on any late beat.
    specs = [spec(root)];
    recordReminder(home, 'daily', priorRecord());
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(calls).toEqual([]);
    const read = readRemindersState(home);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.state.reminders.daily?.key).toBe('2026-11-02T07:00');
  });
});
