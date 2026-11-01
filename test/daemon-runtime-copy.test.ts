// The retained runtime copy. A service install writes a unit that runs a copy of the whole
// program under the machine folder, never the package folder a later upgrade rewrites. These
// scenes own the program and the manager: the injected runner records the load words and runs
// nothing, so every assertion is about the files install writes and the unit text it leaves.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { DAEMON_LABEL, machineConfigDir } from '../src/daemon/paths.ts';
import { darwinServiceManager } from '../src/daemon/service-darwin.ts';
import type { ServiceProgram, ServiceRunResult, ServiceRunner } from '../src/daemon/service.ts';
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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-runtime-')));
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

/** The program a scene installs: an entry that imports its sibling module, in its own folder. */
function programOnDisk(home: string, name: string, entryBytes = 'import "./module.js";\n'): string {
  const folder = join(home, 'app', name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'module.js'), `export const name = ${JSON.stringify(name)};\n`);
  writeFileSync(join(folder, 'cli.js'), entryBytes);
  return join(folder, 'cli.js');
}

function programOf(entry: string): ServiceProgram {
  return { execPath: '/runtime/bin/node', entry, roots: ['/repo'] };
}

const OK: ServiceRunResult = { status: 0, stdout: '', stderr: '' };

/** The injected manager: every load is accepted and recorded, and no command runs. */
function managerIn(calls: string[]): ReturnType<typeof darwinServiceManager> {
  const runner: ServiceRunner = (_command, args) => {
    calls.push(args[0] ?? '');
    return { ...OK };
  };
  return darwinServiceManager({ runner, uid: 501, sleep: () => {} });
}

const ANSWERING: DaemonHealth = {
  daemon: 'teamcli', socket: '/synthetic/daemon.sock', state: 'running', running: true, pid: 42, uid: 501,
  since: '2026-11-01T00:00:00.000Z', startedBy: 'system-service-manager', version: 'test', gitHead: null,
  heartbeatAt: null, features: null, stuck: [], roots: [],
  probe: { state: 'answered', at: '2026-11-01T00:00:01.000Z' }, why: null,
};
const SILENT: DaemonHealth = {
  daemon: 'teamcli', socket: '/synthetic/daemon.sock', state: 'not-running', running: false, pid: null, uid: null,
  since: null, startedBy: null, version: null, gitHead: null, heartbeatAt: null, features: null, stuck: [], roots: [],
  probe: { state: 'unanswered', at: '2026-11-01T00:00:01.000Z', reason: 'closed' }, why: null,
};

function sourcesOf(
  home: string,
  service: ReturnType<typeof darwinServiceManager>,
  program: ServiceProgram,
  health: DaemonCommandSources['health'],
): DaemonCommandSources {
  return {
    home,
    program,
    version: 'test',
    service,
    health,
    sleep: async () => {},
    start: async () => ({ kind: 'already-running', pid: 42 }),
  };
}

/** The run words a written unit carries, read back as a scene sees them. */
function unitWords(text: string): string[] {
  return [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '')
    .matchAll(/<string>([\s\S]*?)<\/string>/g)].map((one) => one[1] ?? '');
}

/** The home's copy root, and the copy folders it holds. */
function copyRoot(home: string): string {
  return join(machineConfigDir(home), 'daemon-runtime');
}
function copies(home: string): string[] {
  try {
    return readdirSync(copyRoot(home)).sort();
  } catch {
    return [];
  }
}

/** A unit written before this install, as a refresh finds it: the words it names are all it owns. */
function earlierUnit(words: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${words.map((word) => `    <string>${word}</string>`).join('\n')}
  </array>
</dict>
</plist>
`;
}

const uid = process.getuid?.() ?? 501;

describe('the unit runs a copy of the whole program, kept owner-only', () => {
  test('the copy is whole, owner-only, and is what the unit runs', () => {
    const { home } = scratch();
    const entry = programOnDisk(home, 'v1');
    const manager = managerIn([]);
    const installed = manager.install(home, programOf(entry));
    expect(installed.ok, installed.ok ? '' : installed.why).toBe(true);
    if (!installed.ok) return;

    const [sha] = copies(home);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const unit = readFileSync(manager.unitPath(home), 'utf8');
    const retained = unitWords(unit)[1];
    expect(retained).toBe(join(copyRoot(home), sha!, 'cli.js'));
    expect(retained).not.toBe(entry);
    expect(installed.program?.[1]).toBe(retained);
    // The copy carries the entry and the sibling module it imports, byte for byte.
    expect(readFileSync(retained!, 'utf8')).toBe(readFileSync(entry, 'utf8'));
    expect(readFileSync(join(dirname(retained!), 'module.js'), 'utf8'))
      .toBe(readFileSync(join(dirname(entry), 'module.js'), 'utf8'));
    // Owner-only at every level, and no file is writable by the group or the world.
    expect(statSync(copyRoot(home)).mode & 0o777).toBe(0o700);
    expect(statSync(copyRoot(home)).uid).toBe(uid);
    const folder = join(copyRoot(home), sha!);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(folder).uid).toBe(uid);
    for (const name of readdirSync(folder)) {
      const file = statSync(join(folder, name));
      expect(file.uid).toBe(uid);
      expect(file.mode & 0o022).toBe(0);
    }
    // The package folder the copy came from is not named by the unit.
    expect(unit).not.toContain(join(home, 'app'));
  });
});

describe('an existing copy that is not what its name claims is refused', () => {
  test('a copy whose bytes drifted from its name is refused, and the unit is left as it was', () => {
    const { home } = scratch();
    const entry = programOnDisk(home, 'v1');
    const manager = managerIn([]);
    expect(manager.install(home, programOf(entry)).ok).toBe(true);
    const before = readFileSync(manager.unitPath(home), 'utf8');
    const retained = unitWords(before)[1]!;
    writeFileSync(retained, 'synthetic tampered bytes\n');

    const again = manager.install(home, programOf(entry));

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.why).toContain('could not be kept whole');
    expect(again.detail ?? '').toContain('does not match the hash it is named by');
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(before);
    // The install does not overwrite the copy it refused: it changed nothing.
    expect(readFileSync(retained, 'utf8')).toBe('synthetic tampered bytes\n');
  });

  test('a copy folder with a group-writable file is refused rather than run', () => {
    const { home } = scratch();
    const entry = programOnDisk(home, 'v1');
    const manager = managerIn([]);
    expect(manager.install(home, programOf(entry)).ok).toBe(true);
    const before = readFileSync(manager.unitPath(home), 'utf8');
    const retained = unitWords(before)[1]!;
    chmodSync(retained, 0o666);

    const again = manager.install(home, programOf(entry));

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.why).toContain('could not be kept whole');
    expect(again.detail ?? '').toContain('writable by the group or the world');
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(before);
  });

  test('a copy folder that is not owner-only is refused rather than run', () => {
    const { home } = scratch();
    const entry = programOnDisk(home, 'v1');
    const manager = managerIn([]);
    expect(manager.install(home, programOf(entry)).ok).toBe(true);
    const before = readFileSync(manager.unitPath(home), 'utf8');
    const folder = dirname(unitWords(before)[1]!);
    chmodSync(folder, 0o755);

    const again = manager.install(home, programOf(entry));

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.why).toContain('could not be kept whole');
    expect(again.detail ?? '').toContain('is not owner-only');
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(before);
  });

  test('a different file at the computed copy path is refused before the unit is written', () => {
    const { home } = scratch();
    const entry = programOnDisk(home, 'v1');
    const manager = managerIn([]);
    const planned = manager.plan(home, programOf(entry));
    const target = dirname(planned.program[1]!);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, 'synthetic file where a copy belongs\n');

    const installed = manager.install(home, programOf(entry));

    expect(installed.ok).toBe(false);
    if (installed.ok) return;
    expect(installed.why).toContain('could not be kept whole');
    expect(installed.detail ?? '').toContain('is not a directory');
    expect(existsSync(manager.unitPath(home))).toBe(false);
  });
});

describe('the runtime folder is this user\'s own and no other user can write it', () => {
  test('a runtime folder the group or the world can write refuses the install before the unit is written', () => {
    const { home } = scratch();
    const entry = programOnDisk(home, 'v1');
    const manager = managerIn([]);
    expect(manager.install(home, programOf(entry)).ok).toBe(true);
    const before = readFileSync(manager.unitPath(home), 'utf8');
    const retained = unitWords(before)[1]!;
    chmodSync(copyRoot(home), 0o777);

    const again = manager.install(home, programOf(entry));

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.why).toContain('could not be kept whole');
    expect(again.detail ?? '').toContain('writable by the group or the world');
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(before);
    // The copy the unit already runs is untouched: the install changed nothing it refused.
    expect(readFileSync(retained, 'utf8')).toBe(readFileSync(entry, 'utf8'));
  });

  test('a runtime folder that is a symbolic link is refused, never followed', () => {
    const { home } = scratch();
    const entry = programOnDisk(home, 'v1');
    const manager = managerIn([]);
    expect(manager.install(home, programOf(entry)).ok).toBe(true);
    const before = readFileSync(manager.unitPath(home), 'utf8');
    const root = copyRoot(home);
    const moved = join(home, 'runtime-elsewhere');
    renameSync(root, moved);
    symlinkSync(moved, root);

    const again = manager.install(home, programOf(entry));

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.why).toContain('could not be kept whole');
    expect(again.detail ?? '').toContain('is a symbolic link');
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(before);
    // The link is left where it was: the install follows nothing and writes nothing through it.
    expect(lstatSync(root).isSymbolicLink()).toBe(true);
  });

  test('a runtime folder with no group or other write is used as it is', () => {
    const { home } = scratch();
    const entry = programOnDisk(home, 'v1');
    const manager = managerIn([]);
    expect(manager.install(home, programOf(entry)).ok).toBe(true);
    const [sha] = copies(home);
    chmodSync(copyRoot(home), 0o755);

    const again = manager.install(home, programOf(entry));

    expect(again.ok, again.ok ? '' : again.why).toBe(true);
    expect(copies(home)).toEqual([sha!]);
  });
});

describe('a refresh whose earlier unit cannot be put back is refused before anything changes', () => {
  test('an earlier unit that names no program refuses the install, and no copy is made', () => {
    const { home } = scratch();
    const manager = managerIn([]);
    mkdirSync(dirname(manager.unitPath(home)), { recursive: true });
    const before = earlierUnit(['/bin/node']);
    writeFileSync(manager.unitPath(home), before, { mode: 0o600 });
    const entry = programOnDisk(home, 'v1');

    const installed = manager.install(home, programOf(entry));

    expect(installed.ok).toBe(false);
    if (installed.ok) return;
    expect(installed.why).toContain('names no program');
    expect(installed.detail ?? '').toContain('carries no run words');
    expect(installed.kept).toBe(true);
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(before);
    expect(copies(home)).toEqual([]);
  });

  test('an earlier unit that names a missing program refuses the install, and no copy is made', () => {
    const { home } = scratch();
    const manager = managerIn([]);
    mkdirSync(dirname(manager.unitPath(home)), { recursive: true });
    const missing = join(home, 'app', 'gone', 'cli.js');
    const before = earlierUnit(['/bin/node', missing, 'daemon', 'run']);
    writeFileSync(manager.unitPath(home), before, { mode: 0o600 });
    const entry = programOnDisk(home, 'v1');

    const installed = manager.install(home, programOf(entry));

    expect(installed.ok).toBe(false);
    if (installed.ok) return;
    expect(installed.why).toContain('names a program that is not on disk');
    expect(installed.detail ?? '').toContain('is not on disk');
    expect(installed.kept).toBe(true);
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(before);
    expect(copies(home)).toEqual([]);
  });
});

test('an undo removes the copy the refresh added and keeps the one the earlier unit runs', async () => {
  const { root, home } = scratch();
  const firstEntry = programOnDisk(home, 'v1');
  const manager = managerIn([]);
  expect(manager.install(home, programOf(firstEntry)).ok).toBe(true);
  const priorText = readFileSync(manager.unitPath(home), 'utf8');
  const priorCopies = copies(home);
  expect(priorCopies).toHaveLength(1);

  // The refresh's program has different bytes, so it needs its own copy.
  const secondEntry = programOnDisk(home, 'v2', 'import "./module.js"; // refresh\n');
  const secondPlan = manager.plan(home, programOf(secondEntry));
  const added = dirname(secondPlan.program[1]!);
  expect(added).not.toBe(join(copyRoot(home), priorCopies[0]!));
  expect(existsSync(added)).toBe(false);

  // The probe answers the way the program the unit currently names runs: the refresh's program
  // does not answer, and the earlier program answers once the undo has put its unit back.
  const health: DaemonCommandSources['health'] = async () =>
    (readFileSync(manager.unitPath(home), 'utf8') === priorText ? ANSWERING : SILENT);
  const io = testIo(root, { kind: 'owner' });
  const code = await runDaemon(['install', '--json', '--root', root], io, sourcesOf(home, manager, programOf(secondEntry), health));

  expect(code, io.out + io.err).toBe(1);
  expect(JSON.parse(io.out).error.id).toBe('daemon.install-rolled-back');
  // The refresh's copy is gone, and the earlier unit and the copy it runs are exactly as they were.
  expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(priorText);
  expect(copies(home)).toEqual(priorCopies);
  expect(existsSync(added)).toBe(false);
  expect(readFileSync(unitWords(priorText)[1]!, 'utf8')).toBe(readFileSync(firstEntry, 'utf8'));
});

test('a successful install removes a copy no unit names and keeps the one in use', () => {
  const { home } = scratch();
  const entry = programOnDisk(home, 'v1');
  const manager = managerIn([]);
  expect(manager.install(home, programOf(entry)).ok).toBe(true);
  const [sha] = copies(home);
  const stale = join(copyRoot(home), 'a'.repeat(64));
  mkdirSync(stale, { recursive: true, mode: 0o700 });
  writeFileSync(join(stale, 'leftover.js'), 'synthetic leftover copy\n');

  expect(manager.install(home, programOf(entry)).ok).toBe(true);

  expect(copies(home)).toEqual([sha!]);
  expect(existsSync(stale)).toBe(false);
});

describe('a dry run plans the retained copy and writes nothing', () => {
  test('the structured plan names the copy the unit would run', async () => {
    const { root, home } = scratch();
    const entry = programOnDisk(home, 'v1');
    const calls: string[] = [];
    const manager = managerIn(calls);
    const planned = manager.plan(home, programOf(entry));

    const io = testIo(root, { kind: 'owner' });
    const code = await runDaemon(
      ['install', '--dry-run', '--json', '--root', root],
      io,
      sourcesOf(home, manager, programOf(entry), async () => ANSWERING),
    );

    expect(code, io.out + io.err).toBe(0);
    const document = JSON.parse(io.out) as { dry_run: boolean; installed: boolean; program: string[] };
    expect(document.dry_run).toBe(true);
    expect(document.installed).toBe(false);
    expect(document.program[1]).toBe(planned.program[1]);
    expect(dirname(dirname(document.program[1]!))).toBe(copyRoot(home));
    expect(existsSync(manager.unitPath(home))).toBe(false);
    expect(copies(home)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('a dry run refuses a program that cannot be read whole, and writes nothing', async () => {
    const { root, home } = scratch();
    const calls: string[] = [];
    const manager = managerIn(calls);
    const io = testIo(root, { kind: 'owner' });
    const code = await runDaemon(
      ['install', '--dry-run', '--json', '--root', root],
      io,
      sourcesOf(home, manager, programOf(join(home, 'app', 'gone', 'cli.js')), async () => ANSWERING),
    );

    expect(code).toBe(1);
    const document = JSON.parse(io.out) as { error: { id: string; message: string } };
    expect(document.error.id).toBe('daemon.install-failed');
    expect(document.error.message).toContain('could not be read whole');
    expect(existsSync(manager.unitPath(home))).toBe(false);
    expect(copies(home)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
