// A granted orchestrator runs the ordinary up and down of the default file: up brings a
// stopped seat up and does not relaunch the caller, and down stops another seat and leaves
// the caller's seat running. The audit line is written before either effect.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { canonicalLanding } from '../src/file/paths.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T09:00:00Z');
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const SEAT = { kind: 'seat' as const, name: 'lead', pane: 'lead-pane', session: 'alpha' };

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

function seat(name: string, role: string): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
  ].join('\n');
}

function teamYaml(): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: alpha
trust:
  - ${lobby}
  - ${root}
  - ${join(base, 'worktrees')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
${seat('lead', 'coordinator')}
    mode: shared
    cwd: .
${seat('worker', 'implementer')}
    count: 1
grant:
  session: alpha
  seat: lead
  scope:
    - up
    - down
`;
}

function approve(): void {
  const text = teamYaml();
  const path = join(dir, 'team.yaml');
  writeFileSync(path, text);
  const loaded = loadTeamFile(root, { file: path, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

function record(seats: Record<string, { pane: string; workspace: string }>): void {
  updateState(dir, (file) => {
    file.sessions.alpha = {
      ...emptySession(),
      seats: Object.fromEntries(Object.entries(seats).map(([name, seat]) => [
        name,
        { stage: 'ready' as const, pane: seat.pane, workspace: seat.workspace },
      ])),
    };
  });
}

function doctor(): DoctorSources {
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

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-grant-up-down-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  approve();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the granted orchestrator', () => {
  test('up brings a stopped seat up and does not relaunch the caller', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' } });
    const panes = new Map<string, string>();
    let n = 0;
    const workspaces: { label: string; cwd: string }[] = [];
    const closed: string[] = [];
    let clock = NOW.getTime();
    let session: 'absent' | 'running' = 'absent';
    const launch: Launch = {
      sessionState: () => session,
      startServer() {
        session = 'running';
        return true;
      },
      sessionUp: () => session === 'running',
      createWorkspace(_session, cwd, label) {
        n += 1;
        const pane = `made-${n}`;
        panes.set(pane, IDLE);
        workspaces.push({ label, cwd });
        return { pane, workspace: `ws-${n}` };
      },
      paneRun(_session, pane) {
        panes.set(pane, IDLE);
        return true;
      },
      typeText: () => true,
      renameAgent: () => true,
      closeWorkspace(_session, workspace) {
        closed.push(workspace);
        return true;
      },
      agentPanes: () => [...panes.keys()],
      agents: () => [],
      paneText: (_session, pane) => panes.get(pane) ?? '',
      foreground: () => ['claude'],
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => new Date(clock),
    };
    const audits: { seat: string; act: string; made: number }[] = [];
    const sources: UpSources = {
      sessionRunning: () => session === 'running',
      sessionState: () => session,
      agents: () => [],
      home,
      doctor: doctor(),
      launch,
      now: () => new Date(clock),
      logGranted(dir, seat, act) {
        audits.push({ seat, act, made: workspaces.length });
      },
    };
    const io = testIo(root, SEAT);
    const code = await runUp([], io, sources);
    const workerAt = canonicalLanding(lobby).landing;
    expect({ code, out: io.out, err: io.err, audits, workspaces, closed }).toMatchObject({
      code: 0,
      audits: [{ seat: 'lead', act: 'up', made: 0 }],
      closed: [],
    });
    expect(io.err).toContain("skip lead: left as it is; a granted up does not relaunch or close the orchestrator's seat\n");
    expect(workspaces).toContainEqual({ label: 'worker', cwd: workerAt });
    expect(workspaces).not.toContainEqual({ label: 'worker', cwd: root });
    expect(workspaces.length).toBeGreaterThan(0);
  });

  test('down stops another seat and leaves the caller running', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    const closed: string[] = [];
    let box = claudeBox('');
    let workerLive = true;
    const people = (): HerdrAgent[] => [
      { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: 'idle', cwd: null },
      { name: 'worker', agent: 'claude', pane: 'worker-pane', workspace: 'worker-ws', status: 'idle', cwd: null },
    ].filter((agent) => !closed.includes(agent.workspace));
    const launch: DownLaunch = {
      typeText(_session, _pane, text) {
        box = claudeBox(text);
        return true;
      },
      sendKey: () => true,
      pressEnter() {
        workerLive = false;
        return true;
      },
      agentPanes: () => people()
        .filter((agent) => agent.pane !== 'worker-pane' || workerLive)
        .map((agent) => agent.pane),
      closeWorkspace(_session, workspace) {
        closed.push(workspace);
        return true;
      },
      stopSession: () => true,
      deleteSession: () => true,
      kill: () => true,
      sleep: async () => {},
      now: () => NOW,
    };
    const audits: { seat: string; act: string; closed: number }[] = [];
    const sources: DownSources = {
      sessionRunning: () => true,
      agents: people,
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => box,
      status: () => 'idle',
      foreground: () => (workerLive ? ['claude'] : ['zsh']),
      now: () => NOW,
      home,
      launch,
      grantAudit(_dir, seat, act) {
        audits.push({ seat, act, closed: closed.length });
      },
    };
    const io = testIo(root, SEAT);
    const code = await runDown([], io, sources);
    expect({ code, out: io.out, err: io.err, audits, closed }).toMatchObject({
      code: 0,
      audits: [{ seat: 'lead', act: 'down', closed: 0 }],
      closed: ['worker-ws'],
    });
    expect(io.out).toContain("skip lead: left running; only the owner stops the orchestrator's or the operator's seat\n");
    expect(closed).not.toContain('lead-ws');
  });
});
