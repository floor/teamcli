// Boot restore (reviews of c54febae5): only registered, hosted team routes are started; the
// evidence is a per-boot id, never a clock; the queue is durable and resumed by a daemon
// restarted in the same boot; a route stopped or rebound since is invalidated, not started.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootId,
  bootQueuePath,
  bootRouteProblem,
  planBootQueue,
  readBootQueue,
  readSessionsRunning,
  sessionsRunningPath,
  writeBootQueue,
  writeSessionsRunning,
  type BootQueue,
  type BootRoute,
  type SessionsRunning,
} from '../src/daemon/restore/boot-sessions.ts';
import { planBoot, runBootWork, workBootQueue, type BootRunDeps } from '../src/daemon/restore/boot-run.ts';

const FLOOR: BootRoute = { root: '/w/floor', team: 'floor', session: 'floor' };
const MATERIAL: BootRoute = { root: '/w/material', team: 'material', session: 'material' };
const BOOT_A = 'AAAAAAAA-0000-4000-8000-000000000001';
const BOOT_B = 'BBBBBBBB-0000-4000-8000-000000000002';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'boot-sessions-')));
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

test('both records round-trip, and malformed ones read as absent', () => {
  expect(writeSessionsRunning(home, { boot: BOOT_A, at: 5, running: [FLOOR, FLOOR, MATERIAL] })).toBe(true);
  expect(readSessionsRunning(home)).toEqual({ boot: BOOT_A, at: 5, running: [FLOOR, MATERIAL] });
  const queue: BootQueue = { boot: BOOT_A, pending: [MATERIAL], settled: [{ route: FLOOR, outcome: 'started' }] };
  expect(writeBootQueue(home, queue)).toBe(true);
  expect(readBootQueue(home)).toEqual(queue);
  writeFileSync(sessionsRunningPath(home), '{"boot":"x","at":1,"running":[{"root":"rel","team":"t","session":"s"}]}');
  expect(readSessionsRunning(home)).toBeNull();
  writeFileSync(sessionsRunningPath(home), '{"boot":"x","at":1,"running":[{"root":"/r","team":"t","session":"../x"}]}');
  expect(readSessionsRunning(home)).toBeNull();
  writeFileSync(bootQueuePath(home), 'not json');
  expect(readBootQueue(home)).toBeNull();
});

test('the boot id is the kernel boot session uuid, never a clock reading', async () => {
  expect(await bootId(async () => 'f80266ef-87a4-4e2f-970f-fd832d002c52\n')).toBe('F80266EF-87A4-4E2F-970F-FD832D002C52');
  expect(await bootId(async () => '{ sec = 1763403968, usec = 1 }')).toBeNull();
  expect(await bootId(async () => { throw new Error('no sysctl'); })).toBeNull();
});

test('a queue is planned only from another boot\'s observation, and a same-boot queue is resumed', () => {
  const observed: SessionsRunning = { boot: BOOT_A, at: 1, running: [FLOOR, MATERIAL] };
  // Another boot's observation: a new queue.
  expect(planBootQueue(observed, null, BOOT_B)).toEqual({ queue: { boot: BOOT_B, pending: [FLOOR, MATERIAL], settled: [] }, isNew: true });
  // This boot's observation (a daemon restarted later, or a clock change): nothing.
  expect(planBootQueue(observed, null, BOOT_A)).toBeNull();
  // A stored queue of this boot wins over any observation: resumed, never re-derived.
  const stored: BootQueue = { boot: BOOT_B, pending: [MATERIAL], settled: [{ route: FLOOR, outcome: 'started' }] };
  expect(planBootQueue({ boot: BOOT_B, at: 9, running: [] }, stored, BOOT_B)).toEqual({ queue: stored, isNew: false });
  // An old boot's queue is not resumed.
  expect(planBootQueue(null, { ...stored, boot: BOOT_A }, BOOT_B)).toBeNull();
  // No boot id: nothing.
  expect(planBootQueue(observed, null, null)).toBeNull();
});

test('a route is eligible only while it is the same hosted route of a team that is not stopped', () => {
  const ok = () => null;
  expect(bootRouteProblem(FLOOR, [FLOOR], ok)).toBeNull();
  expect(bootRouteProblem(FLOOR, [MATERIAL], ok)).toBe('the root is no longer hosted');
  expect(bootRouteProblem(FLOOR, [{ ...FLOOR, session: 'floor2' }], ok)).toBe('the team\'s session is now "floor2", not "floor"');
  expect(bootRouteProblem(FLOOR, [{ ...FLOOR, team: 'other' }], ok)).toBe('the root now hosts team "other", not "floor"');
  expect(bootRouteProblem(FLOOR, [FLOOR], () => 'the registry team is stopped')).toBe('the registry team is stopped');
});

/** A world for the orchestration: files in `home`, a fake terminal host and load. */
function world(opts: { boot: string; hosted?: BootRoute[]; stopped?: Set<string>; running?: Set<string>; load?: number[]; lifecycle?: (root: string) => string | null; failWrites?: boolean }) {
  const started: string[] = [];
  const logs: string[] = [];
  let clock = 0;
  const loads = [...(opts.load ?? [])];
  const stopped = opts.stopped ?? new Set<string>();
  const running = opts.running ?? new Set<string>();
  let waits = 0;
  let maxWaits = 50;
  const deps: BootRunDeps = {
    bootId: async () => opts.boot,
    readObserved: () => readSessionsRunning(home),
    readQueue: () => readBootQueue(home),
    writeQueue: (queue) => (opts.failWrites === true ? false : writeBootQueue(home, queue)),
    writeObserved: (record) => (opts.failWrites === true ? false : writeSessionsRunning(home, record)),
    sessions: async () => new Map<string, boolean>([...[...stopped].map((name): [string, boolean] => [name, false]), ...[...running].map((name): [string, boolean] => [name, true])]),
    start: async (session) => {
      if (!stopped.has(session)) return running.has(session) ? 'not-stopped' : 'not-stopped';
      started.push(session);
      stopped.delete(session);
      running.add(session);
      return 'started';
    },
    hosted: () => opts.hosted ?? [FLOOR, MATERIAL],
    lifecycleProblem: (root) => opts.lifecycle?.(root) ?? null,
    loadPerCore: () => (loads.length > 0 ? loads.shift() as number : 1),
    wait: async (ms) => { clock += ms; waits += 1; return waits <= maxWaits; },
    now: () => clock,
    log: (line) => { logs.push(line); },
    loadMaxPerCore: 3,
    gapMs: 20_000,
    retryMs: 15_000,
    budgetMs: 30 * 60_000,
    observeEveryMs: 10_000,
  };
  return { deps, started, logs, stopped, running, limitWaits: (n: number) => { maxWaits = n; waits = 0; } };
}

test('after a restart, only the registered routes that ran are started, and an unrelated session never is', async () => {
  // Before the restart: floor and material ran; a personal session ran too but is not a route.
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR, MATERIAL] });
  const w = world({ boot: BOOT_B, stopped: new Set(['floor', 'material', 'personal']) });
  w.limitWaits(3);
  await runBootWork(w.deps);
  expect(w.started).toEqual(['floor', 'material']);
  expect(w.stopped.has('personal')).toBe(true);
  expect(readBootQueue(home)?.pending).toEqual([]);
});

test('a team taken down, or a root rebound to another session, is invalidated, not started', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR, MATERIAL] });
  const w = world({
    boot: BOOT_B,
    stopped: new Set(['floor', 'material']),
    hosted: [{ ...FLOOR, session: 'floor-new' }, MATERIAL],
    lifecycle: (root) => (root === MATERIAL.root ? 'the registry team is stopped' : null),
  });
  w.limitWaits(3);
  await runBootWork(w.deps);
  expect(w.started).toEqual([]);
  const settled = readBootQueue(home)?.settled.map((one) => one.outcome) ?? [];
  expect(settled).toEqual([
    'invalidated: the team\'s session is now "floor-new", not "floor"',
    'invalidated: the registry team is stopped',
  ]);
});

test('held load across an observation, then a same-boot daemon restart: the queue survives and the sessions still start', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR, MATERIAL] });
  // First daemon: the load stays over the guard; the observer writes this boot's record meanwhile.
  const first = world({ boot: BOOT_B, stopped: new Set(['floor', 'material']), load: [9, 9, 9, 9, 9, 9] });
  const planned = await planBoot(first.deps);
  expect(planned.queue?.pending).toEqual([FLOOR, MATERIAL]);
  first.limitWaits(4);
  await workBootQueue(first.deps, planned.queue as BootQueue);
  writeSessionsRunning(home, { boot: BOOT_B, at: 99, running: [] });
  expect(first.started).toEqual([]);
  // Second daemon, same boot: this boot's observation is newer, but the stored queue is resumed.
  const second = world({ boot: BOOT_B, stopped: first.stopped });
  second.limitWaits(3);
  await runBootWork(second.deps);
  expect(second.started).toEqual(['floor', 'material']);
});

test('a queue that cannot be written starts nothing (fail closed), and says so', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR] });
  const w = world({ boot: BOOT_B, stopped: new Set(['floor']), failWrites: true });
  w.limitWaits(2);
  await runBootWork(w.deps);
  expect(w.started).toEqual([]);
  expect(w.logs.join('\n')).toContain('the boot queue could not be written; no session is started');
  expect(w.logs.join('\n')).toContain('the running-sessions record could not be written');
});

test('the observer records only hosted routes whose session runs and whose team is not stopped', async () => {
  const w = world({ boot: BOOT_B, running: new Set(['floor', 'material', 'personal']), lifecycle: (root) => (root === MATERIAL.root ? 'stopped' : null) });
  w.limitWaits(1);
  await runBootWork(w.deps);
  expect(readSessionsRunning(home)).toEqual({ boot: BOOT_B, at: 10_000, running: [FLOOR] });
});

test('a session stopped by hand is dropped from the record at the next observation', async () => {
  const w = world({ boot: BOOT_B, running: new Set(['floor', 'material']) });
  w.limitWaits(1);
  await runBootWork(w.deps);
  expect(readSessionsRunning(home)?.running).toEqual([FLOOR, MATERIAL]);
  const v = world({ boot: BOOT_B, running: new Set(['floor']), stopped: new Set(['material']) });
  v.limitWaits(1);
  await runBootWork(v.deps);
  expect(readSessionsRunning(home)?.running).toEqual([FLOOR]);
});
