import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import { daemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon, type HostedWatchExtras } from '../src/daemon/host.ts';
import type { BrokerWorkSource } from '../src/idle_work.ts';
import { daemonLockPath, daemonLogPath, daemonSocketPath, daemonStatePath, machineConfigDir } from '../src/daemon/paths.ts';
import { mintPresenceBinding } from '../src/daemon/presence/contract.ts';
import { stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import type { HostedRoute } from '../src/daemon/routes.ts';
import { STATE_FILE } from '../src/state.ts';
import { daemonSocketPath as sendSocketPath, startSendDaemon } from '../src/send/daemon.ts';
import { darwinServiceManager } from '../src/daemon/service-darwin.ts';
import type { ServiceManager, ServiceProgram, ServiceRunResult } from '../src/daemon/service.ts';
import { DAEMON_PROTOCOL_VERSION, type DaemonHealthSnapshot } from '../src/daemon/protocol.ts';
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

function scratch(): { base: string; root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-machine-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  return { base, root, home };
}

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** The heartbeat runs on its own; poll the state record until it reflects the change. */
async function waitFor(check: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the daemon state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The same poll, for a reading the scene needs to inspect rather than a yes/no. */
async function waitForValue<T>(check: () => Promise<T | null>, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the daemon reading');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function request(socketPath: string, line: string): Promise<Record<string, unknown>> {
  const { connect } = await import('node:net');
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let buffer = '';
    socket.on('connect', () => socket.write(`${line}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    });
    socket.on('error', reject);
  });
}

describe('one machine daemon hosts the existing send and bus endpoints in one process', () => {
  test('one start binds the machine socket and hosts send and bus for its root; health answers; mutations fail closed', async () => {
    const { root, home } = scratch();
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'service-manager',
      version: '0.5.3-daemon-test',
      heartbeatMs: 10_000,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const machine = daemonSocketPath(home);
      expect(existsSync(machine)).toBe(true);
      expect(existsSync(join(root, '.agents', 'bus.sock'))).toBe(true);
      expect(existsSync(sendSocketPath('acme', root, home))).toBe(true);
      expect(started.daemon.roots).toEqual([
        { root, team: 'acme', send: 'serving', bus: 'serving', why: null },
      ]);

      const health = await daemonHealth(home);
      expect(health.state).toBe('running');
      expect(health.startedBy).toBe('service-manager');
      expect(health.features).toEqual({ broker: 'absent' });
      expect(health.roots).toEqual([{ root, team: 'acme', send: 'serving', bus: 'serving', why: null }]);

      const status = testIo(home, owner);
      expect(await runDaemon(['status'], status, sourcesOf(home))).toBe(0);
      expect(status.out).toContain('roots 1 (send 1, bus 1)');
      expect(status.out).not.toContain('not hosted here');

      const answer = await request(machine, JSON.stringify({ v: 1, id: 'a', op: 'send', scope: { root } }));
      expect(answer).toMatchObject({ ok: false, error: { code: 'daemon.auth-unsupported' } });

      const second = await startMachineDaemon({ home, roots: [root], startedBy: 'manual', version: 'test' });
      expect(second.kind).toBe('already-running');
    } finally {
      await started.daemon.close();
    }
    expect(existsSync(daemonSocketPath(home))).toBe(false);
    const after = await daemonHealth(home);
    expect(after.state).toBe('not-running');
  });

  test('a crash’s leftover lock and socket are reclaimed by the next start', async () => {
    const { root, home } = scratch();
    // What a daemon killed without a clean stop leaves behind: its lock file, held by a pid that
    // is gone, and the socket file it never unlinked. The pid is above this machine's live range,
    // so `kill(pid, 0)` answers ESRCH; the socket is a real one whose server was closed.
    mkdirSync(machineConfigDir(home), { recursive: true, mode: 0o700 });
    const lockPath = daemonLockPath(home);
    writeFileSync(lockPath, '999999\n');
    const socketPath = daemonSocketPath(home);
    const stale = createServer();
    // Measured here: a bound unix socket renamed while listening keeps its socket file when the
    // server closes, while the name it was bound at is unlinked. Moving it onto the daemon's path
    // therefore leaves exactly the socket a killed daemon leaves — a socket entry nobody listens on.
    const staging = join(machineConfigDir(home), 'stale.sock');
    await new Promise<void>((done, fail) => {
      stale.once('error', fail);
      stale.listen(staging, () => done());
    });
    renameSync(staging, socketPath);
    await new Promise<void>((done, fail) => stale.close((error) => (error ? fail(error) : done())));
    expect(existsSync(socketPath)).toBe(true);
    expect(lstatSync(socketPath).isSocket()).toBe(true);

    const started = await startMachineDaemon({ home, roots: [root], startedBy: 'service-manager', version: 'test' });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      // The dead holder's lock is replaced by this process, and the stale socket was unlinked and
      // bound again: the next start needs no manual cleanup and starts no second daemon.
      expect(readFileSync(lockPath, 'utf8')).toBe(`${process.pid}\n`);
      expect(existsSync(socketPath)).toBe(true);
      const health = await daemonHealth(home);
      expect(health.state).toBe('running');
      expect(health.pid).toBe(process.pid);
    } finally {
      await started.daemon.close();
    }
  });

  test('the same checkout named twice is hosted once and recorded once as a duplicate', async () => {
    const { base, root, home } = scratch();
    const link = join(base, 'repo-link');
    symlinkSync(root, link);
    const started = await startMachineDaemon({
      home,
      roots: [root, link],
      startedBy: 'manual',
      version: '0.5.3-daemon-test',
      heartbeatMs: 10_000,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      expect(started.daemon.routes).toHaveLength(1);
      expect(started.daemon.routes[0]?.root).toBe(root);
      expect(started.daemon.roots.map((one) => one.send)).toEqual(['serving', 'failed']);
      expect(started.daemon.roots[1]?.root).toBe(root);
      expect(started.daemon.roots[1]?.why).toBe('this checkout is already hosted by this daemon');
    } finally {
      await started.daemon.close();
    }
  });

  test('status names a checkout whose endpoints were not hosted', async () => {
    const { base, root, home } = scratch();
    const absent = join(base, 'absent');
    const started = await startMachineDaemon({
      home,
      roots: [root, absent],
      startedBy: 'manual',
      version: '0.5.3-daemon-test',
      heartbeatMs: 10_000,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const status = testIo(home, owner);
      expect(await runDaemon(['status'], status, sourcesOf(home))).toBe(0);
      expect(status.out).toContain('roots 2 (send 1, bus 1)');
      expect(status.out).toContain('2 endpoints not hosted here');
      expect(status.out.trim().split('\n').length).toBe(1);

      const json = testIo(home, owner);
      expect(await runDaemon(['status', '--json'], json, sourcesOf(home))).toBe(0);
      const doc = JSON.parse(json.out) as { daemon: { roots: Array<Record<string, unknown>> } };
      expect(doc.daemon.roots).toHaveLength(2);
      expect(doc.daemon.roots[1]).toMatchObject({ root: absent, send: 'failed', bus: 'failed' });
    } finally {
      await started.daemon.close();
    }
  });

  test('the machine folder is 0700 and its socket, state, lock and log are 0600', async () => {
    const { root, home } = scratch();
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'manual',
      version: '0.5.3-daemon-test',
      heartbeatMs: 10_000,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const mode = (path: string): number => statSync(path).mode & 0o777;
      expect(mode(machineConfigDir(home))).toBe(0o700);
      expect(mode(daemonSocketPath(home))).toBe(0o600);
      expect(mode(daemonStatePath(home))).toBe(0o600);
      expect(mode(daemonLockPath(home))).toBe(0o600);
      expect(mode(daemonLogPath(home))).toBe(0o600);
    } finally {
      await started.daemon.close();
    }
  });

  test('malformed, non-object and oversized request lines keep their refusal bytes', async () => {
    const { root, home } = scratch();
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'manual',
      version: '0.5.3-daemon-test',
      heartbeatMs: 10_000,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const machine = daemonSocketPath(home);
      // A line that never parsed carries no version of its own, so the refusal names this
      // daemon's current protocol version.
      const refusal = (message: string): Record<string, unknown> => ({
        v: DAEMON_PROTOCOL_VERSION,
        id: '',
        ok: false,
        error: { code: 'daemon.bad-frame', message },
      });
      expect(await request(machine, 'this is not json')).toEqual(refusal('the request line is not JSON'));
      expect(await request(machine, '42')).toEqual(refusal('the request is not a JSON object'));
      // The frame limit counts the newline: 65,536 buffered characters pass the frame check and
      // are refused by the protocol parser as a non-JSON line.
      expect(await request(machine, 'x'.repeat(65_535))).toEqual(refusal('the request line is not JSON'));
      // One character more is over the limit and refused before the newline search.
      expect(await request(machine, 'x'.repeat(65_536))).toEqual(refusal('the request line exceeds the frame limit'));
    } finally {
      await started.daemon.close();
    }
  });

  test('the heartbeat marks a hosted send endpoint that stopped answering', async () => {
    const { root, home } = scratch();
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'manual',
      version: '0.5.3-daemon-test',
      heartbeatMs: 25,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      expect(existsSync(sendSocketPath('acme', root, home))).toBe(true);
      unlinkSync(sendSocketPath('acme', root, home));
      await waitFor(async () => (await daemonHealth(home)).roots[0]?.send === 'failed');

      const health = await daemonHealth(home);
      expect(health.roots[0]).toMatchObject({
        send: 'failed',
        bus: 'serving',
        why: 'the hosted send endpoint stopped answering',
      });

      const status = testIo(home, owner);
      expect(await runDaemon(['status'], status, sourcesOf(home))).toBe(0);
      expect(status.out).toContain('roots 1 (send 0, bus 1)');
      expect(status.out).toContain('1 endpoint not hosted here');
    } finally {
      await started.daemon.close();
    }
  });

  test('a caller field stays untrusted, and close destroys an idle connection', async () => {
    const { root, home } = scratch();
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'manual',
      version: '0.5.3-daemon-test',
      heartbeatMs: 10_000,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    const machine = daemonSocketPath(home);
    const { connect } = await import('node:net');
    const idle = connect({ path: machine });
    try {
      await new Promise<void>((resolve, reject) => {
        idle.on('error', reject);
        idle.on('connect', () => resolve());
      });
      const forged = await request(
        machine,
        JSON.stringify({ v: 1, id: 'h1', op: 'health', scope: { seat: 'forged' }, caller: { seat: 'forged' } }),
      );
      expect(forged).toMatchObject({ v: 1, id: 'h1', ok: true });
      expect(JSON.stringify(forged)).not.toContain('forged');
      const closed = new Promise<boolean>((resolve) => {
        idle.on('close', () => resolve(true));
        setTimeout(() => resolve(false), 500);
      });
      await started.daemon.close();
      expect(await closed).toBe(true);
    } finally {
      await started.daemon.close();
      idle.destroy();
    }
  });

  test('the heartbeat restarts a hosted bus whose socket stopped answering', async () => {
    const { root, home } = scratch();
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'manual',
      version: '0.5.3-daemon-test',
      heartbeatMs: 25,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const socket = join(root, '.agents', 'bus.sock');
      unlinkSync(socket);
      // The beat notices the socket is gone and starts the bus again. Health is written after
      // that start, so the record a reader sees is the bus answering, not the gap in between.
      await waitFor(async () => {
        const rootState = (await daemonHealth(home)).roots[0];
        return rootState?.bus === 'serving' && rootState.why === null && existsSync(socket);
      }, 15_000);

      const health = await daemonHealth(home);
      expect(health.roots[0]).toMatchObject({
        send: 'serving',
        bus: 'serving',
        why: null,
      });
      expect(readFileSync(daemonLogPath(home), 'utf8')).toContain('bus restarted');

      const status = testIo(home, owner);
      expect(await runDaemon(['status'], status, sourcesOf(home))).toBe(0);
      expect(status.out).toContain('roots 1 (send 1, bus 1)');
      expect(status.out).not.toContain('not hosted here');
    } finally {
      await started.daemon.close();
    }
  });
});

describe('the service adapter writes and registers one user unit, neutrally', () => {
  test('install writes the unit and registers it; uninstall removes it', () => {
    const { home } = scratch();
    const calls: string[][] = [];
    const runner = (command: string, args: string[]): ServiceRunResult => {
      calls.push([command, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const manager = darwinServiceManager({ runner, uid: 501 });
    const installed = manager.install(home, { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: ['/repo'] });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const unit = readFileSync(installed.unitPath, 'utf8');
    expect(unit).toContain('/runtime/bin/node');
    expect(unit).toContain('/app/dist/cli.js');
    expect(unit).toContain('daemon');
    expect(unit).toContain('run');
    expect(unit).toContain('--started-by');
    expect(unit).toContain('service-manager');
    expect(unit).toContain('/repo');
    expect(unit).toContain('RunAtLoad');
    expect(unit).toContain('KeepAlive');
    expect(calls[0]?.[0]).toBe('launchctl');
    expect(calls[0]?.slice(1, 3)).toEqual(['bootstrap', 'gui/501']);
    expect(calls[0]?.[3]).toBe(installed.unitPath);

    const removed = manager.uninstall(home);
    expect(removed).toMatchObject({ ok: true, removed: true });
    expect(existsSync(installed.unitPath)).toBe(false);
  });

  test('the unit carries the presence opt-in exactly when the install program asks for it', () => {
    const { home } = scratch();
    const manager = darwinServiceManager({ runner: () => ({ status: 0, stdout: '', stderr: '' }), uid: 501 });
    const plain = manager.install(home, { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: ['/repo'] });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(readFileSync(plain.unitPath, 'utf8')).not.toContain('--presence');

    const opted = manager.install(home, {
      execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: ['/repo'], presence: true,
    });
    expect(opted.ok).toBe(true);
    if (!opted.ok) return;
    const unit = readFileSync(opted.unitPath, 'utf8');
    expect(unit).toContain('--presence');
    // The same run command, one flag longer: the service manager still starts `daemon run` as the
    // owner with no terminal, and the opt-in survives login restarts with the unit.
    expect(unit).toContain('--started-by');
    expect(unit).toContain('service-manager');
  });

  test('the unit carries the watch opt-in exactly when the install program asks for it', () => {
    const { home } = scratch();
    const manager = darwinServiceManager({ runner: () => ({ status: 0, stdout: '', stderr: '' }), uid: 501 });
    const plain = manager.install(home, { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: ['/repo'] });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(readFileSync(plain.unitPath, 'utf8')).not.toContain('--watch');

    // The watch opt-in is independent of presence: a presence-only unit carries no watch flag.
    const presenceOnly = manager.install(home, {
      execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: ['/repo'], presence: true,
    });
    expect(presenceOnly.ok).toBe(true);
    if (!presenceOnly.ok) return;
    expect(readFileSync(presenceOnly.unitPath, 'utf8')).not.toContain('--watch');

    const opted = manager.install(home, {
      execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: ['/repo'], watch: true,
    });
    expect(opted.ok).toBe(true);
    if (!opted.ok) return;
    const unit = readFileSync(opted.unitPath, 'utf8');
    expect(unit).toContain('--watch');
    expect(unit).not.toContain('--presence');
    // The same run command, one flag longer: the service manager still starts `daemon run` as the
    // owner with no terminal, and the opt-in survives login restarts with the unit.
    expect(unit).toContain('--started-by');
    expect(unit).toContain('service-manager');
  });

  test('a refused registration carries a neutral why, never the platform facility name', () => {
    const { home } = scratch();
    const manager = darwinServiceManager({
      runner: () => ({ status: 1, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }),
      uid: 501,
    });
    const installed = manager.install(home, { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: [] });
    expect(installed.ok).toBe(false);
    if (installed.ok) return;
    expect(installed.why).toBe('the system service manager refused to start the daemon');
    expect(installed.why).not.toContain('launchctl');
    expect(installed.why).not.toContain('launchd');
  });

  test('a failed first install leaves no unit the next login could load', () => {
    const { home } = scratch();
    const manager = darwinServiceManager({
      runner: () => ({ status: 1, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }),
      uid: 501,
    });
    const installed = manager.install(home, { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: ['/repo'] });
    expect(installed.ok).toBe(false);
    // The definition was written before the registration was refused; it is taken back out so
    // the service manager cannot load an unregistered unit at the next login.
    expect(existsSync(manager.unitPath(home))).toBe(false);
  });

  test('a failed reinstall puts the earlier unit back for the next login', () => {
    const { home } = scratch();
    const good = darwinServiceManager({ runner: () => ({ status: 0, stdout: '', stderr: '' }), uid: 501 });
    const first = good.install(home, { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: ['/repo'] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = readFileSync(first.unitPath, 'utf8');
    const failing = darwinServiceManager({
      runner: () => ({ status: 1, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }),
      uid: 501,
    });
    const again = failing.install(home, { execPath: '/runtime/bin/node', entry: '/app/dist/cli-v2.js', roots: ['/repo'] });
    expect(again.ok).toBe(false);
    // The new definition is gone and the one the machine already carried is back, byte for byte.
    expect(readFileSync(first.unitPath, 'utf8')).toBe(before);
  });

  test('a stop the service manager refuses is reported as a refusal, and the unit stays', () => {
    const { home } = scratch();
    const good = darwinServiceManager({ runner: () => ({ status: 0, stdout: '', stderr: '' }), uid: 501 });
    const installed = good.install(home, { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: ['/repo'] });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const before = readFileSync(installed.unitPath, 'utf8');
    const refuses = darwinServiceManager({
      runner: () => ({ status: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process' }),
      uid: 501,
    });
    const removed = refuses.uninstall(home);
    expect(removed.ok).toBe(false);
    if (removed.ok) return;
    expect(removed.why).toBe('the system service manager did not confirm the daemon stopped');
    expect(removed.why).not.toContain('launchctl');
    expect(removed.why).not.toContain('launchd');
    // The unit is the recovery state: it is untouched so the owner can retry the uninstall.
    expect(readFileSync(installed.unitPath, 'utf8')).toBe(before);
  });

  test('an absent unit is not a failed stop: the uninstall reports nothing to remove', () => {
    const { home } = scratch();
    const manager = darwinServiceManager({
      runner: () => ({ status: 3, stdout: '', stderr: '' }),
      uid: 501,
    });
    expect(manager.uninstall(home)).toMatchObject({ ok: true, removed: false });
  });
});

type FakeService = ServiceManager & { calls: string[]; programs: ServiceProgram[] };

function fakeService(overrides: Partial<ServiceManager> = {}): FakeService {
  const calls: string[] = [];
  const programs: ServiceProgram[] = [];
  const base: FakeService = {
    kind: 'system-service-manager',
    calls,
    programs,
    unitPath: (home) => join(home, 'unit.plist'),
    plan: (home, program) => {
      programs.push(program);
      return { unitPath: join(home, 'unit.plist'), program: [program.execPath, program.entry, 'daemon', 'run'] };
    },
    install: (home, program) => {
      calls.push('install');
      programs.push(program);
      return { ok: true, unitPath: join(home, 'unit.plist') };
    },
    uninstall: (home) => {
      calls.push('uninstall');
      return { ok: true, unitPath: join(home, 'unit.plist'), removed: true };
    },
  };
  return { ...base, ...overrides, calls, programs };
}

const snapshot: DaemonHealthSnapshot = {
  pid: 42,
  uid: 501,
  since: '2026-10-20T10:00:00.000Z',
  startedBy: 'service-manager',
  version: 'test',
  heartbeatAt: '2026-10-20T10:00:05.000Z',
  stuck: [],
  features: { broker: 'absent' },
};

const owner = { kind: 'owner' } as const;

function sourcesOf(home: string, overrides: Partial<DaemonCommandSources> = {}): DaemonCommandSources {
  return {
    home,
    program: { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js' },
    version: 'test',
    ...overrides,
  };
}

/** The argv the installed unit itself would run, read back out of its ProgramArguments. */
function unitArguments(unitPath: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(readFileSync(unitPath, 'utf8'))?.[1];
  if (block === undefined) throw new Error('the unit has no ProgramArguments');
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => match[1] ?? '');
}

describe('team daemon status, install, uninstall and run', () => {
  test('status prints one line and never fails', async () => {
    const { home } = scratch();
    const io = testIo(home, owner);
    expect(await runDaemon(['status'], io, sourcesOf(home))).toBe(0);
    expect(io.out).toMatch(/^team daemon: not running; socket /);
    expect(io.out.trim().split('\n').length).toBe(1);
  });

  test('install --dry-run writes nothing and names no platform facility', async () => {
    const { root, home } = scratch();
    const service = fakeService();
    const io = testIo(root, owner);
    const code = await runDaemon(['install', '--dry-run'], io, sourcesOf(home, { service }));
    expect(code).toBe(0);
    expect(service.calls).toEqual([]);
    expect(io.out).toContain('would install');
    expect(io.out).toContain('system service manager');
    expect(io.out).not.toContain('launchd');
  });

  test('install and uninstall go through the injected neutral manager', async () => {
    const { root, home } = scratch();
    const service = fakeService();
    const installed = testIo(root, owner);
    expect(await runDaemon(['install'], installed, sourcesOf(home, { service }))).toBe(0);
    expect(service.calls).toEqual(['install']);
    expect(installed.out).toContain('team daemon: installed');
    // A plain install starts the service-managed daemon exactly as before: no presence opt-in.
    expect(service.programs.at(-1)?.presence).toBeUndefined();

    const removed = testIo(root, owner);
    expect(await runDaemon(['uninstall'], removed, sourcesOf(home, { service }))).toBe(0);
    expect(service.calls).toEqual(['install', 'uninstall']);
    expect(removed.out).toContain('team daemon: uninstalled');
  });

  test('install --presence records the run opt-in in the unit program', async () => {
    const { root, home } = scratch();
    const service = fakeService();
    const io = testIo(root, owner);
    expect(await runDaemon(['install', '--presence'], io, sourcesOf(home, { service }))).toBe(0);
    expect(service.programs.at(-1)).toMatchObject({ roots: [root], presence: true });
    expect(io.out).toContain('team daemon: installed');
  });

  test('install --watch records the watch opt-in and leaves presence off', async () => {
    const { root, home } = scratch();
    const service = fakeService();
    const io = testIo(root, owner);
    expect(await runDaemon(['install', '--watch'], io, sourcesOf(home, { service }))).toBe(0);
    expect(service.programs.at(-1)).toMatchObject({ roots: [root], watch: true });
    expect(service.programs.at(-1)?.presence).toBeUndefined();
    expect(io.out).toContain('team daemon: installed');
  });

  test('a seat cannot install or start the machine daemon', async () => {
    const { root, home } = scratch();
    const seat = { kind: 'seat', name: 'worker-1', pane: 'w1:p2', session: 'acme' } as const;
    const install = testIo(root, seat);
    expect(await runDaemon(['install'], install, sourcesOf(home, { service: fakeService() }))).toBe(1);
    expect(install.err).toContain('only the owner installs or removes the machine daemon');

    const started: string[] = [];
    const run = testIo(root, seat);
    expect(
      await runDaemon(['run'], run, sourcesOf(home, {
        start: async () => {
          started.push('start');
          return { kind: 'serving', daemon: { socketPath: '/tmp/x', roots: [], routes: [], health: () => snapshot, close: async () => {} } };
        },
      })),
    ).toBe(1);
    expect(started).toEqual([]);
    expect(run.err).toContain('only the owner or the system service manager');
  });

  test('run only accepts the three startedBy sources', async () => {
    const { root, home } = scratch();
    const started: string[] = [];
    const io = testIo(root, owner);
    const code = await runDaemon(['run', '--started-by', 'elsewhere'], io, sourcesOf(home, {
      start: async () => {
        started.push('start');
        return { kind: 'already-running', pid: 42 };
      },
    }));
    expect(code).toBe(2);
    expect(io.err).toContain('--started-by takes service-manager, manual or team-up');
    expect(started).toEqual([]);
  });

  test('run hosts presence only when --presence is given; --presence belongs to run', async () => {
    const { root, home } = scratch();
    const seen: Array<Parameters<typeof startMachineDaemon>[0]> = [];
    const start = async (input: Parameters<typeof startMachineDaemon>[0]) => {
      seen.push(input);
      return { kind: 'already-running' as const, pid: 42 };
    };
    expect(await runDaemon(['run'], testIo(root, owner), sourcesOf(home, { start }))).toBe(0);
    expect(await runDaemon(['run', '--presence'], testIo(root, owner), sourcesOf(home, { start }))).toBe(0);
    expect(seen.map((input) => input.presenceHosting)).toEqual([undefined, true]);

    // A start without the flag carries no endpoint reader at all.
    expect(seen[0]?.presenceCodexEndpoint).toBeUndefined();
    const binding = mintPresenceBinding();
    const dir = join(root, '.agents');
    const url = `unix:///private/tmp/launch/${binding}.sock`;
    const located = (current: string): string => `${JSON.stringify({
      format: 1,
      sessions: {
        acme: {
          seats: {
            clerk: {
              id: 'seat_0123456789ab',
              presence_binding: current,
              codex_endpoint: { url, binding, pid: 4242, started_at: '2026-10-20T05:00:00.000Z' },
            },
          },
          worktrees: {},
        },
      },
    })}\n`;
    const route: HostedRoute = { root, team: 'acme', session: 'acme', seats: ['clerk', 'op-1'] };
    writeFileSync(join(dir, STATE_FILE), located(binding));
    const endpoint = seen[1]?.presenceCodexEndpoint;
    expect(endpoint?.(route, dir, 'clerk')).toBe(url);
    // A seat with no state record has no recorded endpoint; nothing is guessed for it.
    expect(endpoint?.(route, dir, 'op-1')).toBeNull();
    // The same record under a different current binding belongs to an earlier incarnation.
    writeFileSync(join(dir, STATE_FILE), located(mintPresenceBinding()));
    expect(endpoint?.(route, dir, 'clerk')).toBeNull();

    const refused = testIo(root, owner);
    expect(await runDaemon(['status', '--presence'], refused, sourcesOf(home))).toBe(2);
    expect(refused.err).toContain('--presence belongs to run or install');
  });

  test('run hosts a watch only when --watch is given; --watch belongs to run or install', async () => {
    const { root, home } = scratch();
    const seen: Array<Parameters<typeof startMachineDaemon>[0]> = [];
    const start = async (input: Parameters<typeof startMachineDaemon>[0]) => {
      seen.push(input);
      return { kind: 'already-running' as const, pid: 42 };
    };
    expect(await runDaemon(['run'], testIo(root, owner), sourcesOf(home, { start }))).toBe(0);
    expect(await runDaemon(['run', '--presence'], testIo(root, owner), sourcesOf(home, { start }))).toBe(0);
    expect(await runDaemon(['run', '--watch'], testIo(root, owner), sourcesOf(home, { start }))).toBe(0);
    // Presence and watch are independent opt-ins: neither flag implies the other.
    expect(seen.map((input) => input.watchHosting)).toEqual([undefined, undefined, true]);
    expect(seen.map((input) => input.presenceHosting)).toEqual([undefined, true, undefined]);

    const refused = testIo(root, owner);
    expect(await runDaemon(['status', '--watch'], refused, sourcesOf(home))).toBe(2);
    expect(refused.err).toContain('--watch belongs to run or install');
  });

  test('the service-manager start admits the watch opt-in; a manual no-terminal start does not', async () => {
    const { root, home } = scratch();
    const seen: Array<Parameters<typeof startMachineDaemon>[0]> = [];
    const start = async (input: Parameters<typeof startMachineDaemon>[0]) => {
      seen.push(input);
      return { kind: 'already-running' as const, pid: 42 };
    };
    // The unit is the one admitted no-terminal start, and it carries --watch only when it was
    // installed with it; the run side accepts the same pair.
    const unitCaller = testIo(root, { kind: 'owner-no-tty' });
    expect(await runDaemon(['run', '--watch', '--started-by', 'service-manager'], unitCaller, sourcesOf(home, { start }))).toBe(0);
    expect(seen[0]?.watchHosting).toBe(true);
    expect(seen[0]?.startedBy).toBe('service-manager');

    const manual = testIo(root, { kind: 'owner-no-tty' });
    expect(await runDaemon(['run', '--watch'], manual, sourcesOf(home, { start }))).toBe(1);
    expect(manual.err).toContain('only the owner or the system service manager runs the machine daemon');
    expect(seen.length).toBe(1);
  });

  test('the service-manager start admits the presence opt-in; a manual no-terminal start does not', async () => {
    const { root, home } = scratch();
    const seen: Array<Parameters<typeof startMachineDaemon>[0]> = [];
    const start = async (input: Parameters<typeof startMachineDaemon>[0]) => {
      seen.push(input);
      return { kind: 'already-running' as const, pid: 42 };
    };
    // The unit is the one admitted no-terminal start, and it carries --presence only when it was
    // installed with it; the run side accepts the same pair.
    const unitCaller = testIo(root, { kind: 'owner-no-tty' });
    expect(await runDaemon(['run', '--presence', '--started-by', 'service-manager'], unitCaller, sourcesOf(home, { start }))).toBe(0);
    expect(seen[0]?.presenceHosting).toBe(true);
    expect(seen[0]?.startedBy).toBe('service-manager');

    const manual = testIo(root, { kind: 'owner-no-tty' });
    expect(await runDaemon(['run', '--presence'], manual, sourcesOf(home, { start }))).toBe(1);
    expect(manual.err).toContain('only the owner or the system service manager runs the machine daemon');
    expect(seen.length).toBe(1);
  });

  test('run --presence hosts the real spool-to-health presence pipeline for its route', async () => {
    const { root, home } = scratch();
    const dir = join(root, '.agents');
    const binding = mintPresenceBinding();
    const seatId = 'seat_0123456789ab';
    writeFileSync(join(dir, STATE_FILE), `${JSON.stringify({
      format: 1,
      sessions: {
        acme: {
          seats: { clerk: { id: seatId, stage: 'ready', presence_binding: binding } },
          worktrees: {},
        },
      },
    })}\n`);
    const io = testIo(root, owner);
    let release: (() => void) | undefined;
    const run = runDaemon(['run', '--presence', '--root', root], io, {
      ...sourcesOf(home),
      stop: (end) => {
        release = end;
        return () => {};
      },
    });
    try {
      await waitFor(async () => (await daemonHealth(home)).state === 'running', 8_000);
      const staged = stagePresenceRecord(dir, {
        session: 'acme',
        seat: 'clerk',
        binding,
        source: 'runtime-hook',
        event: 'turn-end',
        ts: new Date().toISOString(),
      });
      expect(staged.kind).toBe('staged');
      // The default ingester, activity reconciler and publisher are what the flag switched on:
      // this record travels the real spool and the health socket names the serving hook seat.
      const seat = await waitForValue(async () => {
        const reading = await daemonHealth(home);
        const presence = reading.roots?.[0]?.presence;
        const seats = presence !== undefined && 'seats' in presence ? presence.seats : undefined;
        return presence?.state === 'serving'
          ? seats?.find((one) => one.seat === 'clerk') ?? null
          : null;
      }, 8_000);
      expect(seat).toMatchObject({
        seat: 'clerk', state: 'serving', healthy: true, source: 'hook', binding,
        appliedEventId: null, why: null,
      });
      release?.();
      expect(await run).toBe(0);
    } finally {
      release?.();
      await run.catch(() => {});
    }
    expect(io.out).toContain('team daemon: stopped');
  }, 20_000);

  test('the hosted send server gets the route presence folder and the fresh per-seat proof only with --presence', async () => {
    const { root, home } = scratch();
    const dir = join(root, '.agents');
    const binding = mintPresenceBinding();
    writeFileSync(join(dir, STATE_FILE), `${JSON.stringify({
      format: 1,
      sessions: {
        acme: {
          seats: { clerk: { id: 'seat_0123456789ab', stage: 'ready', presence_binding: binding } },
          worktrees: {},
        },
      },
    })}\n`);
    const sends: Array<Parameters<typeof startSendDaemon>[0]> = [];
    const sendStart = async (input: Parameters<typeof startSendDaemon>[0]) => {
      sends.push(input);
      return { kind: 'already-running' as const, socketPath: join(home, 'no-send.sock'), pid: null };
    };
    const off = await startMachineDaemon({ home, roots: [root], startedBy: 'manual', version: 'test', sendStart });
    expect(off.kind).toBe('serving');
    if (off.kind !== 'serving') return;
    await off.daemon.close();
    // Off by absence: a start without presence hosting passes neither field, so the send server
    // keeps its pre-opt-in input.
    expect(sends[0]?.presenceStateDir).toBeUndefined();
    expect(sends[0]?.presenceChannelHealthy).toBeUndefined();

    const on = await startMachineDaemon({
      home, roots: [root], startedBy: 'manual', version: 'test', sendStart,
      presenceHosting: true, presenceEveryMs: 10,
    });
    expect(on.kind).toBe('serving');
    if (on.kind !== 'serving') return;
    try {
      // The team file's own folder, never a home-derived guess; the answer is the same per-seat
      // verdict the hosted watch's dispatcher reads, taken at the caller's own instant.
      expect(sends[1]?.presenceStateDir).toBe(dir);
      const healthy = sends[1]?.presenceChannelHealthy;
      expect(healthy).toBeDefined();
      expect(healthy?.('clerk')).toBe(false);
      const staged = stagePresenceRecord(dir, {
        session: 'acme',
        seat: 'clerk',
        binding,
        source: 'runtime-hook',
        event: 'turn-end',
        ts: new Date().toISOString(),
      });
      expect(staged.kind).toBe('staged');
      await waitFor(() => healthy?.('clerk') === true, 8_000);
      expect(healthy?.('clerk')).toBe(true);
      // A seat outside the route never inherits the route's answer.
      expect(healthy?.('op-1')).toBe(false);
    } finally {
      await on.daemon.close();
    }
  }, 20_000);

  test('the hosted watch gets a broker reading only from a daemon that hosts the broker', async () => {
    const { root, home } = scratch();
    const asked: string[] = [];
    const source: BrokerWorkSource = async () => null;
    const extras: HostedWatchExtras[] = [];
    const hostedWatch = (_route: HostedRoute, _log: (text: string) => void, extra: HostedWatchExtras) => {
      extras.push(extra);
      return { run: async () => 0 };
    };
    const brokerWork = (route: HostedRoute): BrokerWorkSource => {
      asked.push(route.root);
      return source;
    };
    const start = (features?: { broker: 'on' | 'off' | 'absent' }) => startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'manual',
      version: 'test',
      watchHosting: true,
      hostedWatch,
      brokerWork,
      ...(features === undefined ? {} : { features }),
    });

    // Default and explicitly off: the builder is never asked, and the watch is built without a
    // reading, so a tracker team keeps its explicit unknown and no socket is opened.
    for (const features of [undefined, { broker: 'off' as const }]) {
      const started = await start(features);
      expect(started.kind).toBe('serving');
      if (started.kind !== 'serving') return;
      await started.daemon.close();
    }
    expect(asked).toEqual([]);
    expect(extras).toEqual([{}, {}]);

    // Hosted: the builder is asked once for the route, and the watch receives exactly its reader.
    const on = await start({ broker: 'on' });
    expect(on.kind).toBe('serving');
    if (on.kind !== 'serving') return;
    try {
      expect(asked).toEqual([root]);
      expect(extras[2]?.brokerWork).toBe(source);
    } finally {
      await on.daemon.close();
    }
  }, 20_000);

  test('run starts one daemon, prints its line, and stops cleanly', async () => {
    const { root, home } = scratch();
    const io = testIo(root, owner);
    let closed = false;
    const code = await runDaemon(['run'], io, sourcesOf(home, {
      start: async () => ({
        kind: 'serving',
        daemon: {
          socketPath: join(home, 'daemon.sock'),
          roots: [{ root, team: 'acme', send: 'serving', bus: 'serving', why: null }],
          routes: [],
          health: () => snapshot,
          close: async () => {
            closed = true;
          },
        },
      }),
      stop: (end) => {
        setTimeout(end, 0);
        return () => {};
      },
    }));
    expect(code).toBe(0);
    expect(closed).toBe(true);
    expect(io.out).toContain('team daemon: running');
    expect(io.out).toContain('send 1, bus 1');
    expect(io.out).toContain('team daemon: stopped');
  });

  test('run names endpoints that were not hosted', async () => {
    const { root, home } = scratch();
    const io = testIo(root, owner);
    const code = await runDaemon(['run'], io, sourcesOf(home, {
      start: async () => ({
        kind: 'serving',
        daemon: {
          socketPath: join(home, 'daemon.sock'),
          roots: [
            {
              root,
              team: 'acme',
              send: 'serving',
              bus: 'failed',
              why: 'another bus server holds the project socket',
            },
          ],
          routes: [],
          health: () => snapshot,
          close: async () => {},
        },
      }),
      stop: (end) => {
        setTimeout(end, 0);
        return () => {};
      },
    }));
    expect(code).toBe(0);
    expect(io.out).toContain('roots 1 (send 1, bus 0)');
    expect(io.out).toContain('1 endpoint not hosted here');
  });

  test('run reports an existing daemon and a held lock without starting a second one', async () => {
    const { root, home } = scratch();
    const existing = testIo(root, owner);
    expect(
      await runDaemon(['run'], existing, sourcesOf(home, {
        start: async () => ({ kind: 'already-running', pid: 42 }),
      })),
    ).toBe(0);
    expect(existing.out).toContain('already running (pid 42)');

    const locked = testIo(root, owner);
    expect(
      await runDaemon(['run'], locked, sourcesOf(home, {
        start: async () => ({ kind: 'locked', pid: 43 }),
      })),
    ).toBe(1);
    expect(locked.err).toContain('another start holds the machine lock (pid 43)');
  });

  test('the installed unit’s own argv starts the one daemon hosting send and bus', async () => {
    const { root, home } = scratch();
    const manager = darwinServiceManager({ runner: () => ({ status: 0, stdout: '', stderr: '' }), uid: 501 });
    const unit = manager.install(home, { execPath: '/runtime/bin/node', entry: '/app/dist/cli.js', roots: [root] });
    expect(unit.ok).toBe(true);
    if (!unit.ok) return;
    const argv = unitArguments(unit.unitPath);
    expect(argv.slice(-2)).toEqual(['--root', root]);
    expect(argv).toContain('--started-by');

    // The login start, end to end: the unit's own argv through the command surface and the real
    // machine daemon. The run is admitted as the no-terminal owner because the source is the
    // service manager, and one process binds the machine socket and hosts this root's existing
    // send and bus in it, with the broker not hosted.
    let release: (() => void) | undefined;
    const io = testIo(root, { kind: 'owner-no-tty' });
    const running = runDaemon(argv.slice(3), io, sourcesOf(home, {
      stop: (end) => {
        release = end;
        return () => {};
      },
    }));
    await waitFor(() => io.out.includes('team daemon: running'));
    expect(io.out).toContain('roots 1 (send 1, bus 1)');
    expect(io.out).toContain('broker not hosted');
    expect(existsSync(daemonSocketPath(home))).toBe(true);
    expect(existsSync(sendSocketPath('acme', root, home))).toBe(true);
    expect(existsSync(join(root, '.agents', 'bus.sock'))).toBe(true);
    const health = await daemonHealth(home);
    expect(health.state).toBe('running');
    expect(health.startedBy).toBe('service-manager');
    expect(health.roots).toEqual([{ root, team: 'acme', send: 'serving', bus: 'serving', why: null }]);

    release?.();
    expect(await running).toBe(0);
    expect(io.out).toContain('team daemon: stopped');
    expect(existsSync(daemonSocketPath(home))).toBe(false);
  });
});
