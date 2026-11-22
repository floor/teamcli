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
  dropSessionsRunning,
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
  /** Only the observation cannot be written (the queue can). */
  failObserve?: boolean;
  /** Sessions whose server never comes up. */
  dead?: Set<string>;
  /** Runs while the start awaits its read of the terminal host. */
  duringRead?: (session: string) => Promise<void> | void;
  /** Sessions whose server is spawned but not up within the bound (the child lives on). */
  slow?: Set<string>;
  lock?: BootRunDeps['lock'];
  childState?: BootRunDeps['childState'];
  /** The daemon dies right after writing the reservation, before the spawn. */
  crashAfterReserve?: boolean;
}) {
  const spawns: string[] = [];
  const live = new Set<number>();
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
    writeObserved: (record) => (opts.failWrites === true || opts.failObserve === true ? false : writeSessionsRunning(home, record)),
    dropObserved: () => dropSessionsRunning(home),
    sessions: async () => new Map<string, boolean>([...[...stopped].map((name): [string, boolean] => [name, false]), ...[...running].map((name): [string, boolean] => [name, true])]),
    facts: async (root) => {
      if (opts.facts !== undefined) return opts.facts(root);
      const route = routes.find((one) => one.root === root);
      return route === undefined ? { boot: opts.boot, hosted: { problem: 'the root is no longer hosted' }, registry: null } : good(route, opts.boot);
    },
    factsNow: (root) => {
      if (opts.facts !== undefined) return opts.facts(root);
      const route = routes.find((one) => one.root === root);
      return route === undefined ? { boot: opts.boot, hosted: { problem: 'the root is no longer hosted' }, registry: null } : good(route, opts.boot);
    },
    start: async (session, hooks) => {
      attempts.push(session);
      // As startStoppedServer: the read of the host, then proof, reservation, spawn, identity.
      await opts.duringRead?.(session);
      if (!stopped.has(session)) return { kind: 'not-stopped' };
      if (hooks.proveNow !== undefined && !hooks.proveNow()) return { kind: 'refused' };
      if (hooks.reserve !== undefined && !hooks.reserve()) return { kind: 'refused' };
      if (opts.crashAfterReserve === true) throw new Error('daemon died after the reservation');
      spawns.push(session);
      if (opts.slow?.has(session) === true) {
        // Spawned, not up within the bound: the child lives on with this pid.
        live.add(4242);
        hooks.spawned?.({ pid: 4242, start: 1_000 });
        return { kind: 'failed', child: { pid: 4242, start: 1_000 } };
      }
      if (opts.dead?.has(session) === true) return { kind: 'failed' };
      hooks.spawned?.({ pid: 5000 + spawns.length, start: 2_000 });
      started.push(session);
      stopped.delete(session);
      running.add(session);
      return { kind: 'started' };
    },
    lock: (root, session) => (opts.lock !== undefined ? opts.lock(root, session) : { release: () => {} }),
    childState: (child) => (opts.childState !== undefined ? opts.childState(child) : live.has(child.pid) && child.start === 1_000 ? 'alive' : 'gone'),
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
  return { deps, started, attempts, spawns, live, logs, stopped, running, limitWaits: (n: number) => { maxWaits = n; waits = 0; } };
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

test('a boot restore held by the load says so once, and says when it goes on', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR] });
  const w = world({ boot: BOOT_B, stopped: new Set(['floor']), load: [9, 9, 9] });
  w.limitWaits(6);
  await runBootWork(w.deps);
  expect(w.started).toEqual(['floor']);
  const held = w.logs.filter((line) => line.includes("over the boot restore's bound of 3"));
  expect(held).toHaveLength(1);
  expect(held[0]).toContain('floor wait for it to fall');
  expect(w.logs).toContain('restore: the load fell under the bound; the boot restore goes on');
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

test('a team taken down while the start reads the host is refused at the spawn, and stays pending', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR] });
  let lifecycle = 'running';
  const w = world({
    boot: BOOT_B,
    stopped: new Set(['floor']),
    facts: () => ({ ...good(FLOOR), registry: { ...FLOOR, lifecycle } }),
    // The proof before the start passes; during the start's own read the team goes down.
    duringRead: () => { lifecycle = 'stopped'; },
  });
  w.limitWaits(2);
  await runBootWork(w.deps);
  expect(w.attempts.length >= 1).toBe(true);
  expect(w.started).toEqual([]);
  expect(w.stopped.has('floor')).toBe(true);
  expect(readBootQueue(home)?.pending[0]?.last).toBe('the registry team is stopped');
});

test('a session rebound while the start reads the host is refused at the spawn', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR] });
  let session = 'floor';
  const w = world({
    boot: BOOT_B,
    stopped: new Set(['floor']),
    facts: () => ({ ...good(FLOOR), registry: { ...FLOOR, session, lifecycle: 'running' } }),
    duringRead: () => { session = 'floor-new'; },
  });
  w.limitWaits(2);
  await runBootWork(w.deps);
  expect(w.started).toEqual([]);
  expect(readBootQueue(home)?.pending[0]?.last).toBe('the registry names session "floor-new", not "floor"');
});

test('a server spawned but not up in time is never doubled: retries wait for it, and it settles once up', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR] });
  const w = world({ boot: BOOT_B, stopped: new Set(['floor']), slow: new Set(['floor']) });
  w.limitWaits(4);
  await runBootWork(w.deps);
  // One spawn only, across every pass; the queue keeps the child and says why it waits.
  expect(w.spawns).toEqual(['floor']);
  const entry = readBootQueue(home)?.pending[0];
  expect(entry?.child).toEqual({ pid: 4242, start: 1_000 });
  expect(entry?.last).toBe('its server from an earlier attempt is still starting');
  // A same-boot daemon resumes: the child is still alive and now up, so it settles, unspawned.
  const v = world({ boot: BOOT_B, running: new Set(['floor']) });
  v.live.add(4242);
  v.limitWaits(2);
  await runBootWork(v.deps);
  expect(v.spawns).toEqual([]);
  expect(readBootQueue(home)?.settled.map((one) => one.outcome)).toEqual(['started (by an earlier attempt)']);
});

test('once the earlier attempt\'s server is gone, the record clears and a fresh start may run', async () => {
  writeBootQueue(home, { boot: BOOT_B, from: BOOT_A, pending: [{ ...FLOOR, child: { pid: 4242, start: 1_000 }, tries: 1 }], settled: [] });
  const w = world({ boot: BOOT_B, stopped: new Set(['floor']) });
  w.limitWaits(2);
  await runBootWork(w.deps);
  expect(w.spawns).toEqual(['floor']);
  expect(w.started).toEqual(['floor']);
});

test('a live child whose start time cannot be read is not gone: no second spawn across passes and a restart', async () => {
  writeBootQueue(home, { boot: BOOT_B, from: BOOT_A, pending: [{ ...FLOOR, child: { pid: 4242, start: 1_000 }, tries: 1 }], settled: [] });
  const w = world({ boot: BOOT_B, stopped: new Set(['floor']), childState: () => 'unknown' });
  w.limitWaits(3);
  await runBootWork(w.deps);
  const v = world({ boot: BOOT_B, stopped: new Set(['floor']), childState: () => 'unknown' });
  v.limitWaits(3);
  await runBootWork(v.deps);
  expect(w.spawns.length + v.spawns.length).toBe(0);
  expect(readBootQueue(home)?.pending[0]?.child).toEqual({ pid: 4242, start: 1_000 });
  expect(readBootQueue(home)?.pending[0]?.last).toBe('its earlier server cannot be told to be gone; not started again');
});

test('a daemon that dies after the reservation leaves a record that blocks a second spawn', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR] });
  const w = world({ boot: BOOT_B, stopped: new Set(['floor']), crashAfterReserve: true });
  const planned = await planBoot(w.deps);
  if (planned.kind !== 'work') throw new Error('no work');
  w.limitWaits(2);
  await expect(workBootQueue(w.deps, planned.queue)).rejects.toThrow('daemon died after the reservation');
  expect(readBootQueue(home)?.pending[0]?.child).toEqual({ pid: null, start: null });
  // The next daemon of this boot: the reservation is unresolved, so nothing is spawned.
  const v = world({ boot: BOOT_B, stopped: new Set(['floor']) });
  v.limitWaits(3);
  await runBootWork(v.deps);
  expect(v.spawns).toEqual([]);
  expect(readBootQueue(home)?.pending[0]?.last).toBe('an earlier start was reserved and its outcome is unknown; not started again (attach it to restore it)');
});

test('the spawned child\'s identity is durable at once, before the start resolves', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR] });
  let seenDuring: unknown;
  const w = world({ boot: BOOT_B, stopped: new Set(['floor']), slow: new Set(['floor']) });
  const start = w.deps.start;
  w.deps.start = async (session, hooks) => start(session, {
    ...hooks,
    spawned: (child) => { hooks.spawned?.(child); seenDuring = readBootQueue(home)?.pending[0]?.child; },
  });
  w.limitWaits(2);
  await runBootWork(w.deps);
  expect(seenDuring).toEqual({ pid: 4242, start: 1_000 });
});

test('two processes: a team down holding the session run lock means no spawn; released, the start runs', async () => {
  const { acquireRunLock } = await import('../src/launch/run-lock.ts');
  const lockDir = join(home, 'team-dir');
  mkdirSync(lockDir, { recursive: true });
  // Another process (as `team down` would) takes the session's run lock and keeps it.
  const holder = Bun.spawn(['bun', '-e', `
    const { acquireRunLock } = await import(${JSON.stringify(new URL('../src/launch/run-lock.ts', import.meta.url).pathname)});
    const lock = acquireRunLock(${JSON.stringify(lockDir)}, 'floor');
    if ('held' in lock) process.exit(3);
    console.log('locked');
    await new Promise((resolve) => process.stdin.once('data', resolve));
    lock.release();
  `], { stdin: 'pipe', stdout: 'pipe' });
  const realLock: BootRunDeps['lock'] = (_root, session) => {
    const taken = acquireRunLock(lockDir, session);
    return 'held' in taken ? { held: `another session-mutating run is holding session ${session}` } : taken;
  };
  try {
    const reader = holder.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('locked');
    reader.releaseLock();
    writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR] });
    const w = world({ boot: BOOT_B, stopped: new Set(['floor']), lock: realLock });
    w.limitWaits(2);
    await runBootWork(w.deps);
    expect(w.attempts).toEqual([]);
    expect(readBootQueue(home)?.pending[0]?.last).toBe('another session-mutating run is holding session floor');
    // The other process releases: the next daemon pass takes the lock and starts.
    holder.stdin.write('go\n');
    holder.stdin.end();
    await holder.exited;
  } finally {
    // Never leave the holder behind, whatever failed above.
    holder.kill();
  }
  const v = world({ boot: BOOT_B, stopped: new Set(['floor']), lock: realLock });
  v.limitWaits(2);
  await runBootWork(v.deps);
  expect(v.started).toEqual(['floor']);
});

test('the socket probe proves absence only for a missing or refused socket', async () => {
  const { socketProbe } = await import('../src/herdr-direct.ts');
  const probe = socketProbe();
  if (probe === null) return; // not macOS/Bun: the probe is unbound and every look is unknown
  const dir = join(home, 'sock');
  mkdirSync(dir, { recursive: true });
  // No socket file: proven absent.
  expect(probe(join(dir, 'none.sock'))).toBe('absent');
  // A listener: a successful connect is a live server, whatever it would answer.
  const path = join(dir, 'live.sock');
  const server = Bun.listen({ unix: path, socket: { data() {}, open(socket) { socket.end(); } } });
  expect(probe(path)).toBe('listening');
  server.stop(true);
  // A path too long to bind: not proof of anything.
  expect(probe(join(dir, 'x'.repeat(120)))).toBe('unknown');
  // A file that is not a socket: not proof of absence.
  writeFileSync(join(dir, 'plain'), '');
  expect(probe(join(dir, 'plain'))).not.toBe('listening');
});

const SHARED: BootRoute = { root: '/w/docs', team: 'docs', session: 'floor' };

test('two roots sharing one terminal session make one start: one spawn across both routes and a restart', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR, SHARED] });
  const w = world({ boot: BOOT_B, stopped: new Set(['floor']), slow: new Set(['floor']), hosted: [FLOOR, SHARED, MATERIAL] });
  w.limitWaits(4);
  await runBootWork(w.deps);
  const v = world({ boot: BOOT_B, stopped: new Set(['floor']), slow: new Set(['floor']), hosted: [FLOOR, SHARED, MATERIAL] });
  v.live.add(4242);
  v.limitWaits(3);
  await runBootWork(v.deps);
  expect(w.spawns.length + v.spawns.length).toBe(1);
  // Both routes stay queued for the one session; neither is settled until its server is up.
  expect(readBootQueue(home)?.pending.map((one) => one.session)).toEqual(['floor', 'floor']);
});

test('a shared session\'s start is owned across entries: a second entry for it never spawns while the first holds a child', async () => {
  writeBootQueue(home, { boot: BOOT_B, from: BOOT_A, pending: [{ ...FLOOR, child: { pid: 4242, start: 1_000 } }, { ...SHARED }], settled: [] });
  const w = world({ boot: BOOT_B, stopped: new Set(['floor']), hosted: [FLOOR, SHARED], childState: () => 'alive' });
  w.limitWaits(3);
  await runBootWork(w.deps);
  expect(w.spawns).toEqual([]);
});

test('an observation that can no longer be written is removed: the next restart restores nothing stale', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR] });
  // This boot: nothing to restore (already its queue), but every observation write fails.
  writeBootQueue(home, { boot: BOOT_B, from: BOOT_A, pending: [], settled: [] });
  const w = world({ boot: BOOT_B, running: new Set(['floor']), failObserve: true });
  w.limitWaits(1);
  await runBootWork(w.deps);
  expect(readSessionsRunning(home)).toBeNull();
  expect(w.logs.join('\n')).toContain('it was removed, so the next restart brings no session back');
  // The next boot finds no evidence and starts nothing (a session stopped by hand stays stopped).
  const next = world({ boot: BOOT_C, stopped: new Set(['floor']) });
  next.limitWaits(2);
  await runBootWork(next.deps);
  expect(next.spawns).toEqual([]);
  expect(dropSessionsRunning(home)).toBe(true);
});

test('every owner of a session is checked: a gone first owner never unblocks a live or unknown second', async () => {
  for (const second of ['alive', 'unknown'] as const) {
    writeBootQueue(home, {
      boot: BOOT_B,
      from: BOOT_A,
      pending: [{ ...FLOOR, child: { pid: 1111, start: 1 } }, { ...SHARED, child: { pid: 2222, start: 2 } }],
      settled: [],
    });
    const w = world({
      boot: BOOT_B,
      stopped: new Set(['floor']),
      hosted: [FLOOR, SHARED],
      childState: (child) => (child.pid === 1111 ? 'gone' : second),
    });
    w.limitWaits(3);
    await runBootWork(w.deps);
    expect(w.spawns).toEqual([]);
    // The second owner's record stays; it still blocks a later daemon.
    expect(readBootQueue(home)?.pending.find((one) => one.root === SHARED.root)?.child).toEqual({ pid: 2222, start: 2 });
  }
});

test('when every owner of a session is proven gone, the records clear and one start runs', async () => {
  writeBootQueue(home, {
    boot: BOOT_B,
    from: BOOT_A,
    pending: [{ ...FLOOR, child: { pid: 1111, start: 1 } }, { ...SHARED, child: { pid: 2222, start: 2 } }],
    settled: [],
  });
  const w = world({ boot: BOOT_B, stopped: new Set(['floor']), hosted: [FLOOR, SHARED], childState: () => 'gone' });
  w.limitWaits(3);
  await runBootWork(w.deps);
  expect(w.spawns).toEqual(['floor']);
});

test('a shared session whose first route fails its proof is started through the next eligible route, once', async () => {
  writeSessionsRunning(home, { boot: BOOT_A, at: 1, running: [FLOOR, SHARED] });
  const w = world({
    boot: BOOT_B,
    stopped: new Set(['floor']),
    hosted: [FLOOR, SHARED],
    facts: (root) => (root === FLOOR.root ? { ...good(FLOOR), registry: { ...FLOOR, lifecycle: 'stopped' } } : good(SHARED)),
  });
  w.limitWaits(3);
  await runBootWork(w.deps);
  expect(w.spawns).toEqual(['floor']);
  const queue = readBootQueue(home);
  expect(queue?.pending).toEqual([]);
  expect(queue?.settled.map((one) => [one.route.root, one.outcome])).toEqual([
    [FLOOR.root, `started (session shared with ${SHARED.root})`],
    [SHARED.root, 'started'],
  ]);
});
