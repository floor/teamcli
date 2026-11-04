// Synthetic scenes for the install's refresh safety net: an injected runner stands in for the
// system's service manager, so nothing here runs a platform command and no machine daemon is
// touched. The scenes prove what a failed refresh must never leave: the old daemon is stopped,
// the new load is offered again while the manager refuses (the earlier stop may still be
// finishing), and a load that still fails puts the previous unit back and starts its daemon
// again — or says plainly that no daemon was started. The unit a refresh restores runs the
// retained copy it was installed with, which the refresh never writes, so restoring the unit
// text is enough — and the copy the refresh added is removed with it, exactly what install
// changed. A rollback is called `restored` only after the daemon that started answers the health
// probe, because a load the manager accepted is registration, not proof that a program runs. A
// load the manager accepts whose daemon never answers is taken back out by the adapter's own
// undo — the earlier unit restored for a refresh, the new unit removed for a fresh install — so
// an install reports success only after the daemon it started answers. The command scenes prove the failure
// exits non-zero under its own contract row, and that a failure leaving no daemon running names
// the recorded rerun command (its roots and opt-ins) and where a kept unit is — the same command
// in the JSON `repair` — so a rollback that fails is actionable, not just reported.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { daemonLogPath } from '../src/daemon/paths.ts';
import { darwinServiceManager } from '../src/daemon/service-darwin.ts';
import type {
  ServiceInstallFailure,
  ServiceManager,
  ServiceProgram,
  ServiceRunResult,
  ServiceRunner,
} from '../src/daemon/service.ts';
import { testIo, thisProcessJobRecord, thisProcessUnitRecord } from './helpers.ts';

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

function scratch(name = 'repo'): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-install-')));
  bases.push(base);
  const root = join(base, name);
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

const EXEC = '/runtime/bin/node';

/** A program on disk: an entry and the sibling module it imports, in a folder of their own. The
 *  adapter keeps the entry's own folder as the whole program, so this folder is the program. */
function programFiles(home: string, name: string, entryBytes = 'import "./module.js";\n'): string {
  const folder = join(home, 'app', name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'module.js'), 'export const ok = true;\n');
  writeFileSync(join(folder, 'cli.js'), entryBytes);
  return join(folder, 'cli.js');
}

function program(home: string, name: string): ServiceProgram {
  return { execPath: EXEC, entry: programFiles(home, name), roots: ['/repo'] };
}

/** The run words a written unit carries, read back as a scene sees them. */
function unitWords(text: string): string[] {
  return [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '')
    .matchAll(/<string>([\s\S]*?)<\/string>/g)].map((one) => one[1] ?? '');
}

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

/** The restored-daemon check's two answers: a daemon that answered the probe, and one that never
 *  did. Injected, so no machine socket is opened and no wait is real. */
const ANSWERING: DaemonHealth = {
  daemon: 'teamcli',
  socket: '/synthetic/daemon.sock',
  state: 'running',
  running: true,
  pid: 42,
  uid: 501,
  since: '2026-11-01T00:00:00.000Z',
  startedBy: 'system-service-manager',
  version: 'test',
  gitHead: null,
  heartbeatAt: null,
  heartbeatSeconds: null,
  features: null,
  stuck: [],
  roots: [],
  probe: { state: 'answered', at: '2026-11-01T00:00:01.000Z' },
  why: null,
};
const SILENT: DaemonHealth = {
  daemon: 'teamcli',
  socket: '/synthetic/daemon.sock',
  state: 'not-running',
  running: false,
  pid: null,
  uid: null,
  since: null,
  startedBy: null,
  version: null,
  gitHead: null,
  heartbeatAt: null,
  heartbeatSeconds: null,
  features: null,
  stuck: [],
  roots: [],
  probe: { state: 'unanswered', at: '2026-11-01T00:00:01.000Z', reason: 'closed' },
  why: null,
};

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

/** A manager that answers an install with one fixed failure and touches nothing, so a command
 *  scene can name a failure the live adapter only reaches through an unwritable folder. */
function fakeManager(failure: ServiceInstallFailure): ServiceManager {
  const path = (home: string): string => join(home, 'service-unit');
  return {
    kind: 'system-service-manager',
    unitPath: path,
    plan: (home) => ({ unitPath: path(home), program: ['team'] }),
    job: () => thisProcessJobRecord(),
    unit: (home) => thisProcessUnitRecord(path(home)),
    install: () => failure,
    uninstall: () => ({ ok: false, why: 'an uninstall is not part of this scene', detail: null }),
    restart: () => ({ ok: false, reason: 'refused', why: 'a restart is not part of this scene', detail: null }),
  };
}

/** The earlier unit this refresh replaces: one successful install, read back byte for byte. */
function withEarlierUnit(home: string): string {
  const first = managerWith({}).manager;
  expect(first.install(home, program(home, 'v1')).ok).toBe(true);
  return readFileSync(first.unitPath(home), 'utf8');
}

function sourcesOf(
  home: string,
  service: ServiceManager,
  extra: Partial<DaemonCommandSources> = {},
): DaemonCommandSources {
  // The program this install would run: a sibling version folder of the earlier one.
  if (!existsSync(join(home, 'app', 'v2', 'cli.js'))) programFiles(home, 'v2');
  return {
    home,
    program: { execPath: EXEC, entry: join(home, 'app', 'v2', 'cli.js') },
    version: 'test',
    service,
    ...extra,
  };
}

describe('a refresh stops the old daemon and offers the new load until the manager takes it', () => {
  test('a load refused while the old daemon is loaded is offered again after the stop', () => {
    const { home } = scratch();
    const sleeps: number[] = [];
    const { manager, calls } = managerWith({ load: [LOAD_REFUSED, OK] }, sleeps);

    const result = manager.install(home, program(home, 'v2'));

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

    const result = manager.install(home, program(home, 'v2'));

    expect(result).toMatchObject({ ok: true });
    expect(calls).toEqual(['bootstrap', 'bootout', 'bootstrap', 'bootstrap', 'bootstrap']);
    expect(sleeps).toEqual([100, 200]);
  });

  test('the waits between offers grow, so a slow stop is given time without hammering the manager', () => {
    const { home } = scratch();
    const sleeps: number[] = [];
    const { manager } = managerWith({ load: refusedThenAccepted(5) }, sleeps);

    const result = manager.install(home, program(home, 'v2'));

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

    const result = manager.install(home, program(home, 'v2'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe('restored');
    // The earlier definition is the one in place, and it is the one running.
    expect(result.kept).toBe(true);
    expect(result.why).toBe(
      'the system\'s service manager refused to start the new daemon; the previous one was put back and started again',
    );
    // The refusal names no platform facility, and the earlier definition is the one on disk, so
    // the unit the manager starts again is the one that was running before the refresh.
    expect(result.why).not.toMatch(/launchctl|launchd|\.plist|launch agents/i);
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(earlier);
    // Every wait of the bounded retry, and none for the rollback load, which was accepted first.
    expect(sleeps).toEqual([100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000]);
  });

  test('a refresh never writes the program an earlier unit runs, so restoring the unit is restoring its program', () => {
    const { home } = scratch();
    // The package folder the earlier unit was installed from; a later upgrade rewrites this
    // very file. The unit does not run it: it runs the copy the install kept.
    const entry = programFiles(home, 'v1', 'old known-good bytes');
    const first = managerWith({}).manager;
    expect(first.install(home, { execPath: EXEC, entry, roots: ['/repo'] }).ok).toBe(true);
    const earlier = readFileSync(first.unitPath(home), 'utf8');
    const retained = unitWords(earlier)[1];
    expect(retained).toBeDefined();
    expect(readFileSync(retained ?? '', 'utf8')).toBe('old known-good bytes');

    // Every load of the new bytes is refused; the rollback load starts the earlier unit's copy,
    // so the scene can ask whether that program could come up at all.
    let loads = 0;
    let running = false;
    const runner: ServiceRunner = (_command, args) => {
      if ((args[0] ?? '') === 'bootout') {
        running = false;
        return { ...OK };
      }
      loads += 1;
      if (loads <= BOUNDED_OFFERS) return { ...LOAD_REFUSED };
      running = readFileSync(retained ?? '/nonexistent', 'utf8') === 'old known-good bytes';
      return { ...OK };
    };
    const manager = darwinServiceManager({ runner, uid: 501, sleep: () => {} });

    // The package is upgraded in place; the copy the earlier unit names is untouched.
    writeFileSync(entry, 'new broken bytes');
    const result = manager.install(home, program(home, 'v2'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe('restored');
    // The earlier unit is back, and the program it names is the one it was accepted with —
    // still on disk at its own path, whatever happened to the package the copy came from.
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(earlier);
    expect(readFileSync(retained ?? '', 'utf8')).toBe('old known-good bytes');
    expect(readFileSync(entry, 'utf8')).toBe('new broken bytes');
    expect(running).toBe(true);
  });

  test('a rollback load that is refused too says no daemon was started, and leaves the earlier unit on disk', () => {
    const { home } = scratch();
    const earlier = withEarlierUnit(home);
    const { manager, calls } = managerWith({ load: [LOAD_REFUSED] });

    const result = manager.install(home, program(home, 'v2'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe('lost');
    // Nothing runs, but the earlier definition is still there for the command to name.
    expect(result.kept).toBe(true);
    expect(result.why).toBe(
      'the system\'s service manager refused to start the new daemon, and the previous one could not be started again; no daemon was started',
    );
    expect(result.why).not.toMatch(/launchctl|launchd|\.plist|launch agents/i);
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(earlier);
    // The effort is bounded: the forward retry, then the same bounded retry for the earlier unit.
    expect(calls.filter((call) => call === 'bootstrap')).toHaveLength(19);
  });

  test('a first install the manager refuses takes its own definition back out and names no earlier unit', () => {
    const { home } = scratch();
    const { manager, calls } = managerWith({ load: [LOAD_REFUSED] });

    const result = manager.install(home, program(home, 'v2'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe('refused');
    // The definition it wrote was taken back out, so there is no kept unit to name.
    expect(result.kept).toBe(false);
    expect(result.why).toBe('the system\'s service manager refused to start the daemon');
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

    const code = await runDaemon(['install'], io, sourcesOf(home, manager, { health: async () => ANSWERING }));

    expect(code).toBe(1);
    expect(io.err).toContain(
      'team daemon: the system\'s service manager refused to start the new daemon; the previous one was put back and started again',
    );
    expect(io.err).not.toContain('launchctl');
    // The rollback left a daemon running, so there is no recovery command to give.
    expect(io.err).not.toContain('the owner or a general-grant holder runs');
    // The daemon log carries the technical failure and the rollback, so the incident is
    // diagnosable after the one line has gone by.
    const log = readFileSync(daemonLogPath(home), 'utf8');
    expect(log).toContain('install: the load exited 5');
    expect(log).toContain('the earlier unit was put back and its daemon started');
  });

  test('install --json exits 1 with the daemon.install-rolled-back error id', async () => {
    const { root, home, manager } = refuseRefresh(refusedThenAccepted(BOUNDED_OFFERS));
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install', '--json'], io, sourcesOf(home, manager, { health: async () => ANSWERING }));

    expect(code).toBe(1);
    const document = JSON.parse(io.out) as { error: { id: string; message: string } };
    expect(document.error.id).toBe('daemon.install-rolled-back');
    expect(document.error.message).toContain('the previous one was put back and started again');
  });

  test('a restored load whose daemon never answers is reported as no daemon, with the rerun command', async () => {
    const { root, home, manager } = refuseRefresh(refusedThenAccepted(BOUNDED_OFFERS));
    const io = testIo(root, { kind: 'owner' });
    const sleeps: number[] = [];
    let probes = 0;

    const code = await runDaemon(['install', '--json'], io, sourcesOf(home, manager, {
      health: async () => {
        probes += 1;
        return SILENT;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }));

    expect(code).toBe(1);
    const document = JSON.parse(io.out) as { error: { id: string; message: string; repair: string | null } };
    // A load the manager accepted is registration, not proof that a program runs: with nothing
    // answering, "restored" would be a false all-clear, and the honest answer is the one a lost
    // rollback gives — no daemon, and the command that starts one.
    expect(document.error.id).toBe('daemon.install-rollback-failed');
    expect(document.error.message).toContain('did not answer');
    expect(document.error.repair).toBe(`the owner or a general-grant holder runs \`team daemon install --root ${root}\``);
    // The check is bounded: the cold-start window's sixteen probes, with the growing waits
    // between them and no more.
    expect(probes).toBe(16);
    expect(sleeps).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000]);
  });

  test('a restored daemon that answers after the first probes is still a verified rollback', async () => {
    const { root, home, manager } = refuseRefresh(refusedThenAccepted(BOUNDED_OFFERS));
    const io = testIo(root, { kind: 'owner' });
    const sleeps: number[] = [];
    let probes = 0;

    const code = await runDaemon(['install', '--json'], io, sourcesOf(home, manager, {
      health: async () => {
        probes += 1;
        return probes < 3 ? SILENT : ANSWERING;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }));

    expect(code).toBe(1);
    const document = JSON.parse(io.out) as { error: { id: string; repair: string | null } };
    // The daemon needed a moment to bind and answer; that is still the earlier daemon running.
    expect(document.error.id).toBe('daemon.install-rolled-back');
    expect(document.error.repair).toBeNull();
    expect(probes).toBe(3);
    expect(sleeps).toEqual([250, 500]);
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

  test('a failure that leaves no daemon names the recorded command that starts one again, and the kept unit', async () => {
    const { root, home, manager } = refuseRefresh([LOAD_REFUSED]);
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install'], io, sourcesOf(home, manager));

    expect(code).toBe(1);
    expect(io.err).toContain('no daemon was started');
    // The exact rerun, carrying the root this install recorded, and where the unit it kept is.
    expect(io.err).toContain(`the owner or a general-grant holder runs \`team daemon install --root ${root}\` to start a daemon again`);
    expect(io.err).toContain(`; the previous unit is kept at ${manager.unitPath(home)}`);
    expect(io.err).not.toContain('launchctl');
  });

  test('install --json sets repair to the same rerun, in the owner-or-grant-holder shape the other repairs use', async () => {
    const { root, home, manager } = refuseRefresh([LOAD_REFUSED]);
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install', '--json'], io, sourcesOf(home, manager));

    expect(code).toBe(1);
    const document = JSON.parse(io.out) as { error: { repair: string | null } };
    expect(document.error.repair).toBe(`the owner or a general-grant holder runs \`team daemon install --root ${root}\``);
  });

  test('the opt-ins this install was given are part of the rerun command', async () => {
    const { root, home, manager } = refuseRefresh([LOAD_REFUSED]);
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install', '--presence', '--watch', '--json'], io, sourcesOf(home, manager));

    expect(code).toBe(1);
    const document = JSON.parse(io.out) as { error: { repair: string | null } };
    expect(document.error.repair).toBe(`the owner or a general-grant holder runs \`team daemon install --root ${root} --presence --watch\``);
  });

  test('a first install the manager refuses names the rerun to try again and no kept unit', async () => {
    const { root, home } = scratch();
    const { manager } = managerWith({ load: [LOAD_REFUSED] });
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install'], io, sourcesOf(home, manager));

    expect(code).toBe(1);
    expect(io.err).toContain(`the owner or a general-grant holder runs \`team daemon install --root ${root}\` to try again`);
    // Its own definition was taken back out, so there is no unit to point the owner at.
    expect(io.err).not.toContain('is kept at');
  });

  test('a lost rollback whose earlier unit could not be put back names no unit path', async () => {
    const { root, home } = scratch();
    const manager = fakeManager({
      ok: false,
      why: 'the system\'s service manager refused to start the new daemon, and the earlier service definition could not be put back; no daemon was started',
      detail: null,
      outcome: 'lost',
      kept: false,
    });
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install'], io, sourcesOf(home, manager));

    expect(code).toBe(1);
    expect(io.err).toContain('could not be put back; no daemon was started');
    expect(io.err).toContain(`the owner or a general-grant holder runs \`team daemon install --root ${root}\` to start a daemon again`);
    expect(io.err).not.toContain('is kept at');
  });

  test('a root with a space reaches the rerun quoted, so the recorded checkout arrives whole', async () => {
    const { root, home } = scratch('my repo');
    const manager = fakeManager({
      ok: false,
      why: 'the system\'s service manager refused to start the new daemon, and the previous one could not be started again; no daemon was started',
      detail: null,
      outcome: 'lost',
      kept: false,
    });
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install'], io, sourcesOf(home, manager));

    expect(code).toBe(1);
    expect(io.err).toContain(`--root '${root}'`);
  });
});

describe('an install whose new daemon does not answer is taken back out', () => {
  test('a refresh whose new daemon never answers restores the earlier unit and reports the rollback', async () => {
    const { root, home } = scratch();
    const earlier = withEarlierUnit(home);
    const { manager, calls } = managerWith({});
    const io = testIo(root, { kind: 'owner' });

    // The manager accepts the new load, so only the health probe can tell the install failed.
    // The earlier daemon is put back by the adapter's own undo, and it answers; the probe that
    // sees an answer can only be the restored daemon's, because it runs after the undo.
    const code = await runDaemon(['install', '--json'], io, sourcesOf(home, manager, {
      health: async () => (calls.includes('bootout') ? ANSWERING : SILENT),
      sleep: async () => {},
    }));

    expect(code).toBe(1);
    const document = JSON.parse(io.out) as { error: { id: string; message: string } };
    expect(document.error.id).toBe('daemon.install-rolled-back');
    expect(document.error.message).toContain('did not answer');
    // The earlier definition is the one on disk again, and its daemon was the one loaded last.
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(earlier);
    // The last health probe asks the manager for its job record: a daemon no process stands
    // behind is the one an undo is for.
    expect(calls).toEqual(['bootstrap', 'print', 'bootout', 'bootstrap']);
  });

  test('a fresh install whose new daemon never answers removes its unit and names the rerun', async () => {
    const { root, home } = scratch();
    const { manager, calls } = managerWith({});
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install'], io, sourcesOf(home, manager, {
      health: async () => SILENT,
      sleep: async () => {},
    }));

    expect(code).toBe(1);
    expect(io.err).toContain('the daemon the new unit started did not answer the health probe');
    expect(io.err).toContain(`the owner or a general-grant holder runs \`team daemon install --root ${root}\` to try again`);
    // Its own definition was taken back out, so there is no kept unit to name.
    expect(io.err).not.toContain('is kept at');
    expect(existsSync(manager.unitPath(home))).toBe(false);
    // The job the manager accepted was stopped again before the unit was removed; the last
    // health probe had already asked the manager for the job record and found no process.
    expect(calls).toEqual(['bootstrap', 'print', 'bootout']);
  });

  test('an install is reported only after the new daemon answers', async () => {
    const { root, home } = scratch();
    const { manager } = managerWith({});
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install'], io, sourcesOf(home, manager, { health: async () => ANSWERING }));

    expect(code).toBe(0);
    expect(io.out).toContain('team daemon: installed');
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
    expect(io.out).toContain('the new daemon is started, offered again with a bounded, growing wait while the system\'s service manager refuses');
    expect(io.out).toContain('if it still cannot start, the previous unit is put back and its daemon started again');
    expect(io.out).toContain('once the new daemon answers, the kit folders still standing in the lobby move into the runtime home, each held while a loaded unit names it');
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
      'the new daemon is started, offered again with a bounded, growing wait while the system\'s service manager refuses',
      'if it still cannot start, the previous unit is put back and its daemon started again',
      'once the new daemon answers, the kit folders still standing in the lobby move into the runtime home, each held while a loaded unit names it',
    ]);
  });
});
