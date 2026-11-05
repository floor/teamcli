// The unread pass under a daemon-hosted watch: the N re-wake reaches the seat, once, and the
// 2N report follows.
//
// A hosted source set closes every raw writer — typing, a key, a notice — but keeps the one
// gated seam a profile's typed wake runs through (`hostedWatchSources`). The unread pass is part
// of the shared loop (`runWatch`), so a hosted pass runs it too; the wake must take that kept
// seam rather than being left out of the pass, or a daemon-hosted root reports a seat at 2N
// without ever having tried to wake it at N. The pane here is the interrupted Codex frame, read
// as a scripted screen; no live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { createHostedWatch } from '../src/daemon/watch.ts';
import { hostedWatchRun, hostedWatchSources } from '../src/daemon/watch-run.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { dropMessage } from '../src/send/native.ts';
import { signRecord } from '../src/send/record.ts';
import { deliverTypedWake, type TypedWakeResult } from '../src/send/typed-wake.ts';
import type { Live } from '../src/status/compare.ts';
import { markTaken, readTaken } from '../src/send/taken.ts';
import type { Machine } from '../src/watch/machine.ts';
import { reportedPath, wakePath, wakeTryPath } from '../src/watch/unread.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-20T03:00:00Z');
const WIN = '5.5';
const UNREAD = 'cccccccc-0000-4000-8000-000000000201';

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idleScreen = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

/** The interrupted Codex frame: the banner, the empty placeholder and the warning on the status
 *  row. It reads as an idle box, which is what the typed wake needs before it types. */
const CODEX_INTERRUPTED = readFileSync(new URL('./fixtures/codex/0.161.0/interrupted-idle.txt', import.meta.url), 'utf8');
const CODEX_WORKING = readFileSync(new URL('./fixtures/codex/0.161.0/working.txt', import.meta.url), 'utf8');
const CODEX_UNSENT = readFileSync(new URL('./fixtures/codex/0.161.0/unsent.txt', import.meta.url), 'utf8');

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
    cli: codex
    vendor: test
    model: Test
    version: "0.161.0"
    launch: codex
`;

type World = { base: string; root: string; home: string };

let world: World | null = null;

function scratch(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-hosted-unread-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), CREW);
  return { base, root, home };
}

afterEach(() => {
  if (world !== null) rmSync(world.base, { recursive: true, force: true });
  world = null;
});

function live(): Live {
  const agents: HerdrAgent[] = [{
    name: 'worker-1', agent: 'codex', pane: 'fixture-pane-1', workspace: 'fixture-work-1', status: 'idle', cwd: null,
  }];
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens: {} };
}

/** A signed message in the worker's folder, its file time set to the instant it landed: the
 *  unread pass counts from that time, as `team drops` does. */
function seedMessage(at: World, id: string, ts: Date): string {
  const dropDir = join(at.root, '.agents', 'send-drops', 'crew', 'worker-1');
  const record = signRecord({
    kind: 'message',
    id,
    to: 'worker-1',
    to_id: null,
    root: realpathSync(at.root),
    session: 'crew',
    at: ts.toISOString(),
    body: 'from the owner\n\nnobody came',
    from: 'owner',
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, at.home);
  dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  utimesSync(join(dropDir, id), new Date(), ts);
  return dropDir;
}

const TYPED_DELIVERED: TypedWakeResult = {
  delivered: true,
  typed: true,
  tries: 1,
  reason: 'the working screen showed after 1 Enter',
};

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the hosted watch');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the unread pass of a daemon-hosted watch', () => {
  test('an unread message gets one wake through the kept typed seam, and the 2N report once', async () => {
    const made = scratch();
    world = made;
    // Well past twice the window: the wake is due at N, and the report at 2N.
    const dropDir = seedMessage(made, UNREAD, new Date(NOW - 21 * MIN));

    const clock = { at: NOW };
    const typed: { pane: string; line: string; cli: string }[] = [];
    let rawWrites = 0;
    const sources: WatchSources = {
      live: () => live(),
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => (clock.at === NOW ? CODEX_INTERRUPTED : idleScreen),
      status: () => 'idle',
      foreground: () => ['codex'],
      processes: () => null,
      // The raw writers must never be reached: the hosted set closes them, and the typed wake
      // is the one seam this test lets through.
      typeText: () => { rawWrites += 1; return false; },
      pressEnter: () => { rawWrites += 1; return false; },
      sendKey: () => { rawWrites += 1; return false; },
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock.at),
      wait: async () => false,
      alive: () => true,
      pid: 4244,
      home: made.home,
      statusSource: undefined,
      typedWake: async (pane, line, cli) => {
        typed.push({ pane, line, cli });
        return TYPED_DELIVERED;
      },
    };
    const route = routeOf(made.root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
    const log: string[] = [];
    const host = createHostedWatch({
      route,
      now: () => new Date(clock.at),
      effects: 'open',
      run: hostedWatchRun({ route, log: (text) => log.push(text), base: sources, pid: 4244 }),
    });

    try {
      await waitUntil(() => host.state().cycles === 1);
      // The wake ran on the hosted pass, through the kept typed-wake seam and no raw writer.
      expect(typed).toHaveLength(1);
      expect(typed[0]).toMatchObject({ pane: 'fixture-pane-1', cli: 'codex' });
      expect(rawWrites).toBe(0);
      expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);
      // At twice the window the same pass reports the message once.
      expect(existsSync(reportedPath(dropDir, UNREAD))).toBe(true);

      // A later pass changes nothing: the wake marker is spent and the report marker stands.
      clock.at = NOW + 5 * MIN;
      host.tick(new Date(clock.at));
      await waitUntil(() => host.state().cycles === 2);
      expect(typed).toHaveLength(1);
      expect(rawWrites).toBe(0);
      expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);
      expect(existsSync(reportedPath(dropDir, UNREAD))).toBe(true);
    } finally {
      await host.stop('the test is done');
    }
  });

  test('stepped N -> 2N -> 3N on the interrupted Codex frame through the real deliverTypedWake gate wakes once at N, reports once at 2N, and adds nothing later', async () => {
    const made = scratch();
    world = made;
    // At t = NOW, the message is 75 s old (>= N = 60 s, < 2N = 120 s).
    const dropDir = seedMessage(made, UNREAD, new Date(NOW - 75_000));

    const clock = { at: NOW };
    const typedLines: string[] = [];
    let enters = 0;
    let rawWrites = 0;
    let paneState: 'idle' | 'typed' | 'working' = 'idle';
    let currentLine = '';

    const readPane = (): string => {
      if (paneState === 'working') return CODEX_WORKING;
      if (paneState === 'typed') return CODEX_INTERRUPTED.replace('› Ask Codex to do anything', `› ${currentLine}`);
      return CODEX_INTERRUPTED;
    };

    const sources: WatchSources = {
      live: () => live(),
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => readPane(),
      status: () => 'idle',
      foreground: () => ['codex'],
      processes: () => null,
      typeText: () => { rawWrites += 1; return false; },
      pressEnter: () => { rawWrites += 1; return false; },
      sendKey: () => { rawWrites += 1; return false; },
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock.at),
      wait: async () => false,
      alive: () => true,
      pid: 4244,
      home: made.home,
      statusSource: undefined,
      typedWake: async (pane, line, cli) =>
        deliverTypedWake(
          {
            read: () => readPane(),
            type: (_p, text) => {
              typedLines.push(text);
              currentLine = text;
              paneState = 'typed';
              return true;
            },
            enter: () => {
              enters += 1;
              paneState = 'working';
              return true;
            },
            wait: async () => {},
          },
          pane,
          line,
          cli,
          { settleMs: 0, enterSettleMs: 0, pollMs: 0, verifyMs: 10 },
        ),
    };
    const route = routeOf(made.root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
    const host = createHostedWatch({
      route,
      now: () => new Date(clock.at),
      effects: 'open',
      run: hostedWatchRun({ route, log: () => {}, base: sources, pid: 4244 }),
    });

    try {
      // Pass 1 at 75 s (between N and 2N): re-wakes once through deliverTypedWake; not yet due for 2N report.
      await waitUntil(() => host.state().cycles === 1);
      expect(typedLines).toHaveLength(1);
      expect(enters).toBe(1);
      expect(rawWrites).toBe(0);
      expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);
      expect(existsSync(reportedPath(dropDir, UNREAD))).toBe(false);

      // Pass 2 at >= 2N: 2N report fires once; no second wake.
      paneState = 'idle';
      clock.at = NOW + 5 * MIN;
      host.tick(new Date(clock.at));
      await waitUntil(() => host.state().cycles === 2);
      expect(typedLines).toHaveLength(1);
      expect(enters).toBe(1);
      expect(rawWrites).toBe(0);
      expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);
      expect(existsSync(reportedPath(dropDir, UNREAD))).toBe(true);

      // Pass 3 on a later tick: adds nothing.
      clock.at = NOW + 10 * MIN;
      host.tick(new Date(clock.at));
      await waitUntil(() => host.state().cycles === 3);
      expect(typedLines).toHaveLength(1);
      expect(enters).toBe(1);
      expect(rawWrites).toBe(0);
    } finally {
      await host.stop('the test is done');
    }
  });

  test('a working seat is never typed into, and the 2N report still fires once', async () => {
    const made = scratch();
    world = made;
    const dropDir = seedMessage(made, UNREAD, new Date(NOW - 21 * MIN));

    const clock = { at: NOW };
    let typedCalls = 0;
    let rawWrites = 0;
    const sources: WatchSources = {
      live: () => live(),
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => CODEX_WORKING,
      status: () => 'working',
      foreground: () => ['codex'],
      processes: () => null,
      typeText: () => { rawWrites += 1; return false; },
      pressEnter: () => { rawWrites += 1; return false; },
      sendKey: () => { rawWrites += 1; return false; },
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock.at),
      wait: async () => false,
      alive: () => true,
      pid: 4244,
      home: made.home,
      statusSource: undefined,
      typedWake: async () => {
        typedCalls += 1;
        return TYPED_DELIVERED;
      },
    };
    const route = routeOf(made.root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
    const host = createHostedWatch({
      route,
      now: () => new Date(clock.at),
      effects: 'open',
      run: hostedWatchRun({ route, log: () => {}, base: sources, pid: 4244 }),
    });

    try {
      await waitUntil(() => host.state().cycles === 1);
      expect(typedCalls).toBe(0);
      expect(rawWrites).toBe(0);
      expect(existsSync(wakePath(dropDir, UNREAD))).toBe(false);
      expect(existsSync(reportedPath(dropDir, UNREAD))).toBe(true);
    } finally {
      await host.stop('the test is done');
    }
  });

  test('a composer box holding unsent text is refused both before and inside deliverTypedWake without typing', async () => {
    const made = scratch();
    world = made;
    const dropDir = seedMessage(made, UNREAD, new Date(NOW - 75_000));

    const clock = { at: NOW };
    let outerUnsent = true;
    let typedCalls = 0;
    let typedKeystrokes = 0;
    let rawWrites = 0;
    const sources: WatchSources = {
      live: () => live(),
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => (outerUnsent ? CODEX_UNSENT : CODEX_INTERRUPTED),
      status: () => 'idle',
      foreground: () => ['codex'],
      processes: () => null,
      typeText: () => { rawWrites += 1; return false; },
      pressEnter: () => { rawWrites += 1; return false; },
      sendKey: () => { rawWrites += 1; return false; },
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock.at),
      wait: async () => false,
      alive: () => true,
      pid: 4244,
      home: made.home,
      statusSource: undefined,
      typedWake: async (pane, line, cli) => {
        typedCalls += 1;
        let reads = 0;
        return deliverTypedWake(
          {
            // First read inside deliverTypedWake is idle; second read shows a draft (`CODEX_UNSENT`).
            read: () => {
              reads += 1;
              return reads === 1 ? CODEX_INTERRUPTED : CODEX_UNSENT;
            },
            type: () => {
              typedKeystrokes += 1;
              return true;
            },
            enter: () => {
              typedKeystrokes += 1;
              return true;
            },
            wait: async () => {},
          },
          pane,
          line,
          cli,
          { settleMs: 0, enterSettleMs: 0, pollMs: 0, verifyMs: 10 },
        );
      },
    };
    const route = routeOf(made.root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
    const host = createHostedWatch({
      route,
      now: () => new Date(clock.at),
      effects: 'open',
      run: hostedWatchRun({ route, log: () => {}, base: sources, pid: 4244 }),
    });

    try {
      // Pass 1: outer look sees `CODEX_UNSENT` (`kind === 'unsent'`) and skips before calling `typedWake`.
      await waitUntil(() => host.state().cycles === 1);
      expect(typedCalls).toBe(0);
      expect(typedKeystrokes).toBe(0);
      expect(rawWrites).toBe(0);
      expect(existsSync(wakePath(dropDir, UNREAD))).toBe(false);

      // Pass 2: outer look sees `CODEX_INTERRUPTED`, and `deliverTypedWake`'s second read sees `CODEX_UNSENT`:
      // `deliverTypedWake` refuses with 0 keystrokes, releases `<id>.wake`, and records `<id>.wake-try`.
      outerUnsent = false;
      clock.at = NOW + 5 * MIN;
      host.tick(new Date(clock.at));
      await waitUntil(() => host.state().cycles === 2);
      expect(typedCalls).toBe(1);
      expect(typedKeystrokes).toBe(0);
      expect(rawWrites).toBe(0);
      expect(existsSync(wakePath(dropDir, UNREAD))).toBe(false);
      expect(existsSync(wakeTryPath(dropDir, UNREAD))).toBe(true);
      const ledger = JSON.parse(readFileSync(wakeTryPath(dropDir, UNREAD), 'utf8')) as { tries: number; typed: boolean };
      expect(ledger).toMatchObject({ tries: 1, typed: false });
    } finally {
      await host.stop('the test is done');
    }
  });

  test('a human seat is never typed into by the hosted unread pass', async () => {
    const made = scratch();
    world = made;
    writeFileSync(join(made.root, '.agents', 'team.yaml'), `${CREW}    human: true\n`);
    const dropDir = seedMessage(made, UNREAD, new Date(NOW - 21 * MIN));

    const clock = { at: NOW };
    let typedCalls = 0;
    let rawWrites = 0;
    const sources: WatchSources = {
      live: () => live(),
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => CODEX_INTERRUPTED,
      status: () => 'idle',
      foreground: () => ['codex'],
      processes: () => null,
      typeText: () => { rawWrites += 1; return false; },
      pressEnter: () => { rawWrites += 1; return false; },
      sendKey: () => { rawWrites += 1; return false; },
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock.at),
      wait: async () => false,
      alive: () => true,
      pid: 4244,
      home: made.home,
      statusSource: undefined,
      typedWake: async () => {
        typedCalls += 1;
        return TYPED_DELIVERED;
      },
    };
    const route = routeOf(made.root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
    const host = createHostedWatch({
      route,
      now: () => new Date(clock.at),
      effects: 'open',
      run: hostedWatchRun({ route, log: () => {}, base: sources, pid: 4244 }),
    });

    try {
      await waitUntil(() => host.state().cycles === 1);
      expect(typedCalls).toBe(0);
      expect(rawWrites).toBe(0);
      expect(existsSync(wakePath(dropDir, UNREAD))).toBe(false);
    } finally {
      await host.stop('the test is done');
    }
  });

  test('--no-nudge suppresses the hosted N re-wake while still filing the 2N report once', async () => {
    const made = scratch();
    world = made;
    const dropDir = seedMessage(made, UNREAD, new Date(NOW - 21 * MIN));

    const clock = { at: NOW };
    let typedCalls = 0;
    let rawWrites = 0;
    const sources: WatchSources = {
      live: () => live(),
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => CODEX_INTERRUPTED,
      status: () => 'idle',
      foreground: () => ['codex'],
      processes: () => null,
      typeText: () => { rawWrites += 1; return false; },
      pressEnter: () => { rawWrites += 1; return false; },
      sendKey: () => { rawWrites += 1; return false; },
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock.at),
      wait: async () => false,
      alive: () => true,
      pid: 4244,
      home: made.home,
      statusSource: undefined,
      typedWake: async () => {
        typedCalls += 1;
        return TYPED_DELIVERED;
      },
    };
    const route = routeOf(made.root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
    const host = createHostedWatch({
      route,
      now: () => new Date(clock.at),
      effects: 'open',
      run: async (loop) =>
        runWatch(
          ['--no-nudge'],
          {
            stdout: () => {},
            stderr: () => {},
            cwd: route.root,
            env: {},
            stdinIsTTY: true,
            stdoutIsTTY: true,
            stderrIsTTY: true,
            caller: { kind: 'owner' },
          },
          hostedWatchSources(route, loop, sources, undefined, 4244),
        ),
    });

    try {
      await waitUntil(() => host.state().cycles === 1);
      expect(typedCalls).toBe(0);
      expect(rawWrites).toBe(0);
      expect(existsSync(wakePath(dropDir, UNREAD))).toBe(false);
      expect(existsSync(reportedPath(dropDir, UNREAD))).toBe(true);
    } finally {
      await host.stop('the test is done');
    }
  });

  test('hosted watch no-ops label rename and display-agent report and reuses the pass live snapshot in confirmTakenDrops and wakeUnreadDrops without synchronous terminal-host reads', async () => {
    const made = scratch();
    world = made;
    const dropDir = seedMessage(made, UNREAD, new Date(NOW - 75_000));
    const takenId = 'cccccccc-0000-4000-8000-000000000202';
    markTaken(dropDir, {
      id: takenId,
      from: 'owner',
      to: 'worker-1',
      body: 'from the owner\n\nnobody came',
      ts: new Date(NOW - 75_000).toISOString(),
      before: 'working',
    });

    const clock = { at: NOW };
    let syncStatusCalls = 0;
    let syncScreenCalls = 0;
    let syncProcessCalls = 0;
    let renameCalls = 0;
    let displayCalls = 0;
    const typed: { pane: string; line: string; cli: string }[] = [];

    const baseSources: WatchSources = {
      live: () => ({
        running: true,
        agents: [
          { name: 'crew-lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-work', status: 'idle', cwd: null },
          { name: 'worker-1', agent: 'codex', pane: 'fixture-pane-1', workspace: 'fixture-work-1', status: 'idle', cwd: null },
        ],
        workspaces: [
          { id: 'lead-work', label: 'crew-lead' },
          { id: 'fixture-work-1', label: 'worker-1' },
        ],
        screens: {
          'lead-pane': idleScreen,
          'fixture-pane-1': CODEX_INTERRUPTED,
        },
        processes: {
          'lead-pane': { shell: 10, foreground: [11] },
          'fixture-pane-1': { shell: 20, foreground: [21] },
        },
        foreground: {
          'lead-pane': ['claude'],
          'fixture-pane-1': ['codex'],
        },
      }),
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => {
        syncScreenCalls += 1;
        return CODEX_INTERRUPTED;
      },
      status: () => {
        syncStatusCalls += 1;
        return 'idle';
      },
      foreground: () => ['codex'],
      processes: () => {
        syncProcessCalls += 1;
        return null;
      },
      renameWorkspace: () => {
        renameCalls += 1;
        return true;
      },
      reportDisplayAgent: () => {
        displayCalls += 1;
        return true;
      },
      typeText: () => false,
      pressEnter: () => false,
      sendKey: () => false,
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock.at),
      wait: async () => false,
      alive: () => true,
      pid: 4244,
      home: made.home,
      statusSource: {
        async waitStatus() {
          return { outcome: 'timeout', at: clock.at };
        },
        promptKind: () => 'unknown',
      },
      typedWake: async (pane, line, cli) => {
        typed.push({ pane, line, cli });
        return TYPED_DELIVERED;
      },
    };

    const route = routeOf(made.root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
    const wired = hostedWatchSources(route, {
      signal: new AbortController().signal,
      cycled: () => {},
      standby: () => {},
      wait: async () => false,
    }, baseSources, undefined, 4244);
    expect(typeof wired.renameWorkspace).toBe('function');
    expect(typeof wired.reportDisplayAgent).toBe('function');
    expect(wired.renameWorkspace?.('crew', 'fixture-work-1', 'worker-1')).toBe(true);
    expect(wired.reportDisplayAgent?.('crew', 'fixture-pane-1', 'codex')).toBe(true);
    expect(renameCalls).toBe(0);
    expect(displayCalls).toBe(0);

    const host = createHostedWatch({
      route,
      now: () => new Date(clock.at),
      effects: 'open',
      run: async (loop) =>
        runWatch(
          [],
          {
            stdout: () => {},
            stderr: () => {},
            cwd: route.root,
            env: {},
            stdinIsTTY: false,
            stdoutIsTTY: false,
            stderrIsTTY: false,
          },
          {
            ...hostedWatchSources(route, loop, baseSources, undefined, 4244),
            renameWorkspace: baseSources.renameWorkspace,
            reportDisplayAgent: baseSources.reportDisplayAgent,
          },
        ),
    });

    try {
      await waitUntil(() => host.state().cycles === 1);
      expect(readTaken(dropDir)).toEqual([]);
      expect(typed).toHaveLength(1);
      expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);
      expect(syncStatusCalls).toBe(0);
      expect(syncScreenCalls).toBe(0);
      expect(syncProcessCalls).toBe(0);
      expect(renameCalls).toBe(0);
      expect(displayCalls).toBe(0);
    } finally {
      await host.stop('the test is done');
    }
  });

  test('a pane missing from the pass screen snapshot never counts as a free seat when unreadable, and falls back to one async screen read when available', async () => {
    const made = scratch();
    world = made;
    const dropDir = seedMessage(made, UNREAD, new Date(NOW - 75_000));
    const takenId = 'dddddddd-0000-4000-8000-000000000303';
    markTaken(dropDir, {
      id: takenId,
      from: 'owner',
      to: 'worker-1',
      body: 'from the owner\n\nnobody came',
      ts: new Date(NOW - 75_000).toISOString(),
      before: 'working',
    });

    const clock = { at: NOW };
    let syncScreenCalls = 0;
    let asyncScreenCalls = 0;
    let asyncScreenReply: string | null = null;

    const baseSources: WatchSources = {
      live: () => ({
        running: true,
        agents: [
          { name: 'crew-lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-work', status: 'idle', cwd: null },
          { name: 'worker-1', agent: 'codex', pane: 'fixture-pane-1', workspace: 'fixture-work-1', status: 'idle', cwd: null },
        ],
        workspaces: [
          { id: 'lead-work', label: 'crew-lead' },
          { id: 'fixture-work-1', label: 'worker-1' },
        ],
        // `fixture-pane-1` is missing from the snapshot screen map even though `processes` exists.
        screens: {
          'lead-pane': idleScreen,
        },
        processes: {
          'lead-pane': { shell: 10, foreground: [11] },
          'fixture-pane-1': { shell: 20, foreground: [21] },
        },
        foreground: {
          'lead-pane': ['claude'],
          'fixture-pane-1': ['codex'],
        },
      }),
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => {
        syncScreenCalls += 1;
        return CODEX_INTERRUPTED;
      },
      screenAsync: async () => {
        asyncScreenCalls += 1;
        return asyncScreenReply;
      },
      status: () => 'idle',
      foreground: () => ['codex'],
      processes: () => null,
      typeText: () => false,
      pressEnter: () => false,
      sendKey: () => false,
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(clock.at),
      wait: async () => false,
      alive: () => true,
      pid: 4244,
      home: made.home,
      statusSource: {
        async waitStatus() {
          return { outcome: 'timeout', at: clock.at };
        },
        promptKind: () => 'unknown',
      },
      typedWake: async () => TYPED_DELIVERED,
    };

    const route = routeOf(made.root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
    const host = createHostedWatch({
      route,
      now: () => new Date(clock.at),
      effects: 'open',
      run: async (loop) =>
        runWatch(
          [],
          {
            stdout: () => {},
            stderr: () => {},
            cwd: route.root,
            env: {},
            stdinIsTTY: false,
            stdoutIsTTY: false,
            stderrIsTTY: false,
          },
          hostedWatchSources(route, loop, baseSources, undefined, 4244),
        ),
    });

    try {
      // Cycle 1: `fixture-pane-1` is missing from `live.screens` and `screenAsync` returns null
      // ("cannot tell"). The taken drop must be left alone, never judged a free seat past grace.
      await waitUntil(() => host.state().cycles === 1);
      expect(readTaken(dropDir)).toHaveLength(1);
      expect(readTaken(dropDir)[0]?.id).toBe(takenId);
      expect(asyncScreenCalls).toBe(1);
      expect(syncScreenCalls).toBe(0);

      // Cycle 2: `screenAsync` now returns the pane's screen showing a transcript row with the
      // taken drop id. One async fallback read confirms the take and clears the `.taken` marker.
      asyncScreenReply = `• Read ${takenId} from send-drops\n${CODEX_INTERRUPTED}`;
      clock.at = NOW + 5 * MIN;
      host.tick(new Date(clock.at));
      await waitUntil(() => host.state().cycles === 2);
      expect(readTaken(dropDir)).toEqual([]);
      expect(asyncScreenCalls).toBe(2);
      expect(syncScreenCalls).toBe(0);
    } finally {
      await host.stop('the test is done');
    }
  });
});
