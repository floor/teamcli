// Restarting a dead project bus without an owner at a terminal.
//
// The daemon's heartbeat and `team up` both ask this. A live socket is left alone. A dead one is
// started again, and a start that does not come up waits — one second, then two, then four, and
// so on, never more than thirty — so a socket that cannot bind is not retried on every tick.
// The wait is the only state: the next ask reads the socket again and decides from that.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { busListening, startBus, type BusHandle, type StartBusInput, type StartBusResult } from './server.ts';

/** How long to wait after `failures` starts that did not come up. The first wait is one second. */
export function nextBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(30_000, 1000 * 2 ** (failures - 1));
}

export type BusWatch = { failures: number; nextAt: number; starting: boolean };

export function freshBusWatch(): BusWatch {
  return { failures: 0, nextAt: 0, starting: false };
}

export type ReviveResult =
  | { kind: 'listening' }
  | { kind: 'waiting'; nextAt: number }
  | { kind: 'serving'; handle: BusHandle; cleared: boolean }
  | { kind: 'busy' }
  | { kind: 'failed'; nextAt: number; why: string };

/**
 * Brings a dead bus back, or reports that it is already answering. `listening` and `start` are
 * the real socket probe and `startBus` unless a test stands in for them. A watch already inside
 * `start` returns `waiting` so two ticks cannot bind the same socket.
 */
export async function reviveBus(
  input: StartBusInput,
  watch: BusWatch,
  nowMs: number,
  listening: () => Promise<boolean> = () => busListening(input.root),
  start: (input: StartBusInput) => Promise<StartBusResult> = startBus,
): Promise<ReviveResult> {
  if (watch.starting) return { kind: 'waiting', nextAt: watch.nextAt };
  if (await listening()) {
    watch.failures = 0;
    watch.nextAt = 0;
    return { kind: 'listening' };
  }
  if (nowMs < watch.nextAt) return { kind: 'waiting', nextAt: watch.nextAt };
  watch.starting = true;
  try {
    const started = await start(input);
    if (started.kind === 'serving' || started.kind === 'busy') {
      watch.failures = 0;
      watch.nextAt = 0;
      return started.kind === 'serving'
        ? { kind: 'serving', handle: started.handle, cleared: started.cleared }
        : { kind: 'busy' };
    }
    watch.failures += 1;
    watch.nextAt = nowMs + nextBackoffMs(watch.failures);
    const why = started.kind === 'locked' ? 'another bus server is starting' : 'the bus socket could not be bound';
    return { kind: 'failed', nextAt: watch.nextAt, why };
  } finally {
    watch.starting = false;
  }
}

/**
 * Starts `team bus` in its own process when this checkout's socket is dead, and returns without
 * waiting for it. The child proves it was started from here by reading a one-use token under
 * `.agents` (mode 0600); `team bus` consumes that token and then serves. A live socket starts
 * nothing. A checkout with no `.agents` directory yet gets one for the token alone.
 */
export async function spawnInheritedBus(root: string, home?: string): Promise<'listening' | 'spawned'> {
  if (await busListening(root)) return 'listening';
  const nonce = randomBytes(16).toString('hex');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'bus.inherit'), `${nonce}\n`, { mode: 0o600 });
  const here = fileURLToPath(import.meta.url);
  const entry = join(dirname(here), '..', here.endsWith('.ts') ? 'cli.ts' : 'cli.js');
  const child = spawn(process.execPath, [entry, 'bus', '--inherited', nonce], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...(home === undefined ? {} : { HOME: home }) },
  });
  child.unref();
  return 'spawned';
}
