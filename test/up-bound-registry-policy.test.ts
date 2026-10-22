// Independent regression coverage for the policy a bound seat launches from in `team up`.
// A valid registry binding names the launch recipe, model and version the seat was signed to
// run; the team file's own declaration is the fallback for a seat with no current binding, not
// an override. A kept seat and a real relaunch must keep the bound recipe in the seat state, the
// agent registry and the session start — the base recipe, never the expanded launch argv — and
// their next plan must be a plain skip. A seat with no record, a refused one (a stale state
// handle or copy, another terminal session, an orphaned record), a retired one and a fresh seat all
// plan the declared line instead. Every reading is a fixture: no live terminal host, registry, provider
// or pane. The pane's model and its measured conversation come from the command the fake ran.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { TeamFile } from '../src/file/types.ts';
import { findAgent, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { readStoreSessions, sessionsPath } from '../src/sessions/registry.ts';
import { emptySession, readState, updateState, type SeatState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-22T03:15:00Z');
const SESSION = 'acme';
const LEAD = 'lead';
const WORKER = 'worker';
// The stable handle both records carry, and the one the state keeps across a relaunch.
const HANDLE = 'seat_0123456789ab';
const SES_A = 'ses_a1b2c3d4e5f6';
const SES_OTHER = 'ses_other9f8e7d';
const SES_STALE = 'ses_stale5c4b3a';
// The bound policy, written by the launch the registry recorded.
const A = { model: 'Claude Opus', version: '6.1', launch: 'claude --model claude-opus-6-1' };
// The declaration the team file now carries for the same seat.
const B = { model: 'Claude Sonnet', version: '5.2', launch: 'claude --model claude-sonnet-5-2' };

// The captured idle screen, with the model banner and status row naming what a scene's pane runs.
const CAPTURE = readFileSync(new URL('./fixtures/claude-code/2.1.289/idle-suggestion-plain.txt', import.meta.url), 'utf8');
const idleOf = (model: string): string => CAPTURE.replaceAll('Opus 5.5', model);
const IDLE_A = idleOf('Opus 6.1');
const IDLE_B = idleOf('Sonnet 5.2');
const IDLE_THIRD = idleOf('Haiku 4.2');

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;
let team: TeamFile;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

/** Two seats: a lead whose pane is a person's (never launched), and the implementer whose policy
 *  these scenes read. */
function teamText(): string {
  return `format: 1
project: acme
coordinator: ${LEAD}
operator: ${LEAD}
session: ${SESSION}
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${LEAD}
    label: ${LEAD}
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.2"
    launch: claude --model claude-sonnet-5-2
    human: true
  - role: implementer
    name: ${WORKER}
    label: ${WORKER}
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.2"
    launch: claude --model claude-sonnet-5-2
    effort: high
`;
}

function setup(): void {
  const text = teamText();
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  team = loaded.team;
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

type RecordOptions = {
  /** Fields written over the launch record the binding was written from. */
  state?: Partial<SeatState>;
  /** The terminal session the agent record was written in. */
  reachSession?: string;
  orphanedAt?: string;
  retired?: boolean;
  seatHandle?: string;
  /** Write the state record alone: no agent record at all. */
  noAgent?: boolean;
};

/** The state and registry records a launch left: the worker ready on w2:p1, bound to A and to
 *  the live conversation the pane runs. Each scene bends exactly one field. */
function recordValid(options: RecordOptions = {}): void {
  const held: SeatState = {
    stage: 'ready',
    id: HANDLE,
    pane: 'w2:p1',
    workspace: 'w2',
    launched: { shell: 100, cli: [200] },
    agent_session: SES_A,
    model: A.model,
    version: A.version,
    launch_line: A.launch,
    effort: 'high',
    ...options.state,
  };
  updateState(dir, (file) => {
    (file.sessions[SESSION] ??= emptySession()).seats[WORKER] = held;
  });
  if (options.noAgent === true) return;
  registerAgent(home, {
    name: WORKER,
    signing: { model: A.model, version: A.version, role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: A.launch,
    reach: {
      team: teamIdOf(root),
      seat: WORKER,
      session: options.reachSession ?? SESSION,
      pane: 'w2:p1',
      address: null,
      agent_session: SES_A,
    },
    seat_handle: options.seatHandle ?? HANDLE,
    mcp: [],
    skills: [],
    lifecycle: options.retired === true ? 'retired' : 'running',
    by: 'team up',
    ...(options.orphanedAt === undefined ? {} : { orphaned_at: options.orphanedAt }),
  });
}

const seatState = (): SeatState | undefined => readState(dir).sessions[SESSION]?.seats[WORKER];
const agentRecord = () => findAgent(home, { team: teamIdOf(root), seat: WORKER });

type PaneFixture = {
  screen: string;
  session: string | null;
  workspace: string;
  name: string | null;
  status: string;
  process: { shell: number; foreground: number[] };
};

type RunTrace = {
  created: string[];
  closed: string[];
  typed: string[];
  runs: { pane: string; command: string }[];
};

/** The model the line asked for, drawn on the pane it ran in. */
function screenFor(command: string): string {
  const model = /--model(?:=|\s+)['"]?([A-Za-z0-9._-]+)/.exec(command)?.[1] ?? '';
  if (model.includes('sonnet')) return IDLE_B;
  if (model.includes('haiku')) return IDLE_THIRD;
  return IDLE_A;
}

/** The conversation the line names, as the pane's live session: the id the command carries. */
function sessionFor(command: string): string | null {
  return /(?:--resume|--session-id)(?:=|\s+)['"]?([A-Za-z0-9][A-Za-z0-9._:-]*)/.exec(command)?.[1] ?? null;
}

/** One synthetic terminal session: the worker's recorded pane, and whatever a run makes. The
 *  pane's model and session are read back from the command, never asserted into place. */
function makeWorld(
  first: { screen: string; live?: string; status?: string } | null,
): { sources: UpSources; trace: RunTrace; panes: Map<string, PaneFixture> } {
  const trace: RunTrace = { created: [], closed: [], typed: [], runs: [] };
  const panes = new Map<string, PaneFixture>();
  const labels = new Map<string, string>();
  if (first !== null) {
    panes.set('w2:p1', {
      screen: first.screen,
      session: first.live ?? SES_A,
      workspace: 'w2',
      name: WORKER,
      status: first.status ?? 'idle',
      process: { shell: 100, foreground: [200] },
    });
    labels.set('w2', WORKER);
  }
  let made = 0;
  const agents = () => [...panes.entries()]
    .filter(([, pane]) => pane.name !== null)
    .map(([id, pane]) => ({
      name: pane.name,
      agent: 'claude',
      pane: id,
      workspace: pane.workspace,
      status: pane.status,
      cwd: root,
      ...(pane.session === null ? {} : { session: pane.session }),
    }));
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      made += 1;
      const pane = `w${10 + made}:p1`;
      const workspace = `w${10 + made}`;
      trace.created.push(label);
      labels.set(workspace, label);
      panes.set(pane, {
        screen: '',
        session: null,
        workspace,
        name: null,
        status: 'idle',
        process: { shell: 400 + made, foreground: [500 + made] },
      });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      trace.runs.push({ pane, command });
      const held = panes.get(pane);
      if (held === undefined) return false;
      held.screen = screenFor(command);
      held.session = sessionFor(command);
      held.status = 'idle';
      return true;
    },
    renameAgent(_session, pane, name) {
      const held = panes.get(pane);
      if (held === undefined) return false;
      held.name = name;
      return true;
    },
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      for (const [id, held] of panes) if (held.workspace === workspace) panes.delete(id);
      return true;
    },
    agentPanes: () => [...panes.keys()],
    agents,
    workspacePanes: (_session, workspace) =>
      [...panes.entries()].filter(([, held]) => held.workspace === workspace).map(([id]) => id),
    paneText: (_session, pane) => panes.get(pane)?.screen ?? null,
    typeText(_session, _pane, text) {
      trace.typed.push(text);
      return true;
    },
    pressEnter: () => true,
    agentStatus: (_session, pane) => panes.get(pane)?.status ?? null,
    foreground: () => ['claude'],
    shellBack: () => false,
    processInfo: (_session, pane) => panes.get(pane)?.process ?? null,
    sleep: async () => {},
    now: () => NOW,
  };
  const doctor: DoctorSources = {
    version: () => '2.1.289',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  };
  return {
    sources: {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents,
      workspaces: () => [...labels.entries()].map(([id, label]) => ({ id, label })),
      home,
      doctor,
      launch,
      now: () => NOW,
      sleep: async () => {},
    },
    trace,
    panes,
  };
}

const workerRuns = (trace: RunTrace, pane: string | undefined) => trace.runs.filter((run) => run.pane === pane);

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-bound-registry-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  setup();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

test('a kept seat keeps the bound recipe in the registry, not the declared one', async () => {
  recordValid();
  const made = makeWorld({ screen: IDLE_A });
  expect(await runUp([], testIo(root, { kind: 'owner' }), made.sources)).toBe(0);

  // The run only re-pointed the record at its pane: the signing, the lab and the recipe stay
  // the ones the bound launch wrote, and nothing about the seat's role, CLI or effort moved.
  const agent = agentRecord();
  expect(agent?.signing).toEqual({ model: A.model, version: A.version, role: 'implementer' });
  expect(agent?.launch).toBe(A.launch);
  expect(agent?.lab).toBe('anthropic');
  expect(agent?.cli).toBe('claude-code');
  expect(agent?.seat_handle).toBe(HANDLE);
  const held = seatState();
  expect(held?.model).toBe(A.model);
  expect(held?.version).toBe(A.version);
  expect(held?.launch_line).toBe(A.launch);
  expect(held?.effort).toBe('high');
});

test('a kept seat’s next plan is a skip, not a drift', async () => {
  recordValid();
  const made = makeWorld({ screen: IDLE_A });
  expect(await runUp([], testIo(root, { kind: 'owner' }), made.sources)).toBe(0);

  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, made.sources)).toBe(0);
  expect(dry.out).toContain(`  skip ${WORKER}: already ready; left as it is`);
  expect(dry.out).not.toContain('model drifted');
});

test('a relaunch keeps the bound recipe in the state, the registry and the session start', async () => {
  recordValid();
  // The pane runs a third model: the repair closes it and launches the bound recipe again.
  const made = makeWorld({ screen: IDLE_THIRD });
  expect(await runUp([], testIo(root, { kind: 'owner' }), made.sources)).toBe(0);
  expect(made.trace.closed).toContain('w2');

  const held = seatState();
  expect(held?.stage).toBe('ready');
  expect(held?.id).toBe(HANDLE);
  expect(held?.model).toBe(A.model);
  expect(held?.version).toBe(A.version);
  // The stored line is the base recipe, never the expanded command the pane ran.
  expect(held?.launch_line).toBe(A.launch);
  expect(held?.launch_line).not.toContain('AGENT_UNATTENDED');
  expect(held?.launch_line).not.toContain('--resume');
  expect(held?.effort).toBe('high');

  const agent = agentRecord();
  expect(agent?.signing).toEqual({ model: A.model, version: A.version, role: 'implementer' });
  expect(agent?.launch).toBe(A.launch);
  expect(agent?.lab).toBe('anthropic');
  expect(agent?.cli).toBe('claude-code');
  expect(agent?.seat_handle).toBe(HANDLE);
  expect(agent?.mcp).toEqual([]);
  expect(agent?.skills).toEqual([]);

  // The line the pane actually ran carried the bound recipe and the bound conversation.
  const ran = workerRuns(made.trace, held?.pane);
  expect(ran.length).toBe(1);
  expect(ran[0]?.command).toContain(A.launch);
  expect(ran[0]?.command).toContain(`--resume ${SES_A}`);

  // The session start row carries the bound policy. Its line resumed a conversation and so set
  // no new `--session-id`: the row records no CLI session id, and the resumed id is pinned where
  // it belongs, on the command above and in the state and agent records.
  const sessions = readStoreSessions(sessionsPath(team, root, home), home);
  if (!sessions.ok) throw new Error(sessions.reason);
  const started = sessions.sessions.filter((one) => one.seat === WORKER);
  expect(started.length).toBe(1);
  expect(started[0]?.model).toBe(A.model);
  expect(started[0]?.version).toBe(A.version);
  expect(started[0]?.lab).toBe('anthropic');
  expect(started[0]?.cli).toBe('claude-code');
  expect(started[0]?.effort).toBe('high');
});

test('a relaunch’s next plan is a skip, not a false drift', async () => {
  recordValid();
  const made = makeWorld({ screen: IDLE_THIRD });
  expect(await runUp([], testIo(root, { kind: 'owner' }), made.sources)).toBe(0);

  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, made.sources)).toBe(0);
  expect(dry.out).toContain(`  skip ${WORKER}: already ready; left as it is`);
  expect(dry.out).not.toContain('model drifted');
});

test('an orphaned record binds nothing: the relaunch runs the declared line and stores it', async () => {
  recordValid({ orphanedAt: '2026-10-22T00:00:00Z' });
  const made = makeWorld({ screen: IDLE_A });
  expect(await runUp([], testIo(root, { kind: 'owner' }), made.sources)).toBe(0);
  expect(made.trace.closed).toContain('w2');

  const held = seatState();
  expect(held?.model).toBe(B.model);
  expect(held?.version).toBe(B.version);
  expect(held?.launch_line).toBe(B.launch);
  const agent = agentRecord();
  expect(agent?.signing.model).toBe(B.model);
  expect(agent?.signing.version).toBe(B.version);
  expect(agent?.launch).toBe(B.launch);

  // The refused binding proves no conversation: the line is fresh, and the id it mints is the
  // one the fake pane now runs and the session start records.
  const ran = workerRuns(made.trace, held?.pane);
  expect(ran.length).toBe(1);
  expect(ran[0]?.command).toContain(B.launch);
  expect(ran[0]?.command).not.toContain(A.launch);
  expect(ran[0]?.command).not.toContain('--resume');
  const live = sessionFor(ran[0]?.command ?? '');
  expect(live).not.toBeNull();

  const sessions = readStoreSessions(sessionsPath(team, root, home), home);
  if (!sessions.ok) throw new Error(sessions.reason);
  const started = sessions.sessions.filter((one) => one.seat === WORKER);
  expect(started.length).toBe(1);
  expect(started[0]?.model).toBe(B.model);
  expect(started[0]?.version).toBe(B.version);
  expect(started[0]?.cli_session).toBe(live ?? undefined);
});

test('a state copy naming another session withholds the binding: the declared line is planned', async () => {
  recordValid({ state: { agent_session: SES_STALE } });
  const made = makeWorld({ screen: IDLE_A });
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, made.sources)).toBe(0);
  expect(dry.out).toContain(B.launch);
  expect(dry.out).not.toContain(A.launch);
  expect(dry.out).toContain('model drifted from the file');
});

test('a state handle that disagrees with the record is not this seat: the declared line is planned', async () => {
  recordValid({ state: { id: 'seat_bbbbbbbbbbbb' } });
  const made = makeWorld({ screen: IDLE_A });
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, made.sources)).toBe(0);
  expect(dry.out).toContain(B.launch);
  expect(dry.out).not.toContain(A.launch);
});

test('a record written in another terminal session is not this seat: the declared line is planned', async () => {
  recordValid({ reachSession: 'other-session' });
  const made = makeWorld({ screen: IDLE_A });
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, made.sources)).toBe(0);
  expect(dry.out).toContain(B.launch);
  expect(dry.out).not.toContain(A.launch);
});

test('a retired record binds nothing: the declared line is planned, resuming only the pane it proved', async () => {
  recordValid({ retired: true });
  const made = makeWorld({ screen: IDLE_A });
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, made.sources)).toBe(0);
  expect(dry.out).toContain(B.launch);
  expect(dry.out).not.toContain(A.launch);
  // The pane itself still names the conversation the state copy holds, so that is carried.
  expect(dry.out).toContain(`--resume ${SES_A}`);
});

test('a fresh seat with no record plans the declared line', async () => {
  const made = makeWorld(null);
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, made.sources)).toBe(0);
  expect(dry.out).toContain(B.launch);
  expect(dry.out).not.toContain(A.launch);
  expect(dry.out).toContain(`workspace create`);
});

test('a working seat whose screen drifted from the bound recipe is left alone', async () => {
  recordValid();
  const held = { screen: IDLE_THIRD, status: 'working' };
  const plan = makeWorld(held);
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, plan.sources)).toBe(0);
  expect(dry.out).toContain(`  skip ${WORKER}: its model drifted; left as it is`);

  const made = makeWorld(held);
  expect(await runUp([], testIo(root, { kind: 'owner' }), made.sources)).toBe(0);
  expect(made.trace.closed).toEqual([]);
  expect(workerRuns(made.trace, 'w2:p1')).toEqual([]);
  expect(made.trace.typed).toEqual([]);
  expect(seatState()?.model).toBe(A.model);
  expect(seatState()?.version).toBe(A.version);
});

test('a live conversation the records do not bind is not taken for the seat', async () => {
  recordValid();
  const made = makeWorld({ screen: IDLE_A, live: SES_OTHER });
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, made.sources)).toBe(0);
  expect(dry.out).toContain(`  skip ${WORKER}: already ready; left as it is`);
  expect(dry.out).not.toContain('model drifted');

  expect(await runUp([], testIo(root, { kind: 'owner' }), made.sources)).toBe(0);
  expect(made.trace.closed).toEqual([]);
  expect(workerRuns(made.trace, 'w2:p1')).toEqual([]);
  const sessions = readStoreSessions(sessionsPath(team, root, home), home);
  if (!sessions.ok) throw new Error(sessions.reason);
  expect(sessions.sessions.filter((one) => one.seat === WORKER)).toEqual([]);
});
