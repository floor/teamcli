// S2: one hosted watch per running team, and the transfer of an existing pane watch without two
// senders. Everything here is synthetic: scratch checkouts, named fake pids, recorder sources and
// an injected pane process list. No real pane is read or typed into, no service is restarted, and
// nothing is signalled anywhere.
//
// The transfer is cooperative and request-shaped. A daemon-hosted watch that finds a verified
// pane watch holding its route writes `watch-handover.json` beside the session state and keeps
// the fixed beat; the pane watch reads the request at the top of its next pass, leaves through its
// own loop and deletes only its own record; the daemon's next beat acquires. A holder whose pid
// cannot be proven to be the process in its own recorded pane is never asked, and an older pane
// watch that does not read the request is stood by honestly after two of its own passes. No
// process is signalled in any case.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import { createHostedWatch } from '../src/daemon/watch.ts';
import { HOSTED_AUTHORITY_TICK_MS, hostedWatchAuthority } from '../src/daemon/watch-authority.ts';
import type { PaneProcesses } from '../src/herdr.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { mintWatchEpoch } from '../src/watch/epoch.ts';
import { handoverPath, readWatchHandover } from '../src/watch/handover.ts';
import type { Machine } from '../src/watch/machine.ts';

const NOW = Date.parse('2026-10-21T04:00:00Z');
const PANE = 'w1:p1';
const PANE_PID = 6_101;
const WORKSPACE_PID = 6_102;
const FINE: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const VERSION = '0.5.4-daemon-handover-test';

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

let base = '';
let root = '';
let home = '';
let agents = '';
let teamFile = '';

beforeEach(() => {
  const made = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-handover-')));
  base = made;
  root = join(made, 'repo');
  home = join(made, 'home');
  agents = join(root, '.agents');
  teamFile = join(agents, 'team.yaml');
  mkdirSync(agents, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(teamFile, CREW);
  writeFileSync(join(agents, 'queue.yaml'), '- id: t1\n  title: "First"\n');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function route() {
  return routeOf(root, 'acme-web', 'crew', ['crew-lead', 'crew-op', 'worker-1']);
}

/** The binding `up` writes after a real launch: without it no hosted watch starts at all. */
function bind(): void {
  updateState(agents, (state) => {
    (state.sessions.crew ??= emptySession()).watchdog = { file: teamFile };
  });
}

function paneWatch(over: { pid?: number; pane?: string; heartbeat?: string } = {}) {
  return {
    pid: over.pid ?? PANE_PID,
    pane: over.pane ?? PANE,
    heartbeat: over.heartbeat ?? new Date(NOW).toISOString(),
  };
}

function sessionWatch() {
  return readState(agents).sessions.crew?.watch;
}

/** The quiet read set: a route with no agents, no standing, no checks and no work. Passes are the
 *  loop's own read-only ones; the daemon's first one proves the host cycles. */
function quietSources(clock: { at: number }): WatchSources {
  return {
    live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
    machine: () => FINE,
    standing: () => ({ kind: 'none' }),
    readChecks: () => [],
    screen: () => '',
    status: () => 'idle',
    foreground: () => [],
    processes: () => null,
    typeText: () => false,
    pressEnter: () => false,
    sendKey: () => false,
    sleep: async () => {},
    notify: () => {},
    now: () => new Date(clock.at),
    wait: async () => false,
    alive: () => true,
    pid: 4_243,
    home,
    statusSource: undefined,
  };
}

/** A hosted watch as the daemon composes it: the build's own tick rides the fixed beat. */
function machine(build: ReturnType<typeof hostedWatchAuthority>, clock: { at: number }) {
  return createHostedWatch({
    route: route(),
    now: () => new Date(clock.at),
    ...build,
    onTick: build.tick,
  });
}

async function waitUntil(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the hosted watch');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function requested(): ReturnType<typeof readWatchHandover> {
  return readWatchHandover(agents);
}

describe('a hosted watch facing a live pane watch', () => {
  test('asks the verified pane watch to hand over and acquires only after its record is gone', async () => {
    bind();
    const standing = paneWatch();
    updateState(agents, (state) => {
      (state.sessions.crew ??= emptySession()).watch = standing;
    });
    const clock = { at: NOW };
    const logs: string[] = [];
    const build = hostedWatchAuthority({
      route: route(),
      teamFile,
      log: (text) => logs.push(text),
      now: () => new Date(clock.at),
      base: quietSources(clock),
      alive: (pid) => pid === PANE_PID || pid === process.pid,
      // The pane its own record names lists the recorded pid as a foreground process.
      processInfo: (pane): PaneProcesses | null =>
        (pane === PANE ? { shell: WORKSPACE_PID, foreground: [PANE_PID] } : null),
    });
    const host = machine(build, clock);

    // The request names this daemon, this route's session, and the daemon's own beat.
    await waitUntil(() => requested().kind === 'request');
    const asked = requested();
    expect(asked.kind).toBe('request');
    if (asked.kind === 'request') {
      expect(asked.request.pid).toBe(process.pid);
      expect(asked.request.session).toBe('crew');
      expect(asked.request.heartbeat).toBe(new Date(NOW).toISOString());
    }
    // While the pane watch still stands, the daemon holds: no authority record of its own, no
    // pass, no effect. There is never a second sender beside the pane's watch.
    expect(sessionWatch()).toEqual(standing);
    expect(host.state().cycles).toBe(0);
    expect(host.state().effects).toBe('blocked');
    expect(logs.some((line) => line.includes('asked it to hand over'))).toBe(true);

    // The pane watch leaves through its own loop: it deletes only its own record. The next fixed
    // beat finds the record gone and acquires.
    updateState(agents, (state) => {
      delete state.sessions.crew?.watch;
    });
    clock.at = NOW + HOSTED_AUTHORITY_TICK_MS;
    host.tick(new Date(clock.at));
    await waitUntil(() => sessionWatch()?.epoch !== undefined);
    expect(sessionWatch()?.pid).toBe(process.pid);
    expect(sessionWatch()?.epoch).toMatch(/^watch_[0-9a-f]{32}$/);
    // The request is withdrawn the moment it is answered: nothing is left asking.
    expect(existsSync(handoverPath(agents))).toBe(false);
    await waitUntil(() => host.state().cycles >= 1);
    await host.stop('done');
  });

  test('a pane whose process cannot be proven is never asked and stands in the honest standby', async () => {
    bind();
    const standing = paneWatch();
    updateState(agents, (state) => {
      (state.sessions.crew ??= emptySession()).watch = standing;
    });
    const clock = { at: NOW };
    const logs: string[] = [];
    const build = hostedWatchAuthority({
      route: route(),
      teamFile,
      log: (text) => logs.push(text),
      now: () => new Date(clock.at),
      base: quietSources(clock),
      alive: (pid) => pid === PANE_PID || pid === process.pid,
      // The recorded pane exists but lists another process there: the pid is not the watch.
      processInfo: () => ({ shell: WORKSPACE_PID, foreground: [WORKSPACE_PID] }),
    });
    const host = machine(build, clock);
    await waitUntil(() => host.state().phase === 'standby');
    expect(host.state().why).toContain('a watch authority stands for the session "crew"');
    expect(existsSync(handoverPath(agents))).toBe(false);
    expect(logs.some((line) => line.includes('asked it to hand over'))).toBe(false);
    expect(sessionWatch()).toEqual(standing);
    await host.stop('done');
  });

  test('an unreadable pane is unproven too, and an authority epoch holder is never asked', async () => {
    bind();
    const standing = paneWatch();
    updateState(agents, (state) => {
      (state.sessions.crew ??= emptySession()).watch = standing;
    });
    const clock = { at: NOW };
    const first = hostedWatchAuthority({
      route: route(),
      teamFile,
      log: () => {},
      now: () => new Date(clock.at),
      base: quietSources(clock),
      alive: (pid) => pid === PANE_PID || pid === process.pid,
      processInfo: () => null,
    });
    const host = machine(first, clock);
    await waitUntil(() => host.state().phase === 'standby');
    expect(existsSync(handoverPath(agents))).toBe(false);
    expect(sessionWatch()).toEqual(standing);
    await host.stop('done');

    // An epoch record is an authority holder, not a pane watch: it is left exactly as it was.
    const authority = { pid: PANE_PID, epoch: mintWatchEpoch(), heartbeat: new Date(NOW).toISOString() };
    updateState(agents, (state) => {
      (state.sessions.crew ??= emptySession()).watch = authority;
    });
    const second = hostedWatchAuthority({
      route: route(),
      teamFile,
      log: () => {},
      now: () => new Date(clock.at),
      base: quietSources(clock),
      alive: (pid) => pid === PANE_PID || pid === process.pid,
      processInfo: () => ({ shell: WORKSPACE_PID, foreground: [PANE_PID] }),
    });
    const epochHost = machine(second, clock);
    await waitUntil(() => epochHost.state().phase === 'standby');
    expect(existsSync(handoverPath(agents))).toBe(false);
    expect(sessionWatch()).toEqual(authority);
    await epochHost.stop('done');
  });

  test('a pane watch that never reads the request is stood by after two of its own passes', async () => {
    bind();
    updateState(agents, (state) => {
      (state.sessions.crew ??= emptySession()).watch = paneWatch();
    });
    const clock = { at: NOW };
    const logs: string[] = [];
    const build = hostedWatchAuthority({
      route: route(),
      teamFile,
      log: (text) => logs.push(text),
      now: () => new Date(clock.at),
      base: quietSources(clock),
      alive: (pid) => pid === PANE_PID || pid === process.pid,
      processInfo: () => ({ shell: WORKSPACE_PID, foreground: [PANE_PID] }),
    });
    const host = machine(build, clock);
    await waitUntil(() => requested().kind === 'request');

    // The pane watch completes two passes while the request stands (its heartbeat advances) but
    // never leaves: an older watch that does not read the request. The first pass refreshes the
    // request; the second is the one that stands the daemon by and withdraws it.
    for (const pass of [1, 2]) {
      clock.at = NOW + pass * HOSTED_AUTHORITY_TICK_MS;
      updateState(agents, (state) => {
        const record = state.sessions.crew?.watch;
        if (record !== undefined) record.heartbeat = new Date(clock.at).toISOString();
      });
      host.tick(new Date(clock.at));
      if (pass === 1) {
        await waitUntil(() => {
          const read = requested();
          return read.kind === 'request' && read.request.heartbeat === new Date(clock.at).toISOString();
        });
      }
    }
    await waitUntil(() => host.state().phase === 'standby');
    expect(host.state().why).toContain('did not hand over');
    // The request is withdrawn, and the pane's own record is left exactly as it stands.
    expect(existsSync(handoverPath(agents))).toBe(false);
    expect(sessionWatch()).toMatchObject({ pid: PANE_PID, pane: PANE });
    expect(logs.some((line) => line.includes('did not hand over after 2 passes'))).toBe(true);
    await host.stop('done');
  });
});

describe('a daemon restart', () => {
  test('restores the accepted route watch without a new command, taking a dead authority record', async () => {
    bind();
    const quiet = { at: NOW };
    const build = (routeArg: ReturnType<typeof route>, log: (text: string) => void) => hostedWatchAuthority({
      route: routeArg,
      teamFile,
      log,
      base: quietSources(quiet),
      alive: (pid) => pid === process.pid,
    });
    const first = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'manual',
      version: VERSION,
      heartbeatMs: 20,
      watchHosting: true,
      hostedWatch: build,
    });
    expect(first.kind).toBe('serving');
    if (first.kind !== 'serving') return;
    // The first daemon takes the route's authority and completes a pass without any command.
    await waitUntil(() => sessionWatch()?.pid === process.pid && sessionWatch()?.epoch !== undefined);
    const firstEpoch = sessionWatch()?.epoch;
    expect(firstEpoch).toMatch(/^watch_[0-9a-f]{32}$/);
    await waitUntil(() => {
      const read = readDaemonState(home);
      return read.kind === 'ok'
        && read.state.roots.some((entry) => entry.root === root && (entry.watch?.cycles ?? 0) >= 1);
    });
    await first.daemon.close();

    // A crashed daemon leaves its authority record behind: the pid is gone, the epoch is stale.
    const stale = { pid: 9_999_999, epoch: mintWatchEpoch(), heartbeat: new Date(NOW).toISOString() };
    updateState(agents, (state) => {
      (state.sessions.crew ??= emptySession()).watch = stale;
    });

    // The restart happens with no new `up` and no new `watch`: the recorded binding is the whole
    // command. The dead record gives way, the new daemon acquires, and its first pass cycles.
    const again = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'manual',
      version: VERSION,
      heartbeatMs: 20,
      watchHosting: true,
      hostedWatch: build,
    });
    expect(again.kind).toBe('serving');
    if (again.kind !== 'serving') return;
    try {
      await waitUntil(() => sessionWatch()?.pid === process.pid && sessionWatch()?.epoch !== stale.epoch);
      expect(sessionWatch()?.epoch).toMatch(/^watch_[0-9a-f]{32}$/);
      await waitUntil(() => {
        const read = readDaemonState(home);
        return read.kind === 'ok'
          && read.state.roots.some((entry) => entry.root === root && (entry.watch?.cycles ?? 0) >= 1);
      });
      // Nothing was asked to move: there was no pane watch to transfer.
      expect(existsSync(handoverPath(agents))).toBe(false);
    } finally {
      await again.daemon.close();
    }
  });
});
