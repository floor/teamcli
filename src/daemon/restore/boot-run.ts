// The daemon's boot work, with its world injected (see boot-sessions.ts for the records).
//
// 1. Plan: this boot's queue is derived from the previous boot's observation and written
//    durably. Until it is durable, nothing is started and the observation is never replaced:
//    a failed write is retried, and if it never succeeds the evidence stays for a later daemon.
// 2. Work: every pass visits every pending route (one stuck route never holds the others). A
//    start runs only on a positive proof read at that moment (`startProblem`): the boot is the
//    queue's, the root still hosts that team and session in its file, and the registry has a
//    running entry for that root with that team and session. A refused proof, a host that did
//    not answer, or a server that did not come up is written on the entry (`tries`, `last`) and
//    retried on the next pass; nothing is guessed and nothing is dropped. A route settles only
//    when its server is up (the session reads running after the start) or was already running.
// 3. Observe: once the queue is durable (or there is no boot work), the running hosted routes
//    are written for the next restart every few seconds.
import {
  planBootQueue,
  startProblem,
  type BootQueue,
  type BootRoute,
  type QueueEntry,
  type SessionsRunning,
  type StartFacts,
} from './boot-sessions.ts';
import type { StoppedServerHooks, StoppedServerStart } from '../../herdr.ts';

export type BootRunDeps = {
  bootId: () => Promise<string | null>;
  readObserved: () => SessionsRunning | null;
  readQueue: () => BootQueue | null;
  writeQueue: (queue: BootQueue) => boolean;
  writeObserved: (record: SessionsRunning) => boolean;
  /** Removes the observation (stale once it can no longer be written). True when it is gone. */
  dropObserved: () => boolean;
  /** The terminal host's sessions, name to running; null when it did not answer. */
  sessions: () => Promise<ReadonlyMap<string, boolean> | null>;
  /** The live facts for a root, read fresh (team file, registry, boot id). */
  facts: (root: string) => Promise<StartFacts>;
  /** The same facts read synchronously (team file and registry now; the boot id given), for the
   *  proof the start runs with nothing awaited between it and the spawn. */
  factsNow: (root: string, boot: string | null) => StartFacts;
  /** Starts a session that reads stopped and resolves once the server is up (or why not); the
   *  caller holds the session's run lock. The hooks run after its last await (see herdr.ts). */
  start: (session: string, hooks: StoppedServerHooks) => Promise<StoppedServerStart>;
  /** Takes the session's run lock (the one `team down`, `up` and `remove` take), without
   *  waiting: a release, or why it is held. */
  lock: (root: string, session: string) => { release: () => void } | { held: string };
  /** An earlier attempt's server: 'alive' (same pid, same start time), 'gone' (no such
   *  process, or a different start time: the pid was reused), or 'unknown' (not readable). */
  childState: (child: { pid: number; start: number | null }) => 'alive' | 'gone' | 'unknown';
  /** The routes the daemon hosts now (for the observation only; starts use `facts`). */
  hosted: () => readonly BootRoute[];
  /** Why the registered team may not be restored, or null (observation filter). */
  lifecycleProblem: (root: string, team: string) => string | null;
  loadPerCore: () => number;
  /** Waits `ms`; false when the daemon is closing. */
  wait: (ms: number) => Promise<boolean>;
  now: () => number;
  log: (line: string) => void;
  loadMaxPerCore: number;
  gapMs: number;
  retryMs: number;
  budgetMs: number;
  observeEveryMs: number;
};

type Plan = { kind: 'none' } | { kind: 'work'; boot: string; queue: BootQueue } | { kind: 'no-boot' } | { kind: 'unwritten'; boot: string; queue: BootQueue };

/** Plans this boot's queue. A new queue is written before it is returned as work. */
export async function planBoot(deps: BootRunDeps): Promise<Plan> {
  const boot = await deps.bootId();
  if (boot === null) {
    deps.log('restore: this boot\'s id could not be read; no session is started after a restart');
    return { kind: 'no-boot' };
  }
  const planned = planBootQueue(deps.readObserved(), deps.readQueue(), boot);
  if (planned === null) return { kind: 'none' };
  if (planned.isNew && !deps.writeQueue(planned.queue)) return { kind: 'unwritten', boot, queue: planned.queue };
  const names = planned.queue.pending.map((route) => route.session).join(', ');
  if (planned.isNew) deps.log(`restore: machine restart: registered sessions that ran before it: ${names}; each still stopped is started again on a fresh proof, under the load guard`);
  else if (planned.queue.pending.length > 0) deps.log(`restore: resuming this boot's queue: ${names}`);
  return { kind: 'work', boot, queue: planned.queue };
}

const same = (a: BootRoute, b: BootRoute): boolean => a.root === b.root && a.team === b.team && a.session === b.session;

/** Works the queue until every route is settled, the budget runs out, or the daemon closes. */
export async function workBootQueue(deps: BootRunDeps, queue: BootQueue): Promise<void> {
  const startedAt = deps.now();
  const save = (what: string): void => {
    if (!deps.writeQueue(queue)) deps.log(`restore: the boot queue could not be written (${what}); it is written again with the next change`);
  };
  // A route settles only when its terminal session is up (started, by this or an earlier
  // attempt, or already running): every entry of that session settles with it, the one that
  // started it by name and the others as sharing it.
  const settle = (route: QueueEntry, outcome: string): void => {
    const sharing = queue.pending.filter((one) => one.session === route.session);
    queue.pending = queue.pending.filter((one) => one.session !== route.session);
    for (const one of sharing) {
      queue.settled.push({
        route: { root: one.root, team: one.team, session: one.session },
        outcome: same(one, route) ? outcome : `${outcome} (session shared with ${route.root})`,
      });
    }
    save(`${route.session}: ${outcome}`);
  };
  const note = (route: QueueEntry, why: string): void => {
    const entry = queue.pending.find((one) => same(one, route));
    if (entry === undefined) return;
    entry.tries = (entry.tries ?? 0) + 1;
    if (entry.last !== why) deps.log(`restore: session ${route.session} not started yet: ${why}; retried`);
    entry.last = why;
    save(`${route.session}: ${why}`);
  };
  // The load guard holds every start while the machine is loaded, as it is right after a login.
  // The hold is said once per streak: a queue waiting on load is never silent.
  let loadHeld = false;
  while (queue.pending.length > 0) {
    if (deps.now() - startedAt > deps.budgetMs) {
      deps.log(`restore: boot queue left after the wait bound: ${queue.pending.map((route) => `${route.session} (${route.last ?? 'not tried'})`).join(', ')}; attach them to restore them`);
      return;
    }
    let startedOne = false;
    for (const route of [...queue.pending]) {
      const load = deps.loadPerCore();
      if (load > deps.loadMaxPerCore) {
        if (!loadHeld) deps.log(`restore: the load is ${load.toFixed(1)} per core, over the boot restore's bound of ${String(deps.loadMaxPerCore)}; ${queue.pending.map((one) => one.session).join(', ')} wait for it to fall`);
        loadHeld = true;
        break;
      }
      if (loadHeld) deps.log('restore: the load fell under the bound; the boot restore goes on');
      loadHeld = false;
      // A server an earlier attempt spawned (or reserved) is never doubled: while it lives, or
      // while it cannot be told to be gone, the route waits for it (and settles once its session
      // reads running). Only a proven exit or a reused pid clears the record. Ownership is per
      // terminal session: every pending entry for this session holding a child is checked, and
      // any one alive, reserved or not readable blocks the start. Only owners proven gone clear.
      const owners = queue.pending.filter((one) => one.session === route.session && one.child !== undefined);
      let blocking: { pid: number | null; state: 'alive' | 'unknown' } | null = null;
      const gone: QueueEntry[] = [];
      for (const owner of owners) {
        const child = owner.child as NonNullable<QueueEntry['child']>;
        const state = child.pid === null ? 'unknown' : deps.childState({ pid: child.pid, start: child.start });
        if (state === 'gone') gone.push(owner);
        else if (blocking === null || state === 'alive') blocking = { pid: child.pid, state };
      }
      if (blocking !== null) {
        if ((await deps.sessions())?.get(route.session) === true) settle(route, 'started (by an earlier attempt)');
        else note(route, blocking.pid === null
          ? 'an earlier start was reserved and its outcome is unknown; not started again (attach it to restore it)'
          : blocking.state === 'alive' ? 'its server from an earlier attempt is still starting' : 'its earlier server cannot be told to be gone; not started again');
        continue;
      }
      if (gone.length > 0) {
        for (const owner of gone) delete owner.child;
        save(`${route.session}: the earlier attempt's server is gone`);
      }
      const facts = await deps.facts(route.root);
      const problem = startProblem(route, queue.boot, facts);
      if (problem !== null) {
        note(route, problem);
        continue;
      }
      // The run lock `team down`, `up` and `remove` take is held across the observation, the
      // proof and the spawn: no other session mutation interleaves. Not taken: retried later.
      const lock = deps.lock(route.root, route.session);
      if ('held' in lock) {
        note(route, lock.held);
        continue;
      }
      let late: string | null = null;
      let result: StoppedServerStart;
      try {
        result = await deps.start(route.session, {
          // Under the lock, after the observation taken under it: the proof again, now.
          proveNow: () => {
            late = startProblem(route, queue.boot, deps.factsNow(route.root, facts.boot));
            return late === null;
          },
          // The in-flight reservation, durable before the spawn.
          reserve: () => {
            const held = queue.pending.find((one) => same(one, route));
            if (held === undefined) return false;
            held.child = { pid: null, start: null };
            return deps.writeQueue(queue);
          },
          // The child's identity, durable as soon as it exists.
          spawned: (child) => {
            const held = queue.pending.find((one) => same(one, route));
            if (held === undefined) return;
            held.child = child;
            save(`${route.session}: spawned ${String(child.pid)}`);
          },
        });
      } finally {
        lock.release();
      }
      const outcome = result.kind;
      if (outcome === 'refused') {
        const held = queue.pending.find((one) => same(one, route));
        if (held?.child !== undefined && held.child.pid === null && late === null) {
          // The reservation could not be written: nothing was spawned, so it is withdrawn.
          delete held.child;
          note(route, 'the in-flight reservation could not be written; not started');
        } else note(route, late ?? 'the proof failed at the start');
        continue;
      }
      if (result.kind === 'failed') {
        const held = queue.pending.find((one) => same(one, route));
        if (held?.child !== undefined && held.child.pid !== null) {
          // Spawned but not up in time: its identity is kept, so no retry doubles it.
          note(route, 'its server did not come up in time; that server is watched, not doubled');
          continue;
        }
        if (held?.child !== undefined && held.child.pid === null) {
          // Reserved, and the spawn itself failed: no process exists, so the reservation goes.
          delete held.child;
        }
      }
      if (outcome === 'started') {
        deps.log(`restore: session ${route.session} started again after the machine restart`);
        settle(route, 'started');
        startedOne = true;
        if (!(await deps.wait(deps.gapMs))) return;
        continue;
      }
      if (outcome === 'not-stopped') {
        const running = (await deps.sessions())?.get(route.session);
        if (running === true) settle(route, 'already running');
        else note(route, 'the terminal host does not list the session as stopped');
        continue;
      }
      note(route, outcome === 'unread' ? 'the terminal host did not answer' : 'its server did not come up');
    }
    if (queue.pending.length > 0 && !startedOne && !(await deps.wait(deps.retryMs))) return;
  }
}

/** Keeps the observation current for the next restart: the hosted routes whose session runs
 *  and whose registered team is not stopped. A failed write is said once per failing streak. */
export async function observeRunning(deps: BootRunDeps, boot: string): Promise<void> {
  let failing = false;
  while (await deps.wait(deps.observeEveryMs)) {
    const sessions = await deps.sessions();
    if (sessions === null) continue;
    const running = deps.hosted().filter((route) => sessions.get(route.session) === true && deps.lifecycleProblem(route.root, route.team) === null);
    const ok = deps.writeObserved({ boot, at: deps.now(), running: [...running] });
    if (!ok) {
      // An observation that can no longer be kept current is stale evidence: a session stopped
      // since would be restarted from it. It is removed, so the next restart restores nothing
      // rather than something stopped on purpose.
      const dropped = deps.dropObserved();
      if (!failing) {
        deps.log(dropped
          ? 'restore: the running-sessions record could not be written; it was removed, so the next restart brings no session back until it is written again'
          : 'restore: the running-sessions record could not be written or removed; the next restart may restore from an older record');
      }
    }
    if (ok && failing) deps.log('restore: the running-sessions record is written again');
    failing = !ok;
  }
}

/** The whole boot work: plan (retrying an unwritten queue), then work and observe side by side. */
export async function runBootWork(deps: BootRunDeps): Promise<void> {
  let plan = await planBoot(deps);
  if (plan.kind === 'no-boot') return;
  const startedAt = deps.now();
  while (plan.kind === 'unwritten') {
    // Not durable: nothing is started and the observation is left as it is, so the evidence
    // survives for this daemon's next try or a later daemon.
    deps.log('restore: the machine restarted, but the boot queue could not be written; nothing is started until it is');
    if (deps.now() - startedAt > deps.budgetMs || !(await deps.wait(deps.retryMs))) return;
    plan = deps.writeQueue(plan.queue) ? { kind: 'work', boot: plan.boot, queue: plan.queue } : plan;
  }
  const boot = plan.kind === 'work' ? plan.boot : await deps.bootId();
  if (boot === null) return;
  const observing = observeRunning(deps, boot);
  if (plan.kind === 'work') await workBootQueue(deps, plan.queue);
  await observing;
}
