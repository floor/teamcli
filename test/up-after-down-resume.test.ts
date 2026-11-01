// `team up` after `team down`: the seat has no state record, only the handle and conversation
// down retained. The registry's recorded conversation is resumed when the two agree.
// Fixture harness shared with up-bound-registry-policy.test.ts.
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

/** The state and registry records a launch left: the worker ready on pane1, bound to A and to
 *  the live conversation the pane runs. Each scene bends exactly one field. */
function recordValid(options: RecordOptions = {}): void {
  const held: SeatState = {
    stage: 'ready',
    id: HANDLE,
    pane: 'pane1',
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
      pane: 'pane1',
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
    panes.set('pane1', {
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
      const pane = `pane${10 + made}`;
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
      // The CLI the line started is in front of the pane, beside its shell.
      held.process = { shell: held.process.shell, foreground: [1000 + trace.runs.length] };
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
    // The pane's argv0 names: whatever pids are in front run the CLI this fixture launches, and
    // a scene that empties the foreground names none.
    foreground: (_session, pane) => {
      const held = panes.get(pane);
      return held === undefined ? null : held.process.foreground.map(() => 'claude');
    },
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


/** What `team down` leaves: no seat state, the retained handle (and conversation), and the
 *  registry record marked stopped with no pane. */
function recordDown(retained: { id: string; agent_session?: string }): void {
  recordValid();
  updateState(dir, (file) => {
    const one = file.sessions[SESSION]!;
    delete one.seats[WORKER];
    (one.retained_seats ??= {})[WORKER] = retained;
  });
  registerAgent(home, {
    name: WORKER,
    signing: { model: A.model, version: A.version, role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: A.launch,
    reach: { team: teamIdOf(root), seat: WORKER, session: SESSION, pane: null, address: null, agent_session: SES_A },
    seat_handle: HANDLE,
    mcp: [],
    skills: [],
    lifecycle: 'stopped',
    by: 'team down',
  });
}

test('after down, up resumes the conversation the registry and the retained seat both name', async () => {
  recordDown({ id: HANDLE, agent_session: SES_A });
  const made = makeWorld(null);
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);
  const held = seatState();
  expect(held?.id).toBe(HANDLE);
  expect(held?.agent_session).toBe(SES_A);
  const ran = workerRuns(made.trace, held?.pane);
  expect(ran.length).toBe(1);
  expect(ran[0]?.command).toContain(`--resume ${SES_A}`);
  expect(ran[0]?.command).not.toContain('--session-id');
  expect(agentRecord()?.reach.agent_session).toBe(SES_A);
  expect(made.trace.typed).toEqual([]);
});

test('after down, a retained conversation the registry does not name is not resumed', async () => {
  recordDown({ id: HANDLE, agent_session: SES_OTHER });
  const made = makeWorld(null);
  expect(await runUp([], testIo(root, { kind: 'owner' }), made.sources)).toBe(0);
  const ran = workerRuns(made.trace, seatState()?.pane);
  expect(ran.length).toBe(1);
  expect(ran[0]?.command).not.toContain('--resume');
});

test('after down, a retained handle with no conversation launches fresh, as before', async () => {
  recordDown({ id: HANDLE });
  const made = makeWorld(null);
  expect(await runUp([], testIo(root, { kind: 'owner' }), made.sources)).toBe(0);
  const ran = workerRuns(made.trace, seatState()?.pane);
  expect(ran.length).toBe(1);
  expect(ran[0]?.command).not.toContain('--resume');
  expect(seatState()?.id).toBe(HANDLE);
});

test('a recorded conversation that is not on disk is launched fresh, with a note, never resumed', async () => {
  recordDown({ id: HANDLE, agent_session: SES_A });
  const made = makeWorld(null);
  const asked: string[] = [];
  made.sources.launch!.conversationExists = (_cli, _cwd, id) => { asked.push(id); return false; };
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);
  expect(asked).toEqual([SES_A]);
  const held = seatState();
  const ran = workerRuns(made.trace, held?.pane);
  expect(ran.length).toBe(1);
  expect(ran[0]?.command).not.toContain('--resume');
  expect(ran[0]?.command).toContain('--session-id');
  expect(held?.stage).toBe('ready');
  expect(held?.agent_session).toBe(sessionFor(ran[0]?.command ?? '') ?? undefined);
  expect(`${io.out}${io.err}`).toContain(`its recorded conversation ${SES_A} is not on disk; launched a fresh one`);
  expect(made.trace.typed).toEqual([]);
});

test('a conversation that is on disk is resumed', async () => {
  recordDown({ id: HANDLE, agent_session: SES_A });
  const made = makeWorld(null);
  made.sources.launch!.conversationExists = () => true;
  expect(await runUp([], testIo(root, { kind: 'owner' }), made.sources)).toBe(0);
  const ran = workerRuns(made.trace, seatState()?.pane);
  expect(ran.length).toBe(1);
  expect(ran[0]?.command).toContain(`--resume ${SES_A}`);
});

test('a resume the CLI refuses at runtime is launched again fresh in the same pane, never left at the shell', async () => {
  recordDown({ id: HANDLE, agent_session: SES_A });
  const made = makeWorld(null);
  const launch = made.sources.launch!;
  const run = launch.paneRun;
  launch.paneRun = (session, pane, command) => {
    const ok = run(session, pane, command);
    if (/--resume/.test(command)) {
      const held = made.panes.get(pane)!;
      held.screen = `${command}\nNo conversation found with session ID: ${SES_A}\n❯ `;
      held.session = null;
      held.status = 'unknown';
      // The CLI printed the error and exited: the pane's processes name no CLI, so the shell is
      // back and the relaunch may type.
      held.process = { shell: 100, foreground: [] };
    }
    return ok;
  };
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);
  const held = seatState();
  expect(held?.stage).toBe('ready');
  const ran = workerRuns(made.trace, held?.pane);
  expect(ran.length).toBe(2);
  expect(ran[0]?.command).toContain(`--resume ${SES_A}`);
  expect(ran[1]?.command).not.toContain('--resume');
  expect(ran[1]?.command).toContain('--session-id');
  expect(held?.agent_session).toBe(sessionFor(ran[1]?.command ?? '') ?? undefined);
  expect(`${io.out}${io.err}`).toContain('its recorded conversation was not found by the CLI; launched a fresh one');
  expect(made.trace.typed).toEqual([]);
});
