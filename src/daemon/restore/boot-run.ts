// The daemon's boot work, with its world injected (see boot-sessions.ts for the records):
// plan this boot's queue durably, then work it (one route at a time, under the load guard),
// while the observer keeps the running-routes record current for the next restart. The
// observer never starts before the queue is planned and written, so a restart's evidence is
// never replaced before it has become durable work.
import {
  bootRouteProblem,
  planBootQueue,
  type BootQueue,
  type BootRoute,
  type SessionsRunning,
} from './boot-sessions.ts';

export type BootRunDeps = {
  bootId: () => Promise<string | null>;
  readObserved: () => SessionsRunning | null;
  readQueue: () => BootQueue | null;
  writeQueue: (queue: BootQueue) => boolean;
  writeObserved: (record: SessionsRunning) => boolean;
  /** The terminal host's sessions, name to running; null when it did not answer. */
  sessions: () => Promise<ReadonlyMap<string, boolean> | null>;
  /** Starts a session that reads stopped (the check is the helper's own, right before it). */
  start: (session: string) => Promise<'started' | 'not-stopped' | 'unread' | 'failed'>;
  /** The routes the daemon hosts now (root, team, session). */
  hosted: () => readonly BootRoute[];
  /** Why the registered team may not be restored (stopped, archived…), or null. */
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

/** Plans this boot's queue and writes it when new. Null when there is no boot work. */
export async function planBoot(deps: BootRunDeps): Promise<{ boot: string | null; queue: BootQueue | null }> {
  const boot = await deps.bootId();
  if (boot === null) {
    deps.log('restore: this boot\'s id could not be read; no session is started after a restart');
    return { boot: null, queue: null };
  }
  const planned = planBootQueue(deps.readObserved(), deps.readQueue(), boot);
  if (planned === null) return { boot, queue: null };
  if (planned.isNew) {
    if (!deps.writeQueue(planned.queue)) {
      // Fail closed: work that is not durable could be lost or repeated by a later daemon.
      deps.log('restore: the machine restarted, but the boot queue could not be written; no session is started (attach them to restore them)');
      return { boot, queue: null };
    }
    const names = planned.queue.pending.map((route) => route.session);
    deps.log(`restore: machine restart: ${String(names.length)} registered session${names.length === 1 ? '' : 's'} ran before it (${names.join(', ')}); each still stopped is started again under the load guard`);
  } else if (planned.queue.pending.length > 0) {
    deps.log(`restore: resuming this boot's queue: ${planned.queue.pending.map((route) => route.session).join(', ')}`);
  }
  return { boot, queue: planned.queue };
}

/** Works the queue until every route is settled, the budget runs out, or the daemon closes. */
export async function workBootQueue(deps: BootRunDeps, queue: BootQueue): Promise<void> {
  const startedAt = deps.now();
  const settle = (route: BootRoute, outcome: string): void => {
    queue.pending = queue.pending.filter((one) => !(one.root === route.root && one.team === route.team && one.session === route.session));
    queue.settled.push({ route, outcome });
    if (!deps.writeQueue(queue)) deps.log(`restore: the boot queue could not be written after ${route.session} (${outcome})`);
  };
  while (queue.pending.length > 0) {
    if (deps.now() - startedAt > deps.budgetMs) {
      deps.log(`restore: boot queue left after the wait bound: ${queue.pending.map((route) => route.session).join(', ')} (attach them to restore them)`);
      return;
    }
    const route = queue.pending[0] as BootRoute;
    const problem = bootRouteProblem(route, deps.hosted(), deps.lifecycleProblem);
    if (problem !== null) {
      deps.log(`restore: session ${route.session} not started: ${problem}`);
      settle(route, `invalidated: ${problem}`);
      continue;
    }
    if (deps.loadPerCore() > deps.loadMaxPerCore) {
      if (!(await deps.wait(deps.retryMs))) return;
      continue;
    }
    const outcome = await deps.start(route.session);
    if (outcome === 'started') {
      deps.log(`restore: session ${route.session} started again after the machine restart`);
      settle(route, 'started');
      if (!(await deps.wait(deps.gapMs))) return;
      continue;
    }
    if (outcome === 'not-stopped') {
      // Running already (attached), or no longer a session the host knows: nothing to start.
      const sessions = await deps.sessions();
      const running = sessions?.get(route.session);
      settle(route, running === true ? 'already running' : 'invalidated: the terminal host no longer lists the session');
      continue;
    }
    // A host that did not answer, or a spawn that failed: passing, so it stays queued.
    deps.log(`restore: session ${route.session} not started yet (${outcome}); retried`);
    if (!(await deps.wait(deps.retryMs))) return;
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
    if (!ok && !failing) deps.log('restore: the running-sessions record could not be written; the next restart may not bring sessions back');
    if (ok && failing) deps.log('restore: the running-sessions record is written again');
    failing = !ok;
  }
}

/** The whole boot work: plan, then work the queue and observe side by side. */
export async function runBootWork(deps: BootRunDeps): Promise<void> {
  const { boot, queue } = await planBoot(deps);
  if (boot === null) return;
  const observing = observeRunning(deps, boot);
  if (queue !== null) await workBootQueue(deps, queue);
  await observing;
}
