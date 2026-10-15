// A folder with no git repository: flagless load reads `.agents/team.yaml` there and nowhere
// above it, `up` starts a watch only when that watch would read the file it was given, and the
// caller gate and the approval still decide once the file is found.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { loadConfig } from '../../src/commands/check.ts';
import { commits } from '../../src/commands/commits.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { runStatus, type StatusSources } from '../../src/commands/status.ts';
import { runUp, watchWouldRead, type Launch, type UpSources } from '../../src/commands/up.ts';
import { runWatch, type WatchSources } from '../../src/commands/watch.ts';
import { LINK_NOT_FOLLOWED, loadTeamFile, NOT_A_REPO } from '../../src/file/load.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import { storePath, writeApproval, type Standing } from '../../src/store/store.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-03T14:02:00Z');
const SESSION = 'acme-web';

let base: string;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function fresh(): { base: string; home: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-plain-')));
  const home = join(base, 'home');
  mkdirSync(lobbyDir(home), { recursive: true });
  chmodSync(lobbyDir(home), 0o700);
  return { base, home };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

function teamText(root: string): string {
  return `format: 1
project: acme
session: ${SESSION}
coordinator: claude-coordinator-acme
operator: claude-operator-acme
workspace:
  mode: shared
  base: main
trust:
  - ~/.config/team/lobby
  - ${root}
watch:
  interval: 120s
  checks:
    extra: off
    team-idle: off
    load: off
    memory: off
    disk: off
    swap-free: off
    swap-growth: off
    budget: off
    idle: off
    unsent: off
    restored: off
seats:
  - role: coordinator
    name: claude-coordinator-acme
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: claude-operator-acme
    label: operator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;
}

const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;

function approve(cwd: string, file: string, home: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const loaded = loadTeamFile(cwd, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
}

function doctor(home: string): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

function world(): {
  launch: Launch;
  creates: { label: string; cwd: string }[];
  runs: { pane: string; command: string }[];
  watches: { command: string; cwd: string }[];
} {
  const creates: { label: string; cwd: string }[] = [];
  const runs: { pane: string; command: string }[] = [];
  const watches: { command: string; cwd: string }[] = [];
  const panes = new Map<string, { text: string; agent: boolean }>();
  let session: 'absent' | 'running' = 'absent';
  let n = 0;
  let clock = NOW.getTime();
  const launch: Launch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace(_session, cwd, label) {
      n++;
      const pane = `w${n}:p1`;
      panes.set(pane, { text: IDLE, agent: false });
      creates.push({ label, cwd });
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      runs.push({ pane, command });
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    spawnWatch(command, cwd) {
      watches.push({ command, cwd });
      return 4242;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes(_session, workspace) {
      const found = [...panes.keys()].filter((pane) => pane.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return { launch, creates, runs, watches };
}

function upSources(home: string, made: ReturnType<typeof world>): UpSources {
  return {
    sessionRunning: () => made.launch.sessionUp(''),
    agents: () => [],
    home,
    getuid: () => process.getuid?.() ?? 0,
    now: made.launch.now,
    sleep: made.launch.sleep,
    doctor: doctor(home),
    launch: made.launch,
  };
}

function statusSources(home: string): StatusSources {
  return {
    live: () => ({ running: true, agents: [], workspaces: [], screens: {}, processes: {} }),
    branch: () => null,
    standing: () => ({ kind: 'none' }) as Standing,
    now: () => NOW,
    home,
  };
}

function watchSources(home: string): WatchSources {
  return {
    live: () => ({ running: false, agents: [], workspaces: [], screens: {}, processes: {} }),
    machine: () => ({ loadPerCore: 0, memoryFree: 100, diskFree: 1e12, swapTotal: 16e9, swapFree: 8e9, swapUsed: 0 }),
    standing: () => ({ kind: 'none' }) as Standing,
    readChecks: () => [],
    screen: () => null,
    status: () => null,
    foreground: () => null,
    processes: () => null,
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
    notify: () => {},
    now: () => NOW,
    wait: async () => false,
    alive: () => false,
    pid: 4242,
    home,
  };
}

function addSources(home: string): AddSources {
  return {
    home,
    sessionState: () => 'absent',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(home),
    now: () => NOW,
    launch: world().launch,
  };
}

/** The pane herdr recorded for the watchdog, when `up` wrote one. */
function recordedWatchdogPane(cwd: string): string | undefined {
  try {
    for (const session of Object.values(readState(join(cwd, '.agents')).sessions)) {
      if (session.watchdog?.pane) return session.watchdog.pane;
    }
  } catch {
    // No state yet: the watch starts with no recorded pane.
  }
  return undefined;
}

/** The recorded pane command, run as the pane runs it. The parent is named `herdr` and stays
 *  alive, and the stub on `PATH` answers the pane's own root, so the walk places the pane. */
function runAsPane(command: string, cwd: string, home: string): Promise<{ pid: number; heartbeat: string }> {
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'herdr'), `#!/bin/sh
while [ "$1" = "--session" ]; do
  shift 2
done
if [ "$1" = agent ] && [ "$2" = list ]; then
  printf '%s\\n' '{"result":{"agents":[]}}'
  exit 0
fi
if [ "$1" = pane ] && [ "$2" = process-info ]; then
  printf '%s\\n' "{\\"result\\":{\\"process_info\\":{\\"shell_pid\\":$PANE_ROOT_PID}}}"
  exit 0
fi
if [ "$1" = session ] && [ "$2" = list ]; then
  printf '%s\\n' '{"sessions":[]}'
  exit 0
fi
exit 1
`);
  chmodSync(join(bin, 'herdr'), 0o755);
  const parent = join(cwd, 'parent');
  mkdirSync(parent);
  writeFileSync(join(parent, 'pane.c'), `#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>
int main(int argc, char **argv) {
  char pid[32];
  snprintf(pid, sizeof pid, "%d", (int)getpid());
  setenv("PANE_ROOT_PID", pid, 1);
  pid_t child = fork();
  if (child == 0) {
    execl("/bin/sh", "sh", "-c", argv[1], (char *)0);
    _exit(127);
  }
  if (child < 0) return 127;
  int status = 0;
  if (waitpid(child, &status, 0) < 0) return 127;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
`);
  execFileSync('cc', ['-o', join(parent, 'herdr'), join(parent, 'pane.c')]);
  const pane = recordedWatchdogPane(cwd);
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(join(parent, 'herdr'), [command], {
      cwd,
      detached: true,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ...(pane ? { HERDR_PANE_ID: pane } : {}),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const stop = () => {
      try {
        process.kill(-(child.pid ?? 0), 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    };
    let seen: { pid: number; heartbeat: string } | undefined;
    child.on('exit', () => {
      if (seen) resolve(seen);
    });
    const timer = setInterval(() => {
      let watch: { pid: number; heartbeat: string } | undefined;
      try {
        watch = readState(join(cwd, '.agents')).sessions[SESSION]?.watch;
      } catch {
        watch = undefined;
      }
      if (watch?.heartbeat && !seen) {
        seen = { pid: watch.pid, heartbeat: watch.heartbeat };
        clearInterval(timer);
        clearTimeout(giveUp);
        stop();
      }
    }, 50);
    const giveUp = setTimeout(() => {
      clearInterval(timer);
      stop();
      reject(new Error(`no heartbeat\n${stderr}`));
    }, 15_000);
  });
}

describe('a folder with no git repository', () => {
  test('up --file .agents/team.yaml starts a watch that reads that file', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    const file = join(root, '.agents', 'team.yaml');
    mkdirSync(root);
    const text = teamText(root);
    approve(root, file, home, text);
    const flagged = loadTeamFile(root, { file, home });
    if (!flagged.ok) throw new Error(JSON.stringify(flagged.errors));
    const found = loadTeamFile(flagged.root, { home });
    expect(found.ok && found.path === flagged.path).toBe(true);
    expect(watchWouldRead(flagged.root, flagged.path, home)).toBe(true);

    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--file', '.agents/team.yaml'], io, upSources(home, made));
    expect(code, io.out + io.err).toBe(0);
    const watchdog = made.watches[0];
    expect(watchdog?.cwd).toBe(root);
    expect(io.err).toContain('watch: started\n');
    const command = watchdog?.command ?? '';
    expect(command).toContain(' watch');
    expect(command).not.toContain('--file');

    const beat = await runAsPane(command, root, home);
    expect(beat.heartbeat).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(beat.pid).toBeGreaterThan(0);
  }, 20_000);

  // Earlier rule, reversed by the status caller rule:
  // a plain folder's seat reads status with no flag whatever pane it is on, and that run writes nothing.
  test.skip("a seat's status with no flag reads the file and writes nothing", async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root));
    const io = testIo(root, { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w1:p1', session: SESSION });
    const code = await runStatus([], io, statusSources(home));
    expect(code).not.toBe(2);
    expect(io.err).not.toContain('not inside a git repository');
    expect(io.out).toContain('team acme');
    expect(readdirSync(join(root, '.agents')).sort()).toEqual(['team.yaml']);
  });

  test('a seat on its recorded pane reads a plain folder with no flag and writes nothing', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root));
    updateState(join(root, '.agents'), (state) => {
      const session = (state.sessions[SESSION] ??= emptySession());
      session.seats['claude-coordinator-acme'] = { stage: 'ready', pane: 'w1:p1', workspace: 'w1' };
    });
    const before = readFileSync(join(root, '.agents', 'team.state.json'), 'utf8');
    const io = testIo(root, { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w1:p1', session: SESSION });
    const code = await runStatus([], io, statusSources(home));
    expect(code).not.toBe(2);
    expect(io.err).not.toContain('not inside a git repository');
    expect(io.out).toContain('team acme');
    expect(readFileSync(join(root, '.agents', 'team.state.json'), 'utf8')).toBe(before);
    expect(readState(join(root, '.agents')).last_valid).toBeUndefined();
  });

  test('the same seat with no recorded pane gets the fixed sentence', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root));
    const io = testIo(root, { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w1:p1', session: SESSION });
    const code = await runStatus([], io, statusSources(home));
    expect(code).toBe(2);
    expect(io.err).toBe('team status: this team is not yours to read\n');
    expect(io.out).toBe('');
    expect(readdirSync(join(root, '.agents')).sort()).toEqual(['team.yaml']);
  });

  test('an unapproved file is refused as any unapproved file is', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root));
    const owner = testIo(root, { kind: 'owner' });
    const added = await runAdd(['claude-coordinator-acme'], owner, addSources(home));
    expect(added).toBe(1);
    expect(owner.err).toBe('team add: the file was never approved on this machine: run `team approve`\n');
    expect(readdirSync(join(root, '.agents')).sort()).toEqual(['team.yaml']);

    const seat = testIo(root, { kind: 'seat', name: 'other-seat', pane: 'w9:p1', session: 'elsewhere' });
    const refused = await runAdd(['claude-coordinator-acme'], seat, addSources(home));
    expect(refused).toBe(1);
    expect(seat.err).toContain('only the owner, the orchestrator or the operator');
    expect(readdirSync(join(root, '.agents')).sort()).toEqual(['team.yaml']);

    const doctorIo = testIo(root, { kind: 'seat', name: 'other-seat', pane: 'w9:p1' });
    await runDoctor([], doctorIo, doctor(home));
    expect(doctorIo.err).not.toContain('not inside a git repository');
    expect(readdirSync(join(root, '.agents')).sort()).toEqual(['team.yaml']);

    const checkIo = testIo(root, { kind: 'owner' });
    const checked = await commits(['check', 'HEAD'], checkIo, (cwd, file) => loadConfig(cwd, file, home));
    expect(checked).toBe(2);
    expect(checkIo.err).not.toContain('not inside a git repository: run team from a project, or pass --file');
    expect(readdirSync(join(root, '.agents')).sort()).toEqual(['team.yaml']);

    const watching = testIo(root, { kind: 'owner' });
    const watched = await runWatch([], watching, watchSources(home));
    expect(watched).toBe(0);
    expect(watching.err).not.toContain('not inside a git repository');
    expect(watching.out).toContain('the file was never approved on this machine');
  });
});

describe('a file the watch would not read', () => {
  test('up --file custom/team.yaml records a watch that reads the flagged file', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    const customDir = join(root, 'custom');
    const custom = join(customDir, 'team.yaml');
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root));
    const customBody = teamText(customDir);
    approve(root, custom, home, customBody);

    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--file', custom], io, upSources(home, made));
    expect(code, io.out + io.err).toBe(0);
    const watchdog = made.watches[0];
    expect(watchdog?.cwd).toBe(customDir);
    expect(watchdog?.command).toContain(' watch');
    expect(watchdog?.command).not.toContain('--file');
    expect(watchdog?.command).toContain(`--session ${SESSION}`);

    const other = testIo(customDir, { kind: 'pane', pane: 'w9:p1' });
    const refused = await runWatch(['--session', SESSION], other, watchSources(home));
    expect(refused).toBe(1);
    expect(other.err).toContain('only the watch this session records');
    expect(readState(customDir).sessions[SESSION]?.watch?.pid).toBe(4242);

    updateState(customDir, (state) => {
      const record = state.sessions[SESSION];
      if (record?.watch) record.watch.pid = process.pid;
    });
    const watching = testIo(customDir, { kind: 'pane', pane: 'w9:p1' });
    const watched = await runWatch(['--session', SESSION], watching, { ...watchSources(home), pid: process.pid });
    expect(watched, watching.out + watching.err).toBe(0);
    expect(watching.out).toContain(`watching the session "${SESSION}"`);
    expect(readState(customDir).last_valid?.file).toBe(customBody);
    expect(readState(customDir).sessions[SESSION]?.watchdog).toEqual({ file: custom });
    expect(readState(join(root, '.agents')).last_valid?.file).not.toBe(customBody);
    expect(readState(join(root, '.agents')).sessions[SESSION]?.watch).toBeUndefined();
  });

  test('a dry run prints the watchdog and does not say the watch was left unstarted', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    const customDir = join(root, 'custom');
    const custom = join(customDir, 'team.yaml');
    approve(root, custom, home, teamText(customDir));
    const flagged = loadTeamFile(root, { file: custom, home });
    if (!flagged.ok) throw new Error(JSON.stringify(flagged.errors));
    expect(watchWouldRead(flagged.root, flagged.path, home)).toBe(false);

    const dry = testIo(root, { kind: 'owner' });
    const preview = await runUp(['--dry-run', '--file', custom], dry, upSources(home, world()));
    expect(preview).toBe(0);
    expect(dry.out).toContain('dry run: nothing was run\n');
    expect(dry.out).toContain('detached; the state records its pid');
    expect(dry.out).not.toContain('--file');
    expect(dry.out).not.toContain('watch: not started');
    expect(dry.err).not.toContain('watch: not started');
  });

  test('the flagged path is not printed when it holds an escape', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    const customDir = join(root, 'custom');
    const custom = join(customDir, 'te\x1b[2Jam.yaml');
    approve(root, custom, home, teamText(customDir));
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--file', custom], io, upSources(home, made));
    expect(code, io.out + io.err).toBe(0);
    expect(made.watches).toHaveLength(1);
    const command = made.watches[0]?.command ?? '';
    expect(command).not.toContain('--file');
    expect(command.includes('\x1b')).toBe(false);
    expect(io.out.includes('\x1b')).toBe(false);
    expect(io.err.includes('\x1b')).toBe(false);
    const dry = testIo(root, { kind: 'owner' });
    const preview = await runUp(['--dry-run', '--file', custom], dry, upSources(home, world()));
    expect(preview).toBe(0);
    expect(dry.out.includes('\x1b')).toBe(false);
    expect(dry.err.includes('\x1b')).toBe(false);
    expect(dry.out).not.toContain('watch: not started');
  });

  test('the default path starts the watch', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    const file = join(root, '.agents', 'team.yaml');
    approve(root, file, home, teamText(root));
    const flagged = loadTeamFile(root, { home });
    if (!flagged.ok) throw new Error(JSON.stringify(flagged.errors));
    expect(watchWouldRead(flagged.root, flagged.path, home)).toBe(true);

    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--file', file], io, upSources(home, made));
    expect(code, io.out + io.err).toBe(0);
    expect(made.watches).toHaveLength(1);
    expect(io.err).toContain('watch: started\n');
    expect(io.out).not.toContain('watch: not started');
    expect(io.err).not.toContain('watch: not started');
  });
});

// Host reads. `now` and `home` are the clock and the store, not a host. A call here means the
// refusal returned after the file was opened.
function quietHosts(home: string): StatusSources {
  const refuse = (which: string): never => {
    throw new Error(`called ${which}`);
  };
  return {
    live: () => refuse('live'),
    branch: () => refuse('branch'),
    standing: () => refuse('standing'),
    now: () => NOW,
    home,
  };
}

const NOT_YOURS = 'team status: this team is not yours to read\n';
const LINK_SEAT = { kind: 'seat' as const, name: 'claude-coordinator-acme', pane: 'w1:p1', session: SESSION };

function expectUnfollowed(cwd: string, home: string): void {
  const loaded = loadTeamFile(cwd, { home });
  expect(loaded.ok).toBe(false);
  if (loaded.ok) return;
  expect(loaded.path).toBeUndefined();
  expect(loaded.errors[0]?.message).toBe(LINK_NOT_FOLLOWED);
}

async function ownerRefusesLink(cwd: string, home: string): Promise<void> {
  expectUnfollowed(cwd, home);
  const io = testIo(cwd, { kind: 'owner' });
  const code = await runStatus([], io, quietHosts(home));
  expect(code).toBe(2);
  expect(io.err).toBe(`team status: ${LINK_NOT_FOLLOWED}\n`);
  expect(io.out).toBe('');
}

async function seatRefusesLink(cwd: string, home: string): Promise<void> {
  expectUnfollowed(cwd, home);
  const io = testIo(cwd, LINK_SEAT);
  const code = await runStatus([], io, quietHosts(home));
  expect(code).toBe(2);
  expect(io.err).toBe(NOT_YOURS);
  expect(io.out).toBe('');
}

// The owner and a seat both get the link refusal, and neither reaches a host.
async function bothRefuse(cwd: string, home: string): Promise<void> {
  const loaded = loadTeamFile(cwd, { home });
  expect(loaded.ok).toBe(false);
  if (loaded.ok) return;
  expect(loaded.path).toBeUndefined();
  expect(loaded.errors[0]?.message).toBe(LINK_NOT_FOLLOWED);
  for (const caller of [
    { kind: 'owner' as const },
    { kind: 'seat' as const, name: 'claude-coordinator-acme', pane: 'w1:p1', session: SESSION },
  ]) {
    const io = testIo(cwd, caller);
    const code = await runStatus([], io, quietHosts(home));
    expect(code).toBe(2);
    expect(io.err).toBe(`team status: ${LINK_NOT_FOLLOWED}\n`);
    expect(io.out).toBe('');
  }
}

describe('a link is not a plain folder\'s team file', () => {
  // Earlier rule, reversed by the status caller rule:
  // a seat is shown the same link refusal as the owner when .agents is a link, and the link is not followed.
  test.skip('a link at .agents is not followed', async () => {
    const { home } = fresh();
    const plain = join(base, 'plain');
    const vault = join(base, 'vault');
    mkdirSync(plain);
    mkdirSync(vault);
    const target = join(vault, 'team.yaml');
    writeFileSync(target, teamText(plain));
    symlinkSync(vault, join(plain, '.agents'));
    const before = { text: readFileSync(target, 'utf8'), names: readdirSync(vault).sort() };

    await bothRefuse(plain, home);

    expect(readFileSync(target, 'utf8')).toBe(before.text);
    expect(readdirSync(vault).sort()).toEqual(before.names);
    expect(readdirSync(plain).sort()).toEqual(['.agents']);
    expect(lstatSync(join(plain, '.agents')).isSymbolicLink()).toBe(true);
  });

  test('a link at .agents is not followed for the owner', async () => {
    const { home } = fresh();
    const plain = join(base, 'plain');
    const vault = join(base, 'vault');
    mkdirSync(plain);
    mkdirSync(vault);
    const target = join(vault, 'team.yaml');
    writeFileSync(target, teamText(plain));
    symlinkSync(vault, join(plain, '.agents'));
    const before = { text: readFileSync(target, 'utf8'), names: readdirSync(vault).sort() };

    await ownerRefusesLink(plain, home);

    expect(readFileSync(target, 'utf8')).toBe(before.text);
    expect(readdirSync(vault).sort()).toEqual(before.names);
    expect(readdirSync(plain).sort()).toEqual(['.agents']);
    expect(lstatSync(join(plain, '.agents')).isSymbolicLink()).toBe(true);
  });

  test('a seat gets the fixed sentence when .agents is a link, and the target is not read', async () => {
    const { home } = fresh();
    const plain = join(base, 'plain');
    const vault = join(base, 'vault');
    mkdirSync(plain);
    mkdirSync(vault);
    const target = join(vault, 'team.yaml');
    writeFileSync(target, teamText(plain));
    symlinkSync(vault, join(plain, '.agents'));
    const before = { text: readFileSync(target, 'utf8'), names: readdirSync(vault).sort() };

    await seatRefusesLink(plain, home);

    expect(readFileSync(target, 'utf8')).toBe(before.text);
    expect(readdirSync(vault).sort()).toEqual(before.names);
    expect(readdirSync(plain).sort()).toEqual(['.agents']);
    expect(lstatSync(join(plain, '.agents')).isSymbolicLink()).toBe(true);
  });

  // Earlier rule, reversed by the status caller rule:
  // a seat is shown the same link refusal as the owner when team.yaml is a link, and the link is not followed.
  test.skip('a link at team.yaml is not followed', async () => {
    const { home } = fresh();
    const plain = join(base, 'plain');
    const vault = join(base, 'vault');
    mkdirSync(join(plain, '.agents'), { recursive: true });
    mkdirSync(vault);
    const target = join(vault, 'secret.yaml');
    writeFileSync(target, teamText(plain));
    symlinkSync(target, join(plain, '.agents', 'team.yaml'));
    const before = { text: readFileSync(target, 'utf8'), names: readdirSync(vault).sort() };

    await bothRefuse(plain, home);

    expect(readFileSync(target, 'utf8')).toBe(before.text);
    expect(readdirSync(vault).sort()).toEqual(before.names);
    expect(readdirSync(join(plain, '.agents')).sort()).toEqual(['team.yaml']);
    expect(existsSync(join(plain, '.agents', 'team.state.json'))).toBe(false);
  });

  test('a link at team.yaml is not followed for the owner', async () => {
    const { home } = fresh();
    const plain = join(base, 'plain');
    const vault = join(base, 'vault');
    mkdirSync(join(plain, '.agents'), { recursive: true });
    mkdirSync(vault);
    const target = join(vault, 'secret.yaml');
    writeFileSync(target, teamText(plain));
    symlinkSync(target, join(plain, '.agents', 'team.yaml'));
    const before = { text: readFileSync(target, 'utf8'), names: readdirSync(vault).sort() };

    await ownerRefusesLink(plain, home);

    expect(readFileSync(target, 'utf8')).toBe(before.text);
    expect(readdirSync(vault).sort()).toEqual(before.names);
    expect(readdirSync(join(plain, '.agents')).sort()).toEqual(['team.yaml']);
    expect(existsSync(join(plain, '.agents', 'team.state.json'))).toBe(false);
  });

  test('a seat gets the fixed sentence when team.yaml is a link, and the target is not read', async () => {
    const { home } = fresh();
    const plain = join(base, 'plain');
    const vault = join(base, 'vault');
    mkdirSync(join(plain, '.agents'), { recursive: true });
    mkdirSync(vault);
    const target = join(vault, 'secret.yaml');
    writeFileSync(target, teamText(plain));
    symlinkSync(target, join(plain, '.agents', 'team.yaml'));
    const before = { text: readFileSync(target, 'utf8'), names: readdirSync(vault).sort() };

    await seatRefusesLink(plain, home);

    expect(readFileSync(target, 'utf8')).toBe(before.text);
    expect(readdirSync(vault).sort()).toEqual(before.names);
    expect(readdirSync(join(plain, '.agents')).sort()).toEqual(['team.yaml']);
    expect(existsSync(join(plain, '.agents', 'team.state.json'))).toBe(false);
  });

  // Earlier rule, reversed by the status caller rule:
  // a seat is shown the same link refusal as the owner when the link's target is inside the same folder, and the link is not followed.
  test.skip('a link whose target is inside the same folder is not followed', async () => {
    const { home } = fresh();
    const plain = join(base, 'plain');
    const agents = join(plain, '.agents');
    mkdirSync(agents, { recursive: true });
    const target = join(agents, 'real.yaml');
    writeFileSync(target, teamText(plain));
    symlinkSync('real.yaml', join(agents, 'team.yaml'));
    const before = { text: readFileSync(target, 'utf8'), names: readdirSync(agents).sort() };

    await bothRefuse(plain, home);

    expect(readFileSync(target, 'utf8')).toBe(before.text);
    expect(readdirSync(agents).sort()).toEqual(before.names);
    expect(readlinkSync(join(agents, 'team.yaml'))).toBe('real.yaml');

    const held = join(base, 'held');
    const inside = join(held, 'nested');
    mkdirSync(inside, { recursive: true });
    const nestedFile = join(inside, 'team.yaml');
    writeFileSync(nestedFile, teamText(held));
    symlinkSync('nested', join(held, '.agents'));
    const nestedBefore = { text: readFileSync(nestedFile, 'utf8'), names: readdirSync(inside).sort() };

    await bothRefuse(held, home);

    expect(readFileSync(nestedFile, 'utf8')).toBe(nestedBefore.text);
    expect(readdirSync(inside).sort()).toEqual(nestedBefore.names);
    expect(readdirSync(held).sort()).toEqual(['.agents', 'nested']);
  });

  test('a link whose target is inside the same folder is not followed for the owner', async () => {
    const { home } = fresh();
    const plain = join(base, 'plain');
    const agents = join(plain, '.agents');
    mkdirSync(agents, { recursive: true });
    const target = join(agents, 'real.yaml');
    writeFileSync(target, teamText(plain));
    symlinkSync('real.yaml', join(agents, 'team.yaml'));
    const before = { text: readFileSync(target, 'utf8'), names: readdirSync(agents).sort() };

    await ownerRefusesLink(plain, home);

    expect(readFileSync(target, 'utf8')).toBe(before.text);
    expect(readdirSync(agents).sort()).toEqual(before.names);
    expect(readlinkSync(join(agents, 'team.yaml'))).toBe('real.yaml');

    const held = join(base, 'held');
    const inside = join(held, 'nested');
    mkdirSync(inside, { recursive: true });
    const nestedFile = join(inside, 'team.yaml');
    writeFileSync(nestedFile, teamText(held));
    symlinkSync('nested', join(held, '.agents'));
    const nestedBefore = { text: readFileSync(nestedFile, 'utf8'), names: readdirSync(inside).sort() };

    await ownerRefusesLink(held, home);

    expect(readFileSync(nestedFile, 'utf8')).toBe(nestedBefore.text);
    expect(readdirSync(inside).sort()).toEqual(nestedBefore.names);
    expect(readdirSync(held).sort()).toEqual(['.agents', 'nested']);
  });

  test('a seat gets the fixed sentence when the link target is inside the same folder, and the target is not read', async () => {
    const { home } = fresh();
    const plain = join(base, 'plain');
    const agents = join(plain, '.agents');
    mkdirSync(agents, { recursive: true });
    const target = join(agents, 'real.yaml');
    writeFileSync(target, teamText(plain));
    symlinkSync('real.yaml', join(agents, 'team.yaml'));
    const before = { text: readFileSync(target, 'utf8'), names: readdirSync(agents).sort() };

    await seatRefusesLink(plain, home);

    expect(readFileSync(target, 'utf8')).toBe(before.text);
    expect(readdirSync(agents).sort()).toEqual(before.names);
    expect(readlinkSync(join(agents, 'team.yaml'))).toBe('real.yaml');

    const held = join(base, 'held');
    const inside = join(held, 'nested');
    mkdirSync(inside, { recursive: true });
    const nestedFile = join(inside, 'team.yaml');
    writeFileSync(nestedFile, teamText(held));
    symlinkSync('nested', join(held, '.agents'));
    const nestedBefore = { text: readFileSync(nestedFile, 'utf8'), names: readdirSync(inside).sort() };

    await seatRefusesLink(held, home);

    expect(readFileSync(nestedFile, 'utf8')).toBe(nestedBefore.text);
    expect(readdirSync(inside).sort()).toEqual(nestedBefore.names);
    expect(readdirSync(held).sort()).toEqual(['.agents', 'nested']);
  });

  // Earlier rule, reversed by the status caller rule:
  // a seat is shown the same link refusal as the owner when the link dangles, and the link is not followed.
  test.skip('a dangling link is not followed', async () => {
    const { home } = fresh();
    const plain = join(base, 'plain');
    mkdirSync(plain);
    const missing = join(base, 'missing');
    symlinkSync(missing, join(plain, '.agents'));

    await bothRefuse(plain, home);

    expect(existsSync(missing)).toBe(false);
    expect(readlinkSync(join(plain, '.agents'))).toBe(missing);
    expect(readdirSync(plain).sort()).toEqual(['.agents']);

    const agents = join(base, 'file-link', '.agents');
    mkdirSync(agents, { recursive: true });
    symlinkSync(join(base, 'gone.yaml'), join(agents, 'team.yaml'));

    await bothRefuse(join(base, 'file-link'), home);

    expect(existsSync(join(base, 'gone.yaml'))).toBe(false);
    expect(readdirSync(agents).sort()).toEqual(['team.yaml']);
    expect(lstatSync(join(agents, 'team.yaml')).isSymbolicLink()).toBe(true);
  });

  test('a dangling link is not followed for the owner', async () => {
    const { home } = fresh();
    const plain = join(base, 'plain');
    mkdirSync(plain);
    const missing = join(base, 'missing');
    symlinkSync(missing, join(plain, '.agents'));

    await ownerRefusesLink(plain, home);

    expect(existsSync(missing)).toBe(false);
    expect(readlinkSync(join(plain, '.agents'))).toBe(missing);
    expect(readdirSync(plain).sort()).toEqual(['.agents']);

    const agents = join(base, 'file-link', '.agents');
    mkdirSync(agents, { recursive: true });
    symlinkSync(join(base, 'gone.yaml'), join(agents, 'team.yaml'));

    await ownerRefusesLink(join(base, 'file-link'), home);

    expect(existsSync(join(base, 'gone.yaml'))).toBe(false);
    expect(readdirSync(agents).sort()).toEqual(['team.yaml']);
    expect(lstatSync(join(agents, 'team.yaml')).isSymbolicLink()).toBe(true);
  });

  test('a seat gets the fixed sentence when the link dangles, and the target is not read', async () => {
    const { home } = fresh();
    const plain = join(base, 'plain');
    mkdirSync(plain);
    const missing = join(base, 'missing');
    symlinkSync(missing, join(plain, '.agents'));

    await seatRefusesLink(plain, home);

    expect(existsSync(missing)).toBe(false);
    expect(readlinkSync(join(plain, '.agents'))).toBe(missing);
    expect(readdirSync(plain).sort()).toEqual(['.agents']);

    const agents = join(base, 'file-link', '.agents');
    mkdirSync(agents, { recursive: true });
    symlinkSync(join(base, 'gone.yaml'), join(agents, 'team.yaml'));

    await seatRefusesLink(join(base, 'file-link'), home);

    expect(existsSync(join(base, 'gone.yaml'))).toBe(false);
    expect(readdirSync(agents).sort()).toEqual(['team.yaml']);
    expect(lstatSync(join(agents, 'team.yaml')).isSymbolicLink()).toBe(true);
  });

  test('the folder itself may be reached through a link', () => {
    const { home } = fresh();
    const real = join(base, 'real');
    mkdirSync(join(real, '.agents'), { recursive: true });
    writeFileSync(join(real, '.agents', 'team.yaml'), teamText(real));
    const via = join(base, 'via');
    symlinkSync(real, via);

    const loaded = loadTeamFile(via, { home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.root).toBe(real);
    expect(loaded.path).toBe(join(real, '.agents', 'team.yaml'));
    expect(readdirSync(join(real, '.agents')).sort()).toEqual(['team.yaml']);
  });

  test('--file still opens a path the owner named, link and all', () => {
    const { home } = fresh();
    const plain = join(base, 'plain');
    const vault = join(base, 'vault');
    mkdirSync(plain);
    mkdirSync(vault);
    writeFileSync(join(vault, 'team.yaml'), teamText(plain));
    symlinkSync(vault, join(plain, '.agents'));
    const named = join(plain, '.agents', 'team.yaml');

    const loaded = loadTeamFile(plain, { file: named, home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.path).toBe(named);
    expect(loaded.text).toBe(teamText(plain));
  });

  test('a git repository still follows a link at .agents', () => {
    const { home } = fresh();
    const root = join(base, 'repo');
    const vault = join(base, 'vault');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    mkdirSync(vault);
    writeFileSync(join(vault, 'team.yaml'), teamText(root));
    symlinkSync(vault, join(root, '.agents'));

    const loaded = loadTeamFile(root, { home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.root).toBe(root);
    expect(loaded.path).toBe(join(root, '.agents', 'team.yaml'));
  });

  test('a plain folder with no link keeps the refusal that names no link', () => {
    const { home } = fresh();
    const plain = join(base, 'plain');
    mkdirSync(plain);
    const loaded = loadTeamFile(plain, { home });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.errors[0]?.message).toBe(NOT_A_REPO);
  });
});
