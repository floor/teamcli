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
});
