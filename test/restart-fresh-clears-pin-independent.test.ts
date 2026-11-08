// A placed lead's `team restart <seat> --fresh` clears a conversation pinned on the agent
// record: the resume flag leaves the record's launch line, the recorded session is cleared,
// and the new CLI starts with no resume flag. The audit names the caller. Signing and
// settings stay byte for byte. `--abandon` does not clear a pin it cannot strip. The home,
// the agent record and the pane names are synthetic. The host is a stub and starts no CLI.
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { agentsDir, registerAgent, type Agent } from '../src/registry/agents.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, shortSocketBase, testIo } from './helpers.ts';

const NOW = new Date('2026-11-08T10:00:00Z');
const PIN = 'ses_0123456789ab';
const CLEAN = 'claude --model claude-opus-5-5';
const PINNED = `${CLEAN} -r ${PIN}`;

const TEAM = `format: 1
project: acme
coordinator: lead
operator: ops
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${CLEAN}
  - role: coordinator
    name: ops
    label: ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${CLEAN}
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${CLEAN}
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Independent',
      GIT_AUTHOR_EMAIL: 'independent@example.invalid',
      GIT_COMMITTER_NAME: 'Independent',
      GIT_COMMITTER_EMAIL: 'independent@example.invalid',
    },
  });
}

type Scene = {
  home: string;
  root: string;
  dir: string;
  agent: Agent;
  runs: string[];
  sources: RestartSources;
};

function section(text: string, name: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `${name}:`);
  if (start < 0) return '';
  const out = [lines[start]!];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.startsWith('  ')) break;
    out.push(line);
  }
  return out.join('\n');
}

function open(): Scene {
  const base = realpathSync(mkdtempSync(join(shortSocketBase(), 'restart-fresh-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'team.yaml'), TEAM.replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:\n`));
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
    session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', agent_session: PIN };
  });
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  const lead = loaded.team.seats.find((seat) => seat.name === 'lead');
  if (lead === undefined) throw new Error('no lead');
  const placed = registerLaunch({ home, team: loaded.team, root, by: 'owner' }, lead, 'pane-lead');
  if ('note' in placed) throw new Error(placed.note);
  const agent = registerAgent(home, {
    name: 'worker',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: PINNED,
    reach: {
      team: teamIdOf(root),
      seat: 'worker',
      session: 'acme',
      pane: 'pane-old',
      address: null,
      agent_session: PIN,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    settings: { effort: { word: 'steady' } },
    by: 'the test',
  });

  const runs: string[] = [];
  let workerAlive = true;
  let shelled = false;
  const drawn = new Map<string, string>();
  const fresh = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();
  const agents = (): HerdrAgent[] => [
    { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: root },
    { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle', cwd: root },
    ...(workerAlive
      ? [{ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle', cwd: root, session: PIN }]
      : []),
    ...[...fresh.entries()].filter(([, slot]) => slot.agent).map(([pane, slot]) => ({
      name: slot.name,
      agent: 'claude-code',
      pane,
      workspace: slot.workspace,
      status: 'idle' as const,
      cwd: root,
    })),
  ];
  const downLaunch: DownLaunch = {
    typeText(_session, pane, text) {
      drawn.set(pane, claudeBox(text));
      return text.includes('/exit');
    },
    sendKey: () => true,
    pressEnter() {
      shelled = true;
      return true;
    },
    agentPanes: () => agents().map((item) => item.pane),
    closeWorkspace(_session, workspace) {
      if (workspace === 'ws-old') workerAlive = false;
      return true;
    },
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };
  const upLaunch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    registerInbox: () => ({ ok: true }),
    createWorkspace() {
      const pane = 'pane-new';
      const workspace = 'ws-new';
      fresh.set(pane, { text: CLAUDE_IDLE, agent: false, name: null, workspace });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      runs.push(command);
      const slot = fresh.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = fresh.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace: downLaunch.closeWorkspace,
    agentPanes: () => agents().map((item) => item.pane),
    agents: () => agents(),
    workspacePanes: (_session, workspace) => {
      if (workspace === 'ws-old' && workerAlive) return ['pane-old'];
      return [...fresh.entries()].filter(([, slot]) => slot.workspace === workspace).map(([pane]) => pane);
    },
    paneText: (_session, pane) => drawn.get(pane) ?? fresh.get(pane)?.text ?? CLAUDE_IDLE,
    typeText(_session, pane, text) {
      const slot = fresh.get(pane);
      if (slot) slot.text = claudeBox(text);
      return true;
    },
    pressEnter() {
      return true;
    },
    agentStatus: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : ['claude']),
    shellBack: (_session, pane) => pane === 'pane-old' && shelled,
    sleep: async () => {},
    now: () => NOW,
  };
  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  };
  const sources: RestartSources = {
    home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => agents(),
    workspaces: () => agents().map((item) => ({ id: item.workspace })),
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: (_session, pane) => drawn.get(pane) ?? claudeBox(''),
    status: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : ['claude']),
    now: () => NOW,
    sleep: async () => {},
    launch: downLaunch,
    upLaunch,
    doctor,
    autoOrder: () => null,
  };
  return { home, root, dir, agent, runs, sources };
}

function recordText(scene: Scene): string {
  return readFileSync(join(agentsDir(scene.home), `${scene.agent.id}.yaml`), 'utf8');
}

test('restart --fresh clears the pinned conversation, starts with no resume flag, and keeps signing and settings', async () => {
  const scene = open();
  const before = recordText(scene);
  expect(before).toContain(PIN);
  const io = testIo(scene.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
  const code = await runRestart(['worker', '--fresh'], io, scene.sources);
  expect(code).toBe(0);
  const after = recordText(scene);
  expect(after.includes(PIN)).toBe(false);
  expect(after).toContain('agent_session: null');
  expect(section(after, 'signing')).toBe(section(before, 'signing'));
  expect(section(after, 'settings')).toBe(section(before, 'settings'));
  expect(section(before, 'signing')).toContain('Claude Opus');
  expect(section(before, 'settings')).toContain('steady');
  expect(scene.runs.length).toBeGreaterThan(0);
  for (const command of scene.runs) {
    expect(command.includes(PIN)).toBe(false);
    expect(command.includes('--resume')).toBe(false);
    expect(/(^|\s)-r(\s|$)/.test(command)).toBe(false);
  }
  const log = readFileSync(join(scene.dir, 'team.log'), 'utf8');
  expect(log).toContain('restart [lead]');
  expect(log).toContain('worker: cleared the pinned conversation from its agent record');
  expect(readFileSync(join(scene.dir, 'team.yaml'), 'utf8').includes(PIN)).toBe(false);
});

test('restart --abandon leaves a pinned conversation it cannot strip', async () => {
  const scene = open();
  const before = recordText(scene);
  const io = testIo(scene.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
  const code = await runRestart(['worker', '--abandon'], io, scene.sources);
  expect(code).toBe(1);
  expect(`${io.out}${io.err}`).toContain('clear the resume selection from its launch line');
  expect(recordText(scene)).toBe(before);
  expect(scene.runs).toEqual([]);
});
