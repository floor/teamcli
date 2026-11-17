// Boot restore (reviews of c54febae5 and d23287b71): a start runs only on a fresh positive proof
// (boot id, hosted route from the file read now, a running registry entry with the same team and
// session); the evidence is a per-boot id; the queue is durable, resumed in the same boot, built
// from an observation once only; every failure is a retryable record; every pending route is
// visited each pass; a route settles only once its server is up.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootId,
  bootQueuePath,
  planBootQueue,
  readBootQueue,
  readSessionsRunning,
  sessionsRunningPath,
  startProblem,
  writeBootQueue,
  writeSessionsRunning,
  type BootQueue,
  type BootRoute,
  type SessionsRunning,
  type StartFacts,
} from '../src/daemon/restore/boot-sessions.ts';
import { planBoot, runBootWork, workBootQueue, type BootRunDeps } from '../src/daemon/restore/boot-run.ts';

const FLOOR: BootRoute = { root: '/w/floor', team: 'floor', session: 'floor' };
const MATERIAL: BootRoute = { root: '/w/material', team: 'material', session: 'material' };
const BOOT_A = 'AAAAAAAA-0000-4000-8000-000000000001';
const BOOT_B = 'BBBBBBBB-0000-4000-8000-000000000002';
const BOOT_C = 'CCCCCCCC-0000-4000-8000-000000000003';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'boot-sessions-')));
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

test('both records round-trip, and malformed ones read as absent', () => {
  expect(writeSessionsRunning(home, { boot: BOOT_A, at: 5, running: [FLOOR, FLOOR, MATERIAL] })).toBe(true);
  expect(readSessionsRunning(home)).toEqual({ boot: BOOT_A, at: 5, running: [FLOOR, MATERIAL] });
  const queue: BootQueue = { boot: BOOT_B, from: BOOT_A, pending: [{ ...MATERIAL, tries: 2, last: 'the terminal host did not answer' }], settled: [{ route: FLOOR, outcome: 'started' }] };
  expect(writeBootQueue(home, queue)).toBe(true);
  expect(readBootQueue(home)).toEqual(queue);
  writeFileSync(sessionsRunningPath(home), '{"boot":"x","at":1,"running":[{"root":"rel","team":"t","session":"s"}]}');
  expect(readSessionsRunning(home)).toBeNull();
  writeFileSync(sessionsRunningPath(home), '{"boot":"x","at":1,"running":[{"root":"/r","team":"t","session":"../x"}]}');
  expect(readSessionsRunning(home)).toBeNull();
  writeFileSync(bootQueuePath(home), '{"boot":"x","pending":[],"settled":[]}');
  expect(readBootQueue(home)).toBeNull();
});

test('the boot id is the kernel boot session uuid, never a clock reading', async () => {
  expect(await bootId(async () => 'f80266ef-87a4-4e2f-970f-fd832d002c52\n')).toBe('F80266EF-87A4-4E2F-970F-FD832D002C52');
  expect(await bootId(async () => '{ sec = 1763403968, usec = 1 }')).toBeNull();
  expect(await bootId(async () => { throw new Error('no sysctl'); })).toBeNull();
});

test('a queue is planned once from another boot\'s observation; a same-boot queue is resumed', () => {
  const observed: SessionsRunning = { boot: BOOT_A, at: 1, running: [FLOOR, MATERIAL] };
  expect(planBootQueue(observed, null, BOOT_B)).toEqual({ queue: { boot: BOOT_B, from: BOOT_A, pending: [FLOOR, MATERIAL], settled: [] }, isNew: true });
  // This boot's observation (a later daemon, or a clock change): nothing.
  expect(planBootQueue(observed, null, BOOT_A)).toBeNull();
  // A stored queue of this boot is resumed, never re-derived.
  const stored: BootQueue = { boot: BOOT_B, from: BOOT_A, pending: [MATERIAL], settled: [{ route: FLOOR, outcome: 'started' }] };
  expect(planBootQueue({ boot: BOOT_B, at: 9, running: [] }, stored, BOOT_B)).toEqual({ queue: stored, isNew: false });
  // Boot C finds boot A's observation still on disk (boot B's observer never replaced it), but
  // boot B's queue was built from it: it is not replayed.
  expect(planBootQueue(observed, stored, BOOT_C)).toBeNull();
  expect(planBootQueue(observed, null, null)).toBeNull();
});

const good = (route: BootRoute, boot = BOOT_B): StartFacts => ({ boot, hosted: { ...route }, registry: { ...route, lifecycle: 'running' } });

test('a start needs the whole positive proof, read at the moment of the start', () => {
  expect(startProblem(FLOOR, BOOT_B, good(FLOOR))).toBeNull();
  expect(startProblem(FLOOR, BOOT_B, { ...good(FLOOR), boot: null })).toBe('this boot\'s id cannot be read now');
  expect(startProblem(FLOOR, BOOT_B, good(FLOOR, BOOT_C))).toBe('the boot id changed since the queue was planned');
  expect(startProblem(FLOOR, BOOT_B, { ...good(FLOOR), hosted: { problem: 'the root is no longer hosted' } })).toBe('the root is no longer hosted');
  expect(startProblem(FLOOR, BOOT_B, { ...good(FLOOR), hosted: { ...FLOOR, session: 'floor2' } })).toBe('the team\'s session is now "floor2", not "floor"');
  expect(startProblem(FLOOR, BOOT_B, { ...good(FLOOR), registry: null })).toBe('the registry has no team for this root');
  expect(startProblem(FLOOR, BOOT_B, { ...good(FLOOR), registry: { ...FLOOR, session: 'other', lifecycle: 'running' } })).toBe('the registry names session "other", not "floor"');
  expect(startProblem(FLOOR, BOOT_B, { ...good(FLOOR), registry: { ...FLOOR, lifecycle: 'stopped' } })).toBe('the registry team is stopped');
});

/** A world for the orchestration: files in `home`, a fake terminal host, load and facts. */
function world(opts: {
  boot: string;
  hosted?: BootRoute[];
  stopped?: Set<string>;
  running?: Set<string>;
  load?: number[];
  facts?: (root: string) => StartFacts;
  failWrites?: boolean;
  /** Sessions whose server never comes up. */
  dead?: Set<string>;
}) {
  const started: string[] = [];
  const attempts: string[] = [];
  const logs: string[] = [];
  let clock = 0;
  const loads = [...(opts.load ?? [])];
  const stopped = opts.stopped ?? new Set<string>();
  const running = opts.running ?? new Set<string>();
  let waits = 0;
  let maxWaits = 50;
  const routes = opts.hosted ?? [FLOOR, MATERIAL];
  const deps: BootRunDeps = {
    bootId: async () => opts.boot,
    readObserved: () => readSessionsRunning(home),
    readQueue: () => readBootQueue(home),
    writeQueue: (queue) => (opts.failWrites === true ? false : writeBootQueue(home, queue)),
    writeObserved: (record) => (opts.failWrites === true ? false : writeSessionsRunning(home, record)),
    sessions: async () => new Map<string, boolean>([...[...stopped].map((name): [string, boolean] => [name, false]), ...[...running].map((name): [string, boolean] => [name, true])]),
    facts: async (root) => {
      if (opts.facts !== undefined) return opts.facts(root);
      const route = routes.find((one) => one.root === root);
      return route === undefined ? { boot: opts.boot, hosted: { problem: 'the root is no longer hosted' }, registry: null } : good(route, opts.boot);
    },
    start: async (session) => {
      attempts.push(session);
      if (!stopped.has(session)) return 'not-stopped';
      if (opts.dead?.has(session) === true) return 'failed';
      started.push(session);
      stopped.delete(session);
      running.add(session);
      return 'started';
    },
    hosted: () => routes,
    lifecycleProblem: () => null,
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
  return { deps, started, attempts, logs, stopped, running, limitWaits: (n: number) => { maxWaits = n; waits = 0; } };
}

test('after a restart, only the registered routes that ran are started, and an unrelated session never is', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR, MATERIAL] });
  const w = world({ boot: BOOT_B, stopped: new Set(['floor', 'material', 'personal']) });
  w.limitWaits(3);
  await runBootWork(w.deps);
  expect(w.started).toEqual(['floor', 'material']);
  expect(w.stopped.has('personal')).toBe(true);
  expect(readBootQueue(home)?.pending).toEqual([]);
});

test('a refused proof is never started: it stays pending with its reason, and starts once the proof holds', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR] });
  let downed = true;
  const w = world({
    boot: BOOT_B,
    stopped: new Set(['floor']),
    facts: () => (downed ? { ...good(FLOOR), registry: { ...FLOOR, lifecycle: 'stopped' } } : good(FLOOR)),
  });
  const planned = await planBoot(w.deps);
  if (planned.kind !== 'work') throw new Error('no work');
  w.limitWaits(2);
  await workBootQueue(w.deps, planned.queue);
  expect(w.attempts).toEqual([]);
  const left = readBootQueue(home)?.pending[0];
  expect(left?.last).toBe('the registry team is stopped');
  expect((left?.tries ?? 0) >= 1).toBe(true);
  downed = false;
  w.limitWaits(3);
  await workBootQueue(w.deps, readBootQueue(home) as BootQueue);
  expect(w.started).toEqual(['floor']);
});

test('a stuck route does not hold the others: every pending route is visited each pass', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR, MATERIAL] });
  const w = world({ boot: BOOT_B, stopped: new Set(['floor', 'material']), dead: new Set(['floor']) });
  w.limitWaits(3);
  await runBootWork(w.deps);
  expect(w.started).toEqual(['material']);
  const queue = readBootQueue(home);
  expect(queue?.pending.map((one) => one.session)).toEqual(['floor']);
  expect(queue?.pending[0]?.last).toBe('its server did not come up');
  expect(queue?.settled.map((one) => one.outcome)).toEqual(['started']);
});

test('held load across an observation, then a same-boot daemon restart: the queue survives and the sessions start', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR, MATERIAL] });
  const first = world({ boot: BOOT_B, stopped: new Set(['floor', 'material']), load: [9, 9, 9, 9, 9, 9] });
  const planned = await planBoot(first.deps);
  if (planned.kind !== 'work') throw new Error('no work');
  first.limitWaits(4);
  await workBootQueue(first.deps, planned.queue);
  writeSessionsRunning(home, { boot: BOOT_B, at: 99, running: [] });
  expect(first.started).toEqual([]);
  const second = world({ boot: BOOT_B, stopped: first.stopped });
  second.limitWaits(3);
  await runBootWork(second.deps);
  expect(second.started).toEqual(['floor', 'material']);
});

test('an unwritable queue starts nothing and leaves the observation in place for a later daemon', async () => {
  const before: SessionsRunning = { boot: BOOT_A, at: 1, running: [FLOOR] };
  writeSessionsRunning(home, before);
  const w = world({ boot: BOOT_B, stopped: new Set(['floor']), failWrites: true });
  w.limitWaits(3);
  await runBootWork(w.deps);
  expect(w.started).toEqual([]);
  expect(w.logs.join('\n')).toContain('the boot queue could not be written; nothing is started until it is');
  expect(readSessionsRunning(home)).toEqual(before);
  // A later daemon in the same boot can write: it plans from the kept evidence and starts.
  const v = world({ boot: BOOT_B, stopped: new Set(['floor']) });
  v.limitWaits(3);
  await runBootWork(v.deps);
  expect(v.started).toEqual(['floor']);
});

test('the observer records only hosted routes whose session runs', async () => {
  const w = world({ boot: BOOT_B, running: new Set(['floor', 'personal']), stopped: new Set(['material']) });
  w.limitWaits(1);
  await runBootWork(w.deps);
  expect(readSessionsRunning(home)).toEqual({ boot: BOOT_B, at: 10_000, running: [FLOOR] });
});
