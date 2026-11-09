// A Claude lead keeps its project root; without its own pair it launches without the channel
// and warns once. A GLM-on-claude worker gets the flag and its lobby pair. Legacy trust also
// launches without the channel and warns once. `channel: off` gets neither. Existing project
// config for another seat stays byte-identical.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTeamConfig } from '../src/file/team-config.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { upPlan, type Step, type UpSeat } from '../src/launch/plan.ts';
import { prepareChannelConfig } from '../src/mcp/launch-config.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';

const FLAG = '--dangerously-load-development-channels';
const EPOCH = 'run_0123456789ab';
const SESSION = 'synthetic-session';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function world(treeMode?: number, legacyTrust = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'channel-default-')));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'project');
  const lobby = join(home, 'lobby');
  const tree = join(root, 'wt');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(lobby, { mode: 0o700 });
  mkdirSync(join(root, '.agents'), { recursive: true });
  if (treeMode !== undefined) {
    mkdirSync(tree, { recursive: true });
    chmodSync(tree, treeMode);
  }
  const kept = `${JSON.stringify({
    mcpServers: { 'team-inbox': { command: '/usr/bin/team', args: ['mcp', 'serve', '--seat', 'owner', '--session', SESSION], env: {} } },
  }, null, 2)}\n`;
  writeFileSync(join(root, '.mcp.json'), kept);
  mkdirSync(join(root, '.claude'), { mode: 0o755 });
  writeFileSync(join(root, '.claude', 'settings.local.json'), `${JSON.stringify({ enabledMcpjsonServers: ['team-inbox'] })}\n`);
  const file = join(root, '.agents/team.yaml');
  writeFileSync(file, `format: 1
project: synthetic-project
session: ${SESSION}
coordinator: lead
operator: lead
lobby: ${lobby}
trust:
${legacyTrust ? '  - .' : `  - ${root}\n  - ${lobby}`}
workspace:
  mode: shared
seats:
  - name: lead
    role: coordinator
    leads: true
    cli: claude-code
    vendor: synthetic
    model: Claude
    version: "1"
    launch: claude --model claude-opus-5-5
  - name: glm
    role: implementer
    cli: claude-code
    vendor: synthetic
    model: GLM
    version: "1"
    launch: claude-glm --model glm-4.6
  - name: quiet
    role: implementer
    cli: claude-code
    vendor: synthetic
    model: Claude
    version: "1"
    channel: off
    launch: claude --model claude-opus-5-5
  - name: owner
    role: implementer
    cli: claude-code
    vendor: synthetic
    model: Claude
    version: "1"
    launch: claude --model claude-opus-5-5
${treeMode === undefined ? '' : `  - name: tree
    role: implementer
    cli: claude-code
    vendor: synthetic
    model: Claude
    version: "1"
    cwd: wt
    launch: claude --model claude-opus-5-5
`}`);
  const names = ['lead', 'glm', 'quiet', 'owner', ...(treeMode === undefined ? [] : ['tree'])];
  upsertTeam(home, teamIdOf(root), {
    root, project: 'synthetic-project', session: SESSION, lobby,
    roster: names.map((seat, i) => ({ agent: `agt_${String(i + 1).padStart(12, '0')}`, seat, role: 'worker' })),
  });
  writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({ format: 1, sessions: { [SESSION]: {
    seats: {},
    worktrees: {},
    briefs: Object.fromEntries(names.map((seat) => [seat, {
      id: '01234567-0000-4000-8000-000000000001', incarnation: 'inc_0123456789ab', epoch: EPOCH,
      at: '2026-01-01T00:00:00Z', sha256: 'a'.repeat(64), stage: 'ready',
    }])),
  } } }));
  const loaded = readTeamConfig(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return { home, root, lobby, kept, team: loaded.team, tree };
}

function planned(name: string, launch: string): UpSeat {
  return {
    name, cli: 'claude-code', launch, cwd: '.', label: name, displayAgent: name,
    repairLine: 'restart', rules: 'rules', stopped: false,
  };
}

function launchOf(steps: Step[], name: string) {
  const step = steps.find((item) => item.do?.do === 'launch' && item.do.seat === name);
  if (step?.do?.do !== 'launch') throw new Error(`no launch for ${name}`);
  return step.do;
}

async function executeSeat(steps: Step[], name: string) {
  const commands: string[] = [];
  const created: string[] = [];
  const said: string[] = [];
  const logged: string[] = [];
  const host: Host = {
    startServer: () => true, sessionUp: () => true,
    createWorkspace: (_session, cwd) => { created.push(cwd); return { pane: 'pane-fixture', workspace: 'workspace-fixture' }; },
    paneRun: (_session, _pane, command) => { commands.push(command); return true; },
    registerInbox: () => null,
    typeLine: () => false, renameAgent: () => true, closeWorkspace: () => true, stopSession: () => true,
    kill: () => true, agentPanes: () => [], classify: () => 'idle', sleep: async () => {}, now: () => 0,
    allow: () => null, record: () => {}, running: () => {}, drop: () => {},
    say: (line) => { said.push(line); }, log: (_who, line) => { logged.push(line); },
  };
  // Complete the synthetic launch so its buffered notice is emitted with a final record.
  const launchSteps = steps.filter((step) =>
    (step.do?.do === 'create' || step.do?.do === 'launch') && step.do.seat === name);
  const report = await executePlan([...launchSteps, {
    kind: 'skip', text: 'synthetic launch complete',
    do: { do: 'record', seat: name, record: { kind: 'ready' } },
  }], SESSION, host);
  return { report, commands, created, said, logged };
}

test('a lead stays in its project without a channel pair; workers still get their admitted channel', async () => {
  const w = world();
  expect(w.team.seats.find((seat) => seat.name === 'lead')?.channelOff).toBeUndefined();
  expect(w.team.seats.find((seat) => seat.name === 'quiet')?.channelOff).toBe(true);
  const steps = upPlan({
    root: w.root, session: SESSION, sessionRunning: true, home: w.home, team: w.team,
    seats: [
      planned('lead', 'claude --model claude-opus-5-5'),
      planned('glm', 'claude-glm --model glm-4.6'),
      planned('quiet', 'claude --model claude-opus-5-5'),
      planned('owner', 'claude --model claude-opus-5-5'),
    ],
    briefEpochs: Object.fromEntries(['lead', 'glm', 'quiet', 'owner'].map((seat) => [seat, EPOCH])),
    startWatch: false, watchLabel: 'Synthetic watch',
  });
  for (const name of ['glm', 'owner']) {
    const launch = launchOf(steps, name);
    expect(launch.command).toContain(FLAG);
    expect(launch.command).toContain('server:team-inbox');
    expect(launch.recordLine).toContain(FLAG);
    expect(launch.recordLine).not.toContain('--resume');
  }
  // A default channel must not move a lead out of its project or overwrite another seat's pair.
  expect(launchOf(steps, 'lead').cwd).toBe(w.root);
  expect(launchOf(steps, 'lead').command).not.toContain(FLAG);
  expect(launchOf(steps, 'lead').command).not.toContain('server:team-inbox');
  expect(launchOf(steps, 'lead').recordLine).not.toContain(FLAG);
  const leadRun = await executeSeat(steps, 'lead');
  expect(leadRun.report.dropped).toEqual([]);
  expect(leadRun.created).toEqual([w.root]);
  expect(leadRun.commands).toHaveLength(1);
  expect(leadRun.commands[0]).not.toContain(FLAG);
  const warnings = leadRun.said.filter((line) => line.includes('Launching without the channel'));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('project folder has no channel pair for this seat');
  expect(leadRun.logged.filter((line) => line.includes('Launching without the channel'))).toHaveLength(1);
  expect(launchOf(steps, 'glm').cwd).toBe(join(w.lobby, 'glm'));
  expect(launchOf(steps, 'quiet').command).not.toContain(FLAG);
  expect(launchOf(steps, 'quiet').cwd).toBe(w.root);
  expect(launchOf(steps, 'owner').cwd).toBe(w.root);

  const input = (seat: string, cwd: string) => ({ root: w.root, home: w.home, seat, session: SESSION, cwd, epoch: EPOCH });
  expect(prepareChannelConfig(input('lead', join(w.lobby, 'lead'))).ok).toBe(false);
  expect(existsSync(join(w.lobby, 'lead'))).toBe(false);
  expect(prepareChannelConfig(input('glm', join(w.lobby, 'glm'))).ok).toBe(true);
  expect(prepareChannelConfig(input('quiet', join(w.lobby, 'quiet'))).ok).toBe(false);
  expect(prepareChannelConfig(input('owner', w.root)).ok).toBe(true);
  for (const name of ['glm']) {
    const mcp = JSON.parse(readFileSync(join(w.lobby, name, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { args: string[] }> };
    expect(mcp.mcpServers['team-inbox']?.args).toContain(name);
    const settings = JSON.parse(readFileSync(join(w.lobby, name, '.claude', 'settings.local.json'), 'utf8')) as { enabledMcpjsonServers: string[] };
    expect(settings.enabledMcpjsonServers).toContain('team-inbox');
  }
  expect(existsSync(join(w.lobby, 'quiet'))).toBe(false);
  expect(existsSync(join(w.lobby, 'owner'))).toBe(false);
  expect(readFileSync(join(w.root, '.mcp.json'), 'utf8')).toBe(w.kept);
  for (const name of ['glm']) {
    expect(statSync(join(w.lobby, name)).mode & 0o777).toBe(0o700);
    expect(statSync(join(w.lobby, name, '.mcp.json')).mode & 0o777).toBe(0o600);
  }
});

test('a launch line that already sets the unattended prefix keeps it once', () => {
  const w = world();
  const steps = upPlan({
    root: w.root, session: SESSION, sessionRunning: true, home: w.home, team: w.team,
    seats: [planned('glm', 'AGENT_UNATTENDED=1 claude-glm --model glm-4.6')],
    briefEpochs: { glm: EPOCH },
    startWatch: false, watchLabel: 'Synthetic watch',
  });
  const command = launchOf(steps, 'glm').command;
  expect(command.split('AGENT_UNATTENDED=1').length - 1).toBe(1);
  expect(command.startsWith('AGENT_UNATTENDED=1 ')).toBe(true);
  expect(command).toContain(FLAG);
});

test('a worktree at 0755 gets the channel pair', () => {
  const w = world(0o755);
  const prepared = prepareChannelConfig({
    root: w.root, home: w.home, seat: 'tree', session: SESSION, cwd: w.tree, epoch: EPOCH,
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error(prepared.reason);
  prepared.lease.release();
  expect(statSync(w.tree).mode & 0o777).toBe(0o755);
  expect(statSync(join(w.tree, '.mcp.json')).mode & 0o777).toBe(0o600);
  expect(statSync(join(w.tree, '.claude', 'settings.local.json')).mode & 0o777).toBe(0o600);
  const mcp = JSON.parse(readFileSync(join(w.tree, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { args: string[] }> };
  expect(mcp.mcpServers['team-inbox']?.args).toContain('tree');
  expect(existsSync(join(w.tree, '.team-channel.lock'))).toBe(false);
});

test('a group-writable worktree warns and still launches without the channel', async () => {
  const w = world(0o775);
  const steps = upPlan({
    root: w.root, session: SESSION, sessionRunning: true, home: w.home, team: w.team,
    seats: [{ ...planned('tree', 'claude --model claude-opus-5-5'), cwd: 'wt' }],
    briefEpochs: { tree: EPOCH },
    startWatch: false, watchLabel: 'Synthetic watch',
  });
  const plannedLaunch = launchOf(steps, 'tree');
  expect(plannedLaunch.command).toContain(FLAG);
  expect(plannedLaunch.recordLine).toContain(FLAG);
  expect(plannedLaunch.cwd).toBe(w.tree);
  const ran = { command: '' };
  const said: string[] = [];
  const logged: string[] = [];
  const host: Host = {
    startServer: () => true, sessionUp: () => true,
    createWorkspace: () => ({ pane: 'pane-tree', workspace: 'workspace-tree' }),
    paneRun: (_session, _pane, command) => { ran.command = command; return true; },
    registerInbox: () => null,
    typeLine: () => false, renameAgent: () => true, closeWorkspace: () => true, stopSession: () => true,
    kill: () => true, agentPanes: () => [], classify: () => 'idle', sleep: async () => {}, now: () => 0,
    allow: () => null, record: () => {}, running: () => {}, drop: () => {},
    say: (line) => { said.push(line); }, log: (_who, line) => { logged.push(line); },
  };
  const report = await executePlan(
    steps.filter((step) => step.do?.do === 'create' || step.do?.do === 'launch'),
    SESSION,
    host,
  );
  expect(report.dropped).toEqual([]);
  expect(ran.command).not.toContain(FLAG);
  expect(ran.command).not.toContain('server:team-inbox');
  const warnings = said.filter((line) => line.includes('its channel was not prepared'));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('safe permissions');
  expect(warnings[0]).toContain('no group or other write');
  expect(warnings[0]).toContain('channel: off');
  expect(logged.filter((line) => line.includes('its channel was not prepared'))).toHaveLength(1);
  expect(existsSync(join(w.tree, '.mcp.json'))).toBe(false);
});

// Legacy trust keeps its admitted start; only the optional channel is declined.
test('legacy trust launches in the project without the channel and warns once', async () => {
  const w = world(undefined, true);
  const settingsPath = join(w.root, '.claude', 'settings.local.json');
  const settingsBefore = readFileSync(settingsPath, 'utf8');
  const steps = upPlan({
    root: w.root, session: SESSION, sessionRunning: true, home: w.home, team: w.team,
    seats: [planned('glm', 'claude-glm --model glm-4.6')],
    briefEpochs: { glm: EPOCH }, startWatch: false, watchLabel: 'Synthetic watch',
  });
  const launch = launchOf(steps, 'glm');
  expect(launch.cwd).toBe(w.root);
  expect(launch.command).not.toContain(FLAG);
  expect(launch.command).not.toContain('server:team-inbox');
  const ran = await executeSeat(steps, 'glm');
  expect(ran.report.dropped).toEqual([]);
  expect(ran.created).toEqual([w.root]);
  expect(ran.commands).toHaveLength(1);
  expect(ran.commands[0]).toContain('claude-glm');
  expect(ran.commands[0]).not.toContain(FLAG);
  expect(ran.commands[0]).not.toContain('server:team-inbox');
  const warnings = ran.said.filter((line) => line.includes('Launching without the channel'));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('channel needs the current trust form');
  expect(ran.logged.filter((line) => line.includes('Launching without the channel'))).toHaveLength(1);
  expect(readFileSync(join(w.root, '.mcp.json'), 'utf8')).toBe(w.kept);
  expect(readFileSync(settingsPath, 'utf8')).toBe(settingsBefore);
  expect(existsSync(join(w.lobby, 'glm'))).toBe(false);
});
