// Independent coverage of the declared-seat roster fix at 24e3b976a.
// A registry seat is on the roster before its first launch registers an inbox; a name that
// belongs to another team is not given a line; a team-file launch still registers from the
// file. A second up keeps one line and the same agent. Adding a seat the registry record
// does not declare names that record and offers --like. Restart revives a stopped seat
// written as a flow mapping, a bare dash, or a same-indent list: the dry run and the real
// run launch the same command, and every field of the seat survives.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { registerInbox } from '../src/mcp/register.ts';
import { findAgent } from '../src/registry/agents.ts';
import { ensureSeatLine } from '../src/registry/sync.ts';
import { getTeam, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, gitEnv, testIo, recordRenames } from './helpers.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { intoRegistry, storedTeam, underRegistry } from './helpers/registry-team.ts';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const SESSION = 'acme';
const CURSOR_IDLE = readFileSync(new URL('./fixtures/cursor/2026.10.22/idle.txt', import.meta.url), 'utf8');
const OWNER: Caller = { kind: 'owner' };

const kept = {
  role: 'implementer',
  name: 'parked',
  label: 'kept-label',
  cli: 'claude-code',
  vendor: 'anthropic',
  model: 'Claude Opus',
  version: '5.5',
  launch: 'claude --model claude-opus-5-5',
} as const;

let bases: string[] = [];

afterEach(() => {
  discardFixtures(bases, { roots: [tmpdir()] });
  bases = [];
});

function scratch(prefix: string): { base: string; root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  bases.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  return { base, root, home };
}

function withTrust(text: string, root: string): string {
  return text.replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:\n`);
}

function rosterSeats(home: string, root: string): string[] {
  return (getTeam(home, teamIdOf(root))?.roster ?? []).map((line) => line.seat);
}

type Registered = { file?: string; roster: string[] };

function cursorWorld(home: string, root: string): {
  launch: Launch;
  runs: string[];
  registered: Registered[];
  session: 'absent' | 'running';
} {
  const runs: string[] = [];
  const registered: Registered[] = [];
  const panes = new Map<string, { text: string; front: string[] }>();
  let n = 0;
  let session: 'absent' | 'running' = 'absent';
  const world = {
    launch: {} as Launch,
    runs,
    registered,
    get session() {
      return session;
    },
    set session(next: 'absent' | 'running') {
      session = next;
    },
  };
  world.launch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace() {
      n += 1;
      const pane = `pane${String(n)}`;
      panes.set(pane, { text: CURSOR_IDLE, front: [] });
      return { pane, workspace: `space${String(n)}` };
    },
    paneRun(_session, pane, command) {
      const roster = rosterSeats(home, root);
      runs.push(`${roster.join(',')}|${command}`);
      const held = panes.get(pane);
      if (held && /(?:^|\s)cursor-agent\b/.test(command)) held.front = ['cursor-agent'];
      return true;
    },
    registerInbox(cli, seat, cwd, launchSession, teamFile) {
      registered.push({ ...(teamFile === undefined ? {} : { file: teamFile }), roster: rosterSeats(home, root) });
      return registerInbox({
        cli,
        seat,
        cwd,
        session: launchSession,
        home,
        ...(teamFile === undefined ? {} : { file: teamFile }),
        run: () => ({ code: 0 }),
      });
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.front.length > 0).map(([id]) => id),
    agents: () => [],
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: (_session, pane) => panes.get(pane)?.front ?? [],
    sleep: async () => {},
    now: () => NOW,
  };

  recordRenames(world.launch);
  return world;
}

function upSources(home: string, world: ReturnType<typeof cursorWorld>): UpSources {
  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => world.session === 'running',
    now: () => NOW,
    home,
  };
  return {
    sessionRunning: () => world.session === 'running',
    sessionState: () => world.session,
    agents: () => world.launch.agents(SESSION),
    home,
    now: () => world.launch.now(),
    sleep: world.launch.sleep,
    alive: () => true,
    doctor,
    launch: world.launch,
  };
}

function registryTeam(root: string, home: string, seats: readonly string[]): void {
  const blocks = seats.map((name) => name === 'lead'
    ? `  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Claude Opus
    version: "5.5"
    launch: claude
    human: true
`
    : `  - role: worker
    name: ${name}
    cli: cursor
    vendor: test
    model: Gemini Argon
    version: "4"
    launch: cursor-agent --model gemini-4-argon-high
`).join('');
  const text = withTrust(`format: 1
project: acme
coordinator: ${seats[0]}
operator: ${seats[0]}
session: acme
workspace:
  mode: shared
seats:
${blocks}`, root);
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  intoRegistry(root, home);
  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    session: SESSION,
    root,
    roster: [],
  });
}

function approveRegistry(root: string, home: string): void {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const stored = storedTeam(root, home);
  if (stored === null) throw new Error('the team is not in the registry');
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: stored.text },
    loaded.team.seats,
    home,
    NOW,
  );
}

function seatFields(text: string, name: string) {
  const validated = validateTeamFile(text);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  const seat = validated.team.seats.find((item) => item.name === name);
  if (seat === undefined) throw new Error(`${name} is not in the record`);
  return {
    role: seat.role,
    name: seat.name,
    label: seat.label,
    cli: seat.cli,
    vendor: seat.vendor,
    model: seat.model,
    version: seat.version,
    launch: seat.launch,
    stopped: seat.stopped === true,
  };
}

function restartYaml(shape: 'flow' | 'dash' | 'indent'): string {
  const header = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
`;
  if (shape === 'flow') {
    return `${header}seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - { role: implementer, name: parked, label: kept-label, cli: claude-code, vendor: anthropic, model: Claude Opus, version: "5.5", launch: claude --model claude-opus-5-5, stopped: true }
`;
  }
  const parked = shape === 'dash'
    ? `  -
    role: implementer
    name: parked
    label: kept-label
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`
    : `- role: implementer
  name: parked
  label: kept-label
  cli: claude-code
  vendor: anthropic
  model: Claude Opus
  version: "5.5"
  launch: claude --model claude-opus-5-5
  stopped: true
`;
  const lead = shape === 'indent'
    ? `- role: coordinator
  name: lead
  label: lead
  cli: claude-code
  vendor: anthropic
  model: Claude Opus
  version: "5.5"
  launch: claude --model claude-opus-5-5
`
    : `  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
  return `${header}seats:\n${lead}${parked}`;
}

function restartHarness(home: string): { sources: RestartSources; runs: string[]; created: { n: number } } {
  const runs: string[] = [];
  const created = { n: 0 };
  const panes = new Map<string, string>();
  const down: DownLaunch = {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => ['pane-lead'],
    closeWorkspace: () => true,
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
      created.n += 1;
      const pane = 'pane-new';
      panes.set(pane, CLAUDE_IDLE);
      return { pane, workspace: 'ws-new' };
    },
    paneRun(_session, _pane, command) {
      runs.push(command);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => ['pane-lead', ...panes.keys()],
    agents: () => [{ name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: null }],
    paneText: (_session, pane) => panes.get(pane) ?? CLAUDE_IDLE,
    pressEnter: () => true,
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
  const sources: RestartSources = {
    home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => upLaunch.agents(SESSION),
    workspaces: () => [{ id: 'ws-lead' }],
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: () => CLAUDE_IDLE,
    status: () => 'idle',
    foreground: () => ['claude'],
    now: () => NOW,
    sleep: async () => {},
    launch: down,
    upLaunch,
    doctor: {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => true,
      now: () => NOW,
      home,
    },
  };
  return { sources, runs, created };
}

describe('declared-seat roster', () => {
  test('a declared registry seat is rostered before its inbox registers, a foreign name is not, and a second up keeps the one line', async () => {
    const { root, home, base } = scratch('roster-');
    const otherRoot = join(base, 'other');
    mkdirSync(join(otherRoot, '.agents'), { recursive: true });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
      cwd: otherRoot,
      env: gitEnv(),
    });
    await underRegistry(async () => {
      registryTeam(root, home, ['lead', 'helper']);
      approveRegistry(root, home);
      expect(rosterSeats(home, root)).toEqual([]);

      const world = cursorWorld(home, root);
      const io = testIo(root, OWNER);
      expect(await runUp([], io, upSources(home, world)), io.out + io.err).toBe(0);
      expect(world.registered.length).toBeGreaterThan(0);
      expect(world.registered[0]?.file).toBeUndefined();
      expect(world.registered[0]?.roster).toEqual(['helper']);
      const launch = world.runs.find((line) => line.includes('cursor-agent'));
      expect(launch?.startsWith('helper|')).toBe(true);
      const agentId = findAgent(home, { team: teamIdOf(root), seat: 'helper' })?.id;
      expect(agentId).toBeDefined();
      if (agentId === undefined) throw new Error('the declared seat has no agent id');
      expect(getTeam(home, teamIdOf(root))?.roster).toEqual([{ agent: agentId, seat: 'helper', role: 'worker' }]);

      const again = cursorWorld(home, root);
      again.session = 'running';
      again.launch.agents = () => {
        const held = readState(join(root, '.agents')).sessions[SESSION]?.seats.helper;
        return [{ name: 'helper', agent: 'cursor', pane: held?.pane ?? 'pane1', workspace: held?.workspace ?? 'space1', status: 'idle', cwd: null }];
      };
      updateState(join(root, '.agents'), (state) => {
        const session = (state.sessions[SESSION] ??= emptySession());
        session.watch = { pid: 4242, heartbeat: NOW.toISOString() } as never;
      });
      const second = testIo(root, OWNER);
      expect(await runUp([], second, upSources(home, again)), second.out + second.err).toBe(0);
      expect(rosterSeats(home, root)).toEqual(['helper']);
      expect(findAgent(home, { team: teamIdOf(root), seat: 'helper' })?.id).toBe(agentId);

      registryTeam(otherRoot, home, ['stranger']);
      upsertTeam(home, teamIdOf(otherRoot), {
        project: 'acme',
        session: 'other',
        root: otherRoot,
        roster: [{ agent: 'agt_stranger0001', seat: 'stranger', role: 'worker' }],
      });
      const otherBefore = getTeam(home, teamIdOf(otherRoot))?.roster ?? [];
      const loaded = loadTeamFile(root, { home });
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
      const refused = ensureSeatLine({ home, team: loaded.team, root, by: 'the test' }, { name: 'stranger' });
      expect(refused).toEqual({ note: 'registry not written: the team does not declare seat "stranger"' });
      expect(rosterSeats(home, root)).toEqual(['helper']);
      expect(findAgent(home, { team: teamIdOf(root), seat: 'stranger' })).toBeNull();
      expect(getTeam(home, teamIdOf(otherRoot))?.roster).toEqual(otherBefore);
    });
  });

  test('a team-file launch registers from the file, with no roster line ahead of the inbox', async () => {
    const { root, home } = scratch('file-launch-');
    const text = withTrust(`format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Claude Opus
    version: "5.5"
    launch: claude
    human: true
  - role: worker
    name: helper
    cli: cursor
    vendor: test
    model: Gemini Argon
    version: "4"
    launch: cursor-agent --model gemini-4-argon-high
`, root);
    writeFileSync(join(root, '.agents', 'team.yaml'), text);
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    writeApproval(
      storePath(loaded.team.project, loaded.root, home),
      { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
      loaded.team.seats,
      home,
      NOW,
    );
    const world = cursorWorld(home, root);
    const io = testIo(root, OWNER);
    expect(await runUp(['--file', '.agents/team.yaml'], io, upSources(home, world)), io.out + io.err).toBe(0);
    expect(world.registered[0]?.file).toBe(join(root, '.agents', 'team.yaml'));
    expect(world.registered[0]?.roster).toEqual([]);
    expect(world.runs.some((line) => line.startsWith('|') && line.includes('cursor-agent'))).toBe(true);
  });

  test('adding a seat a registry team does not declare names the record and suggests --like', async () => {
    const { root, home } = scratch('add-missing-');
    const text = withTrust(`format: 1
project: acme
coordinator: lead
operator: lead
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
`, root);
    writeFileSync(join(root, '.agents', 'team.yaml'), text);
    const loaded = loadTeamFile(root, { home, file: join(root, '.agents', 'team.yaml') });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    writeApproval(
      storePath(loaded.team.project, loaded.root, home),
      { approval: approvalOf(loaded.team, loaded.root, NOW), file: readFileSync(join(root, '.agents', 'team.yaml'), 'utf8') },
      loaded.team.seats,
      home,
      NOW,
    );
    await underRegistry(async () => {
      intoRegistry(root, home);
      const sources: AddSources = {
        home,
        sessionState: () => 'absent',
        agents: () => [],
        workspaces: () => [],
        now: () => NOW,
        doctor: {
          version: () => '2.1.288',
          onPath: () => true,
          loggedIn: () => true,
          herdrVersion: () => '0.7.1',
          sessionRunning: () => false,
          now: () => NOW,
          home,
        },
        launch: {
          sessionState: () => 'absent',
          startServer: () => false,
          sessionUp: () => false,
          createWorkspace: () => null,
          paneRun: () => false,
          renameAgent: () => false,
          closeWorkspace: () => false,
          agentPanes: () => [],
          agents: () => [],
          paneText: () => '',
          foreground: () => [],
          sleep: async () => {},
          now: () => NOW,
        },
      };
      const plain = testIo(root, OWNER);
      expect(await runAdd(['missing'], plain, sources)).not.toBe(0);
      expect(plain.err).toContain(`the registry's record has no seat "missing"`);
      const json = testIo(root, OWNER);
      expect(await runAdd(['missing', '--json'], json, sources)).not.toBe(0);
      const error = JSON.parse(json.out).error as { id: string; message: string; repair: string };
      expect(error.id).toBe('add.no-seat');
      expect(error.message).toBe(`the registry's record has no seat "missing"`);
      expect(error.repair).toBe('team add missing --like <seat>');
    });
  });

  test.each(['flow', 'dash', 'indent'] as const)('restart revives a stopped %s seat: the dry run and the real run agree, and every field survives', async (shape) => {
    const { root, home } = scratch(`restart-${shape}-`);
    const file = join(root, '.agents', 'team.yaml');
    writeFileSync(file, withTrust(restartYaml(shape), root));
    const before = seatFields(readFileSync(file, 'utf8'), 'parked');
    const leadBefore = seatFields(readFileSync(file, 'utf8'), 'lead');
    expect(before.stopped).toBe(true);
    updateState(join(root, '.agents'), (state) => {
      (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    });
    const { sources, runs, created } = restartHarness(home);
    const caller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const dry = testIo(root, caller);
    expect(await runRestart(['parked', '--dry-run'], dry, sources), dry.err).toBe(0);
    expect(dry.out).toContain('dry run: nothing was run\n');
    expect(created.n).toBe(0);
    expect(seatFields(readFileSync(file, 'utf8'), 'parked').stopped).toBe(true);

    const live = testIo(root, caller);
    expect(await runRestart(['parked'], live, sources), live.err).toBe(0);
    expect(live.out).toContain('team restart: restarted parked; pane none -> pane-new\n');
    expect(created.n).toBe(1);
    expect(runs).toHaveLength(1);
    expect(dry.out).toContain(kept.launch);
    expect(runs[0]).toContain(kept.launch);
    const after = seatFields(readFileSync(file, 'utf8'), 'parked');
    expect(after).toEqual({ ...kept, stopped: false });
    expect(seatFields(readFileSync(file, 'utf8'), 'lead')).toEqual(leadBefore);
    expect(readState(join(root, '.agents')).sessions.acme?.seats.parked?.stage).toBe('ready');
  });
});
