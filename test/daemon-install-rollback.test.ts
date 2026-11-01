// Synthetic scenes for the install's refresh safety net: an injected runner stands in for the
// system service manager, so nothing here runs a platform command and no machine daemon is
// touched. The scenes prove what a failed refresh must never leave: the old daemon is stopped,
// the new load is offered again while the manager refuses (the earlier stop may still be
// finishing), and a load that still fails puts the previous unit back and starts its daemon
// again — or says plainly that no daemon was started. The command scenes prove the failure
// exits non-zero under its own contract row.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import { daemonLogPath } from '../src/daemon/paths.ts';
import { darwinServiceManager } from '../src/daemon/service-darwin.ts';
import type { ServiceManager, ServiceProgram, ServiceRunResult, ServiceRunner } from '../src/daemon/service.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
coordinator: clerk
operator: op-1
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: clerk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - role: worker
    name: op-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;

const bases: string[] = [];

function scratch(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-install-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  return { root, home };
}

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

const PRIOR_PROGRAM: ServiceProgram = { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: ['/repo'] };
const NEW_PROGRAM: ServiceProgram = { execPath: '/runtime/bin/node', entry: '/app/dist/cli-v2.js', roots: ['/repo'] };

const OK: ServiceRunResult = { status: 0, stdout: '', stderr: '' };
/** The manager's answer for a load it will not take — a status 5 refusal, the answer that stopped
 *  the previous daemon and left the machine empty before this fix. */
const LOAD_REFUSED: ServiceRunResult = { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };

/** The loads one install makes for the new unit before it gives up: the first offer, then the
 *  nine of the bounded retry, each refused. */
const BOUNDED_OFFERS = 10;

/** `count` refused loads, then the accepted one. */
function refusedThenAccepted(count: number): ServiceRunResult[] {
  return [...Array.from({ length: count }, () => LOAD_REFUSED), OK];
}

type Script = { load?: ServiceRunResult[]; stop?: ServiceRunResult[] };

/**
 * One answer per manager call, in order, keyed by the call the adapter makes; the last answer
 * repeats for every call after it. The call itself is recorded as its verb, so a scene can say
 * what the adapter asked the manager to do and in which order. Nothing is executed.
 */
function synthetic(script: Script): { runner: ServiceRunner; calls: string[] } {
  const queues: Record<string, ServiceRunResult[]> = {
    bootstrap: [...(script.load ?? [OK])],
    bootout: [...(script.stop ?? [OK])],
  };
  const calls: string[] = [];
  const runner: ServiceRunner = (_command, args): ServiceRunResult => {
    const verb = args[0] ?? '';
    calls.push(verb);
    const queue = queues[verb] ?? [OK];
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    return { ...(answer ?? OK) };
  };
  return { runner, calls };
}

/** The live adapter with the platform's command replaced and every wait recorded, not slept. */
function managerWith(script: Script, sleeps: number[] = []): { manager: ServiceManager; calls: string[] } {
  const { runner, calls } = synthetic(script);
  const manager = darwinServiceManager({ runner, uid: 501, sleep: (ms) => sleeps.push(ms) });
  return { manager, calls };
}

/** The earlier unit this refresh replaces: one successful install, read back byte for byte. */
function withEarlierUnit(home: string): string {
  const first = managerWith({}).manager;
  expect(first.install(home, PRIOR_PROGRAM).ok).toBe(true);
  return readFileSync(first.unitPath(home), 'utf8');
}

function sourcesOf(home: string, service: ServiceManager): DaemonCommandSources {
  return {
    home,
    program: { execPath: NEW_PROGRAM.execPath, entry: NEW_PROGRAM.entry },
    version: 'test',
    service,
  };
}

describe('a refresh stops the old daemon and offers the new load until the manager takes it', () => {
  test('a load refused while the old daemon is loaded is offered again after the stop', () => {
    const { home } = scratch();
    const sleeps: number[] = [];
    const { manager, calls } = managerWith({ load: [LOAD_REFUSED, OK] }, sleeps);

    const result = manager.install(home, NEW_PROGRAM);

    expect(result).toMatchObject({ ok: true });
    expect(calls).toEqual(['bootstrap', 'bootout', 'bootstrap']);
    // The manager took the load at once after the stop, so nothing waited.
    expect(sleeps).toEqual([]);
    expect(existsSync(manager.unitPath(home))).toBe(true);
  });

  test('a load still refused while the previous daemon is leaving is waited on, not called failed', () => {
    const { home } = scratch();
    const sleeps: number[] = [];
    // The stop is still in flight for the next two offers; the third is accepted.
    const { manager, calls } = managerWith({ load: refusedThenAccepted(3) }, sleeps);

    const result = manager.install(home, NEW_PROGRAM);

    expect(result).toMatchObject({ ok: true });
    expect(calls).toEqual(['bootstrap', 'bootout', 'bootstrap', 'bootstrap', 'bootstrap']);
    expect(sleeps).toEqual([100, 200]);
  });

  test('the waits between offers grow, so a slow stop is given time without hammering the manager', () => {
    const { home } = scratch();
    const sleeps: number[] = [];
    const { manager } = managerWith({ load: refusedThenAccepted(5) }, sleeps);

    const result = manager.install(home, NEW_PROGRAM);

    expect(result).toMatchObject({ ok: true });
    expect(sleeps).toEqual([100, 200, 400, 800]);
  });
});

describe('a load that fails every time puts the previous unit back', () => {
  test('the previous daemon is started again, the failure names the rollback, and a daemon runs under the earlier unit', () => {
    const { home } = scratch();
    const earlier = withEarlierUnit(home);
    const sleeps: number[] = [];
    const { manager } = managerWith({ load: refusedThenAccepted(BOUNDED_OFFERS) }, sleeps);

    const result = manager.install(home, NEW_PROGRAM);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe('restored');
    expect(result.why).toBe(
      'the system service manager refused to start the new daemon; the previous one was put back and started again',
    );
    // The refusal names no platform facility, and the earlier definition is the one on disk, so
    // the unit the manager starts again is the one that was running before the refresh.
    expect(result.why).not.toMatch(/launchctl|launchd|\.plist|launch agents/i);
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(earlier);
    // Every wait of the bounded retry, and none for the rollback load, which was accepted first.
    expect(sleeps).toEqual([100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000]);
  });

  test('a rollback load that is refused too says no daemon was started, and leaves the earlier unit on disk', () => {
    const { home } = scratch();
    const earlier = withEarlierUnit(home);
    const { manager, calls } = managerWith({ load: [LOAD_REFUSED] });

    const result = manager.install(home, NEW_PROGRAM);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe('lost');
    expect(result.why).toBe(
      'the system service manager refused to start the new daemon, and the previous one could not be started again; no daemon was started',
    );
    expect(result.why).not.toMatch(/launchctl|launchd|\.plist|launch agents/i);
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(earlier);
    // The effort is bounded: the forward retry, then the same bounded retry for the earlier unit.
    expect(calls.filter((call) => call === 'bootstrap')).toHaveLength(19);
  });

  test('a first install the manager refuses takes its own definition back out and names no earlier unit', () => {
    const { home } = scratch();
    const { manager, calls } = managerWith({ load: [LOAD_REFUSED] });

    const result = manager.install(home, NEW_PROGRAM);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe('refused');
    expect(result.why).toBe('the system service manager refused to start the daemon');
    expect(existsSync(manager.unitPath(home))).toBe(false);
    // The offers are bounded: the first, then the nine of the retry, and no more.
    expect(calls.filter((call) => call === 'bootstrap')).toHaveLength(BOUNDED_OFFERS);
  });
});

describe('the command reports a failed refresh with its own row and a daemon still running', () => {
  /** One failed refresh scene: the first install leaves the earlier unit, the second is refused. */
  function refuseRefresh(load: ServiceRunResult[]): { root: string; home: string; manager: ServiceManager } {
    const { root, home } = scratch();
    withEarlierUnit(home);
    const manager = managerWith({ load }).manager;
    return { root, home, manager };
  }

  test('install exits 1 under daemon.install-rolled-back and prints the rollback plainly', async () => {
    const { root, home, manager } = refuseRefresh(refusedThenAccepted(BOUNDED_OFFERS));
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install'], io, sourcesOf(home, manager));

    expect(code).toBe(1);
    expect(io.err).toContain(
      'team daemon: the system service manager refused to start the new daemon; the previous one was put back and started again',
    );
    expect(io.err).not.toContain('launchctl');
    // The daemon log carries the technical failure and the rollback, so the incident is
    // diagnosable after the one line has gone by.
    const log = readFileSync(daemonLogPath(home), 'utf8');
    expect(log).toContain('install: the load exited 5');
    expect(log).toContain('the earlier unit was put back and its daemon started');
  });

  test('install --json exits 1 with the daemon.install-rolled-back error id', async () => {
    const { root, home, manager } = refuseRefresh(refusedThenAccepted(BOUNDED_OFFERS));
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install', '--json'], io, sourcesOf(home, manager));

    expect(code).toBe(1);
    const document = JSON.parse(io.out) as { error: { id: string; message: string } };
    expect(document.error.id).toBe('daemon.install-rolled-back');
    expect(document.error.message).toContain('the previous one was put back and started again');
  });

  test('a rollback that cannot start a daemon exits 1 under daemon.install-rollback-failed', async () => {
    const { root, home, manager } = refuseRefresh([LOAD_REFUSED]);
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install', '--json'], io, sourcesOf(home, manager));

    expect(code).toBe(1);
    const document = JSON.parse(io.out) as { error: { id: string; message: string } };
    expect(document.error.id).toBe('daemon.install-rollback-failed');
    expect(document.error.message).toContain('no daemon was started');
  });
});

describe('the dry run shows the steps a refresh takes', () => {
  test('install --dry-run names the stop, the retry and the rollback, and runs nothing', async () => {
    const { root, home } = scratch();
    const { manager, calls } = managerWith({});
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install', '--dry-run'], io, sourcesOf(home, manager));

    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(io.out).toContain('would install');
    expect(io.out).toContain('the previous daemon, if the service manager holds one, is stopped before the new one is offered');
    expect(io.out).toContain('the new daemon is started, offered again with a bounded, growing wait while the system service manager refuses');
    expect(io.out).toContain('if it still cannot start, the previous unit is put back and its daemon started again');
    expect(io.out).toContain('nothing was written');
    expect(io.out).not.toContain('launchd');
  });

  test('install --dry-run --json carries the same steps', async () => {
    const { root, home } = scratch();
    const { manager } = managerWith({});
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install', '--dry-run', '--json'], io, sourcesOf(home, manager));

    expect(code).toBe(0);
    const document = JSON.parse(io.out) as { steps: string[]; dry_run: boolean };
    expect(document.dry_run).toBe(true);
    expect(document.steps).toEqual([
      'the previous daemon, if the service manager holds one, is stopped before the new one is offered',
      'the new daemon is started, offered again with a bounded, growing wait while the system service manager refuses',
      'if it still cannot start, the previous unit is put back and its daemon started again',
    ]);
  });
});
