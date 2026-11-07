// Independent coverage of context-reset slices 2 and 4 at 343efa451.
// Slice 2: only the owner or a placed leads seat records a checkpoint ask; the entity's main
// orchestrator may, from its own placed session; a non-orchestrator seat of the other team may
// not. A wildcard grant reaches the new command, and team check names that grant with the note
// for the ops a later release actually shipped.
// Slice 4: --resume pins this seat's own conversation in this checkout's store. A foreign seat,
// terminal-host session, CLI, or checkout is refused before any stop, and so is a store that
// cannot be read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { generalDoor } from '../src/client/general-door.ts';
import {
  GENERAL_OPS,
  OP_FIRST_SHIPPED,
  generalGrantPath,
  issueOwnerGeneralGrant,
} from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { runCheckpoint } from '../src/commands/checkpoint.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { beginSession, endSession } from '../src/sessions/registry.ts';
import { installKey } from '../src/store/keys.ts';
import { approvalStanding, storePath } from '../src/store/store.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, claudeBox, deliverBriefs, fixtureBase, gitEnv, notesOtherThanSocket, testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const EARLIER = new Date('2026-11-04T10:00:00.000Z');
const MIDDLE = new Date('2026-11-04T11:00:00.000Z');
const DEADLINE = '2026-11-04T12:30:00.000Z';
const SIGNED = '2026-10-27T12:00:00Z';
const EXPIRES = new Date('2027-01-01T00:00:00.000Z');
const OWNER: Caller = { kind: 'owner' };

const owned: string[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const path of owned.splice(0)) discardFixtures([path], { roots });
  roots.length = 0;
});

function temp(prefix: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  owned.push(base);
  return base;
}

/** A client key is refused under the OS temp directory, so a world that holds one lives in the suite scratch root. */
function scratch(prefix: string): string {
  const base = fixtureBase(prefix);
  owned.push(base);
  roots.push(dirname(base));
  return base;
}

function gitInit(root: string): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
}

const TEAM = (root: string): string => `format: 1
project: alpha
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
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

  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

type CheckpointWorld = { base: string; root: string; home: string; dir: string };

function checkpointWorld(base = temp('checkpoint-s2-')): CheckpointWorld {
  const root = join(base, 'alpha');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  gitInit(root);
  writeFileSync(join(dir, 'team.yaml'), TEAM(root));
  updateState(dir, (state) => {
    state.sessions.alpha = {
      ...emptySession(),
      seats: {
        lead: { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead', cli: 'claude-code' },
        worker: { stage: 'ready', pane: 'pane-work', workspace: 'ws-work', cli: 'claude-code' },
      },
    };
  });
  return { base, root, home, dir };
}

function placeEntity(world: CheckpointWorld): void {
  const head = join(world.base, 'corp');
  const headDir = join(head, '.agents');
  mkdirSync(headDir, { recursive: true });
  gitInit(head);
  writeFileSync(
    join(world.dir, 'team.yaml'),
    TEAM(world.root)
      .replace('project: alpha\n', 'project: alpha\nentity: corp\n')
      .replace('  - ~/.config/team/lobby\n', '  - ~/.config/team/lobby\n  - ~/.config/team/lobbies/corp\n'),
  );
  writeFileSync(
    join(headDir, 'team.yaml'),
    `format: 1
project: corp
entity: corp
coordinator: orchestrator
operator: orchestrator
trust:
  - ~/.config/team/lobby
  - ~/.config/team/lobbies/corp
  - ${head}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: orchestrator
    label: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true

  - role: implementer
    name: helper
    label: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`,
  );
  updateState(headDir, (state) => {
    state.sessions.corp = {
      ...emptySession(),
      seats: {
        orchestrator: { stage: 'ready', pane: 'pane-corp-orch', workspace: 'ws-corp-orch', cli: 'claude-code' },
        helper: { stage: 'ready', pane: 'pane-corp-helper', workspace: 'ws-corp-helper', cli: 'claude-code' },
      },
    };
  });
  upsertTeam(world.home, teamIdOf(world.root), {
    project: 'alpha',
    entity: 'corp',
    session: 'alpha',
    root: world.root,
    at: NOW.toISOString(),
  });
  upsertTeam(world.home, teamIdOf(head), {
    project: 'corp',
    entity: 'corp',
    session: 'corp',
    root: head,
    at: NOW.toISOString(),
  });
}

function ioFor(cwd: string, caller: Caller, home: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      env: { HOME: home },
      stdinIsTTY: caller.kind === 'owner',
      caller,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
    out: () => stdout.join(''),
    err: () => stderr.join(''),
  };
}

describe('team checkpoint', () => {
  test('the owner may record an ask, and a seat that is not leads may not', async () => {
    const world = checkpointWorld();
    const owner = ioFor(world.root, OWNER, world.home);
    expect(await runCheckpoint(['worker'], owner.io, { home: world.home, now: () => NOW })).toBe(0);
    const record = readState(world.dir).checkpoints?.worker;
    expect(record?.by).toBe('owner');
    expect(record?.session).toBe('alpha');
    expect(record?.deadline).toBe(DEADLINE);
    expect(record?.path).toContain(`${join('handovers', 'worker-')}`);
    expect(existsSync(record?.path ?? '')).toBe(false);
    expect(owner.out()).toContain(`team checkpoint: recorded worker -> ${record?.path}`);
    expect(owner.err()).toBe('');

    const worker = ioFor(world.root, { kind: 'seat', session: 'alpha', name: 'worker', pane: 'pane-work' }, world.home);
    expect(await runCheckpoint(['worker', '--json'], worker.io, { home: world.home, now: () => NOW })).toBe(1);
    const refused = JSON.parse(worker.out()) as { error: { id: string; rule?: string; message: string } };
    expect(refused.error.id).toBe('checkpoint.caller');
    expect(refused.error.rule).toBe('owner-or-leads');
    expect(refused.error.message).toContain('this call is worker');
    expect(readState(world.dir).checkpoints?.worker?.by).toBe('owner');
  });

  test('a placed leads seat of this team records the ask', async () => {
    const world = checkpointWorld();
    const lead = ioFor(world.root, { kind: 'seat', session: 'alpha', name: 'lead', pane: 'pane-lead' }, world.home);
    expect(await runCheckpoint(['worker'], lead.io, { home: world.home, now: () => NOW })).toBe(0);
    expect(readState(world.dir).checkpoints?.worker?.by).toBe('lead');
    expect(lead.err()).toBe('');
  });

  test('the entity main orchestrator records from its own placed session, and another seat of that team is refused', async () => {
    const world = checkpointWorld();
    placeEntity(world);
    const orchestrator = ioFor(
      world.root,
      { kind: 'seat', session: 'corp', name: 'orchestrator', pane: 'pane-corp-orch' },
      world.home,
    );
    const orchestratorCode = await runCheckpoint(['worker', '--json'], orchestrator.io, { home: world.home, now: () => NOW });
    const recorded = orchestratorCode === 0 ? (JSON.parse(orchestrator.out()) as { status: string; by: string; seat: string }) : null;
    expect({ code: orchestratorCode, err: orchestrator.err(), status: recorded?.status ?? orchestrator.out() }).toEqual({
      code: 0,
      err: '',
      status: 'recorded',
    });
    expect(recorded).toMatchObject({ by: 'orchestrator', seat: 'worker' });
    expect(readState(world.dir).checkpoints?.worker?.by).toBe('orchestrator');

    const helper = ioFor(
      world.root,
      { kind: 'seat', session: 'corp', name: 'helper', pane: 'pane-corp-helper' },
      world.home,
    );
    expect(await runCheckpoint(['lead', '--json'], helper.io, { home: world.home, now: () => NOW })).toBe(1);
    const refused = JSON.parse(helper.out()) as { error: { id: string; rule?: string; message: string } };
    expect(refused.error.id).toBe('checkpoint.caller');
    expect(refused.error.rule).toBe('owner-or-leads');
    expect(refused.error.message).toContain('this call is helper');
    expect(readState(world.dir).checkpoints?.lead).toBeUndefined();
    expect(readState(world.dir).checkpoints?.worker?.by).toBe('orchestrator');
  });

  test('a wildcard grant reaches checkpoint, and team check names the grant with the note for ops a later release shipped', async () => {
    const world = checkpointWorld(scratch('checkpoint-grant-'));
    installKey(world.home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
    const pair = newClientKeyPair();
    const written = writeClientKeyFiles(join(world.home, '.config', 'team-client', 'holder'), pair);
    if (!written.ok) throw new Error(written.why);
    const issued = issueOwnerGeneralGrant(
      world.home,
      { clientId: 'holder', publicKey: pair.publicKey, entities: ['*'], ops: ['*'], mayIssue: false, expires: EXPIRES },
      new Date(SIGNED),
    );
    if (!issued.ok) throw new Error(issued.why);
    const shipped = GENERAL_OPS.filter((op) => {
      const release = OP_FIRST_SHIPPED[op];
      return release !== null && Date.parse(release.at) > Date.parse(SIGNED);
    });
    expect(shipped).toContain('checkpoint');

    const caller = ioFor(world.root, { kind: 'seat', session: 'alpha', name: 'worker', pane: 'pane-work' }, world.home);
    caller.io.stdinIsTTY = true;
    const door = generalDoor(
      'checkpoint',
      ['worker', '--general', generalGrantPath(world.home, issued.grant.grant_id), '--key', written.keyPath],
      caller.io,
      NOW,
    );
    expect(door.kind === 'admitted' ? 'admitted' : door).toBe('admitted');
    if (door.kind !== 'admitted') return;
    expect(await runCheckpoint(door.argv, door.io, { home: world.home, now: () => NOW })).toBe(0);
    expect(readState(world.dir).checkpoints?.worker?.by).toBe('owner');

    const checkRoot = join(world.base, 'noted');
    const checkDir = join(checkRoot, '.agents');
    mkdirSync(checkDir, { recursive: true });
    gitInit(checkRoot);
    const noted = `format: 1
project: acme
operator: steward
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: steward
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
`;
    writeFileSync(join(checkDir, 'team.yaml'), noted);
    const parsed = validateTeamFile(noted);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    updateState(checkDir, (state) => {
      const session = (state.sessions[parsed.team.session] ??= emptySession());
      session.watch = { pid: 1, heartbeat: NOW.toISOString() };
      session.seats.steward = { stage: 'ready', pane: 'pane1', workspace: 'space1' };
    });
    deliverBriefs({
      dir: checkDir,
      root: checkRoot,
      session: parsed.team.session,
      seats: ['steward'],
      home: world.home,
      at: NOW.toISOString(),
    });
    const live = (): Live => ({
      running: true,
      agents: parsed.team.seats.map((seat, index) => ({
        name: seat.name,
        agent: 'claude',
        pane: `pane${index + 1}`,
        workspace: `space${index + 1}`,
        status: 'idle',
        cwd: null,
        displayAgent: displayAgent(seat),
      })),
      workspaces: parsed.team.seats.map((seat, index) => ({ id: `space${index + 1}`, label: workspaceLabel(seat) })),
      screens: { pane1: CLAUDE_IDLE },
    });
    const check = testIo(checkRoot, OWNER);
    check.env = { HOME: world.home };
    const code = runTeamCheck({ file: '.agents/team.yaml' }, check, {
      home: world.home,
      live,
      branch: () => 'main',
      standing: (at) => approvalStanding(at, join(checkRoot, 'nowhere')),
      now: () => NOW,
    });
    expect(code).toBe(0);
    const note = notesOtherThanSocket(`${check.out}${check.err}`).find((line) => line.includes('wildcard general grant'));
    expect(note).toBe(
      `note: wildcard general grant ${issued.grant.grant_id} signed 2026-10-27 now reaches ${shipped.join(', ')}, which shipped in later releases; re-sign the grant to stop this note`,
    );
    expect(note).toContain('checkpoint');
  });
});

const RESTART = (root: string): string => `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
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

  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

type RestartWorld = ReturnType<typeof restartWorld>;

function restartWorld() {
  const base = temp('resume-s4-');
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  gitInit(root);
  const text = RESTART(root);
  writeFileSync(join(dir, 'team.yaml'), text);
  const parsed = validateTeamFile(text, { home, root });
  if (!parsed.ok) throw new Error('restart fixture does not validate');
  const team = parsed.team;
  const worker = team.seats.find((seat) => seat.name === 'worker');
  const lead = team.seats.find((seat) => seat.name === 'lead');
  if (worker === undefined || lead === undefined) throw new Error('fixture seats missing');
  updateState(dir, (state) => {
    state.sessions.acme = {
      ...emptySession(),
      seats: {
        lead: { id: 'seat_000000000001', stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead', cli: 'claude-code' },
        worker: {
          id: 'seat_000000000002',
          stage: 'ready',
          pane: 'pane-old',
          workspace: 'ws-old',
          cli: 'claude-code',
          agent_session: 'sess-latest',
        },
      },
    };
  });
  beginSession({ home, root, team, session: 'acme', seat: worker, pane: 'pane-first', workspace: 'ws-first', cli_session: 'sess-earlier', now: EARLIER });
  endSession({ home, root, team, session: 'acme', seat: 'worker', reason: 'restart', now: MIDDLE });
  beginSession({ home, root, team, session: 'acme', seat: worker, pane: 'pane-old', workspace: 'ws-old', cli_session: 'sess-latest', now: MIDDLE });
  beginSession({ home, root, team, session: 'acme', seat: lead, pane: 'pane-lead', workspace: 'ws-lead', cli_session: 'sess-lead-only', now: EARLIER });
  registerAgent(home, {
    name: 'worker',
    seat_handle: 'seat_000000000002',
    cli: 'claude-code',
    lab: 'anthropic',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { session: 'acme', pane: 'pane-old', team: teamIdOf(root), seat: 'worker', address: null, agent_session: 'sess-latest' },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });
  return { base, root, home, dir, team, worker };
}

function restartHarness(world: RestartWorld) {
  const ran: { pane: string; command: string }[] = [];
  const closed: string[] = [];
  let workerAlive = true;
  const boxes = new Map<string, string>();
  const shelled = new Set<string>();
  const created = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();
  const agents = (): HerdrAgent[] => [
    ...(workerAlive
      ? [{ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle' as const, cwd: world.root, session: 'sess-latest' }]
      : []),
    { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle' as const, cwd: world.root, session: 'sess-lead-only' },
    ...[...created.entries()].filter(([, slot]) => slot.agent).map(([pane, slot]) => ({
      // A blank herdr name is null. An empty string is another seat's name.
      name: slot.name,
      agent: 'claude-code',
      pane,
      workspace: slot.workspace,
      status: 'idle' as const,
      cwd: world.root,
    })),
  ];
  const closeWorkspace = (_session: string, workspace: string): boolean => {
    closed.push(workspace);
    if (workspace === 'ws-old') workerAlive = false;
    return true;
  };
  const down: DownLaunch = {
    typeText(_session, pane, text) { boxes.set(pane, claudeBox(text)); return true; },
    sendKey: () => true,
    pressEnter(_session, pane) { shelled.add(pane); return true; },
    agentPanes: () => agents().map((agent) => agent.pane),
    closeWorkspace,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };
  const up: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      created.set('pane-new', { text: CLAUDE_IDLE, agent: false, name: null, workspace: 'ws-new' });
      return { pane: 'pane-new', workspace: 'ws-new' };
    },
    paneRun(_session, pane, command) {
      ran.push({ pane, command });
      const slot = created.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = created.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace,
    agentPanes: () => agents().map((agent) => agent.pane),
    agents: () => agents(),
    paneText: (_session, pane) => created.get(pane)?.text ?? CLAUDE_IDLE,
    typeText: () => true,
    pressEnter(_session, pane) {
      const slot = created.get(pane);
      if (slot) slot.text = CLAUDE_IDLE;
      return true;
    },
    agentStatus: () => 'idle',
    foreground: (_session, pane) => (shelled.has(pane) ? ['zsh'] : ['claude']),
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
    home: world.home,
  };
  const sources: RestartSources = {
    home: world.home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => agents(),
    workspaces: () => agents().map((agent) => ({ id: agent.workspace })),
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: (_session, pane) => boxes.get(pane) ?? claudeBox(''),
    status: () => 'idle',
    foreground: (_session, pane) => (shelled.has(pane) ? ['zsh'] : ['claude']),
    now: () => NOW,
    sleep: async () => {},
    launch: down,
    upLaunch: up,
    doctor,
  };
  return { sources, ran, closed };
}

const LEAD: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };

describe('team restart --resume', () => {
  test("pins this seat's own earlier conversation in this checkout's store", async () => {
    const world = restartWorld();
    const harness = restartHarness(world);
    const io = testIo(world.root, LEAD);
    expect(await runRestart(['worker', '--resume', 'sess-earlier'], io, harness.sources)).toBe(0);
    expect(io.err).toBe('');
    expect(harness.ran.map((run) => run.command).join('\n')).toContain('--resume sess-earlier');
    expect(harness.ran.map((run) => run.command).join('\n')).not.toContain('sess-latest');
    expect(harness.closed).toEqual(['ws-old']);
  });

  test('a foreign seat, terminal-host session, CLI, or checkout is refused before any stop', async () => {
    const world = restartWorld();
    const other = join(world.base, 'acme-checkout-2');
    mkdirSync(other, { recursive: true });
    beginSession({
      home: world.home,
      root: world.root,
      team: world.team,
      session: 'other-host',
      seat: world.worker,
      pane: 'pane-other',
      workspace: 'ws-other',
      cli_session: 'sess-other-host',
      now: EARLIER,
    });
    beginSession({
      home: world.home,
      root: world.root,
      team: world.team,
      session: 'acme',
      seat: { ...world.worker, cli: 'codex', vendor: 'openai' },
      pane: 'pane-codex',
      workspace: 'ws-codex',
      cli_session: 'sess-other-cli',
      now: EARLIER,
    });
    beginSession({
      home: world.home,
      root: other,
      team: world.team,
      session: 'acme',
      seat: world.worker,
      pane: 'pane-second',
      workspace: 'ws-second',
      cli_session: 'sess-other-checkout',
      now: EARLIER,
    });
    const harness = restartHarness(world);
    const cases: [string, string][] = [
      ['sess-lead-only', 'belongs to seat lead'],
      ['sess-other-host', 'other-host'],
      ['sess-other-cli', 'ran codex, the seat now declares claude-code'],
      ['sess-other-checkout', 'is not a recorded session of worker'],
    ];
    for (const [id, words] of cases) {
      const io = testIo(world.root, LEAD);
      expect(await runRestart(['worker', '--resume', id], io, harness.sources)).toBe(1);
      expect(io.err).toContain(words);
      expect(harness.closed).toEqual([]);
      expect(harness.ran).toEqual([]);
    }
  });

  test('an unreadable store is refused before any stop', async () => {
    const world = restartWorld();
    const sessions = join(storePath('acme', world.root, world.home), 'sessions.jsonl');
    discardFixtures([sessions]);
    mkdirSync(sessions, { recursive: true });
    const harness = restartHarness(world);
    const io = testIo(world.root, LEAD);
    expect(await runRestart(['worker', '--resume', 'sess-earlier', '--json'], io, harness.sources)).toBe(1);
    expect(harness.closed).toEqual([]);
    expect(harness.ran).toEqual([]);
    const doc = JSON.parse(io.out) as { error: { id: string; message: string } };
    expect(doc.error.id).toBe('restart.not-ready');
    expect(doc.error.message).toContain('the session registry path is a directory');
  });
});
