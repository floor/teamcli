// `team reload` continues past one untested CLI release only in dev mode: AGY 1.4.3, the release
// after the profile's tested 1.2.16 to 1.4.2, warns and reloads anyway, while the same version
// with dev mode off is refused before anything is closed. The profile's tested range is never
// widened, and every other CLI and version keeps the refusal it always had. Every team, pane,
// version and log below is synthetic.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runReload, type ReloadSources } from '../src/commands/reload.ts';
import type { Launch } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-20T11:00:00Z');
const OWNER = { kind: 'owner' as const };
/** The closest captured screen for an AGY 1.4.3 install: the 1.4.2 idle capture, which reads
 *  as idle, so the relaunch reaches ready in the synthetic world. */
const AGY_IDLE = readFileSync(join(import.meta.dir, 'fixtures/antigravity/1.4.2/idle.txt'), 'utf8');

type WorkerCli = 'antigravity' | 'claude-code';

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-agy-143-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true });
  chmodSync(lobby, 0o700);
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** The same team with the worker on the CLI under test: the lead is always claude-code. */
function teamYaml(workerCli: WorkerCli): string {
  const worker = workerCli === 'antigravity'
    ? `  - role: implementer
    label: worker
    name: worker
    cli: antigravity
    vendor: google
    model: Gemini 3.8 Flash
    version: "3.8"
    launch: agy
    effort: high
    mode: shared
    cwd: .`
    : `  - role: implementer
    label: worker
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    effort: high
    mode: shared
    cwd: .`;
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: alpha
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    label: lead
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    effort: high
    mode: shared
    cwd: .
${worker}
`;
}

function writeTeam(workerCli: WorkerCli): void {
  const text = teamYaml(workerCli);
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

/** A ready worker whose record differs from the file in its effort alone, so the run reaches the
 *  version guard with a close still to make. */
function remember(workerCli: WorkerCli, effort = 'low'): void {
  const model = workerCli === 'antigravity' ? 'Gemini 3.8 Flash' : 'Claude Opus';
  const version = workerCli === 'antigravity' ? '3.8' : '5.5';
  updateState(dir, (file) => {
    const session = (file.sessions.alpha ??= emptySession());
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats.worker = {
      stage: 'ready',
      pane: 'worker-pane',
      workspace: 'worker-ws',
      cli: workerCli,
      launched: { shell: 1, cli: [2] },
      model,
      version,
      effort,
      launch_line: workerCli === 'antigravity' ? 'agy' : 'claude --model claude-opus-5-5',
    };
  });
}

function logText(): string {
  try {
    return readFileSync(join(dir, 'team.log'), 'utf8');
  } catch {
    return '';
  }
}

/** A herdr world with both seats idle and every relaunched pane drawing the CLI's idle screen. */
function harness(workerCli: WorkerCli): { sources: ReloadSources; closed: string[]; commands: string[] } {
  const idle = workerCli === 'antigravity' ? AGY_IDLE : CLAUDE_IDLE;
  const panes = new Map<string, string>();
  const closed: string[] = [];
  const commands: string[] = [];
  let ackPending = false;
  let clock = NOW.getTime();
  let n = 0;
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      n += 1;
      const pane = `made-${n}`;
      panes.set(pane, idle);
      return { pane, workspace: `ws-${n}` };
    },
    paneRun(_session, pane, command) {
      commands.push(command);
      panes.set(pane, idle);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      closed.push(workspace);
      return true;
    },
    agentPanes: () => [...panes.keys()],
    agents: () => [
      { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: 'idle', cwd: null },
      {
        name: 'worker',
        agent: workerCli === 'antigravity' ? 'agy' : 'claude',
        pane: 'worker-pane',
        workspace: 'worker-ws',
        status: 'idle',
        cwd: null,
      },
    ] satisfies HerdrAgent[],
    workspacePanes(_session, workspace) {
      if (workspace === 'lead-ws') return ['lead-pane'];
      if (workspace === 'worker-ws') return ['worker-pane'];
      return [`made-${n}`];
    },
    paneText(_session, pane) {
      return panes.get(pane) ?? (pane === 'lead-pane' ? CLAUDE_IDLE : idle);
    },
    // A message seat (antigravity) has its rules typed after the relaunch and read back from the
    // box: typing draws the line in the composer, Enter sends it and the CLI answers working.
    typeText(_session, pane, text) {
      panes.set(pane, idle.replace(/^>$/m, `> ${text}`));
      return true;
    },
    pressEnter(_session, pane) {
      panes.set(pane, idle);
      ackPending = true;
      return true;
    },
    agentStatus() {
      if (ackPending) {
        ackPending = false;
        return 'working';
      }
      return 'idle';
    },
    foreground: (_session, pane) => (pane === 'lead-pane' ? ['claude'] : [workerCli === 'antigravity' ? 'agy' : 'claude']),
    processInfo: () => ({ shell: 1, foreground: [1, 2] }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return { sources: { launch, home, now: () => new Date(clock) }, closed, commands };
}

describe('AGY 1.4.3 and dev mode', () => {
  test('dev mode on warns and reloads it', async () => {
    writeTeam('antigravity');
    remember('antigravity');
    const { sources, closed, commands } = harness('antigravity');
    const io = testIo(root, OWNER);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const code = await runReload(['worker'], io, { ...sources, version: () => '1.4.3' });
    const warning = 'worker: agy 1.4.3 is newer than the tested 1.2.16 to 1.4.2; '
      + 'its ready screen may not be recognised; dev mode continues';
    expect(code, io.err).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(commands).toHaveLength(1);
    expect(io.err).toBe(`team reload: warning: ${warning}\n`);
    // The warning is the run's own audit line, written once before the close.
    expect(logText()).toContain(`${NOW.toISOString()} reload [owner] warning: ${warning}\n`);
    expect(logText().match(/warning: .*dev mode continues/g)).toHaveLength(1);
    expect(logText()).toContain('reload [owner] worker: effort');
    expect(readState(dir).sessions.alpha?.seats.worker?.effort).toBe('high');
  });

  test('dev mode off refuses it before anything is closed', async () => {
    writeTeam('antigravity');
    remember('antigravity');
    const { sources, closed, commands } = harness('antigravity');
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, { ...sources, version: () => '1.4.3' });
    expect(code).toBe(1);
    expect(io.err).toBe(
      'team reload: worker: agy 1.4.3 is newer than the tested 1.2.16 to 1.4.2; '
      + 'its ready screen may not be recognised, so nothing closed\n',
    );
    expect(closed).toEqual([]);
    expect(commands).toEqual([]);
    expect(logText()).toBe('');
    expect(readState(dir).sessions.alpha?.seats.worker?.effort).toBe('low');
  });

  test('a version that cannot be read still reloads under dev mode, with no warning', async () => {
    writeTeam('antigravity');
    remember('antigravity');
    const { sources, closed } = harness('antigravity');
    const io = testIo(root, OWNER);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const code = await runReload(['worker'], io, { ...sources, version: () => null });
    expect(code, io.err).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(io.err).toBe('');
    expect(logText()).not.toContain('warning:');
  });

  test('a tested version reloads under dev mode, with no warning', async () => {
    writeTeam('antigravity');
    remember('antigravity');
    const { sources, closed } = harness('antigravity');
    const io = testIo(root, OWNER);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const code = await runReload(['worker'], io, { ...sources, version: () => '1.4.2' });
    expect(code, io.err).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(io.err).toBe('');
    expect(logText()).not.toContain('warning:');
  });

  const stillRefused = [
    {
      cli: 'antigravity' as const,
      printed: '1.2.15',
      said: 'worker: agy 1.2.15 is older than the tested 1.2.16 to 1.4.2; '
        + 'its ready screen may not be recognised, so nothing closed',
    },
    {
      cli: 'antigravity' as const,
      printed: '1.4.4',
      said: 'worker: agy 1.4.4 is newer than the tested 1.2.16 to 1.4.2; '
        + 'its ready screen may not be recognised, so nothing closed',
    },
    {
      cli: 'antigravity' as const,
      printed: '1.4.3.1',
      said: 'worker: agy 1.4.3.1 is newer than the tested 1.2.16 to 1.4.2; '
        + 'its ready screen may not be recognised, so nothing closed',
    },
    {
      cli: 'antigravity' as const,
      printed: '1.5.0',
      said: 'worker: agy 1.5.0 is newer than the tested 1.2.16 to 1.4.2; '
        + 'its ready screen may not be recognised, so nothing closed',
    },
    {
      cli: 'claude-code' as const,
      printed: '2.2.0',
      said: 'worker: claude 2.2.0 is newer than the tested 2.1.288 to 2.1.302; '
        + 'its ready screen may not be recognised, so nothing closed',
    },
  ];

  for (const scenario of stillRefused) {
    test(`dev mode on keeps the refusal for ${scenario.cli} ${scenario.printed}`, async () => {
      writeTeam(scenario.cli);
      remember(scenario.cli);
      const { sources, closed, commands } = harness(scenario.cli);
      const io = testIo(root, OWNER);
      io.env = { TEAMCLI_DEV_MODE: '1' };
      const code = await runReload(['worker'], io, { ...sources, version: () => scenario.printed });
      expect(code).toBe(1);
      expect(io.err).toBe(`team reload: ${scenario.said}\n`);
      expect(closed).toEqual([]);
      expect(commands).toEqual([]);
      expect(logText()).toBe('');
    });
  }
});
