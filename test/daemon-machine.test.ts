import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import { daemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { daemonLockPath, daemonLogPath, daemonSocketPath, daemonStatePath, machineConfigDir } from '../src/daemon/paths.ts';
import { daemonSocketPath as sendSocketPath } from '../src/send/daemon.ts';
import { darwinServiceManager } from '../src/daemon/service-darwin.ts';
import type { ServiceManager, ServiceRunResult } from '../src/daemon/service.ts';
import type { DaemonHealthSnapshot } from '../src/daemon/protocol.ts';
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
});

type FakeService = ServiceManager & { calls: string[] };

function fakeService(overrides: Partial<ServiceManager> = {}): FakeService {
  const calls: string[] = [];
  const base: FakeService = {
    kind: 'system-service-manager',
    calls,
    unitPath: (home) => join(home, 'unit.plist'),
    plan: (home, program) => ({ unitPath: join(home, 'unit.plist'), program: [program.execPath, program.entry, 'daemon', 'run'] }),
    install: (home) => {
      calls.push('install');
      return { ok: true, unitPath: join(home, 'unit.plist') };
    },
    uninstall: (home) => {
      calls.push('uninstall');
      return { ok: true, unitPath: join(home, 'unit.plist'), removed: true };
    },
  };
  return { ...base, ...overrides, calls };
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

    const removed = testIo(root, owner);
    expect(await runDaemon(['uninstall'], removed, sourcesOf(home, { service }))).toBe(0);
    expect(service.calls).toEqual(['install', 'uninstall']);
    expect(removed.out).toContain('team daemon: uninstalled');
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
          return { kind: 'serving', daemon: { socketPath: '/tmp/x', roots: [], health: () => snapshot, close: async () => {} } };
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
});
