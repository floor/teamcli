// The machine child: a token that names no root but carries the machine reminder. Its tick
// reads the configured list and walks the sends on the child's own loop, and every line the beat
// writes crosses the protocol as a `reminder-note` frame, because the child's standard output
// carries frames and nothing else. These scenes drive that seam directly with a scripted list
// and transport; the child's process boundary is the supervisor's, covered beside the fleet.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { choresConfigProblem, serveChoresChild } from '../src/daemon/chores/child.ts';
import { readChildMessage, type ChoresChildConfig, type ChoresChildMessage } from '../src/daemon/chores/protocol.ts';
import type { DaemonDirectContext, DaemonDirectRequest, DaemonDirectResult } from '../src/reminder/direct-send.ts';
import type { ReminderProvider } from '../src/reminder/provider.ts';
import type { ReminderSend, ReminderSpec } from '../src/reminder/run.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function machineHome(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reminder-chores-')));
  dirs.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  return home;
}

function machineConfig(home: string, hosted: readonly string[]): ChoresChildConfig {
  return {
    version: 1,
    home,
    beatMs: 10_000,
    sliceMs: 2_000,
    since: '2026-11-01T00:00:00.000Z',
    routes: [],
    machine: { reminders: { hosted: [...hosted] } },
  };
}

type Served = {
  lines: ChoresChildMessage[];
  tick(at: Date): void;
  stop(): void;
  done: Promise<number>;
};

/** One machine child on pipes this test holds: the frames it writes, the nudges it reads, and
 *  the exit code it reports once stopped. */
function serve(input: {
  config: ChoresChildConfig;
  now: () => Date;
  provider: ReminderProvider;
  send: ReminderSend;
}): Served {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: ChoresChildMessage[] = [];
  let buffer = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (line.trim() === '') continue;
      const message = readChildMessage(JSON.parse(line) as Record<string, unknown>);
      if (message === null) throw new Error(`the child wrote a frame this test cannot read: ${line}`);
      lines.push(message);
    }
  });
  const done = serveChoresChild({
    config: input.config,
    stdin,
    stdout,
    now: input.now,
    reminder: { provider: input.provider, send: input.send },
  });
  return {
    lines,
    tick(at: Date) {
      stdin.write(`${JSON.stringify({ type: 'tick', id: `tick-${String(at.getTime())}`, at: at.toISOString() })}\n`);
    },
    stop() {
      stdin.write(`${JSON.stringify({ type: 'stop', why: 'the test is done' })}\n`);
    },
    done,
  };
}

function spec(): ReminderSpec {
  return {
    name: 'daily',
    at: ['07:00'],
    zone: 'UTC',
    targets: [{ recipient: { root: '/work/acme', session: 'acme', seat: 'crew-lead' }, text: 'Stand-up for acme.' }],
  };
}

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the child');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function notes(lines: readonly ChoresChildMessage[]): string[] {
  return lines.flatMap((line) => (line.type === 'reminder-note' ? [line.text] : []));
}

describe('the machine token', () => {
  test('no roots are accepted when the machine reminders are named', () => {
    expect(choresConfigProblem(machineConfig(machineHome(), ['/work/acme']))).toBeNull();
  });

  test('no roots and no machine work is still refused', () => {
    const config = machineConfig(machineHome(), ['/work/acme']);
    const bare = { ...config, machine: undefined } as unknown;
    expect(choresConfigProblem(bare)).toBe('the token names no roots');
  });

  test('a machine word that is not a map, or names no reminders, is refused by name', () => {
    const config = machineConfig(machineHome(), ['/work/acme']) as unknown as Record<string, unknown>;
    expect(choresConfigProblem({ ...config, machine: 'reminders' })).toBe('the token names a malformed machine chore');
    expect(choresConfigProblem({ ...config, machine: {} })).toBe('the token names a machine chore without its reminders');
  });

  test('reminders without their hosted checkouts are refused by name', () => {
    const config = machineConfig(machineHome(), ['/work/acme']) as unknown as Record<string, unknown>;
    const machine = (value: unknown): Record<string, unknown> => ({ ...config, machine: value });
    expect(choresConfigProblem(machine({ reminders: {} }))).toBe('the token names reminders without their hosted checkouts');
    expect(choresConfigProblem(machine({ reminders: { hosted: '/work/acme' } }))).toBe(
      'the token names reminders without their hosted checkouts',
    );
    expect(choresConfigProblem(machine({ reminders: { hosted: [''] } }))).toBe(
      'the token names reminders without their hosted checkouts',
    );
  });
});

describe('the machine child', () => {
  test('a tick reads the list and walks the send; every line crosses as a reminder-note frame', async () => {
    const home = machineHome();
    let now = new Date('2026-11-01T07:00:05Z');
    let reads = 0;
    const sent: { context: DaemonDirectContext; request: DaemonDirectRequest }[] = [];
    const served = serve({
      config: machineConfig(home, ['/work/acme']),
      now: () => now,
      provider: () => {
        reads += 1;
        return [spec()];
      },
      send: (context, request) => {
        sent.push({ context, request });
        return Promise.resolve<DaemonDirectResult>({ ok: true, code: 0, id: 'msg-1', staged: true, text: '' });
      },
    });
    try {
      // The first tick remembers the instant without firing: a new reminder never sends an
      // instant that is already old.
      served.tick(now);
      await waitUntil(() => notes(served.lines).some((line) => line.includes('first run — remembered without firing')));
      expect(sent).toHaveLength(0);

      // The next day's instant is due: the same child reads the list again and walks the send.
      now = new Date('2026-11-02T07:00:05Z');
      served.tick(now);
      await waitUntil(() => sent.length > 0);
      expect(reads).toBe(2);
      expect(sent[0]?.request).toEqual({ root: '/work/acme', seat: 'crew-lead', body: 'Stand-up for acme.' });
      expect(sent[0]?.context).toEqual({ reminder: 'daily', due: '2026-11-02T07:00', recipients: [{ root: '/work/acme', session: 'acme', seat: 'crew-lead' }] });
      await waitUntil(() => notes(served.lines).some((line) => line.includes('2026-11-02T07:00: sent 1, refused 0')));
      // The words are the run's own, one frame per line; no phase prefix is added.
      expect(notes(served.lines)).toContain('reminder daily 2026-11-02T07:00: sent 1, refused 0; late 5s');
    } finally {
      served.stop();
      expect(await served.done).toBe(0);
    }
  }, 10_000);

  test('a list that cannot be read is a note, and the child keeps serving', async () => {
    const home = machineHome();
    const now = new Date('2026-11-01T07:00:05Z');
    let reads = 0;
    const served = serve({
      config: machineConfig(home, ['/work/acme']),
      now: () => now,
      provider: () => {
        reads += 1;
        if (reads === 1) throw new Error('the entity record is not there');
        return [];
      },
      send: () => Promise.resolve<DaemonDirectResult>({ ok: true, code: 0, id: null, staged: false, text: '' }),
    });
    try {
      served.tick(now);
      await waitUntil(() => notes(served.lines).some((line) => line.includes('the configured list could not be read')));
      expect(notes(served.lines)).toContain(
        'reminders: the configured list could not be read — the entity record is not there; nothing fires this beat',
      );
      // The failed beat did not end the child: the next tick asks the list again.
      served.tick(now);
      await waitUntil(() => reads === 2);
    } finally {
      served.stop();
      expect(await served.done).toBe(0);
    }
  }, 10_000);

  test('a reminder-note frame carries one line and refuses an empty one', () => {
    expect(readChildMessage({ type: 'reminder-note', text: 'reminders: sent 1' })).toEqual({
      type: 'reminder-note',
      text: 'reminders: sent 1',
    });
    expect(readChildMessage({ type: 'reminder-note', text: '' })).toBeNull();
    expect(readChildMessage({ type: 'reminder-note', text: 7 })).toBeNull();
  });
});
