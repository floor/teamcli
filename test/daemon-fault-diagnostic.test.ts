// The one scoped hosted-watch fault diagnostic, independently of the loop it faults. The owner
// (or the dev-mode orchestrator the same proof admits) asks a running daemon to end exactly one
// hosted run; the request is one 0600 file bound to the daemon's resolved home, pid and start
// instant, the daemon's own heartbeat consumes it once, and only the route id it names is
// faulted. Every other route keeps cycling, a malformed or wrongly-owned request changes
// nothing, a repeated request is never replayed, and a fault that has not reached its seam when
// the daemon closes is answered `not reached`. The scenes are synthetic throughout: temporary
// homes, temporary checkouts, fake herdr sources and an injected watch run. No live service is
// installed, started or faulted, and no pane, credential or grant is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallerSources, Process as CallerProcess } from '../src/caller.ts';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import {
  FAULT_WHY,
  createFaultInbox,
  faultRequestPath,
  readFaultResult,
  writeFaultRequest,
  type FaultRequest,
} from '../src/daemon/fault.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { daemonSocketPath, machineConfigDir } from '../src/daemon/paths.ts';
import { routeId, routeOf } from '../src/daemon/routes.ts';
import { readDaemonState, writeDaemonState, type DaemonRootState, type DaemonState } from '../src/daemon/state.ts';
import { createHostedWatch, type HostedWatch } from '../src/daemon/watch.ts';
import { upsertTeam, teamIdOf } from '../src/registry/teams.ts';
import type { HostedWatchState } from '../src/watch/hosted.ts';
import { testIo } from './helpers.ts';

const SINCE = '2026-10-21T09:00:00.000Z';
const START = Date.parse('2026-10-21T09:00:00Z');

const TEAM = `format: 1
project: acme
entity: floor
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

const MAIN_TEAM = `format: 1
project: floor
entity: floor
session: main
coordinator: atlas
operator: atlas
workspace:
  mode: shared
seats:
  - role: coordinator
    name: atlas
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

let bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function scratch(): { base: string; root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-fault-')));
  bases.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  return { base, root, home };
}

/** A main team folder above the project checkout, its own state and the registry entry, so the
 *  main orchestrator's cross-team proof can actually be made. */
function crossPlace(): { mainRoot: string; root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-fault-cross-')));
  bases.push(base);
  const mainRoot = join(base, 'floor');
  const root = join(mainRoot, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(mainRoot, '.agents'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(mainRoot, '.agents', 'team.yaml'), MAIN_TEAM);
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  writeFileSync(
    join(mainRoot, '.agents', 'team.state.json'),
    `${JSON.stringify({
      format: 1,
      sessions: { main: { seats: { atlas: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' } }, worktrees: {} } },
    }, null, 2)}\n`,
  );
  upsertTeam(home, teamIdOf(mainRoot), { project: 'floor', entity: 'floor', session: 'main', root: mainRoot, roster: [], by: 'test' });
  upsertTeam(home, teamIdOf(root), { project: 'acme', entity: 'floor', session: 'crew', root, roster: [], by: 'test' });
  return { mainRoot, root, home };
}

const owner = { kind: 'owner' } as const;

function sourcesOf(home: string, overrides: Partial<DaemonCommandSources> = {}): DaemonCommandSources {
  return {
    home,
    program: { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js' },
    version: 'test',
    ...overrides,
  };
}

function idOf(root: string): string {
  return routeId(routeOf(root, 'acme', 'crew', []));
}

function watchRecord(routeIdValue: string, root: string, overrides: Partial<HostedWatchState> = {}): HostedWatchState {
  return {
    routeId: routeIdValue,
    root,
    team: 'acme',
    session: 'crew',
    phase: 'running',
    startedAt: SINCE,
    lastCycleAt: SINCE,
    lastCycleOutcome: 'pass',
    cycles: 3,
    failures: 0,
    effects: 'blocked',
    required: true,
    why: null,
    ...overrides,
  };
}

function rootRecord(root: string, watch?: HostedWatchState): DaemonRootState {
  return {
    root,
    team: 'acme',
    send: 'serving',
    bus: 'serving',
    why: null,
    ...(watch === undefined ? {} : { watch }),
  };
}

/** A daemon record a reader and the request validator can both see: this process is its own
 *  live pid, as a real foreground daemon's record would name it. */
function daemonRecord(home: string, roots: DaemonRootState[]): DaemonState {
  return {
    format: 1,
    pid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    since: SINCE,
    startedBy: 'manual',
    version: 'test',
    heartbeatAt: SINCE,
    socket: daemonSocketPath(home),
    features: { broker: 'absent' },
    stuck: [],
    roots,
  };
}

function requestOf(home: string, route: string, nonce = 'nonce-1', overrides: Partial<FaultRequest> = {}): FaultRequest {
  return {
    format: 1,
    home,
    routeId: route,
    daemonPid: process.pid,
    daemonSince: SINCE,
    why: FAULT_WHY,
    requestedAt: SINCE,
    nonce,
    ...overrides,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the fault diagnostic');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A watch whose run cycles once and then waits; its own route is its identity. */
function cyclingWatch(root: string, clock: { at: number }): HostedWatch {
  return createHostedWatch({
    route: routeOf(root, 'acme', 'crew', ['crew-lead']),
    now: () => new Date(clock.at),
    run: async (loop) => {
      for (;;) {
        loop.cycled(new Date(clock.at));
        if (!(await loop.wait(10_000))) return 0;
      }
    },
  });
}

const UNDER_HERDR: CallerProcess[] = [
  { pid: 501, name: 'zsh' },
  { pid: 500, name: 'herdr' },
];

/** The same-entity proof's own answer: one agent per listed pane in a session, the caller's
 *  pane root an ancestor and every other pane another process's. */
function herdr(sessions: Record<string, { name: string; pane: string }[]>): (asked?: string) => CallerSources {
  return (asked) => {
    const agents = asked === undefined ? [] : (sessions[asked] ?? []);
    return {
      ancestors: () => UNDER_HERDR,
      agents: () => agents.map((agent) => ({ name: agent.name, agent: 'claude', pane: agent.pane, workspace: agent.pane.split(':')[0] ?? '', status: 'idle', cwd: null })),
      paneRootPid: (pane) => (agents.some((agent) => agent.pane === pane) ? 501 : null),
      env: {},
      stdinIsTTY: false,
    };
  };
}

describe('the request the owner writes', () => {
  test('one 0600 request names the resolved home, route and daemon run; a second waits behind it', async () => {
    const { root, home } = scratch();
    const id = idOf(root);
    writeDaemonState(home, daemonRecord(home, [rootRecord(root, watchRecord(id, root))]));

    const io = testIo(root, owner);
    expect(
      await runDaemon(['fault-watch', '--root', root, '--route', id], io, sourcesOf(home, { faultWaitMs: 40, faultPollMs: 5 })),
    ).toBe(1);
    // Nothing consumed the request in this scene, so the honest answer is that the fault was
    // never reached — and nothing was killed to pretend otherwise.
    expect(io.err).toContain('did not reach the fault');
    expect(io.err).toContain('nothing was killed');

    const path = faultRequestPath(home);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(path, 'utf8')) as FaultRequest;
    expect(written).toMatchObject({ format: 1, home, routeId: id, daemonPid: process.pid, daemonSince: SINCE, why: FAULT_WHY });

    const again = testIo(root, owner);
    expect(await runDaemon(['fault-watch', '--root', root, '--route', id], again, sourcesOf(home, { faultWaitMs: 40 }))).toBe(1);
    expect(again.err).toContain('a fault request is already waiting');
    unlinkSync(path);
  });

  test('the route id is parsed and matched exactly; a wrong id is refused before anything is written', async () => {
    const { root, home } = scratch();
    const id = idOf(root);
    writeDaemonState(home, daemonRecord(home, [rootRecord(root, watchRecord(id, root))]));

    const malformed = testIo(root, owner);
    expect(
      await runDaemon(['fault-watch', '--root', root, '--route', 'not-a-route'], malformed, sourcesOf(home)),
    ).toBe(2);
    expect(malformed.err).toContain('32-character route id');
    expect(existsSync(faultRequestPath(home))).toBe(false);

    const wrong = testIo(root, owner);
    expect(
      await runDaemon(['fault-watch', '--root', root, '--route', 'f'.repeat(32)], wrong, sourcesOf(home)),
    ).toBe(1);
    expect(wrong.err).toContain("does not name this checkout's hosted route");
    expect(wrong.err).toContain(id);
    expect(existsSync(faultRequestPath(home))).toBe(false);
  });

  test('only a running daemon with that exact required watch is asked; each refusal names why', async () => {
    const { root, home } = scratch();
    const id = idOf(root);

    const absent = testIo(root, owner);
    expect(await runDaemon(['fault-watch', '--root', root, '--route', id], absent, sourcesOf(home))).toBe(1);
    expect(absent.err).toContain('not running');

    writeDaemonState(home, daemonRecord(home, [rootRecord(root)]));
    const noWatch = testIo(root, owner);
    expect(await runDaemon(['fault-watch', '--root', root, '--route', id], noWatch, sourcesOf(home))).toBe(1);
    expect(noWatch.err).toContain('no hosted watch');

    writeDaemonState(home, daemonRecord(home, [rootRecord(root, watchRecord(id, root, { phase: 'standby', why: 'a pane watch owns it' }))]));
    const standby = testIo(root, owner);
    expect(await runDaemon(['fault-watch', '--root', root, '--route', id], standby, sourcesOf(home))).toBe(1);
    expect(standby.err).toContain('stands down to a live pane watch');

    writeDaemonState(home, daemonRecord(home, [rootRecord(root, watchRecord(id, root, { phase: 'stopped' }))]));
    const stopped = testIo(root, owner);
    expect(await runDaemon(['fault-watch', '--root', root, '--route', id], stopped, sourcesOf(home))).toBe(1);
    expect(stopped.err).toContain('has stopped');

    writeDaemonState(home, daemonRecord(home, [rootRecord(root, watchRecord(id, root, { required: false }))]));
    const notRequired = testIo(root, owner);
    expect(await runDaemon(['fault-watch', '--root', root, '--route', id], notRequired, sourcesOf(home))).toBe(1);
    expect(notRequired.err).toContain('not started with a hosted watch');

    expect(existsSync(faultRequestPath(home))).toBe(false);
  });

  test('a dry run proves admission and the watch but writes no request', async () => {
    const { root, home } = scratch();
    const id = idOf(root);
    writeDaemonState(home, daemonRecord(home, [rootRecord(root, watchRecord(id, root))]));
    const io = testIo(root, owner);
    expect(await runDaemon(['fault-watch', '--root', root, '--route', id, '--dry-run'], io, sourcesOf(home))).toBe(0);
    expect(io.out).toContain(`would ask the running daemon to fault the hosted watch for ${root}`);
    expect(existsSync(faultRequestPath(home))).toBe(false);
  });
});

describe('the administration admission', () => {
  test('the same-entity main orchestrator is lifted with the warning and its audit line', async () => {
    const { root, home } = crossPlace();
    const id = idOf(root);
    writeDaemonState(home, daemonRecord(home, [rootRecord(root, watchRecord(id, root))]));
    const io = testIo(root);
    io.callerSources = herdr({ main: [{ name: 'atlas', pane: 'w1:p1' }] });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const code = await runDaemon(['fault-watch', '--root', root, '--route', id, '--dry-run'], io, sourcesOf(home));
    expect(code).toBe(0);
    // The warning keeps the refusal's own words, which name the caller it refuses.
    expect(io.err).toContain('warning: only the owner installs or removes the machine daemon');
    expect(io.err).toContain('dev mode continues');
    const log = readFileSync(join(root, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('daemon [atlas] warning: only the owner installs or removes the machine daemon');
    expect(log).toContain('admitted as orchestrator');
  });

  test('the target team’s operator is no orchestrator: dev mode does not blanket-admit every seat', async () => {
    const { root, home } = crossPlace();
    const id = idOf(root);
    writeDaemonState(home, daemonRecord(home, [rootRecord(root, watchRecord(id, root))]));
    const io = testIo(root, { kind: 'seat', name: 'crew-op', pane: 'w2:p1', session: 'crew' });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runDaemon(['fault-watch', '--root', root, '--route', id, '--dry-run'], io, sourcesOf(home))).toBe(1);
    expect(io.err).toContain('only the owner installs or removes the machine daemon');
    expect(io.err).not.toContain('dev mode continues');
    expect(existsSync(faultRequestPath(home))).toBe(false);
  });

  test('the right name placed elsewhere and an unplaced caller are refused', async () => {
    const { root, home } = crossPlace();
    const id = idOf(root);
    writeDaemonState(home, daemonRecord(home, [rootRecord(root, watchRecord(id, root))]));
    // The main team's state records its orchestrator on w1:p1; this caller stands on w9:p9.
    const wrongPane = testIo(root);
    wrongPane.callerSources = herdr({ main: [{ name: 'atlas', pane: 'w9:p9' }] });
    wrongPane.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runDaemon(['fault-watch', '--root', root, '--route', id, '--dry-run'], wrongPane, sourcesOf(home))).toBe(1);
    expect(wrongPane.err).toContain('only the owner');

    const off = testIo(root);
    off.callerSources = herdr({ main: [{ name: 'atlas', pane: 'w1:p1' }] });
    expect(await runDaemon(['fault-watch', '--root', root, '--route', id, '--dry-run'], off, sourcesOf(home))).toBe(1);
    expect(off.err).toContain('only the owner');
    expect(existsSync(faultRequestPath(home))).toBe(false);
  });
});

describe('the daemon consumes one request once', () => {
  test('only the named route is faulted, once, and its own beat restarts it', async () => {
    const { root, home } = scratch();
    const clock = { at: START };
    const a = cyclingWatch(join(root, 'a'), clock);
    const b = cyclingWatch(join(root, 'b'), clock);
    const bBefore = b.state();
    const inbox = createFaultInbox({ home, pid: process.pid, since: SINCE, now: () => new Date(clock.at) });

    expect(writeFaultRequest(home, requestOf(home, a.state().routeId, 'nonce-a'))).toEqual({ ok: true });
    inbox.consume([a, b]);
    await flush();

    expect(a.state()).toMatchObject({ phase: 'failed', failures: 1, lastCycleOutcome: 'failed', why: FAULT_WHY });
    expect(b.state()).toMatchObject({ phase: bBefore.phase, failures: 0, cycles: bBefore.cycles });
    expect(existsSync(faultRequestPath(home))).toBe(false);
    const result = readFaultResult(home);
    expect(result).toMatchObject({ outcome: 'faulted', nonce: 'nonce-a', routeId: a.state().routeId, why: FAULT_WHY });

    // A repeated consume with no new request is nothing; the faulted watch stays counted once.
    inbox.consume([a, b]);
    await flush();
    expect(a.state().failures).toBe(1);
    expect(b.state().failures).toBe(0);

    // The next beat restarts only the faulted route; its first completed pass clears the why
    // and leaves the failure count standing.
    a.tick(new Date(clock.at + 5_000));
    b.tick(new Date(clock.at + 5_000));
    await flush();
    expect(a.state()).toMatchObject({ phase: 'running', failures: 1, why: null });
    expect(a.state().cycles).toBe(2);
    expect(b.state().cycles).toBe(bBefore.cycles);
    await a.stop('the scene is done');
    await b.stop('the scene is done');
  });

  test('a malformed, wrongly-owned or unreachable request changes nothing and leaves its refusal', async () => {
    const { root, home } = scratch();
    const clock = { at: START };
    const watched = cyclingWatch(root, clock);
    const inbox = createFaultInbox({ home, pid: process.pid, since: SINCE, now: () => new Date(clock.at) });
    const path = faultRequestPath(home);
    mkdirSync(machineConfigDir(home), { recursive: true, mode: 0o700 });
    const route = watched.state().routeId;

    const cases: { write: () => void; nonce: string; why: string }[] = [
      {
        write: () => {
          writeFileSync(path, `${JSON.stringify(requestOf(home, route, 'mode'))}\n`, { mode: 0o600 });
          chmodSync(path, 0o644);
        },
        nonce: 'mode',
        why: 'not a private 0600 file',
      },
      { write: () => writeFileSync(path, '{ not json\n', { mode: 0o600 }), nonce: '', why: 'not a valid diagnostic request' },
      {
        write: () => writeFileSync(path, `${JSON.stringify(requestOf(home, route, 'home', { home: '/elsewhere' }))}\n`, { mode: 0o600 }),
        nonce: 'home',
        why: 'another daemon home',
      },
      {
        write: () => writeFileSync(path, `${JSON.stringify(requestOf(home, route, 'pid', { daemonPid: 1 }))}\n`, { mode: 0o600 }),
        nonce: 'pid',
        why: 'another daemon run',
      },
      {
        write: () => writeFileSync(path, `${JSON.stringify(requestOf(home, 'a'.repeat(32), 'route'))}\n`, { mode: 0o600 }),
        nonce: 'route',
        why: 'no hosted watch serves this route',
      },
    ];
    for (const one of cases) {
      one.write();
      inbox.consume([watched]);
      expect(existsSync(path)).toBe(false);
      const result = readFaultResult(home);
      expect(result?.outcome).toBe('refused');
      expect(result?.nonce).toBe(one.nonce);
      expect(result?.why).toContain(one.why);
      expect(watched.state().failures).toBe(0);
    }
    await watched.stop('the scene is done');
  });

  test('a standby route and a route not started with a watch refuse instead of being ended', async () => {
    const { root, home } = scratch();
    const clock = { at: START };
    const standby = createHostedWatch({
      route: routeOf(join(root, 'standby'), 'acme', 'crew', []),
      now: () => new Date(clock.at),
      standby: 'a pane watch owns this session',
      run: async () => 0,
    });
    const optional = createHostedWatch({
      route: routeOf(join(root, 'optional'), 'acme', 'crew', []),
      now: () => new Date(clock.at),
      required: false,
      run: async (loop) => {
        await loop.wait(10_000);
        return 0;
      },
    });
    const inbox = createFaultInbox({ home, pid: process.pid, since: SINCE, now: () => new Date(clock.at) });

    expect(writeFaultRequest(home, requestOf(home, standby.state().routeId, 'standby'))).toEqual({ ok: true });
    inbox.consume([standby, optional]);
    const refusedStandby = readFaultResult(home);
    expect(refusedStandby?.outcome).toBe('refused');
    expect(refusedStandby?.nonce).toBe('standby');
    expect(refusedStandby?.why).toContain('stands down');

    expect(writeFaultRequest(home, requestOf(home, optional.state().routeId, 'optional'))).toEqual({ ok: true });
    inbox.consume([standby, optional]);
    const refusedOptional = readFaultResult(home);
    expect(refusedOptional?.outcome).toBe('refused');
    expect(refusedOptional?.nonce).toBe('optional');
    expect(refusedOptional?.why).toContain('not started with a hosted watch');
    expect(standby.state().phase).toBe('standby');
    expect(optional.state().failures).toBe(0);
    await standby.stop('the scene is done');
    await optional.stop('the scene is done');
  });

  test('a fault still waiting for its seam is answered not reached when the daemon closes', async () => {
    const { root, home } = scratch();
    const clock = { at: START };
    const stuck = createHostedWatch({
      route: routeOf(join(root, 'stuck'), 'acme', 'crew', []),
      now: () => new Date(clock.at),
      run: async (loop) => {
        // This run never reaches the host's seam: the injected fault cannot end it, and the
        // close must answer its writer rather than leave the request to a later daemon.
        while (!loop.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 2));
        return 0;
      },
    });
    const inbox = createFaultInbox({ home, pid: process.pid, since: SINCE, now: () => new Date(clock.at) });
    expect(writeFaultRequest(home, requestOf(home, stuck.state().routeId, 'stuck'))).toEqual({ ok: true });
    inbox.consume([stuck]);
    expect(readFaultResult(home)).toBeNull();
    inbox.close();
    expect(readFaultResult(home)).toMatchObject({ outcome: 'not reached', nonce: 'stuck' });
    await stuck.stop('the daemon is closing');
  });

  test('a second request for the same route is refused while the first is still leaving its seam', async () => {
    const { root, home } = scratch();
    const clock = { at: START };
    const stuck = createHostedWatch({
      route: routeOf(join(root, 'stuck'), 'acme', 'crew', []),
      now: () => new Date(clock.at),
      run: async (loop) => {
        while (!loop.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 2));
        return 0;
      },
    });
    const inbox = createFaultInbox({ home, pid: process.pid, since: SINCE, now: () => new Date(clock.at) });
    expect(writeFaultRequest(home, requestOf(home, stuck.state().routeId, 'first'))).toEqual({ ok: true });
    inbox.consume([stuck]);
    expect(readFaultResult(home)).toBeNull();
    expect(writeFaultRequest(home, requestOf(home, stuck.state().routeId, 'second'))).toEqual({ ok: true });
    inbox.consume([stuck]);
    const refused = readFaultResult(home);
    expect(refused?.outcome).toBe('refused');
    expect(refused?.nonce).toBe('second');
    expect(refused?.why).toContain('still leaving its seam');
    inbox.close();
    expect(readFaultResult(home)).toMatchObject({ outcome: 'not reached', nonce: 'first' });
    await stuck.stop('the daemon is closing');
  });

  test('a request is consumed by a repeated beat only once, even for the same nonce', async () => {
    const { root, home } = scratch();
    const clock = { at: START };
    const watched = cyclingWatch(root, clock);
    const inbox = createFaultInbox({ home, pid: process.pid, since: SINCE, now: () => new Date(clock.at) });
    expect(writeFaultRequest(home, requestOf(home, watched.state().routeId, 'once'))).toEqual({ ok: true });
    inbox.consume([watched]);
    await flush();
    inbox.consume([watched]);
    await flush();
    expect(watched.state().failures).toBe(1);
    expect(readFaultResult(home)).toMatchObject({ outcome: 'faulted', nonce: 'once' });
    await watched.stop('the scene is done');
  });
});

describe('the running daemon, end to end', () => {
  test('the CLI faults one hosted route of a real daemon; the record counts it and the loop recovers', async () => {
    const { root, home } = scratch();
    const clock = { at: START };
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'manual',
      version: 'test',
      heartbeatMs: 25,
      now: () => new Date(clock.at),
      watchHosting: true,
      hostedWatch: () => ({
        run: async (loop) => {
          for (;;) {
            loop.cycled(new Date(clock.at));
            if (!(await loop.wait(10_000))) return 0;
          }
        },
      }),
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const before = started.daemon.roots[0]?.watch;
      expect(before).toMatchObject({ phase: 'running', failures: 0 });
      if (before === undefined) return;
      const pidBefore = before.startedAt;
      const io = testIo(root, owner);
      const code = await runDaemon(
        ['fault-watch', '--root', root, '--route', before.routeId],
        io,
        sourcesOf(home, { faultWaitMs: 2000, faultPollMs: 10 }),
      );
      expect(code).toBe(0);
      expect(io.out).toContain(`faulted the hosted watch for ${root}`);
      expect(io.out).toContain(before.routeId);

      await waitUntil(() => {
        const watch = started.daemon.roots[0]?.watch;
        return watch !== undefined && watch.failures === 1 && watch.phase === 'running';
      });
      const after = started.daemon.roots[0]?.watch;
      expect(after).toMatchObject({ phase: 'running', failures: 1, why: null, lastCycleOutcome: 'pass' });
      expect(after?.cycles).toBeGreaterThan(before.cycles);
      expect(after?.startedAt).toBe(pidBefore);

      const recorded = readDaemonState(home);
      expect(recorded.kind).toBe('ok');
      if (recorded.kind === 'ok') {
        expect(recorded.state.pid).toBe(process.pid);
        expect(recorded.state.since).toBe(SINCE);
        expect(recorded.state.roots[0]?.watch).toMatchObject({ failures: 1, phase: 'running' });
      }
    } finally {
      await started.daemon.close();
    }
    expect(started.daemon.roots[0]?.watch?.phase).toBe('stopped');
    expect(existsSync(faultRequestPath(home))).toBe(false);
  });
});
