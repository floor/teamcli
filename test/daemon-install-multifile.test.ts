// A refresh must leave a daemon that runs, not only a unit that names one. The program a unit
// runs is a module tree, not a single file: an entry imports its siblings, and a refresh that
// replaced any of them in place cannot be put back by restoring the entry alone.
//
// These scenes own the whole program: the injected runner stands in for the system's service
// manager and executes the unit's own entry word when a load is offered, so "a daemon runs" is
// the program's own exit, nothing else. No scene runs a service-manager command, starts the
// machine daemon or touches a real unit. The first install is the prior definition; the second
// is the refresh, made after one module in the program was changed.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { DAEMON_LABEL } from '../src/daemon/paths.ts';
import { darwinServiceManager } from '../src/daemon/service-darwin.ts';
import type { ServiceManager, ServiceRunResult, ServiceRunner } from '../src/daemon/service.ts';
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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-multifile-')));
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

const OK: ServiceRunResult = { status: 0, stdout: '', stderr: '' };
const LOAD_REFUSED: ServiceRunResult = { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };

/** The probe's answer, as the install gate reads it: the daemon the load started answers. */
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

/**
 * The manager the scenes inject: a load of a unit runs the unit's own entry word, so the daemon
 * a scene reports running is the program the unit names, and nothing else. A second load while
 * the first is registered is refused, as the manager refuses a label already claimed.
 */
function programManager(home: string): { manager: ServiceManager; calls: string[]; running: () => boolean } {
  let registered = false;
  let alive = false;
  const calls: string[] = [];
  const runner: ServiceRunner = (_command, args) => {
    const verb = args[0] ?? '';
    calls.push(verb);
    if (verb === 'bootout') {
      registered = false;
      alive = false;
      return { ...OK };
    }
    if (verb === 'bootstrap') {
      if (registered) return { ...LOAD_REFUSED };
      registered = true;
      const unit = readFileSync(join(home, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`), 'utf8');
      const words = [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(unit)?.[1] ?? '')
        .matchAll(/<string>([\s\S]*?)<\/string>/g)].map((one) => one[1] ?? '');
      const entry = words[1];
      if (entry === undefined || entry === '') {
        alive = false;
        calls.push('program-running:false');
        return { ...OK };
      }
      try {
        execFileSync(process.execPath, [entry], { env: { ...process.env, HOME: home }, stdio: 'pipe', timeout: 20_000 });
        alive = true;
      } catch {
        alive = false;
      }
      calls.push(`program-running:${String(alive)}`);
      return { ...OK };
    }
    return { ...OK };
  };
  const manager = darwinServiceManager({ runner, uid: 501, accountHome: home, sleep: () => {} });
  return { manager, calls, running: () => alive };
}

function sourcesOf(
  home: string,
  service: ServiceManager,
  program: { execPath: string; entry: string },
  health: DaemonCommandSources['health'],
): DaemonCommandSources {
  return {
    home,
    accountHome: home,
    program,
    version: 'test',
    service,
    health,
    // The health gate's waits are recorded, not slept: the answer is already injected.
    sleep: async () => {},
    start: async () => ({ kind: 'already-running', pid: 42 }),
  };
}

describe('a refresh puts back a program that runs, not only a unit that names it', () => {
  for (const changed of ['entry', 'dependency'] as const) {
    test(`a refresh that broke the ${changed} module is put back with a program that runs`, async () => {
      const { root, home } = scratch();
      const entry = join(home, 'cli.mjs');
      const dependency = join(home, 'daemon.mjs');
      const earlierEntry = 'import { admitted } from "./daemon.mjs"; process.exit(admitted ? 0 : 1);\n';
      writeFileSync(entry, earlierEntry);
      writeFileSync(dependency, 'export const admitted=true;\n');
      const { manager, running } = programManager(home);
      expect(manager.install(home, { execPath: process.execPath, entry, roots: [root] }).ok).toBe(true);
      expect(running()).toBe(true);

      if (changed === 'entry') writeFileSync(entry, 'process.exit(1);\n');
      else writeFileSync(dependency, 'export const admitted=false;\n');

      const io = testIo(root, { kind: 'owner' });
      const code = await runDaemon(['install', '--json', '--root', root], io, sourcesOf(home, manager, { execPath: process.execPath, entry }, async () => (running() ? ANSWERING : SILENT)));
      expect(code, io.out + io.err).toBe(1);
      expect(JSON.parse(io.out).error.id).toBe('daemon.install-rolled-back');
      expect(running()).toBe(true);
    });
  }
});
