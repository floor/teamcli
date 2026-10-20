// The daemon's production sender closure: the hosted wrapper's captured acquisition selects the
// context the watch's own verified direct send receives, and the actual verifier inside that send
// admits it. The scene is synthetic — a temporary team, a fake socket folder and a scripted pane
// — and touches no live session or real CLI home.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import { routeOf } from '../src/daemon/routes.ts';
import { createHostedWatch } from '../src/daemon/watch.ts';
import { hostedWatchAuthority } from '../src/daemon/watch-authority.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { MESSAGE_ID } from '../src/mcp/inbox.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { WATCH_DIRECT_WORK, verifyWatchAuthority } from '../src/watch/authority.ts';
import { sendWatchDirect } from '../src/watch/direct-send.ts';
import type { Machine } from '../src/watch/machine.ts';
import { dropDir, fake, scripted, world, type World } from './send-native-fixtures.ts';

const SESSION = 'acme';
// The dispatcher reads the idle seats its own snapshot counts: the team file's operator is
// skipped, so the wake target is a worker seat, not the coordinator.
const PANE = 'w1:p2';
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idleScreen = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** The receiving seat's own declaration that it accepts cross-session frames, and the socket its
 *  pane exposes, written so the declaration predates the socket. */
function accepting(made: World): void {
  const path = cliHookSettingsPath(made.dir, SESSION, 'helper');
  if (path === null) throw new Error('the fixture declares no settings path for helper');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(join(made.sockets, '222.sock'), '');
  const at = Date.now() - 60_000;
  utimesSync(path, new Date(at), new Date(at));
}

/** The registry records `up` leaves: the team, and the running seat whose pane it is on. The
 *  plain-seat send address resolves through this roster, so the woken worker is recorded. */
function registered(made: World): void {
  const id = teamIdOf(made.root);
  const agent = registerAgent(made.home, {
    name: 'helper',
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: id, seat: 'helper', session: SESSION, pane: PANE, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
  upsertTeam(made.home, id, {
    project: 'acme',
    entity: 'acme',
    session: SESSION,
    root: made.root,
    lobby: lobbyDir(made.home),
    roster: [{ agent: agent.id, seat: 'helper', role: 'implementer' }],
    lifecycle: 'running',
  });
}

/** The team file names its lobby outright. The fixture's lobby lives under the fixture home, and
 *  the actual verifier loads the file under the process's own home; an absolute lobby is the same
 *  folder to both readers, so the file the verifier judges is the file the send resolves. */
function verifiable(made: World): void {
  const path = join(made.dir, 'team.yaml');
  writeFileSync(path, `${readFileSync(path, 'utf8')}lobby: ${lobbyDir(made.home)}\n`);
}

/** The binding `up` records and the ready worker the queue can wake: the watch record itself is
 *  this run's own acquisition, written by the wrapper. */
function bound(made: World): void {
  updateState(made.dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.watchdog = { file: join(made.dir, 'team.yaml') };
    session.seats.helper = {
      stage: 'ready',
      pane: PANE,
      workspace: 'w1',
      last_active: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
  });
  writeFileSync(join(made.dir, 'queue.yaml'), '- id: t1\n  title: "First"\n');
}

function live(): Live {
  const agents: HerdrAgent[] = [{
    name: 'helper', agent: 'claude', pane: PANE, workspace: 'w1', status: 'idle', cwd: null,
  }];
  return {
    running: true,
    agents,
    workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })),
    screens: { [PANE]: idleScreen },
  };
}

function sources(made: World, clock: { at: number }): WatchSources {
  return {
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
    sendKey: () => false,
    sleep: async () => {},
    notify: () => {},
    now: () => new Date(clock.at),
    wait: async () => false,
    alive: () => true,
    pid: process.pid,
    home: made.home,
    statusSource: undefined,
  };
}

async function waitUntil(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the hosted watch');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function stagedIds(made: World, seat = 'helper'): string[] {
  try {
    return readdirSync(dropDir(made.dir, seat)).filter((name) => MESSAGE_ID.test(name));
  } catch {
    return [];
  }
}

describe("the daemon's watch sender", () => {
  test('the captured acquisition, not a request field, selects the send context', async () => {
    const made = world(['socket']);
    cleanup = made.cleanup;
    accepting(made);
    registered(made);
    verifiable(made);
    bound(made);
    const clock = { at: Date.now() };
    const dials: string[] = [];
    const pane = scripted(['idle'], null);
    const host = fake(made, {
      agents: () => [{ name: 'helper', pane: PANE }],
      native: pane,
      deliver: async (_socketPath, frame) => {
        dials.push(frame);
        return { ok: true };
      },
    });
    const route = routeOf(made.root, 'acme', SESSION, ['lead', 'helper', 'native']);
    const teamFile = join(made.dir, 'team.yaml');
    let captured = '';
    const build = hostedWatchAuthority({
      route,
      teamFile,
      log: () => {},
      now: () => new Date(clock.at),
      base: sources(made, clock),
      verifyAuthority: (check) => verifyWatchAuthority({ ...check, purpose: WATCH_DIRECT_WORK, now: new Date(clock.at) }),
      // The production closure: the epoch this host captured at acquire, never a queue field or
      // a wrapper boolean. `sendWatchDirect` then compiles the actual verifier itself.
      sender: (acquisition) => {
        captured = acquisition.epoch;
        return (request) => sendWatchDirect(
          { root: route.root, session: route.session, capturedEpoch: acquisition.epoch },
          request,
          host,
        );
      },
    });
    const machineHost = createHostedWatch({ route, now: () => new Date(clock.at), ...build, onTick: build.tick });

    await waitUntil(() => dials.length === 1);
    const held = readState(made.dir).sessions[SESSION]?.watch;
    expect(captured).toMatch(/^watch_[0-9a-f]{32}$/);
    expect(held?.epoch).toBe(captured);
    expect(machineHost.state().effects).toBe('open');
    // The send staged the watch's own record and typed nothing: the socket leg carried it.
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const ids = stagedIds(made);
    expect(ids).toHaveLength(1);
    const staged = readFileSync(join(dropDir(made.dir, 'helper'), ids[0] as string), 'utf8');
    expect(staged).toContain('"from": "watch"');

    await machineHost.stop('done');
    expect(readState(made.dir).sessions[SESSION]?.watch).toBeUndefined();
  });

  test('a successor epoch installed during preparation stops the send at its own recheck', async () => {
    const made = world(['socket']);
    cleanup = made.cleanup;
    accepting(made);
    registered(made);
    verifiable(made);
    bound(made);
    const clock = { at: Date.now() };
    const dials: string[] = [];
    const host = fake(made, {
      agents: () => [{ name: 'helper', pane: PANE }],
      deliver: async (_socketPath, frame) => {
        dials.push(frame);
        return { ok: true };
      },
      // The preparation's own clock: the message id is minted after the wrapper's effect check
      // and `sendWatchDirect`'s first verification, but before the record is staged and the
      // transport recheck runs. The wrapper's boolean cannot stand in for that recheck.
      sendId: () => {
        updateState(made.dir, (state) => {
          const session = state.sessions[SESSION];
          if (session?.watch === undefined) throw new Error('the fixture records no watch');
          session.watch.epoch = `watch_${'ab'.repeat(16)}`;
          session.watch.heartbeat = new Date().toISOString();
        });
        return '11111111-2222-4333-8444-555555555555';
      },
    });
    const route = routeOf(made.root, 'acme', SESSION, ['lead', 'helper', 'native']);
    const build = hostedWatchAuthority({
      route,
      teamFile: join(made.dir, 'team.yaml'),
      log: () => {},
      now: () => new Date(clock.at),
      base: sources(made, clock),
      verifyAuthority: (check) => verifyWatchAuthority({ ...check, purpose: WATCH_DIRECT_WORK, now: new Date(clock.at) }),
      sender: (acquisition) => (request) => sendWatchDirect(
        { root: route.root, session: route.session, capturedEpoch: acquisition.epoch },
        request,
        host,
      ),
    });
    const machineHost = createHostedWatch({ route, now: () => new Date(clock.at), ...build, onTick: build.tick });

    // The send stages its record before the recheck; nothing is dialed behind the refusal.
    await waitUntil(() => stagedIds(made).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dials).toHaveLength(0);
    expect(readState(made.dir).sessions[SESSION]?.watch?.epoch).toBe(`watch_${'ab'.repeat(16)}`);

    // The successor's record is not this run's to release.
    await machineHost.stop('done');
    expect(readState(made.dir).sessions[SESSION]?.watch?.epoch).toBe(`watch_${'ab'.repeat(16)}`);
  });
});
