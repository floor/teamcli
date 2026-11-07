// One end-to-end fire under a real machine daemon: the daemon's own beat decides the instant,
// the verified daemon identity establishes the principal from the state record and the
// single-instance lock this test process really holds, and the ordinary send path delivers into
// the fixture world. Only the transport is a fixture — the same fake socket and pane every send
// scene uses — so no live session or CLI home is reached. The config list is injected because the
// parser is not written yet; everything else is the production chain.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { recordDir } from '../src/commands/messages.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { daemonLogPath } from '../src/daemon/paths.ts';
import { sendDaemonDirect } from '../src/reminder/direct-send.ts';
import type { ReminderSpec } from '../src/reminder/run.ts';
import { readRemindersState, recordReminder, type ReminderRecord } from '../src/reminder/state.ts';
import { recordFile } from '../src/send/record.ts';
import { dropDir, fake, world, type World } from './send-native-fixtures.ts';

const NOW = new Date('2026-11-02T18:00:02.000Z');
const ZONE = 'Europe/Paris';
const SESSION = 'acme';

const made: World[] = [];
afterEach(() => {
  for (const one of made.splice(0)) one.cleanup();
});

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

function spec(root: string): ReminderSpec {
  return {
    name: 'daily',
    at: ['07:00', '19:00'],
    zone: ZONE,
    targets: [{ recipient: { root, session: SESSION, seat: 'lead' }, text: 'Please update the activity before the next cycle.' }],
  };
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the reminder fire');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function settled(home: string): ReminderRecord | null {
  const read = readRemindersState(home);
  if (read.kind !== 'ok') return null;
  const entry = read.state.reminders.daily;
  // The seeded record is yesterday's cadence; only today's 19:00 record is the fire this scene
  // is waiting for, and only once its walk has settled.
  return entry !== undefined && entry.key === '2026-11-02T19:00' && entry.finishedAt !== null ? entry : null;
}

describe('one reminder fires end to end under the daemon', () => {
  test('the beat decides, the daemon identity proves itself, and the send settles into a record', async () => {
    const one = world(['mcp-inbox', 'typed']);
    made.push(one);
    recordReminder(one.home, 'daily', priorRecord());
    // The fixture transport, but bound to the daemon's own home and clock: the verifier reads the
    // record this very process just wrote, and the send walks the fixture world's sockets.
    const transport = fake(one, { home: one.home, now: () => new Date(NOW) });

    const started = await startMachineDaemon({
      home: one.home,
      roots: [one.root],
      startedBy: 'reminder-fire-test',
      version: '0.0.0-reminder-fire',
      now: () => new Date(NOW),
      heartbeatMs: 20,
      restoreSweep: false,
      reminders: () => [spec(one.root)],
      reminderSend: (context, request) => sendDaemonDirect(context, request, transport),
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      await waitFor(() => settled(one.home) !== null);

      const written = settled(one.home);
      expect(written?.key).toBe('2026-11-02T19:00');
      expect(written?.firedAt).toBe(NOW.toISOString());
      expect(written?.lateMs).toBe(2_000);
      expect(written?.deliveries).toHaveLength(1);
      const delivery = written?.deliveries[0];
      expect(delivery).toMatchObject({ seat: 'lead', root: one.root, ok: true, why: null });
      expect(typeof delivery?.id).toBe('string');

      // The ordinary send path staged the message under the id the record names, and left it in
      // the fixture world's drop folder — the evidence the walk reached a transport.
      expect(existsSync(recordFile(recordDir(one.root, SESSION, 'lead'), delivery?.id ?? ''))).toBe(true);
      expect(readdirSync(dropDir(one.dir, 'lead')).length).toBeGreaterThan(0);

      const log = readFileSync(daemonLogPath(one.home), 'utf8');
      expect(log).toContain('reminder daily 2026-11-02T19:00: sent 1, refused 0; late 2s');
    } finally {
      await started.daemon.close();
    }
  }, 15_000);
});
