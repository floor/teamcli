import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import { registerEnd, registerLaunch, registerRun, type RegistryTeam } from '../src/registry/sync.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { findAgent, getAgent, readAgents } from '../src/registry/agents.ts';
import { getTeam, teamIdOf } from '../src/registry/teams.ts';
import { get as getProject, projectIdOf, projectsFile } from '../src/registry/projects.ts';
import { emptySession, updateState } from '../src/state.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T02:00:00Z');
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;

const TEAM_YAML = `format: 1
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
    launch: claude --model claude-opus-5-5

  - role: coordinator
    name: ops
    label: ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: parked-seat
    label: parked
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`;

type Fixture = { root: string; home: string; file: string; dir: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-registry-writers-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  const yaml = TEAM_YAML.replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:\n`);
  const file = join(dir, 'team.yaml');
  writeFileSync(file, yaml);
  return { root, home, file, dir };
}

/** The team the fixture's file declares, parsed the way the commands parse it. */
function teamOf(fixture: Fixture) {
  const parsed = validateTeamFile(TEAM_YAML.replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${fixture.root}\nworkspace:\n`), { home: fixture.home, root: fixture.root });
  if (!parsed.ok) throw new Error('fixture team does not validate');
  return parsed.team;
}

function registryOf(fixture: Fixture): RegistryTeam {
  return { home: fixture.home, team: teamOf(fixture), root: fixture.root, by: 'owner' };
}

describe('registry writers: the shared register-or-repoint rule', () => {
  test('the first launch registers the agent and the roster; a relaunch keeps its id and re-points the pane', () => {
    const fixture = makeFixture();
    const input = registryOf(fixture);
    const worker = input.team.seats.find((seat) => seat.name === 'worker')!;
    const teamId = teamIdOf(fixture.root);

    const first = registerLaunch(input, worker, 'pane-1');
    expect('id' in first).toBe(true);
    const id = (first as { id: string }).id;
    expect(id).toMatch(/^agt_[0-9a-f]{12}$/);
    const agent = getAgent(fixture.home, id)!;
    expect(agent.lifecycle).toBe('running');
    expect(agent.reach).toMatchObject({ team: teamId, seat: 'worker', session: 'acme', pane: 'pane-1' });
    expect(agent.signing).toEqual({ model: 'Claude Opus', version: '5.5', role: 'implementer' });
    expect(agent.lab).toBe('anthropic');
    expect(agent.cli).toBe('claude-code');
    expect(getTeam(fixture.home, teamId)?.roster).toEqual([{ agent: id, seat: 'worker', role: 'implementer' }]);
    expect(getTeam(fixture.home, teamId)?.lifecycle).toBe('running');

    const second = registerLaunch(input, worker, 'pane-2');
    expect(second).toEqual({ id });
    expect(readAgents(fixture.home)).toHaveLength(1);
    expect(getAgent(fixture.home, id)?.reach.pane).toBe('pane-2');
    expect(getTeam(fixture.home, teamId)?.roster).toHaveLength(1);
  });

  test("a launch writes the file's lead mark on the roster, and a moved mark does not linger", () => {
    const fixture = makeFixture();
    const input = registryOf(fixture);
    const lead = input.team.seats.find((seat) => seat.name === 'lead')!;
    const worker = input.team.seats.find((seat) => seat.name === 'worker')!;
    const leadId = (registerLaunch(input, lead, 'pane-lead') as { id: string }).id;
    const workerId = (registerLaunch(input, worker, 'pane-worker') as { id: string }).id;
    // The file leads with `lead` (`coordinator: lead`), so only that line says so.
    expect(getTeam(fixture.home, teamIdOf(fixture.root))?.roster).toEqual([
      { agent: leadId, seat: 'lead', role: 'coordinator', leads: true },
      { agent: workerId, seat: 'worker', role: 'implementer' },
    ]);
    // The file moves its lead mark to the worker: the next write re-resolves every line.
    const moved = { ...input, team: { ...input.team, orchestrator: 'worker' } };
    registerLaunch(moved, worker, 'pane-worker-2');
    expect(getTeam(fixture.home, teamIdOf(fixture.root))?.roster).toEqual([
      { agent: leadId, seat: 'lead', role: 'coordinator' },
      { agent: workerId, seat: 'worker', role: 'implementer', leads: true },
    ]);
  });

  test("a launch writes the file's assistant mark on the roster, and a moved mark does not linger", () => {
    const fixture = makeFixture();
    const input = registryOf(fixture);
    const teamId = teamIdOf(fixture.root);
    const lead = input.team.seats.find((seat) => seat.name === 'lead')!;
    const worker = input.team.seats.find((seat) => seat.name === 'worker')!;
    // The file's own seats are what the mark is read from — its digest field, beside `parked` —
    // so a scene marks one without rewriting the fixture's YAML, as the lead's own scene moves
    // `orchestrator`.
    const marks = (seatName: string) => ({
      ...input.team,
      seats: input.team.seats.map((seat) => (seat.name === seatName ? { ...seat, assistant: true as const } : seat)),
    });
    const leadId = (registerLaunch({ ...input, team: marks('lead') }, lead, 'pane-lead') as { id: string }).id;
    const workerId = (registerLaunch({ ...input, team: marks('lead') }, worker, 'pane-worker') as { id: string }).id;
    // The file marks `lead`, so that line says so — beside its own `leads`, which the fixture's
    // `coordinator:` key resolves.
    expect(getTeam(fixture.home, teamId)?.roster).toEqual([
      { agent: leadId, seat: 'lead', role: 'coordinator', leads: true, assistant: true },
      { agent: workerId, seat: 'worker', role: 'implementer' },
    ]);
    // The file moves its assistant mark to the worker: the next write re-resolves every line.
    registerLaunch({ ...input, team: marks('worker') }, worker, 'pane-worker-2');
    expect(getTeam(fixture.home, teamId)?.roster).toEqual([
      { agent: leadId, seat: 'lead', role: 'coordinator', leads: true },
      { agent: workerId, seat: 'worker', role: 'implementer', assistant: true },
    ]);
  });

  test('a stop keeps the id and clears the pane; the next launch is the same agent', () => {
    const fixture = makeFixture();
    const input = registryOf(fixture);
    const worker = input.team.seats.find((seat) => seat.name === 'worker')!;
    const id = (registerLaunch(input, worker, 'pane-1') as { id: string }).id;

    expect(registerEnd(input, 'worker', 'stopped')).toBeNull();
    const stopped = getAgent(fixture.home, id)!;
    expect(stopped.lifecycle).toBe('stopped');
    expect(stopped.reach.pane).toBeNull();
    expect(getTeam(fixture.home, teamIdOf(fixture.root))?.roster.map((item) => item.seat)).toEqual(['worker']);

    expect(registerLaunch(input, worker, 'pane-9')).toEqual({ id });
    expect(getAgent(fixture.home, id)).toMatchObject({ lifecycle: 'running', reach: { pane: 'pane-9' } });
  });

  test('a retirement leaves the roster, and the seat added back is a new agent with a new id', () => {
    const fixture = makeFixture();
    const input = registryOf(fixture);
    const worker = input.team.seats.find((seat) => seat.name === 'worker')!;
    const old = (registerLaunch(input, worker, 'pane-1') as { id: string }).id;

    expect(registerEnd(input, 'worker', 'retired')).toBeNull();
    expect(getAgent(fixture.home, old)?.lifecycle).toBe('retired');
    expect(getTeam(fixture.home, teamIdOf(fixture.root))?.roster).toEqual([]);

    const next = (registerLaunch(input, worker, 'pane-2') as { id: string }).id;
    expect(next).not.toBe(old);
    expect(getAgent(fixture.home, old)?.lifecycle).toBe('retired');
    expect(findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })).not.toBeNull();
  });

  test('the seat handle the state minted is kept on the agent once, and never rewritten', () => {
    const fixture = makeFixture();
    const input = registryOf(fixture);
    const worker = input.team.seats.find((seat) => seat.name === 'worker')!;
    const id = (registerLaunch(input, worker, 'pane-1', 'seat_0123456789ab') as { id: string }).id;
    expect(getAgent(fixture.home, id)?.seat_handle).toBe('seat_0123456789ab');

    registerLaunch(input, worker, 'pane-2', 'seat_ba9876543210');
    expect(getAgent(fixture.home, id)?.seat_handle).toBe('seat_0123456789ab');

    // A handle that is not a seat handle is left out; the agent is still registered.
    const lead = input.team.seats.find((seat) => seat.name === 'lead')!;
    const other = (registerLaunch(input, lead, 'pane-3', 'seat_a') as { id: string }).id;
    expect(getAgent(fixture.home, other)?.seat_handle).toBeUndefined();
  });

  test('a seat the registry never knew is not written by a stop', () => {
    const fixture = makeFixture();
    expect(registerEnd(registryOf(fixture), 'worker', 'stopped')).toBeNull();
    expect(readAgents(fixture.home)).toEqual([]);
  });

  test('a run registers each ready seat, stops the seats the file stops or that are not ready, and stops the team when none runs', () => {
    const fixture = makeFixture();
    const input = registryOf(fixture);
    const seat = (name: string) => input.team.seats.find((item) => item.name === name)!;
    const teamId = teamIdOf(fixture.root);

    const notes = registerRun(input, [
      { seat: seat('lead'), pane: 'pane-lead' },
      { seat: seat('worker'), pane: 'pane-worker' },
      { seat: seat('parked-seat'), pane: null },
    ]);
    expect(notes).toEqual([]);
    expect(readAgents(fixture.home).map((agent) => agent.reach.seat).sort()).toEqual(['lead', 'worker']);
    expect(getTeam(fixture.home, teamId)?.roster.map((item) => item.seat).sort()).toEqual(['lead', 'worker']);

    registerRun(input, [
      { seat: seat('lead'), pane: null },
      { seat: seat('worker'), pane: null },
    ]);
    expect(readAgents(fixture.home).map((agent) => agent.lifecycle)).toEqual(['stopped', 'stopped']);
    expect(getTeam(fixture.home, teamId)?.lifecycle).toBe('stopped');
  });

  test('a registry that cannot be written is a note, never a throw', () => {
    const fixture = makeFixture();
    const input = registryOf(fixture);
    const worker = input.team.seats.find((seat) => seat.name === 'worker')!;
    // A file where the registry's folder must be.
    mkdirSync(join(fixture.home, '.config'), { recursive: true });
    writeFileSync(join(fixture.home, '.config', 'team'), 'not a folder');
    const made = registerLaunch(input, worker, 'pane-1');
    expect('note' in made && made.note.length > 0).toBe(true);
    expect(registerEnd(input, 'worker', 'stopped')).toBeNull();
  });
});

describe('the project a team leads, read through the launch', () => {
  /** The fixture's file, also naming the project it sits in and claiming its lead. */
  function leadFixture(): { fixture: Fixture; input: RegistryTeam } {
    const fixture = makeFixture();
    const yaml = TEAM_YAML
      .replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${fixture.root}\nworkspace:\n`)
      .replace('workspace:\n', 'in_project: TeamCLI\nproject_lead: true\nworkspace:\n');
    writeFileSync(fixture.file, yaml);
    const parsed = validateTeamFile(yaml, { home: fixture.home, root: fixture.root });
    if (!parsed.ok) throw new Error('lead fixture does not validate');
    return { fixture, input: { home: fixture.home, team: parsed.team, root: fixture.root, by: 'owner' } };
  }

  test("a launch writes the project's lead as the lead seat's agent", () => {
    const { fixture, input } = leadFixture();
    const lead = input.team.seats.find((seat) => seat.name === 'lead')!;
    const id = (registerLaunch(input, lead, 'pane-1') as { id: string }).id;
    expect(getProject(fixture.home, projectIdOf('TeamCLI'))).toMatchObject({
      name: 'TeamCLI',
      lead: id,
      teams: [teamIdOf(fixture.root)],
    });
  });

  test('a launch before the lead seat has launched leaves no lead, and the lead launch points it', () => {
    const { fixture, input } = leadFixture();
    const worker = input.team.seats.find((seat) => seat.name === 'worker')!;
    const lead = input.team.seats.find((seat) => seat.name === 'lead')!;
    registerLaunch(input, worker, 'pane-w');
    expect(getProject(fixture.home, projectIdOf('TeamCLI'))?.lead).toBeNull();
    const id = (registerLaunch(input, lead, 'pane-l') as { id: string }).id;
    expect(getProject(fixture.home, projectIdOf('TeamCLI'))?.lead).toBe(id);
  });

  test('the mark moving in the file re-points the lead on the next launch', () => {
    const { fixture, input } = leadFixture();
    const lead = input.team.seats.find((seat) => seat.name === 'lead')!;
    const worker = input.team.seats.find((seat) => seat.name === 'worker')!;
    const leadId = (registerLaunch(input, lead, 'pane-l') as { id: string }).id;
    const workerId = (registerLaunch(input, worker, 'pane-w') as { id: string }).id;
    expect(getProject(fixture.home, projectIdOf('TeamCLI'))?.lead).toBe(leadId);
    const moved = { ...input, team: { ...input.team, orchestrator: 'worker' } };
    registerLaunch(moved, worker, 'pane-w2');
    expect(getProject(fixture.home, projectIdOf('TeamCLI'))?.lead).toBe(workerId);
  });

  test('a file that leads no project writes no lead', () => {
    const fixture = makeFixture();
    const input = registryOf(fixture);
    const lead = input.team.seats.find((seat) => seat.name === 'lead')!;
    registerLaunch(input, lead, 'pane-1');
    expect(existsSync(projectsFile(fixture.home))).toBe(false);
  });
});

describe('team restart: the agent keeps its id and its address re-points', () => {
  test('acceptance (c): a restarted seat is the same agent on its new pane', async () => {
    const fixture = makeFixture();
    const input = registryOf(fixture);
    const worker = input.team.seats.find((seat) => seat.name === 'worker')!;
    const before = (registerLaunch(input, worker, 'pane-old') as { id: string }).id;
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
    });

    const { sources } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], io, sources)).toBe(0);
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');

    expect(readAgents(fixture.home)).toHaveLength(1);
    const after = getAgent(fixture.home, before)!;
    expect(after.lifecycle).toBe('running');
    expect(after.reach.pane).toBe('pane-new');
    expect(findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })?.id).toBe(before);
  });

  test('a restart of a seat the registry never knew registers it on the new pane', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const { sources } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], io, sources)).toBe(0);

    const agents = readAgents(fixture.home);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.reach).toMatchObject({ seat: 'worker', pane: 'pane-new', session: 'acme' });
    expect(agents[0]?.lifecycle).toBe('running');
    expect(getTeam(fixture.home, teamIdOf(fixture.root))?.roster).toEqual([
      { agent: agents[0]!.id, seat: 'worker', role: 'implementer' },
    ]);
  });
});

describe('the session the command launched in is the session the registry addresses', () => {
  test('a run under another session registers its agents and its team there', () => {
    const fixture = makeFixture();
    const input = { ...registryOf(fixture), session: 'alternate' };
    const lead = input.team.seats.find((seat) => seat.name === 'lead')!;
    const notes = registerRun(input, [{ seat: lead, pane: 'pane-lead' }]);
    expect(notes).toEqual([]);
    const agent = findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'lead' })!;
    expect(agent.reach.session).toBe('alternate');
    expect(getTeam(fixture.home, teamIdOf(fixture.root))?.session).toBe('alternate');
  });

  test('team restart --session names that session on the agent, not the file\'s', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.alternate ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const { sources } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker', '--session', 'alternate'], io, sources)).toBe(0);
    const agent = findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })!;
    expect(agent.reach).toMatchObject({ session: 'alternate', pane: 'pane-new' });
    expect(getTeam(fixture.home, teamIdOf(fixture.root))?.session).toBe('alternate');
  });
});

describe('team down ends the agents it stops', () => {
  const NAMES = ['lead', 'worker'] as const;

  function downSources(fixture: Fixture, opts: { running: boolean }): { sources: DownSources; closed: string[] } {
    const closed: string[] = [];
    const alive = new Set<string>(opts.running ? NAMES : []);
    const shelled = new Set<string>();
    const boxes = new Map<string, string>();
    const listed = (): HerdrAgent[] => NAMES.filter((name) => alive.has(name)).map((name) => ({
      name, agent: 'claude-code', pane: `pane-${name}`, workspace: `ws-${name}`, status: 'idle', cwd: fixture.root,
    }));
    const launch: DownLaunch = {
      typeText: (_session, pane, text) => { boxes.set(pane, claudeBox(text)); return true; },
      sendKey: () => true,
      pressEnter: (_session, pane) => { shelled.add(pane); return true; },
      agentPanes: () => listed().map((agent) => agent.pane),
      closeWorkspace(_session, workspace) {
        closed.push(workspace);
        alive.delete(workspace.replace('ws-', ''));
        return true;
      },
      stopSession: () => true,
      deleteSession: () => true,
      kill: () => true,
      sleep: async () => {},
      now: () => NOW,
    };
    const sources: DownSources = {
      home: fixture.home,
      sessionRunning: () => opts.running,
      agents: () => listed(),
      alive: () => true,
      screen: () => ({ kind: 'idle' }),
      screenText: (_session, pane) => boxes.get(pane) ?? claudeBox(''),
      status: () => 'idle',
      foreground: (_session, pane) => (shelled.has(pane) ? ['zsh'] : ['claude']),
      now: () => NOW,
      sleep: async () => {},
      launch,
    };
    return { sources, closed };
  }

  function registerBoth(fixture: Fixture, session?: string): { lead: string; worker: string } {
    const input = { ...registryOf(fixture), ...(session ? { session } : {}) };
    const seat = (name: string) => input.team.seats.find((item) => item.name === name)!;
    return {
      lead: (registerLaunch(input, seat('lead'), 'pane-lead') as { id: string }).id,
      worker: (registerLaunch(input, seat('worker'), 'pane-worker') as { id: string }).id,
    };
  }

  function seedState(fixture: Fixture): void {
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.launched_file = fixture.file;
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      session.seats.worker = { stage: 'ready', pane: 'pane-worker', workspace: 'ws-worker' };
    });
  }

  test('acceptance: after up, down leaves the team and its roster agents stopped, with no pane', async () => {
    const fixture = makeFixture();
    const ids = registerBoth(fixture);
    seedState(fixture);
    const { sources, closed } = downSources(fixture, { running: true });
    const io = testIo(fixture.root, { kind: 'owner' });
    const code = await runDown([], io, sources);
    expect({ code, err: io.err }).toEqual({ code: 0, err: '' });
    expect(io.out).toContain('worker: stopped');
    expect(closed.sort()).toEqual(['ws-lead', 'ws-worker']);

    expect(getTeam(fixture.home, teamIdOf(fixture.root))?.lifecycle).toBe('stopped');
    for (const id of [ids.lead, ids.worker]) {
      expect(getAgent(fixture.home, id)).toMatchObject({ lifecycle: 'stopped', reach: { pane: null } });
    }
    // The roster keeps both seats: the file still names them, and they come back as the same agents.
    expect(getTeam(fixture.home, teamIdOf(fixture.root))?.roster.map((item) => item.agent).sort()).toEqual([ids.lead, ids.worker].sort());
  });

  test('a session found already dead stops the agents that were launched in it, and only those', async () => {
    const fixture = makeFixture();
    const ids = registerBoth(fixture);
    const elsewhere = registerBoth(fixture, 'alternate');
    // Same seats, same team, launched in another session: `registerLaunch` found the live agent
    // and re-pointed it, so both sets are one pair of agents now living in `alternate`.
    expect(elsewhere).toEqual(ids);
    registerLaunch(registryOf(fixture), registryOf(fixture).team.seats.find((seat) => seat.name === 'lead')!, 'pane-lead');
    const { sources } = downSources(fixture, { running: false });
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runDown([], io, sources)).toBe(0);
    expect(io.out).toContain('is not running: nothing to stop');

    // `lead` is in the file's session again and is stopped; `worker` is in `alternate` and is left.
    expect(getAgent(fixture.home, ids.lead)).toMatchObject({ lifecycle: 'stopped', reach: { pane: null } });
    expect(getAgent(fixture.home, ids.worker)).toMatchObject({ lifecycle: 'running', reach: { session: 'alternate', pane: 'pane-worker' } });
  });

  test('a dry run, and a run given no home, end nothing', async () => {
    const fixture = makeFixture();
    const ids = registerBoth(fixture);
    seedState(fixture);
    const dry = downSources(fixture, { running: true });
    expect(await runDown(['--dry-run'], testIo(fixture.root, { kind: 'owner' }), dry.sources)).toBe(0);
    expect(getAgent(fixture.home, ids.lead)?.lifecycle).toBe('running');

    const idle = downSources(fixture, { running: false });
    const { home: _home, ...noHome } = idle.sources;
    expect(await runDown([], testIo(fixture.root, { kind: 'owner' }), noHome)).toBe(0);
    expect(getAgent(fixture.home, ids.lead)?.lifecycle).toBe('running');
    expect(getAgent(fixture.home, ids.worker)?.lifecycle).toBe('running');
  });
});

/** The fake host: one running worker in `pane-old`, a new pane made on relaunch. */
function makeHarness(fixture: Fixture): { sources: RestartSources } {
  let workerAlive = true;
  let boxedText = claudeBox('');
  let shelled = false;
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();
  let created = 0;

  const currentAgents = (): HerdrAgent[] => {
    const list: HerdrAgent[] = [
      { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: fixture.root },
      { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle', cwd: fixture.root },
    ];
    if (workerAlive) {
      list.push({ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle', cwd: fixture.root });
    }
    for (const [pane, slot] of newPanes) {
      if (slot.agent) {
        list.push({ name: slot.name, agent: 'claude-code', pane, workspace: slot.workspace, status: 'idle', cwd: fixture.root });
      }
    }
    return list;
  };

  const downLaunch: DownLaunch = {
    typeText(_session, _pane, text) {
      boxedText = claudeBox(text);
      return true;
    },
    sendKey: () => true,
    pressEnter() {
      shelled = true;
      return true;
    },
    agentPanes: () => currentAgents().map((a) => a.pane),
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
    createWorkspace() {
      created += 1;
      const pane = created === 1 ? 'pane-new' : `pane-new-${created}`;
      const workspace = created === 1 ? 'ws-new' : `ws-new-${created}`;
      newPanes.set(pane, { text: IDLE, agent: false, name: null, workspace });
      return { pane, workspace };
    },
    paneRun(_session, pane) {
      const slot = newPanes.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = newPanes.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace: downLaunch.closeWorkspace,
    agentPanes: () => currentAgents().map((a) => a.pane),
    agents: () => currentAgents(),
    paneText: (_session, pane) => newPanes.get(pane)?.text ?? IDLE,
    foreground: () => ['claude'],
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
    home: fixture.home,
  };

  const sources: RestartSources = {
    home: fixture.home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => currentAgents(),
    workspaces: () => currentAgents().map((a) => ({ id: a.workspace })),
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: () => boxedText,
    status: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : ['claude']),
    now: () => NOW,
    sleep: async () => {},
    launch: downLaunch,
    upLaunch,
    doctor,
  };
  return { sources };
}
