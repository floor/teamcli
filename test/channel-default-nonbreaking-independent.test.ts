// The two ruled non-breaking fallbacks of the default channel, measured independently of the
// builder's own scenes: a legacy-trust team still launches its claude seats at their admitted
// start without the channel flag, and a lead keeps its project cwd when its checkout holds no
// channel pair of its own. Each fallback says and logs one line. A lead whose checkout holds
// its own pair opts in. The protected-checkout refusal and the unmergeable channel settings
// refusal still refuse, and `channel: off` stays silent with its stored launch line unchanged.
// Every home, lobby, pane and seat is synthetic; the host is a stub and starts no CLI.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTeamFile } from '../src/file/load.ts';
import type { TeamFile } from '../src/file/types.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { upPlan, type Step, type UpSeat } from '../src/launch/plan.ts';
import { claudeChannelSeat, prepareChannelConfig } from '../src/mcp/launch-config.ts';
import { CHANNEL_FLAG, CHANNEL_SERVER } from '../src/mcp/channel.ts';
import { seatStart } from '../src/worktree/place.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';

const FLAG = CHANNEL_FLAG;
const SERVER = `server:${CHANNEL_SERVER}`;
const EPOCH = 'run_0123456789ab';
const SESSION = 'forge-session';
const LAUNCH = 'claude --model synth-claude-5';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Variant = { legacy?: boolean; pairFor?: string; vendor?: boolean };

function world(variant: Variant = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'chnb-')));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'forge-project');
  const lobby = join(home, 'lobby');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(lobby, { mode: 0o700 });
  if (variant.pairFor !== undefined) {
    writeFileSync(join(root, '.mcp.json'), `${JSON.stringify({
      mcpServers: { [CHANNEL_SERVER]: { command: '/usr/bin/team', args: ['mcp', 'serve', '--seat', variant.pairFor, '--session', SESSION], env: {} } },
    }, null, 2)}\n`);
    mkdirSync(join(root, '.claude'), { mode: 0o755 });
    writeFileSync(join(root, '.claude', 'settings.local.json'), `${JSON.stringify({ enabledMcpjsonServers: [CHANNEL_SERVER] })}\n`);
  }
  const names = ['pilot', 'wren', 'quiet', ...(variant.vendor ? ['edge'] : [])];
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: forge-project
session: ${SESSION}
coordinator: pilot
operator: pilot
lobby: ${lobby}
trust:
${variant.legacy ? '  - .' : `  - ${root}\n  - ${lobby}`}
workspace:
  mode: shared${variant.vendor ? '\n  protected:\n    - vendor' : ''}
seats:
  - role: coordinator
    name: pilot
    label: pilot
    leads: true
    cli: claude-code
    vendor: synthetic
    model: Synth
    version: "1"
    launch: ${LAUNCH}
  - role: implementer
    name: wren
    label: wren
    cli: claude-code
    vendor: synthetic
    model: Synth
    version: "1"
    launch: ${LAUNCH}
  - role: implementer
    name: quiet
    label: quiet
    cli: claude-code
    vendor: synthetic
    model: Synth
    version: "1"
    channel: off
    launch: ${LAUNCH}
${variant.vendor ? `  - role: implementer
    name: edge
    label: edge
    cli: claude-code
    vendor: synthetic
    model: Synth
    version: "1"
    cwd: vendor/edge
    launch: ${LAUNCH}
` : ''}`);
  writeFileSync(join(root, '.agents', 'team.state.json'), JSON.stringify({ format: 1, sessions: { [SESSION]: {
    seats: {},
    worktrees: {},
    briefs: Object.fromEntries(names.map((name) => [name, {
      id: '01234567-0000-4000-8000-000000000001', incarnation: 'inc_0123456789ab', epoch: EPOCH,
      at: '2026-01-01T00:00:00Z', sha256: 'a'.repeat(64), stage: 'ready',
    }])),
  } } }));
  upsertTeam(home, teamIdOf(root), {
    root, project: 'forge-project', session: SESSION, lobby, lobbies: { [SESSION]: lobby },
    roster: names.map((seat, index) => ({ agent: `agt_${String(index + 1).padStart(12, '0')}`, seat, role: 'worker' })),
  });
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  return { base, home, root, lobby, team: loaded.team };
}

function planned(name: string, cwd = '.'): UpSeat {
  return { name, cli: 'claude-code', launch: LAUNCH, cwd, label: name, displayAgent: name, repairLine: 'restart', rules: 'rules', stopped: false };
}

function launchOf(steps: Step[], name: string) {
  const step = steps.find((item) => item.do?.do === 'launch' && item.do.seat === name);
  if (step?.do?.do !== 'launch') throw new Error(`no launch for ${name}`);
  return step.do;
}

async function runSeat(steps: Step[], name: string) {
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
  // Complete the synthetic launch so the buffered notice is emitted with a final record.
  const launchSteps = steps.filter((step) =>
    (step.do?.do === 'create' || step.do?.do === 'launch') && step.do.seat === name);
  const report = await executePlan([...launchSteps, {
    kind: 'skip', text: 'synthetic launch complete',
    do: { do: 'record', seat: name, record: { kind: 'ready' } },
  }], SESSION, host);
  return { report, commands, created, said, logged };
}

function planFor(team: TeamFile, home: string, root: string, seats: UpSeat[]) {
  return upPlan({
    root, session: SESSION, sessionRunning: true, home, team,
    seats,
    briefEpochs: Object.fromEntries(seats.map((seat) => [seat.name, EPOCH])),
    startWatch: false, watchLabel: 'Synthetic watch',
  });
}

test('legacy trust launches at its admitted start without the channel, with one warning and one log line', async () => {
  const w = world({ legacy: true });
  const steps = planFor(w.team, w.home, w.root, [planned('wren')]);
  const launch = launchOf(steps, 'wren');
  expect(launch.cwd).toBe(w.root);
  expect(launch.command).not.toContain(FLAG);
  expect(launch.command).not.toContain(SERVER);
  expect(launch.recordLine).not.toContain(FLAG);
  expect(JSON.stringify(steps)).not.toContain('absolute trust configuration');
  const ran = await runSeat(steps, 'wren');
  expect(ran.report.dropped).toEqual([]);
  expect(ran.created).toEqual([w.root]);
  expect(ran.commands).toHaveLength(1);
  expect(ran.commands[0]).toContain('claude');
  expect(ran.commands[0]).not.toContain(FLAG);
  expect(ran.commands[0]).not.toContain(SERVER);
  const warnings = ran.said.filter((line) => line.includes('Launching without the channel'));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('channel needs the current trust form');
  expect(warnings[0]).toContain('current absolute-path form');
  expect(warnings[0]).toContain('channel: off');
  expect(ran.logged.filter((line) => line.includes('Launching without the channel'))).toHaveLength(1);
  expect(ran.logged.filter((line) => line.includes('Launching without the channel'))[0]).toContain('channel needs the current trust form');
  expect(existsSync(join(w.lobby, 'wren'))).toBe(false);
});

test('a lead with no channel pair of its own keeps the project cwd, without the channel, with one warning and one log line', async () => {
  const w = world({ pairFor: 'wren' });
  const mcpBefore = readFileSync(join(w.root, '.mcp.json'), 'utf8');
  const start = seatStart(w.team, w.team.seats.find((seat) => seat.name === 'pilot')!, w.root, w.home);
  expect(start).toEqual({ cwd: w.root });
  const steps = planFor(w.team, w.home, w.root, [planned('pilot')]);
  const launch = launchOf(steps, 'pilot');
  expect(launch.cwd).toBe(w.root);
  expect(launch.command).not.toContain(FLAG);
  expect(launch.command).not.toContain(SERVER);
  expect(launch.recordLine).not.toContain(FLAG);
  const ran = await runSeat(steps, 'pilot');
  expect(ran.report.dropped).toEqual([]);
  expect(ran.created).toEqual([w.root]);
  expect(ran.commands).toHaveLength(1);
  expect(ran.commands[0]).not.toContain(FLAG);
  const warnings = ran.said.filter((line) => line.includes('Launching without the channel'));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('no channel pair for this seat');
  expect(warnings[0]).toContain("move the lead's cwd to opt in");
  expect(ran.logged.filter((line) => line.includes('Launching without the channel'))).toHaveLength(1);
  expect(existsSync(join(w.lobby, 'pilot'))).toBe(false);
  expect(readFileSync(join(w.root, '.mcp.json'), 'utf8')).toBe(mcpBefore);
});

test('a lead whose checkout holds its own pair opts in', () => {
  const w = world({ pairFor: 'pilot' });
  const mcpBefore = readFileSync(join(w.root, '.mcp.json'), 'utf8');
  const settingsBefore = readFileSync(join(w.root, '.claude', 'settings.local.json'), 'utf8');
  const steps = planFor(w.team, w.home, w.root, [planned('pilot')]);
  const launch = launchOf(steps, 'pilot');
  expect(launch.cwd).toBe(w.root);
  expect(launch.command).toContain(FLAG);
  expect(launch.command).toContain(SERVER);
  expect(launch.recordLine).toContain(FLAG);
  expect(JSON.stringify(steps)).not.toContain('Launching without the channel');
  const prepared = prepareChannelConfig({ root: w.root, home: w.home, seat: 'pilot', session: SESSION, cwd: w.root, epoch: EPOCH });
  expect(prepared.ok).toBe(true);
  if (prepared.ok) prepared.lease.release();
  expect(readFileSync(join(w.root, '.mcp.json'), 'utf8')).toBe(mcpBefore);
  expect(readFileSync(join(w.root, '.claude', 'settings.local.json'), 'utf8')).toBe(settingsBefore);
  expect(existsSync(join(w.lobby, 'pilot'))).toBe(false);
});

test('the protected-checkout refusal still refuses a default channel seat', () => {
  const w = world({ vendor: true });
  const edge = w.team.seats.find((seat) => seat.name === 'edge');
  if (edge === undefined) throw new Error('no edge seat');
  expect(claudeChannelSeat(edge)).toBe(true);
  const start = seatStart(w.team, edge, w.root, w.home);
  expect('problem' in start).toBe(true);
  if (!('problem' in start)) throw new Error('edge was not refused');
  expect(start.problem).toBe('seat edge would start in vendor/edge, inside the protected checkout vendor; a shared seat never works in a protected checkout');
});

test('unmergeable channel settings still refuse, with the planted bytes kept', () => {
  const w = world();
  const folder = join(w.lobby, 'wren');
  const planted = '{ this is not json\n';
  mkdirSync(join(folder, '.claude'), { mode: 0o700, recursive: true });
  writeFileSync(join(folder, '.claude', 'settings.local.json'), planted);
  const prepared = prepareChannelConfig({ root: w.root, home: w.home, seat: 'wren', session: SESSION, cwd: folder, epoch: EPOCH });
  expect(prepared.ok).toBe(false);
  if (prepared.ok) throw new Error('unmergeable settings were admitted');
  expect(prepared.reason).toBe('the channel configuration must hold valid JSON');
  expect(readFileSync(join(folder, '.claude', 'settings.local.json'), 'utf8')).toBe(planted);
  expect(existsSync(join(folder, '.mcp.json'))).toBe(false);
});

test('channel off stays silent and keeps the stored launch line unchanged', () => {
  const w = world();
  const steps = planFor(w.team, w.home, w.root, [planned('quiet')]);
  const launch = launchOf(steps, 'quiet');
  expect(launch.cwd).toBe(w.root);
  expect(launch.command).not.toContain(FLAG);
  expect(launch.command).not.toContain(SERVER);
  expect(launch.recordLine).toBe(LAUNCH);
  expect(launch.notice).toBeUndefined();
  const text = JSON.stringify(steps);
  expect(text).not.toContain(FLAG);
  expect(text).not.toContain(SERVER);
  expect(text).not.toContain('Launching without the channel');
  expect(existsSync(join(w.lobby, 'quiet'))).toBe(false);
});
