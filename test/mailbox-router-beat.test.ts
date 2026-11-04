import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MachineDaemon } from '../src/daemon/host.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import { spawnMailboxChild } from '../src/daemon/mailbox/spawn.ts';
import type { MailboxChild, MailboxChildEvent, MailboxChildMessage } from '../src/daemon/mailbox/supervisor.ts';

const homes: string[] = [];
const daemons: MachineDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test('the router entry answers one tick with a heartbeat', async () => {
  const child = spawnMailboxChild();
  const messages: MailboxChildMessage[] = [];
  child.subscribe((event) => {
    if (event.kind === 'message') messages.push(event.message);
  });
  const at = '2026-11-04T02:00:00.000Z';
  expect(child.send({ type: 'tick', at })).toBe(true);
  const end = Date.now() + 3_000;
  while (messages.length === 0 && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill('the scene is done');
  await child.exited;
  expect(messages).toEqual([{ type: 'heartbeat', at }]);
});

test('the daemon beat starts the router and records its heartbeat', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mb-beat-'));
  homes.push(home);
  const root = join(home, 'checkout');
  const { startMachineDaemon } = await import('../src/daemon/host.ts');
  let started = 0;
  const factory = (): MailboxChild => {
    started += 1;
    const listeners = new Set<(event: MailboxChildEvent) => void>();
    let alive = true;
    return {
      pid: 41,
      get alive() {
        return alive;
      },
      send(message) {
        if (!alive) return false;
        for (const listener of listeners) {
          listener({ kind: 'message', message: { type: 'heartbeat', at: message.at } });
        }
        return true;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      kill() {
        alive = false;
      },
      exited: Promise.resolve(),
    };
  };
  const startedDaemon = await startMachineDaemon({
    home,
    roots: [root],
    version: 'mailbox-beat',
    heartbeatMs: 30,
    now: () => new Date('2026-11-04T02:00:00.000Z'),
    restoreSweep: false,
    mailboxHosting: true,
    mailboxFactory: factory,
    onFatal: () => undefined,
  });
  expect(startedDaemon.kind).toBe('serving');
  if (startedDaemon.kind !== 'serving') return;
  daemons.push(startedDaemon.daemon);
  const end = Date.now() + 2_000;
  let heartbeatAt: string | null = null;
  while (Date.now() < end) {
    const reading = readDaemonState(home);
    heartbeatAt = reading.kind === 'ok' ? reading.state.mailbox?.heartbeatAt ?? null : null;
    if (typeof heartbeatAt === 'string' && heartbeatAt !== '') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(started).toBeGreaterThan(0);
  expect(heartbeatAt).toBe('2026-11-04T02:00:00.000Z');
});
