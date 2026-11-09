// A GLM-on-claude seat restarted gets the channel flag and the MCP pair in its lobby folder.
// A seat whose cwd is the owner checkout keeps the pair already there. `channel: off` gets
// neither from up nor from restart. Grok and Codex get no flag. The home, the lobby and the
// pane names are synthetic. The host is a stub and starts no CLI.
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { upPlan, type Step, type UpSeat } from '../src/launch/plan.ts';
import { CHANNEL_FLAG } from '../src/mcp/channel.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { emptySession, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, shortSocketBase, testIo } from './helpers.ts';

const NOW = new Date('2026-11-09T08:00:00Z');
const FLAG = CHANNEL_FLAG;
const SERVER = 'server:team-inbox';

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
  lobby: string;
  team: TeamFile;
  runs: string[];
  sources: RestartSources;
  pair: { mcp: string; settings: string };
};

function seat(name: string, cli: string, launch: string, extra = ''): string {
  return `  - role: implementer
    name: ${name}
    label: ${name}
    cli: ${cli}
    vendor: synthetic
    model: Synthetic
    version: "1"
    launch: ${launch}
${extra}`;
}

function open(target: string): Scene {
  const base = realpathSync(mkdtempSync(join(shortSocketBase(), 'channel-default-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const lobby = join(home, 'lobby');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(lobby, { mode: 0o700 });
  chmodSync(home, 0o700);
  chmodSync(lobby, 0o700);
  git(root, 'init', '-q', '-b', 'main');
  const pair = {
    mcp: `${JSON.stringify({
      mcpServers: {
        'team-inbox': {
          command: '/usr/bin/team',
          args: ['mcp', 'serve', '--seat', 'owner', '--session', 'acme'],
          env: {},
        },
      },
    }, null, 2)}\n`,
    settings: `${JSON.stringify({ enabledMcpjsonServers: ['team-inbox'] })}\n`,
  };
  writeFileSync(join(root, '.mcp.json'), pair.mcp);
  mkdirSync(join(root, '.claude'), { mode: 0o755 });
  writeFileSync(join(root, '.claude', 'settings.local.json'), pair.settings);
  const file = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
lobby: ${lobby}
trust:
  - ${root}
  - ${lobby}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    leads: true
    cli: claude-code
    vendor: synthetic
    model: Synthetic
    version: "1"
    launch: claude --model claude-opus-5-5
${seat('glm', 'claude-code', 'claude-glm --model glm-4.6')}${seat('quiet', 'claude-code', 'claude --model claude-opus-5-5', '    channel: off\n')}${seat('owner', 'claude-code', 'claude --model claude-opus-5-5')}${seat('grok', 'grok', 'grok --model grok-4', '    cwd: ../grok-tree\n')}${seat('codex', 'codex', 'codex', '    cwd: ../codex-tree\n')}`;
  writeFileSync(join(dir, 'team.yaml'), file);
  mkdirSync(join(base, 'grok-tree'), { mode: 0o700 });
  mkdirSync(join(base, 'codex-tree'), { mode: 0o700 });
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    session.seats[target] = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
  });
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  const lead = loaded.team.seats.find((item) => item.name === 'lead');
  if (lead === undefined) throw new Error('no lead');
  const placed = registerLaunch({ home, team: loaded.team, root, by: 'owner' }, lead, 'pane-lead');
  if ('note' in placed) throw new Error(placed.note);
  const names = ['lead', 'glm', 'quiet', 'owner', 'grok', 'codex'];
  upsertTeam(home, teamIdOf(root), {
    root,
    project: 'acme',
    session: 'acme',
    lobby,
    lobbies: { acme: lobby },
    roster: names.map((name, index) => ({ agent: `agt_${String(index + 1).padStart(12, '0')}`, seat: name, role: 'worker' })),
  });

  const runs: string[] = [];
  let alive = true;
  let shelled = false;
  const drawn = new Map<string, string>();
  const fresh = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();
  const agents = (): HerdrAgent[] => [
    { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: root },
    ...(alive ? [{ name: target, agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle' as const, cwd: root }] : []),
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
      if (workspace === 'ws-old') alive = false;
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
      if (workspace === 'ws-old' && alive) return ['pane-old'];
      return [...fresh.entries()].filter(([, slot]) => slot.workspace === workspace).map(([pane]) => pane);
    },
    paneText: (_session, pane) => drawn.get(pane) ?? fresh.get(pane)?.text ?? CLAUDE_IDLE,
    typeText(_session, pane, text) {
      const slot = fresh.get(pane);
      if (slot) slot.text = claudeBox(text);
      return true;
    },
    pressEnter: () => true,
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
  return { home, root, lobby, team: loaded.team, runs, sources, pair };
}

function leadIo(scene: Scene) {
  return testIo(scene.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
}

function planned(name: string, cli: string, launch: string, cwd: string): UpSeat {
  return { name, cli, launch, cwd, label: name, displayAgent: name, repairLine: 'restart', rules: 'rules', stopped: false };
}

function launches(steps: Step[], name: string) {
  return steps.filter((step) => step.do?.do === 'launch' && step.do.seat === name);
}

test('a restarted GLM-on-claude seat gets the flag and the pair in its lobby folder', async () => {
  const scene = open('glm');
  const io = leadIo(scene);
  const code = await runRestart(['glm'], io, scene.sources);
  expect(code, io.out + io.err).toBe(0);
  expect(scene.runs.length).toBeGreaterThan(0);
  for (const command of scene.runs) {
    expect(command).toContain(FLAG);
    expect(command).toContain(SERVER);
  }
  const mcp = JSON.parse(readFileSync(join(scene.lobby, 'glm', '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { args: string[] }> };
  expect(mcp.mcpServers['team-inbox']?.args).toContain('glm');
  const settings = JSON.parse(readFileSync(join(scene.lobby, 'glm', '.claude', 'settings.local.json'), 'utf8')) as { enabledMcpjsonServers: string[] };
  expect(settings.enabledMcpjsonServers).toContain('team-inbox');
});

test('a seat whose cwd is the owner checkout leaves the existing pair untouched', async () => {
  const scene = open('owner');
  const io = leadIo(scene);
  const code = await runRestart(['owner'], io, scene.sources);
  expect(code, io.out + io.err).toBe(0);
  expect(readFileSync(join(scene.root, '.mcp.json'), 'utf8')).toBe(scene.pair.mcp);
  expect(readFileSync(join(scene.root, '.claude', 'settings.local.json'), 'utf8')).toBe(scene.pair.settings);
  expect(existsSync(join(scene.lobby, 'owner'))).toBe(false);
  expect(existsSync(join(scene.root, 'owner'))).toBe(false);
});

test('channel off gets neither the flag nor a pair, on up and on restart', async () => {
  const scene = open('quiet');
  const steps = upPlan({
    root: scene.root,
    session: 'acme',
    sessionRunning: true,
    home: scene.home,
    team: scene.team,
    seats: [planned('quiet', 'claude-code', 'claude --model claude-opus-5-5', '.')],
    startWatch: false,
    watchLabel: 'Synthetic watch',
  });
  const plannedLaunch = launches(steps, 'quiet');
  expect(plannedLaunch.length).toBe(1);
  const launch = plannedLaunch[0]?.do;
  if (launch?.do !== 'launch') throw new Error('quiet was not launched');
  expect(launch.command).not.toContain(FLAG);
  expect(launch.recordLine).not.toContain(FLAG);
  expect(launch.cwd).toBe(scene.root);
  const io = leadIo(scene);
  const code = await runRestart(['quiet'], io, scene.sources);
  expect(code, io.out + io.err).toBe(0);
  expect(scene.runs.length).toBeGreaterThan(0);
  for (const command of scene.runs) expect(command).not.toContain(FLAG);
  expect(existsSync(join(scene.lobby, 'quiet'))).toBe(false);
});

test('a grok seat and a codex seat get no channel flag', () => {
  const scene = open('lead');
  const steps = upPlan({
    root: scene.root,
    session: 'acme',
    sessionRunning: true,
    home: scene.home,
    team: scene.team,
    seats: [
      planned('grok', 'grok', 'grok --model grok-4', '../grok-tree'),
      planned('codex', 'codex', 'codex', '../codex-tree'),
    ],
    startWatch: false,
    watchLabel: 'Synthetic watch',
  });
  for (const name of ['grok', 'codex']) {
    for (const step of launches(steps, name)) {
      if (step.do?.do !== 'launch') continue;
      expect(step.do.command).not.toContain(FLAG);
      expect(step.do.recordLine).not.toContain(FLAG);
    }
  }
  const text = JSON.stringify(steps);
  expect(text).not.toContain(FLAG);
  expect(text).not.toContain(SERVER);
});
