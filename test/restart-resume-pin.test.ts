import { registerDefaultChannelFixture } from './helpers/default-channel.ts';
// The R4 resume pin (`team restart <seat> --resume <cli-session-id>`): pins which recorded
// conversation of the seat to resume instead of the latest, verified against the seat's own
// team-owned records (`recordedSeatSession` and the session registry), refused for a foreign or
// unbound id, and refused beside `--fresh` or `--abandon`.
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { beginSession, endSession } from '../src/sessions/registry.ts';
import { storePath } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import { handoverPath } from '../src/handover/paths.ts';
import { runSelfRestarts, selfRestartPath } from '../src/launch/self-restart.ts';
import type { UpSources } from '../src/commands/up.ts';
import { existsSync } from 'node:fs';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';
import { assertJsonErrorShape } from './helpers/output.ts';

const NOW = new Date('2026-11-04T12:00:00Z');
const EARLIER = new Date('2026-11-04T10:00:00Z');
const MIDDLE = new Date('2026-11-04T11:00:00Z');

const YAML = (root: string): string => `format: 1
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

type Fixture = { root: string; home: string; dir: string; file: string; team: TeamFile };

const owned: string[] = [];
afterEach(() => {
  for (const path of owned.splice(0)) discardFixtures([path]);
});

function makeFixture(yaml: (root: string) => string = YAML): Fixture {
  const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'restart-resume-pin-')));
  owned.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  const file = join(dir, 'team.yaml');
  writeFileSync(file, yaml(root));
  const parsed = validateTeamFile(yaml(root), { home, root });
  if (!parsed.ok) throw new Error(`fixture team does not validate: ${JSON.stringify(parsed.errors)}`);
  return { root, home, dir, file, team: parsed.team };
}

function seedSeatWithSessions(fixture: Fixture, agentLaunch = 'claude --model claude-opus-5-5'): void {
  const workerSeat = fixture.team.seats.find((s) => s.name === 'worker')!;
  const leadSeat = fixture.team.seats.find((s) => s.name === 'lead')!;

  updateState(fixture.dir, (state) => {
    state.sessions.acme = {
      ...emptySession(),
      seats: {
        lead: {
          id: 'seat_000000000001',
          stage: 'ready',
          pane: 'pane-lead',
          workspace: 'ws-lead',
          cli: 'claude-code',
        },
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

  beginSession({
    home: fixture.home,
    root: fixture.root,
    team: fixture.team,
    session: 'acme',
    seat: workerSeat,
    pane: 'pane-first',
    workspace: 'ws-first',
    cli_session: 'sess-earlier',
    now: EARLIER,
  });
  endSession({
    home: fixture.home,
    root: fixture.root,
    team: fixture.team,
    session: 'acme',
    seat: 'worker',
    reason: 'restart',
    now: MIDDLE,
  });
  beginSession({
    home: fixture.home,
    root: fixture.root,
    team: fixture.team,
    session: 'acme',
    seat: workerSeat,
    pane: 'pane-old',
    workspace: 'ws-old',
    cli_session: 'sess-latest',
    now: MIDDLE,
  });
  beginSession({
    home: fixture.home,
    root: fixture.root,
    team: fixture.team,
    session: 'acme',
    seat: leadSeat,
    pane: 'pane-lead',
    workspace: 'ws-lead',
    cli_session: 'sess-lead-only',
    now: EARLIER,
  });

  registerAgent(fixture.home, {
    name: 'worker',
    seat_handle: 'seat_000000000002',
    cli: 'claude-code',
    lab: 'anthropic',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    launcher: null,
    launch: agentLaunch,
    reach: {
      session: 'acme',
      pane: 'pane-old',
      team: teamIdOf(fixture.root),
      seat: 'worker',
      address: null,
      agent_session: 'sess-latest',
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });
  // Resume coverage keeps the default channel and its unique registered team/session.
  registerDefaultChannelFixture(fixture.root, fixture.home);
}

type Harness = {
  sources: RestartSources;
  ran: { pane: string; command: string }[];
  closed: string[];
};

function makeHarness(fixture: Fixture): Harness {
  const ran: { pane: string; command: string }[] = [];
  const closed: string[] = [];
  let leadAlive = true;
  let workerAlive = true;
  const boxes = new Map<string, string>();
  const shelled = new Set<string>();
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();

  const agents = (): HerdrAgent[] => [
    ...(leadAlive
      ? [{ name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle' as const, cwd: fixture.root, session: 'sess-lead-only' }]
      : []),
    ...(workerAlive
      ? [{ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle' as const, cwd: fixture.root, session: 'sess-latest' }]
      : []),
    ...[...newPanes.entries()].filter(([, slot]) => slot.agent).map(([pane, slot]) => ({
      // A blank herdr name is null. An empty string is another seat's name.
      name: slot.name, agent: 'claude-code', pane, workspace: slot.workspace, status: 'idle' as const, cwd: fixture.root,
    })),
  ];

  const closeWorkspace = (_session: string, workspace: string): boolean => {
    closed.push(workspace);
    if (workspace === 'ws-lead') leadAlive = false;
    if (workspace === 'ws-old') workerAlive = false;
    return true;
  };

  const downLaunch: DownLaunch = {
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

  const upLaunch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      newPanes.set('pane-new', { text: CLAUDE_IDLE, agent: false, name: null, workspace: 'ws-new' });
      return { pane: 'pane-new', workspace: 'ws-new' };
    },
    paneRun(_session, pane, command) {
      ran.push({ pane, command });
      const slot = newPanes.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = newPanes.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace,
    agentPanes: () => agents().map((agent) => agent.pane),
    agents: () => agents(),
    paneText: (_session, pane) => newPanes.get(pane)?.text ?? CLAUDE_IDLE,
    typeText: () => true,
    pressEnter(_session, pane) {
      const slot = newPanes.get(pane);
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
    home: fixture.home,
  };

  const sources: RestartSources = {
    home: fixture.home,
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
    launch: downLaunch,
    upLaunch,
    doctor,
  };

  return { sources, ran, closed };
}

const leadCaller = { kind: 'seat' as const, name: 'lead', pane: 'pane-lead', session: 'acme' };

describe('team restart --resume <cli-session-id> (R4)', () => {
  test('resumes an earlier recorded conversation of the seat instead of the latest', async () => {
    const fixture = makeFixture();
    seedSeatWithSessions(fixture);
    const harness = makeHarness(fixture);
    const io = testIo(fixture.root, leadCaller);

    const code = await runRestart(['worker', '--resume', 'sess-earlier'], io, harness.sources);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(harness.ran).toHaveLength(1);
    expect(harness.ran[0]?.command).toContain('--resume sess-earlier');
    expect(harness.ran[0]?.command).not.toContain('sess-latest');

    const logText = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(logText).toContain('worker: resuming session sess-earlier on the new declaration');
  });

  test('resumes the current bound conversation when --resume names it on --dry-run', async () => {
    const fixture = makeFixture();
    seedSeatWithSessions(fixture);
    const harness = makeHarness(fixture);
    const io = testIo(fixture.root, leadCaller);

    const code = await runRestart(
      ['worker', '--resume', 'sess-latest', '--dry-run'],
      io,
      harness.sources,
    );

    expect(code).toBe(0);
    expect(io.out).toContain('--resume sess-latest');
    expect(harness.closed).toEqual([]);
  });

  test('refuses --resume beside --fresh or --abandon or with an empty id (exit 2)', async () => {
    const fixture = makeFixture();
    seedSeatWithSessions(fixture);
    const harness = makeHarness(fixture);

    const withFresh = testIo(fixture.root, leadCaller);
    expect(
      await runRestart(['worker', '--resume', 'sess-earlier', '--fresh'], withFresh, harness.sources),
    ).toBe(2);
    expect(withFresh.err).toContain('--resume cannot be combined with --abandon or --fresh');

    const withAbandon = testIo(fixture.root, leadCaller);
    expect(
      await runRestart(
        ['worker', '--resume', 'sess-earlier', '--abandon'],
        withAbandon,
        harness.sources,
      ),
    ).toBe(2);
    expect(withAbandon.err).toContain('--resume cannot be combined with --abandon or --fresh');

    const emptyId = testIo(fixture.root, leadCaller);
    expect(
      await runRestart(['worker', '--resume', '   ', '--json'], emptyId, harness.sources),
    ).toBe(2);
    assertJsonErrorShape(emptyId.out, {
      id: 'restart.usage',
      messageContains: '--resume requires a session id',
    });
  });

  test('refuses an unbound or unknown session id before stopping the seat (exit 1)', async () => {
    const fixture = makeFixture();
    seedSeatWithSessions(fixture);
    const harness = makeHarness(fixture);
    const io = testIo(fixture.root, leadCaller);

    const code = await runRestart(
      ['worker', '--resume', 'sess-never-recorded', '--json'],
      io,
      harness.sources,
    );

    expect(code).toBe(1);
    expect(harness.closed).toEqual([]);
    assertJsonErrorShape(io.out, {
      id: 'restart.not-ready',
      messageContains: 'sess-never-recorded is not a recorded session of worker',
    });
  });

  test('refuses a foreign session id (another seat, another terminal-host session, or another CLI) without stopping the seat', async () => {
    const fixture = makeFixture();
    seedSeatWithSessions(fixture);
    const workerSeat = fixture.team.seats.find((s) => s.name === 'worker')!;
    beginSession({
      home: fixture.home,
      root: fixture.root,
      team: fixture.team,
      session: 'other-herdr',
      seat: workerSeat,
      pane: 'pane-other',
      workspace: 'ws-other',
      cli_session: 'sess-other-herdr',
      now: EARLIER,
    });
    beginSession({
      home: fixture.home,
      root: fixture.root,
      team: fixture.team,
      session: 'acme',
      seat: { ...workerSeat, cli: 'codex', vendor: 'openai' },
      pane: 'pane-codex',
      workspace: 'ws-codex',
      cli_session: 'sess-other-cli',
      now: EARLIER,
    });

    const harness = makeHarness(fixture);

    const otherSeat = testIo(fixture.root, leadCaller);
    expect(
      await runRestart(['worker', '--resume', 'sess-lead-only'], otherSeat, harness.sources),
    ).toBe(1);
    expect(otherSeat.err).toContain('belongs to seat lead');
    expect(harness.closed).toEqual([]);

    const otherHerdr = testIo(fixture.root, leadCaller);
    expect(
      await runRestart(['worker', '--resume', 'sess-other-herdr'], otherHerdr, harness.sources),
    ).toBe(1);
    expect(otherHerdr.err).toContain('other-herdr');
    expect(harness.closed).toEqual([]);

    const otherCli = testIo(fixture.root, leadCaller);
    expect(
      await runRestart(['worker', '--resume', 'sess-other-cli'], otherCli, harness.sources),
    ).toBe(1);
    expect(otherCli.err).toContain('ran codex, the seat now declares claude-code');
    expect(harness.closed).toEqual([]);
  });

  test('refuses a conversation recorded in another checkout of the same project, session, seat, and CLI, or when this checkout store cannot be read', async () => {
    const fixture = makeFixture();
    seedSeatWithSessions(fixture);
    const workerSeat = fixture.team.seats.find((s) => s.name === 'worker')!;

    const secondRoot = join(fixture.root, '..', 'acme-checkout-2');
    mkdirSync(secondRoot, { recursive: true });
    beginSession({
      home: fixture.home,
      root: secondRoot,
      team: fixture.team,
      session: 'acme',
      seat: workerSeat,
      pane: 'pane-second',
      workspace: 'ws-second',
      cli_session: 'sess-other-checkout',
      now: EARLIER,
    });

    const harness = makeHarness(fixture);
    const otherCheckout = testIo(fixture.root, leadCaller);
    expect(
      await runRestart(
        ['worker', '--resume', 'sess-other-checkout', '--json'],
        otherCheckout,
        harness.sources,
      ),
    ).toBe(1);
    expect(harness.closed).toEqual([]);
    assertJsonErrorShape(otherCheckout.out, {
      id: 'restart.not-ready',
      messageContains: 'sess-other-checkout is not a recorded session of worker',
    });

    const storeSessionsFile = join(storePath('acme', fixture.root, fixture.home), 'sessions.jsonl');
    discardFixtures([storeSessionsFile]);
    mkdirSync(storeSessionsFile, { recursive: true });

    const brokenStore = testIo(fixture.root, leadCaller);
    expect(
      await runRestart(
        ['worker', '--resume', 'sess-other-checkout', '--json'],
        brokenStore,
        harness.sources,
      ),
    ).toBe(1);
    expect(harness.closed).toEqual([]);
    assertJsonErrorShape(brokenStore.out, {
      id: 'restart.not-ready',
      messageContains: 'the session registry path is a directory',
    });
  });
});

// A queued self-restart (the daemon carries the seat's own request into the restart): it resumes
// the recorded conversation or does not run, and its strict rule holds up to the stop.
describe('team restart for a self-restart request', () => {
  const owner = { kind: 'owner' as const };
  const request = { seat: 'worker', pane: 'pane-old', launched: 'null', conversation: 'sess-latest' };
  const scene = (yaml?: (root: string) => string) => {
    const fixture = makeFixture(yaml);
    seedSeatWithSessions(fixture);
    return { fixture, harness: makeHarness(fixture) };
  };

  test('at an idle empty prompt: the stopping mark comes before any pane effect, then it resumes', async () => {
    const { fixture, harness } = scene();
    const atMark: number[] = [];
    const io = testIo(fixture.root, owner);
    const code = await runRestart(['worker', '--resume', 'sess-latest'], io, harness.sources, {
      selfRequest: { ...request, stopping: () => { atMark.push(harness.closed.length + harness.ran.length); return true; } },
    });
    expect(code, io.err).toBe(0);
    expect(atMark).toEqual([0]);
    expect(harness.ran[0]?.command).toContain('--resume sess-latest');
  });

  test('on the shipped Claude Code launcher the resolved line carries the conversation', async () => {
    const { fixture, harness } = scene((root) => YAML(root).replace(`  - ${root}\n`, `  - ${root}\n  - ${join(root, '..', 'work')}\n`).replace(
      '    name: worker\n    label: worker\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n',
      `    name: worker\n    label: worker\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n    launcher: claude-code\n    cwd: ../work\n`,
    ));
    mkdirSync(join(fixture.root, '..', 'work'), { recursive: true });
    expect(fixture.team.seats.find((one) => one.name === 'worker')?.launcher).toBe('claude-code');
    const io = testIo(fixture.root, owner);
    expect(await runRestart(['worker', '--resume', 'sess-latest'], io, harness.sources, { selfRequest: request }), io.err).toBe(0);
    expect(harness.ran).toHaveLength(1);
    expect(harness.ran[0]?.command).toContain('--resume sess-latest');
  });

  test('a launcher seat whose unused launch: text sets a fixed --session-id still resumes', async () => {
    const { fixture, harness } = scene((root) => YAML(root).replace(`  - ${root}\n`, `  - ${root}\n  - ${join(root, '..', 'work')}\n`).replace(
      '    name: worker\n    label: worker\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n',
      `    name: worker\n    label: worker\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5 --session-id 0b9e4f7a-1c2d-4e3f-8a5b-6c7d8e9f0a1b\n    launcher: claude-code\n    cwd: ../work\n`,
    ));
    mkdirSync(join(fixture.root, '..', 'work'), { recursive: true });
    const io = testIo(fixture.root, owner);
    expect(await runRestart(['worker', '--resume', 'sess-latest'], io, harness.sources, { selfRequest: request }), io.err).toBe(0);
    expect(harness.ran).toHaveLength(1);
    expect(harness.ran[0]?.command).toContain('--resume sess-latest');
    expect(harness.ran[0]?.command).not.toContain('0b9e4f7a-1c2d-4e3f-8a5b-6c7d8e9f0a1b');
  });

  test('a running turn, a failed stopping mark, or an unread screen at the last read defers it; nothing is stopped', async () => {
    const working = scene();
    working.harness.sources.screen = () => ({ kind: 'working' });
    const workingIo = testIo(working.fixture.root, owner);
    expect(await runRestart(['worker', '--resume', 'sess-latest', '--json'], workingIo, working.harness.sources, { selfRequest: request })).toBe(1);
    expect(workingIo.out).toContain('"id": "restart.deferred"');
    expect(working.harness.closed).toEqual([]);

    const unmarked = scene();
    const unmarkedIo = testIo(unmarked.fixture.root, owner);
    expect(await runRestart(['worker', '--resume', 'sess-latest', '--json'], unmarkedIo, unmarked.harness.sources, { selfRequest: { ...request, stopping: () => false } })).toBe(1);
    expect(unmarkedIo.out).toContain('"id": "restart.deferred"');
    expect(unmarked.harness.closed).toEqual([]);
    expect(unmarked.harness.ran).toEqual([]);

    // A checkpoint ask makes the run read the pane once more before the stop; an unread screen
    // there (an ordinary restart closes it without typing) defers the self-restart.
    const late = scene();
    updateState(late.fixture.dir, (state) => {
      state.checkpoints = { worker: { by: 'owner', path: handoverPath(late.fixture.dir, 'worker', NOW), session: 'acme', at: NOW.toISOString(), deadline: NOW.toISOString() } };
    });
    let reads = 0;
    late.harness.sources.screen = (_session, pane) => (pane === 'pane-old' && ++reads > 2 ? { kind: 'unknown' } : { kind: 'idle' }) as never;
    const lateIo = testIo(late.fixture.root, owner);
    expect(await runRestart(['worker', '--resume', 'sess-latest', '--json'], lateIo, late.harness.sources, { selfRequest: request })).toBe(1);
    expect(lateIo.out).toContain('"id": "restart.deferred"');
    expect(late.harness.closed).toEqual([]);
    expect(reads).toBeGreaterThan(2);
  });

  test('another launch or another conversation under the lock: nothing is stopped', async () => {
    const moved = scene();
    const movedIo = testIo(moved.fixture.root, owner);
    expect(await runRestart(['worker', '--resume', 'sess-latest'], movedIo, moved.harness.sources, { selfRequest: { ...request, launched: '{"shell":1}' } })).toBe(1);
    expect(movedIo.err).toContain('its launch or conversation changed since its self-restart request');
    const switched = scene();
    const switchedIo = testIo(switched.fixture.root, owner);
    expect(await runRestart(['worker', '--resume', 'sess-earlier'], switchedIo, switched.harness.sources, { selfRequest: { ...request, conversation: 'sess-earlier' } })).toBe(1);
    expect(switchedIo.err).toContain('its launch or conversation changed since its self-restart request');
    expect([...moved.harness.closed, ...switched.harness.closed]).toEqual([]);
  });

  for (const LEGACY of [
    'claude --model claude-opus-5-5 --session-id 0b9e4f7a-1c2d-4e3f-8a5b-6c7d8e9f0a1b',
    'claude --model claude-opus-5-5 --continue',
    'claude --model claude-opus-5-5 --resume 0b9e4f7a-1c2d-4e3f-8a5b-6c7d8e9f0a1b',
  ]) test(`end to end through the daemon pass: a launcher seat whose legacy line is "${LEGACY.slice(31)}" queues and resumes its conversation`, async () => {
    const fixture = makeFixture((root) => YAML(root).replace(`  - ${root}\n`, `  - ${root}\n  - ${join(root, '..', 'work')}\n`).replace(
      '    name: worker\n    label: worker\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n',
      `    name: worker\n    label: worker\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: ${LEGACY}\n    launcher: claude-code\n    cwd: ../work\n`,
    ));
    mkdirSync(join(fixture.root, '..', 'work'), { recursive: true });
    // The first launch recorded the legacy declared line as the seat's recipe, as `up` can.
    seedSeatWithSessions(fixture, LEGACY);
    updateState(fixture.dir, (state) => { state.sessions.acme!.seats.worker!.launched = { shell: 300, cli: [301] }; });
    const harness = makeHarness(fixture);
    // The seat queues its own restart from its recorded pane.
    const queueIo = testIo(fixture.root, { kind: 'seat', name: 'worker', pane: 'pane-old', session: 'acme' });
    expect(await runRestart(['worker', '--self'], queueIo, harness.sources), queueIo.err).toBe(0);
    expect(existsSync(selfRestartPath(fixture.dir, 'acme', 'worker'))).toBe(true);
    // The daemon's pass: idle at an empty prompt, so it runs the restart with the request.
    const upSources = {
      home: fixture.home,
      now: () => NOW,
      agents: () => harness.sources.agents('acme'),
      launch: { paneText: () => CLAUDE_IDLE },
    } as unknown as UpSources;
    const notices: string[] = [];
    const lines = await runSelfRestarts({
      home: fixture.home, root: fixture.root, dir: fixture.dir, team: fixture.team, sources: upSources, caller: owner,
      deps: {
        restart: (argv, io, request) => runRestart(argv, io, harness.sources, { selfRequest: request }),
        notify: (one) => { notices.push(one.body); return true; },
      },
    });
    expect(notices).toEqual([]);
    expect(lines).toEqual(['worker: restarted itself with its conversation sess-latest']);
    expect(harness.ran).toHaveLength(1);
    expect(harness.ran[0]?.command).toContain('--resume sess-latest');
    expect(harness.ran[0]?.command).not.toContain('0b9e4f7a-1c2d-4e3f-8a5b-6c7d8e9f0a1b');
    expect(harness.ran[0]?.command).not.toContain('--continue');
    expect(existsSync(selfRestartPath(fixture.dir, 'acme', 'worker'))).toBe(false);
  });
});
