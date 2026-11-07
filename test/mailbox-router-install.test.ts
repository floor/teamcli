import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { runDaemon } from '../src/commands/daemon.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { mailboxHeartbeatFresh, retireShuttles } from '../src/daemon/mailbox/retire.ts';
import { daemonSocketPath } from '../src/daemon/paths.ts';
import { darwinServiceManager } from '../src/daemon/service-darwin.ts';
import type { ServiceRunResult, ServiceRunner } from '../src/daemon/service.ts';
import { writeDaemonState } from '../src/daemon/state.ts';
import { testIo } from './helpers.ts';

describe('retiring the shuttle units', () => {
  test('without a fresh heartbeat nothing is removed', () => {
    let called = 0;
    const result = retireShuttles({
      heartbeatFresh: false,
      retire() {
        called += 1;
        return { ok: true };
      },
    });
    expect(called).toBe(0);
    expect(result).toEqual({ child: 'up', retired: [], failed: [] });
  });

  test('a fresh heartbeat does not remove a shuttle unit while the router has no ask path', () => {
    const asked: string[] = [];
    const result = retireShuttles({
      heartbeatFresh: true,
      retire(label) {
        asked.push(label);
        return { ok: true };
      },
    });
    expect(asked).toEqual([]);
    expect(result).toEqual({ child: 'up', retired: [], failed: [] });
  });

  test('a held retirement does not ask the service manager, even when a removal would fail', () => {
    let called = 0;
    const result = retireShuttles({
      heartbeatFresh: true,
      retire() {
        called += 1;
        return { ok: false, why: 'the unit is still held' };
      },
    });
    expect(called).toBe(0);
    expect(result).toEqual({ child: 'up', retired: [], failed: [] });
  });
});

describe('the router heartbeat the install reads', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function record(home: string, heartbeatAt: string | null | undefined): void {
    writeDaemonState(home, {
      format: 1,
      pid: 1,
      uid: 1,
      since: '2026-11-04T02:00:00.000Z',
      startedBy: 'manual',
      version: 'test',
      heartbeatAt: '2026-11-04T02:00:00.000Z',
      socket: daemonSocketPath(home),
      features: { broker: 'absent' },
      stuck: [],
      roots: [],
      ...(heartbeatAt === undefined ? {} : { mailbox: { heartbeatAt } }),
    });
  }

  test('a record without a router heartbeat is not fresh, and a bare string is not enough', () => {
    const home = mkdtempSync(join(tmpdir(), 'mailbox-retire-'));
    homes.push(home);
    expect(mailboxHeartbeatFresh(home)).toBe(false);
    record(home, undefined);
    expect(mailboxHeartbeatFresh(home)).toBe(false);
    record(home, null);
    expect(mailboxHeartbeatFresh(home)).toBe(false);
    record(home, '2026-11-04T02:00:00.000Z');
    expect(mailboxHeartbeatFresh(home)).toBe(false);
  });

  test('a non-empty heartbeat is not fresh when it is old, the process is gone, or the uid is not this daemon', () => {
    const home = mkdtempSync(join(tmpdir(), 'mailbox-retire-'));
    homes.push(home);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const beat = '2026-11-06T16:00:00.000Z';
    const atBeat = Date.parse(beat);
    writeDaemonState(home, {
      format: 1,
      pid: process.pid,
      uid,
      since: beat,
      startedBy: 'manual',
      version: 'test',
      heartbeatAt: beat,
      socket: daemonSocketPath(home),
      features: { broker: 'absent' },
      stuck: [],
      roots: [],
      mailbox: { heartbeatAt: beat },
    });
    expect(mailboxHeartbeatFresh(home, { now: atBeat + 86_400_000 })).toBe(false);
    expect(mailboxHeartbeatFresh(home, { now: atBeat, alive: () => false })).toBe(false);
    writeDaemonState(home, {
      format: 1,
      pid: process.pid,
      uid: uid + 1,
      since: beat,
      startedBy: 'manual',
      version: 'test',
      heartbeatAt: beat,
      socket: daemonSocketPath(home),
      features: { broker: 'absent' },
      stuck: [],
      roots: [],
      mailbox: { heartbeatAt: beat },
    });
    expect(mailboxHeartbeatFresh(home, { now: atBeat })).toBe(false);
    writeDaemonState(home, {
      format: 1,
      pid: process.pid,
      uid,
      since: beat,
      startedBy: 'manual',
      version: 'test',
      heartbeatAt: beat,
      socket: daemonSocketPath(home),
      features: { broker: 'absent' },
      stuck: [],
      roots: [],
      mailbox: { heartbeatAt: 'not-a-time' },
    });
    expect(mailboxHeartbeatFresh(home, { now: atBeat })).toBe(false);
    writeDaemonState(home, {
      format: 1,
      pid: process.pid,
      uid,
      since: beat,
      startedBy: 'manual',
      version: 'test',
      heartbeatAt: beat,
      socket: daemonSocketPath(home),
      features: { broker: 'absent' },
      stuck: [],
      roots: [],
      mailbox: { heartbeatAt: beat },
    });
    expect(mailboxHeartbeatFresh(home, { now: atBeat })).toBe(true);
  });
});

const UID = typeof process.getuid === 'function' ? process.getuid() : 0;

const ANSWERING: DaemonHealth = {
  daemon: 'teamcli',
  socket: '/synthetic/daemon.sock',
  state: 'running',
  running: true,
  pid: 4242,
  uid: UID,
  since: '2026-11-06T16:00:00.000Z',
  startedBy: 'manual',
  version: 'test',
  gitHead: null,
  heartbeatAt: null,
  heartbeatSeconds: null,
  features: null,
  stuck: [],
  roots: [],
  probe: { state: 'answered', at: '2026-11-06T16:00:01.000Z' },
  why: null,
};

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

describe('an install keeps the shuttle units', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('an account-home install leaves the shuttle units in place when the router heartbeat is fresh', async () => {
    const accountHome = realpathSync(mkdtempSync(join(tmpdir(), 'mailbox-account-')));
    dirs.push(accountHome);
    const root = join(accountHome, 'project');
    mkdirSync(join(root, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
    const entry = join(accountHome, 'entry.ts');
    writeFileSync(entry, 'export const ok = true;\n');
    const beat = new Date().toISOString();
    writeDaemonState(accountHome, {
      format: 1,
      pid: process.pid,
      uid: UID,
      since: beat,
      startedBy: 'manual',
      version: 'test',
      heartbeatAt: beat,
      socket: daemonSocketPath(accountHome),
      features: { broker: 'absent' },
      stuck: [],
      roots: [],
      mailbox: { heartbeatAt: beat },
    });
    const retiredLabels: string[] = [];
    const runner: ServiceRunner = (command, args): ServiceRunResult => {
      if (command === '/usr/bin/id') {
        return { status: 0, stdout: `tester:********:${String(UID)}:20::0:0:Test User:${accountHome}:/bin/zsh\n`, stderr: '' };
      }
      if (args[0] === 'print') {
        return { status: 0, stdout: `\tstate = running\n\tpid = 4242\n\tprogram = ${process.execPath}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const manager = darwinServiceManager({ uid: UID, runner, sleep: () => {} });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDaemon(['install', '--root', root, '--json'], io, {
      home: accountHome,
      accountHome,
      service: manager,
      program: { execPath: process.execPath, entry },
      health: async () => ANSWERING,
      sleep: async () => {},
      retireShuttle: (label) => {
        retiredLabels.push(label);
        return { ok: true };
      },
    });
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(retiredLabels).toEqual([]);
  });
});
