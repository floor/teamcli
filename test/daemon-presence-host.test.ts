// The daemon's presence lifecycle under the real machine host: a synthetic home and checkout, the
// real single-instance lock and machine socket, and injected presence handles so the scenes can
// observe steps, coalescing and close without a live runtime. No owner session, credential or
// pane is touched.
//
// The scenes pin: integration default closed; one ingester per canonical route and none for a
// duplicate or unreadable root; at most one pass per route in flight (a busy route is skipped, not
// queued); admission closes before the presence drain; and ownership is retained with the record
// saying `pending` until the drain is truthfully quiesced.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMachineDaemon, type StartMachineDaemonInput } from '../src/daemon/host.ts';
import { daemonLockPath, daemonSocketPath } from '../src/daemon/paths.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import type { PresenceActivityResult } from '../src/daemon/presence/activity.ts';
import type { PresenceIngestResult, PresenceIngester } from '../src/daemon/presence/ingest.ts';

const CREW = `format: 1
project: acme-web
session: crew
coordinator: crew-lead
operator: crew-op
workspace:
  mode: shared
seats:
  - role: coordinator
    name: crew-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: crew-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

function emptyIngest(): PresenceIngestResult {
  return { ingested: [], rejected: [], stale: [], repaired: [], errors: [], pending: false, closed: false };
}

function activityResult(): PresenceActivityResult {
  return { seats: [], failed: null };
}

type Scratch = { base: string; root: string; home: string };

function scratch(name = 'repo'): Scratch {
  const made = realpathSync(mkdtempSync(join(tmpdir(), 'team-presence-host-')));
  const repo = join(made, name);
  const home = join(made, 'home');
  mkdirSync(join(repo, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, '.agents', 'team.yaml'), CREW);
  return { base: made, root: repo, home };
}

let world: Scratch = { base: '', root: '', home: '' };
let made: Scratch[] = [];
let cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  world = scratch();
  made = [world];
});

afterEach(async () => {
  const fns = cleanups.reverse();
  cleanups = [];
  for (const fn of fns) {
    try { await fn(); } catch { /* one failed cleanup must not hide another */ }
  }
  for (const one of made) rmSync(one.base, { recursive: true, force: true });
});

function later(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}

async function start(overrides: Partial<StartMachineDaemonInput>) {
  const started = await startMachineDaemon({
    home: world.home,
    roots: [world.root],
    startedBy: 'service-manager',
    version: '0.5.3-presence-host-test',
    heartbeatMs: 20,
    ...overrides,
  });
  if (started.kind !== 'serving') throw new Error(`the daemon did not start: ${started.kind}`);
  later(async () => {
    try { await started.daemon.close(); } catch { /* the scene already closed it */ }
  });
  return started.daemon;
}

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the daemon');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the presence pass', () => {
  test('integration is closed by default: neither builder runs', async () => {
    let built = 0;
    let steps = 0;
    const ingester: PresenceIngester = {
      step: async () => { steps += 1; return emptyIngest(); },
      close: async () => ({ quiesced: true }),
      isClosed: () => false,
    };
    const daemon = await start({
      presenceIngest: () => { built += 1; return ingester; },
      presenceActivity: () => async () => { built += 1; return activityResult(); },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(built).toBe(0);
    expect(steps).toBe(0);
    await daemon.close();
  }, 15_000);

  test('one ingester per canonical route; a duplicate spelling and an unreadable root get none', async () => {
    const unreadable = join(world.base, 'unreadable');
    mkdirSync(unreadable, { recursive: true });
    const built: Array<{ root: string; stateDir: string }> = [];
    let steps = 0;
    const ingester: PresenceIngester = {
      step: async () => { steps += 1; return emptyIngest(); },
      close: async () => ({ quiesced: true }),
      isClosed: () => false,
    };
    const daemon = await start({
      roots: [world.root, `${world.root}/`, unreadable],
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: (route, stateDir) => { built.push({ root: route.root, stateDir }); return ingester; },
      presenceActivity: () => async () => activityResult(),
    });
    await waitUntil(() => steps >= 2);
    expect(built).toEqual([{ root: world.root, stateDir: join(world.root, '.agents') }]);
    await daemon.close();
  }, 15_000);

  test('a route with a pass in flight is skipped, never queued, and the pass resumes', async () => {
    let steps = 0;
    let first = true;
    let release: (() => void) | null = null;
    let activities = 0;
    const ingester: PresenceIngester = {
      step: () => {
        steps += 1;
        if (!first) return Promise.resolve(emptyIngest());
        first = false;
        return new Promise<PresenceIngestResult>((resolve) => {
          release = () => { resolve(emptyIngest()); };
        });
      },
      close: async () => ({ quiesced: true }),
      isClosed: () => false,
    };
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: () => ingester,
      presenceActivity: () => async () => { activities += 1; return activityResult(); },
    });
    await waitUntil(() => steps === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(steps).toBe(1);
    expect(activities).toBe(0);
    release!();
    await waitUntil(() => activities >= 1);
    await waitUntil(() => steps >= 2);
    // The activity step runs only after the ingester step it follows resolved.
    await daemon.close();
  }, 15_000);
});

describe('closing', () => {
  test('admission closes first, the in-flight pass drains, and ownership is released only then', async () => {
    const order: string[] = [];
    let resolveClose: ((value: { quiesced: true }) => void) | null = null;
    const ingester: PresenceIngester = {
      step: async () => emptyIngest(),
      close: () => {
        order.push('ingest-close');
        return new Promise<{ quiesced: true }>((resolve) => { resolveClose = resolve; });
      },
      isClosed: () => false,
    };
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: () => ingester,
      presenceActivity: () => async () => activityResult(),
      watchHosting: true,
      hostedWatch: () => ({
        run: (loop) => new Promise<number>((resolve) => {
          loop.signal.addEventListener('abort', () => {
            order.push('watch-stop');
            resolve(0);
          }, { once: true });
        }),
      }),
    });
    let settled = false;
    const closing = daemon.close().then(() => { settled = true; });
    await waitUntil(() => order.includes('watch-stop') && order.includes('ingest-close'));
    expect(order.indexOf('watch-stop')).toBeLessThan(order.indexOf('ingest-close'));
    expect(settled).toBe(false);
    expect(existsSync(daemonLockPath(world.home))).toBe(true);
    expect(existsSync(daemonSocketPath(world.home))).toBe(true);
    resolveClose!({ quiesced: true });
    await closing;
    expect(existsSync(daemonLockPath(world.home))).toBe(false);
    expect(existsSync(daemonSocketPath(world.home))).toBe(false);
  }, 15_000);

  test('a truthful non-quiescence retains the lock, socket and record and says pending', async () => {
    let closeCalls = 0;
    const ingester: PresenceIngester = {
      step: async () => emptyIngest(),
      close: async () => {
        closeCalls += 1;
        return { quiesced: false, why: 'the presence log write is stuck' } as unknown as { quiesced: true };
      },
      isClosed: () => false,
    };
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: () => ingester,
      presenceActivity: () => async () => activityResult(),
    });
    await daemon.close();
    expect(closeCalls).toBe(1);
    expect(existsSync(daemonLockPath(world.home))).toBe(true);
    expect(existsSync(daemonSocketPath(world.home))).toBe(true);
    const read = readDaemonState(world.home);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') {
      expect(read.state.roots[0]?.presence).toEqual({
        state: 'pending',
        why: 'the presence log write is stuck',
      });
    }
    // A second close retries the handle whose own answer was not truthful; ownership still holds.
    await daemon.close();
    expect(closeCalls).toBe(2);
    expect(existsSync(daemonLockPath(world.home))).toBe(true);
  }, 15_000);

  test('a false, then a rejected, then a truthful close: one retry per handle and release only on true', async () => {
    let closeCalls = 0;
    let answer: 'false' | 'reject' | 'true' = 'false';
    const ingester: PresenceIngester = {
      step: async () => emptyIngest(),
      close: async () => {
        closeCalls += 1;
        if (answer === 'reject') throw new Error('the presence log write is stuck');
        if (answer === 'false') {
          return { quiesced: false, why: 'the presence log write is stuck' } as unknown as { quiesced: true };
        }
        return { quiesced: true };
      },
      isClosed: () => false,
    };
    const daemon = await start({
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: () => ingester,
      presenceActivity: () => async () => activityResult(),
    });

    await daemon.close();
    expect(closeCalls).toBe(1);
    expect(existsSync(daemonLockPath(world.home))).toBe(true);
    expect(existsSync(daemonSocketPath(world.home))).toBe(true);
    const first = readDaemonState(world.home);
    if (first.kind === 'ok') {
      expect(first.state.roots[0]?.presence).toEqual({
        state: 'pending',
        why: 'the presence log write is stuck',
      });
    }

    answer = 'reject';
    await daemon.close();
    expect(closeCalls).toBe(2);
    expect(existsSync(daemonLockPath(world.home))).toBe(true);
    const second = readDaemonState(world.home);
    if (second.kind === 'ok') {
      expect(second.state.roots[0]?.presence?.why).toBe('the presence log write is stuck');
    }

    // Two concurrent callers join one run: the retried handle is closed once, and only a truthful
    // quiescence releases the lock, socket and record.
    answer = 'true';
    const left = daemon.close();
    const right = daemon.close();
    expect(right).toBe(left);
    await Promise.all([left, right]);
    expect(closeCalls).toBe(3);
    expect(existsSync(daemonLockPath(world.home))).toBe(false);
    expect(existsSync(daemonSocketPath(world.home))).toBe(false);
    expect(readDaemonState(world.home).kind).toBe('missing');
  }, 15_000);
});
