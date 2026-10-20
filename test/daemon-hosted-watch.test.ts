import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import { daemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import { createHostedWatch } from '../src/daemon/watch.ts';
import { hostedWatchRun } from '../src/daemon/watch-run.ts';
import { forgetIdleEpisodes, type WorkPush, type WorkPushRequest } from '../src/watch/dispatch.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-20T03:00:00Z');
const WIN = '5.5';

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idleScreen = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

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
    version: "${WIN}"
    launch: claude
  - role: operator
    name: crew-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
`;

function teamOf(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function live(): Live {
  const agents: HerdrAgent[] = [{
    name: 'worker-1', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null,
  }];
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens: { 'w1:p1': idleScreen } };
}

let base = '';
let root = '';
let home = '';

function scratch(name = 'repo'): { base: string; root: string; home: string } {
  const made = realpathSync(mkdtempSync(join(tmpdir(), 'team-hosted-watch-')));
  const repo = join(made, name);
  const userHome = join(made, 'home');
  mkdirSync(join(repo, '.agents'), { recursive: true });
  mkdirSync(userHome, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, '.agents', 'team.yaml'), CREW);
  return { base: made, root: repo, home: userHome };
}

beforeEach(() => {
  forgetIdleEpisodes();
  const made = scratch();
  base = made.base;
  root = made.root;
  home = made.home;
  writeFileSync(join(root, '.agents', 'queue.yaml'), '- id: t1\n  title: "First"\n');
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.crew ??= emptySession());
    session.seats['worker-1'] = { stage: 'ready', last_active: new Date(NOW - 10 * MIN).toISOString() };
  });
});

afterEach(() => {
  forgetIdleEpisodes();
  rmSync(base, { recursive: true, force: true });
});

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the hosted watch');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the shared watch loop under a host', () => {
  test('a pass runs with a virtual clock, an injected sender pushes, and nothing is typed', async () => {
    const clock = { at: NOW };
    const pushes: WorkPushRequest[] = [];
    let typed = 0;
    let notified = 0;
    const sources: WatchSources = {
      live: () => live(),
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => idleScreen,
      status: () => 'idle',
      foreground: () => ['claude'],
      processes: () => null,
      typeText: () => { typed += 1; return false; },
      pressEnter: () => { typed += 1; return false; },
      sendKey: () => { typed += 1; return false; },
      sleep: async () => {},
      notify: () => { notified += 1; },
      now: () => new Date(clock.at),
      wait: async () => false,
      alive: () => true,
      pid: 4242,
      home: join(root, 'home'),
      statusSource: undefined,
    };
    const push: WorkPush = async (request) => {
      pushes.push(request);
      return { ok: true, outcome: 'typed (unconfirmed)' };
    };
    const route = routeOf(root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
    const log: string[] = [];
    const host = createHostedWatch({
      route,
      now: () => new Date(clock.at),
      effects: 'open',
      run: hostedWatchRun({ route, log: (text) => log.push(text), base: sources, pushWork: push, pid: 4242 }),
    });

    await waitUntil(() => host.state().cycles === 1);
    expect(host.state()).toMatchObject({
      phase: 'running',
      cycles: 1,
      failures: 0,
      lastCycleAt: new Date(NOW).toISOString(),
      lastCycleOutcome: 'pass',
      effects: 'open',
    });
    expect(pushes.length).toBe(1);
    expect(pushes[0]).toMatchObject({ seat: 'worker-1', pane: 'w1:p1', cli: 'claude-code' });
    // The hosted source set closed every keystroke, notice and pane write.
    expect(typed).toBe(0);
    expect(notified).toBe(0);
    // No pane record is taken over: the session is left to a live pane watch.
    expect(readState(join(root, '.agents')).sessions.crew?.watch).toBeUndefined();
    // The loop's own line goes to the daemon's log, not a terminal.
    expect(log.some((line) => line.includes('watching the session "crew"'))).toBe(true);

    // With no heartbeat tick, no second pass exists: a hosted watch has no timer of its own.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.state().cycles).toBe(1);

    clock.at = NOW + 120_000;
    host.tick(new Date(clock.at));
    await waitUntil(() => host.state().cycles === 2);

    const stopping = host.stop('the daemon is closing');
    await stopping;
    expect(host.state()).toMatchObject({
      phase: 'stopped',
      why: 'the daemon is closing',
      cycles: 2,
      effects: 'open',
    });
    expect(log.some((line) => line.includes('the watch of "crew" stopped'))).toBe(true);
    // Nothing reached a pane across both passes.
    expect(typed).toBe(0);
  });

  test('without an injected sender the effects stay blocked and no push is attempted', async () => {
    const clock = { at: NOW };
    let pushes = 0;
    const sources: WatchSources = {
      live: () => live(),
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => idleScreen,
      status: () => 'idle',
      foreground: () => ['claude'],
      processes: () => null,
      typeText: () => false,
      pressEnter: () => false,
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock.at),
      wait: async () => false,
      alive: () => true,
      pid: 4243,
      home: undefined,
      statusSource: undefined,
      pushWork: async () => {
        pushes += 1;
        return { ok: true, outcome: 'typed (unconfirmed)' };
      },
    };
    const route = routeOf(root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
    // The hosted source set receives no sender; the base's own push must never be reached.
    const host = createHostedWatch({
      route,
      now: () => new Date(clock.at),
      run: hostedWatchRun({ route, log: () => {}, base: sources, pid: 4243 }),
    });
    await waitUntil(() => host.state().cycles === 1);
    expect(host.state().effects).toBe('blocked');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pushes).toBe(0);
    await host.stop('the daemon is closing');
  });
});

describe('the daemon heartbeat hosting', () => {
  test('a pass in flight never holds the heartbeat, and the route records its state', async () => {
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'service-manager',
      version: '0.5.3-hosted-watch-test',
      heartbeatMs: 25,
      watchHosting: true,
      hostedWatch: () => ({
        run: (loop) => new Promise<number>((resolve) => {
          loop.signal.addEventListener('abort', () => resolve(0), { once: true });
        }),
      }),
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      expect(started.daemon.roots[0]?.watch).toMatchObject({
        required: true,
        effects: 'blocked',
        phase: 'starting',
      });
      // The heartbeat keeps writing while the one pass never completes.
      const seen = new Set<string>();
      await waitUntil(() => {
        const read = readDaemonState(home);
        if (read.kind === 'ok') seen.add(read.state.heartbeatAt);
        return seen.size >= 2;
      });
      const health = await daemonHealth(home);
      expect(health.state).toBe('running');

      const read = readDaemonState(home);
      expect(read.kind).toBe('ok');
      if (read.kind === 'ok') {
        expect(read.state.roots[0]?.watch).toMatchObject({
          required: true,
          effects: 'blocked',
          phase: 'starting',
          cycles: 0,
          failures: 0,
          lastCycleAt: null,
          lastCycleOutcome: null,
        });
      }
    } finally {
      const closed = await Promise.race([
        started.daemon.close().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      // The hung pass honours the abort, so closing is not held past the test's bound.
      expect(closed).toBe(true);
    }
  });

  test('one route failing is recorded and the other route keeps cycling', async () => {
    const second = scratch('other');
    try {
      const another = second.root;
      writeFileSync(join(another, '.agents', 'queue.yaml'), '');
      const started = await startMachineDaemon({
        home,
        roots: [root, another],
        startedBy: 'service-manager',
        version: '0.5.3-hosted-watch-test',
        heartbeatMs: 20,
        watchHosting: true,
        hostedWatch: (route) => (route.root === root
          ? { run: async () => { throw new Error('the route read failed'); } }
          : {
            run: async (loop) => {
              for (;;) {
                loop.cycled(new Date());
                if (!(await loop.wait(0))) return 0;
              }
            },
          }),
      });
      expect(started.kind).toBe('serving');
      if (started.kind !== 'serving') return;
      try {
        await waitUntil(() => {
          const read = readDaemonState(home);
          if (read.kind !== 'ok') return false;
          const bad = read.state.roots.find((entry) => entry.root === root);
          const good = read.state.roots.find((entry) => entry.root === another);
          return bad?.watch?.phase === 'failed' && (good?.watch?.cycles ?? 0) > 0;
        });
        const read = readDaemonState(home);
        expect(read.kind).toBe('ok');
        if (read.kind === 'ok') {
          const bad = read.state.roots.find((entry) => entry.root === root);
          const good = read.state.roots.find((entry) => entry.root === another);
          expect(bad?.watch).toMatchObject({ phase: 'failed', failures: 1, why: 'the route read failed' });
          expect(good?.watch?.phase).toBe('running');
          expect(good?.watch?.lastCycleAt).not.toBeNull();
        }
      } finally {
        await started.daemon.close();
      }
    } finally {
      rmSync(second.base, { recursive: true, force: true });
    }
  });
});
