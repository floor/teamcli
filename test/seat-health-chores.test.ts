// The watchdog slice on the chores child: it returns while a restart is still running,
// and the child's heartbeat is not the thing that waited. The host in the mapping scene
// is a fake. No pane is opened and no CLI is started.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { serveChoresChild } from '../src/daemon/chores/child.ts';
import { readChildMessage, type ChoresChildConfig, type ChoresChildMessage } from '../src/daemon/chores/protocol.ts';
import { WATCHDOG_AFTER_MS } from '../src/seat-health/proof.ts';
import { observeRoute, type SeatHealthHost } from '../src/seat-health/live.ts';
import { restartArgs } from '../src/seat-health/restart.ts';

const root = '/work/acme';

function config(): ChoresChildConfig {
  return {
    version: 1,
    home: '/tmp/seat-health-home',
    beatMs: 30,
    sliceMs: 2_000,
    since: '2026-11-04T00:00:00.000Z',
    routes: [{ root, team: 'acme', session: 'acme' }],
  };
}

function waitUntil(ready: () => boolean, boundMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (ready()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > boundMs) {
        clearInterval(timer);
        reject(new Error('the wait ended first'));
      }
    }, 10);
  });
}

describe('seat-health chores slice', () => {
  test('the slice returns while a restart is running, and the heartbeat is not that wait', async () => {
    let clock = Date.parse('2026-11-04T08:00:00.000Z');
    let release: (ready: { kind: 'ready' }) => void = () => {};
    let released = false;
    const restarts: (readonly string[])[] = [];
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
        if (message !== null) lines.push(message);
      }
    });
    const done = serveChoresChild({
      config: config(),
      stdin,
      stdout,
      now: () => new Date(clock),
      pass: async () => [],
      watchdog: {
        seats: async () => [{
          seat: 'crew',
          cli: 'claude-code',
          reconciled: 'working',
          hostStatus: 'working',
          plain: 'thinking',
          screenKind: 'working',
          presenceAt: '2026-11-04T08:00:00.000Z',
          processes: [
            { pid: 1, argv0: 'zsh', shell: true, cli: false },
            { pid: 2, argv0: 'claude', shell: false, cli: true },
          ],
          session: { kind: 'bound' },
          resume: '--resume abc123',
        }],
        restart(_route, _seat, args) {
          restarts.push(args);
          return new Promise((resolve) => {
            release = (ready) => {
              released = true;
              resolve(ready);
            };
          });
        },
        lead() {},
      },
    });
    const tick = (at: number): void => {
      stdin.write(`${JSON.stringify({ type: 'tick', id: `tick-${String(at)}`, at: new Date(at).toISOString() })}\n`);
    };
    await waitUntil(() => lines.some((line) => line.type === 'heartbeat'), 1_000);
    tick(clock);
    await waitUntil(() => lines.filter((line) => line.type === 'heartbeat').length >= 2, 1_000);
    clock += WATCHDOG_AFTER_MS;
    tick(clock);
    await waitUntil(() => restarts.length === 1, 1_000);
    const beats = lines.filter((line) => line.type === 'heartbeat').length;
    await waitUntil(() => lines.filter((line) => line.type === 'heartbeat').length > beats, 1_000);
    expect(released).toBe(false);
    expect(restarts).toEqual([restartArgs('crew')]);
    release({ kind: 'ready' });
    stdin.write(`${JSON.stringify({ type: 'stop', why: 'the test is done' })}\n`);
    expect(await done).toBe(0);
  });

  test('a fake process list names a live child that is not the CLI or the shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seat-health-observe-'));
    try {
      const host: SeatHealthHost = {
        agents: async () => [{ name: 'crew', pane: 'p1', status: 'working' }],
        text: async () => 'thinking',
        processes: async () => ({
          process_info: {
            shell_pid: 1,
            foreground_processes: [
              { pid: 1, argv0: 'zsh' },
              { pid: 2, argv0: 'claude' },
              { pid: 3, argv0: 'bun' },
            ],
          },
        }),
      };
      const seats = await observeRoute({
        home: dir,
        root: dir,
        session: 'acme',
        seats: [{ name: 'crew', cli: 'claude-code', launch: 'claude' }],
      }, host);
      expect(seats).toHaveLength(1);
      expect(seats[0]?.processes?.some((row) => row.argv0 === 'bun' && !row.cli && !row.shell)).toBe(true);
      expect(seats[0]?.processes?.some((row) => row.shell)).toBe(true);
      expect(seats[0]?.processes?.some((row) => row.cli)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
