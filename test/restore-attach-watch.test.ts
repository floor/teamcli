// The restore attach watch on its own, and the restore phrases the daemon line prints. Synthetic
// routes and clocks only: no terminal host, daemon or launch.
import { expect, test } from 'bun:test';
import { createRestoreAttachWatch, sessionsRunningMap, type RestoreAttachAttempt, type RestorePending } from '../src/daemon/restore/attach-watch.ts';
import { restorePhrases } from '../src/daemon/health_display.ts';
import type { HostedRoute } from '../src/daemon/routes.ts';
import type { DaemonRootState } from '../src/daemon/state.ts';

const route = (name: string): HostedRoute => ({ root: `/work/${name}`, team: name, session: name, seats: ['lead'] });

function harness(options: {
  running: () => ReadonlyMap<string, boolean> | null;
  attempt: (route: HostedRoute) => RestoreAttachAttempt;
  loadBudgetMs?: number;
}) {
  let now = 0;
  let closing = false;
  let polls = 0;
  const pending = new Map<string, RestorePending | null>();
  const attempts: string[] = [];
  const lines: string[] = [];
  const watch = createRestoreAttachWatch({
    pollMs: 30_000,
    loadBudgetMs: options.loadBudgetMs ?? 90_000,
    sessionsRunning: async () => { polls++; return options.running(); },
    attempt: async (one) => { attempts.push(one.root); return options.attempt(one); },
    // Each wait advances the synthetic clock by the poll; the test closes the watch to end it.
    wait: async (ms) => { now += ms; await Promise.resolve(); return !closing; },
    closing: () => closing,
    now: () => now,
    log: (line) => lines.push(line),
    onPending: (one, reading) => pending.set(one.root, reading),
  });
  return { watch, pending, attempts, lines, polls: () => polls, close: () => { closing = true; }, now: () => now };
}

async function settle(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index++) await Promise.resolve();
}

test('a stopped route is attempted only once its session runs, then dropped and cleared', async () => {
  let attached = false;
  const h = harness({ running: () => new Map([['alpha', attached]]), attempt: () => 'done' });
  h.watch.add(route('alpha'));
  expect(h.pending.get('/work/alpha')?.reason).toBe('stopped');
  const run = h.watch.run();
  await settle();
  expect(h.attempts).toEqual([]);
  attached = true;
  h.watch.seal();
  await run;
  expect(h.attempts).toEqual(['/work/alpha']);
  expect(h.pending.get('/work/alpha')).toBeNull();
  expect(h.watch.roots()).toEqual([]);
  expect(h.lines[0]).toContain('the restore runs when it is attached');
});

test('an unanswered session read keeps every route and attempts none', async () => {
  let answer: ReadonlyMap<string, boolean> | null = null;
  const h = harness({ running: () => answer, attempt: () => 'done' });
  h.watch.add(route('alpha'));
  const run = h.watch.run();
  await settle();
  expect(h.attempts).toEqual([]);
  expect(h.polls()).toBeGreaterThan(1);
  answer = new Map([['alpha', true]]);
  h.watch.seal();
  await run;
  expect(h.attempts).toEqual(['/work/alpha']);
});

test('a route the load guard keeps holding after the attach is dropped at its bound with a load-bound reading', async () => {
  const h = harness({ running: () => new Map([['alpha', true]]), attempt: () => 'load', loadBudgetMs: 60_000 });
  h.watch.add(route('alpha'));
  h.watch.seal();
  await h.watch.run();
  // Held at 30 s (first hold), 60 s and 90 s: the third read is 60 s past the first hold.
  expect(h.attempts.length).toBe(3);
  expect(h.pending.get('/work/alpha')?.reason).toBe('load-bound');
  expect(h.lines.some((line) => line.includes('retry wait bound reached'))).toBe(true);
});

test('a route whose child finds the session gone again stays watched', async () => {
  let calls = 0;
  const h = harness({ running: () => new Map([['alpha', true]]), attempt: () => (++calls < 3 ? 'not-running' : 'done') });
  h.watch.add(route('alpha'));
  h.watch.seal();
  await h.watch.run();
  expect(calls).toBe(3);
  expect(h.pending.get('/work/alpha')).toBeNull();
});

test('closing ends the watch with routes still watched; a route added twice is watched once', async () => {
  const h = harness({ running: () => new Map([['alpha', false]]), attempt: () => 'done' });
  h.watch.add(route('alpha'));
  h.watch.add(route('alpha'));
  expect(h.lines.length).toBe(1);
  const run = h.watch.run();
  await settle();
  h.close();
  await run;
  expect(h.watch.roots()).toEqual(['/work/alpha']);
  expect(h.attempts).toEqual([]);
});

test('an unsealed empty watch parks without polling until a route is added', async () => {
  const h = harness({ running: () => new Map([['alpha', true]]), attempt: () => 'done' });
  const run = h.watch.run();
  await settle();
  expect(h.polls()).toBe(0);
  h.watch.add(route('alpha'));
  await settle();
  h.watch.seal();
  await run;
  expect(h.attempts).toEqual(['/work/alpha']);
});

test('the production session read maps names to running, and passes an unanswered list through', async () => {
  const map = await sessionsRunningMap(async () => [{ name: 'alpha', running: true }, { name: 'beta', running: false }]);
  expect(map?.get('alpha')).toBe(true);
  expect(map?.get('beta')).toBe(false);
  expect(await sessionsRunningMap(async () => null)).toBeNull();
});

test('the daemon line groups stopped routes and names load-held ones with their bound', () => {
  const row = (root: string, restore?: DaemonRootState['restore']): DaemonRootState => ({
    root, team: 'x', send: 'serving', bus: 'serving', why: null, ...(restore === undefined ? {} : { restore }),
  });
  const phrases = restorePhrases([
    row('/work/a', { reason: 'stopped', since: '2026-11-16T11:38:00.000Z' }),
    row('/work/b', { reason: 'stopped', since: '2026-11-16T11:38:00.000Z' }),
    row('/work/c', { reason: 'load', since: '2026-11-16T11:38:09.000Z', detail: 'the load is 4.3 per core, above 3' }),
    row('/work/d', { reason: 'load-bound', since: '2026-11-16T11:38:09.000Z' }),
    row('/work/e'),
  ]);
  expect(phrases).toEqual([
    'restore pending for 2 roots whose session is not running, restored when attached (/work/a, /work/b)',
    'restore pending for /work/c (held by the load guard since 2026-11-16T11:38:09.000Z: the load is 4.3 per core, above 3; retrying)',
    'restore pending for /work/d (held by the load guard since 2026-11-16T11:38:09.000Z; retry bound reached, run "team up --all" once the load clears)',
  ]);
});
