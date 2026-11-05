// Item 7: a seat launched through a wrapper (an alternate endpoint chosen by the launcher) that
// a terminal-host restore brings back as the bare CLI. Every turn then fails on the wrapper's
// missing endpoint settings, so the pane is never adopted in place: `team up` closes it without
// input and launches the seat again through its own launch line plus `--resume <the recorded
// conversation>`, in a new workspace. The scenes also pin the boundaries: a bare CLI seat is
// still adopted, a line that cannot carry the conversation closes nothing, and a drifted model on
// a pane whose name the restore cleared is seen. All of it is synthetic: no live host, no CLI.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T02:10:00Z');
const SESSION = 'acme';
const SEAT = 'worker';
// Neutral place ids: a restore keeps the pane and the workspace, never a name.
const PANE = 'pane-restored';
const WORKSPACE = 'ws-restored';
// The record a launch wrote before the host restore: the pane, the workspace and the pids then.
const RECORD = { stage: 'ready' as const, pane: PANE, workspace: WORKSPACE, launched: { shell: 100, cli: [200] } };
// The pids the pane holds now: the host restored the process, so they are not the launched ones.
const RESTORED: PaneProcesses = { shell: 101, foreground: [201] };
const SESSION_ID = 'ses_claude';
// The wrapper's own banner id, naming another model than the file declares. A provider wrapper's
// Claude Code screen prints the CLI's default family whatever the launcher selected, so this is
// the one screen reading that proves the seat runs another model.
const DRIFTED = CLAUDE_IDLE.replace('Opus 5.5 · Acme billing', 'deepseek-v3 · API Usage Billing');

/** The launch the file and the record agree on, and the signed model that goes with it. */
type Spec = { launch: string; vendor: string; model: string; version: string };
const WRAPPER: Spec = { launch: 'team-deepseek', vendor: 'deepseek', model: 'DeepSeek Flash', version: 'V4.1' };
const BARE: Spec = { launch: 'claude --model claude-opus-5-5', vendor: 'anthropic', model: 'Claude Opus', version: '5.5' };

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

/** One launchable seat, alone in its team: the only seat every run can touch. The lead is a
 *  human pane, so the seat under test is never a lead: a lead's drift is refused, never cycled. */
function teamText(spec: Spec): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
    human: true
  - role: implementer
    name: ${SEAT}
    label: ${SEAT}
    cli: claude-code
    vendor: ${spec.vendor}
    model: ${spec.model}
    version: "${spec.version}"
    launch: ${spec.launch}
`;
}

/** The state record and the registry binding, written together. `record` is the seat state,
 *  `registry` what the agent record says the launch ran. */
function record(
  spec: Spec,
  seatRecord: Record<string, unknown>,
  registry: { session?: string | null } = {},
): void {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = seatRecord as never;
  });
  registerAgent(home, {
    name: SEAT,
    signing: { model: spec.model, version: spec.version, role: 'implementer' },
    lab: spec.vendor,
    cli: 'claude-code',
    launcher: null,
    launch: spec.launch,
    reach: {
      team: teamIdOf(root),
      seat: SEAT,
      session: SESSION,
      pane: PANE,
      address: null,
      ...(registry.session === null ? {} : { agent_session: registry.session ?? SESSION_ID }),
    },
    seat_handle: 'seat_0123456789ab',
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

function setup(spec: Spec): void {
  const text = teamText(spec);
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

type Trace = {
  created: string[];
  closed: string[];
  typed: string[];
  runs: { pane: string; command: string }[];
  renamed: { pane: string; name: string }[];
};

type Scene = {
  /** The entry's name: null (the restore cleared it) unless a scene says otherwise. */
  name?: string | null;
  status?: string;
  /** The session the entry reports; null omits it as the host does when it reports none. */
  session?: string | null;
  foreground?: string[] | null;
  /** The recorded pane's process reading; the restored one unless a scene says otherwise. */
  process?: PaneProcesses;
  /** The recorded pane's screen; the idle capture unless a scene says otherwise. */
  screen?: string;
};

/** The readings one run takes: the host's list with the seat's pane unnamed, and a pane whose
 *  process is the restored one. */
function sources(scene: Scene = {}): { sources: UpSources; trace: Trace } {
  const trace: Trace = { created: [], closed: [], typed: [], runs: [], renamed: [] };
  const made = new Map<string, string>();
  const madeSpaces = new Map<string, string[]>();
  const agents = (): HerdrAgent[] | null => [{
    name: scene.name === undefined ? null : scene.name,
    agent: 'claude',
    pane: PANE,
    workspace: WORKSPACE,
    status: scene.status ?? 'idle',
    cwd: root,
    ...(scene.session === null ? {} : { session: scene.session ?? SESSION_ID }),
  }];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      const pane = `made-${trace.created.length + 1}`;
      const workspace = `ws-${trace.created.length + 1}`;
      trace.created.push(label);
      made.set(pane, CLAUDE_IDLE);
      madeSpaces.set(workspace, [pane]);
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      trace.runs.push({ pane, command });
      made.set(pane, CLAUDE_IDLE);
      return true;
    },
    typeText(_session, _pane, text) {
      trace.typed.push(text);
      return true;
    },
    renameWorkspace: () => true,
    renameAgent(_session, pane, name) {
      trace.renamed.push({ pane, name });
      return true;
    },
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    agentPanes: () => [PANE, ...made.keys()],
    agents,
    workspacePanes(_session, workspace) {
      if (workspace === WORKSPACE) return [PANE];
      return madeSpaces.get(workspace) ?? null;
    },
    paneText: (_session, pane) => (pane === PANE && scene.screen !== undefined ? scene.screen : made.get(pane) ?? CLAUDE_IDLE),
    foreground: () => (scene.foreground === undefined ? ['claude'] : scene.foreground),
    processInfo: (_session, pane) => (pane === PANE && scene.process !== undefined ? scene.process : RESTORED),
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
  return {
    sources: {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents,
      workspaces: () => [{ id: WORKSPACE, label: SEAT }],
      home,
      doctor,
      launch,
      now: () => NOW,
    },
    trace,
  };
}

/** What the run left in the seat's record. */
const seatState = () => readState(dir).sessions[SESSION]?.seats[SEAT];

/** Effects on the seat alone: a run also starts the team's watch, in a workspace of its own. */
const seatCreated = (trace: Trace): string[] => trace.created.filter((label) => label === SEAT);
/** The commands run in a pane other than the team's own watch or bus. */
const seatRuns = (trace: Trace): Trace['runs'] =>
  trace.runs.filter((run) => !/\/src\/cli\.ts (watch|bus)\b/.test(run.command));
/** A launch line's first word, after any environment assignments the launcher prefixes. */
const firstWord = (command: string): string => command.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, '').split(/\s/)[0] ?? '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-own-line-')));
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
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

test('a wrapper seat restored to its bare CLI is relaunched through its own line, with the recorded conversation', async () => {
  setup(WRAPPER);
  record(WRAPPER, { ...RECORD, agent_session: SESSION_ID });
  // The plan says the close and the relaunch before anything runs, and never the adoption.
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, sources().sources)).toBe(0);
  expect(dry.out).toContain(`workspace close ${WORKSPACE}`);
  expect(dry.out).toContain('closed without input: its pane holds the bare restored CLI, not its launch line');
  expect(dry.out).toContain(`team-deepseek --resume ${SESSION_ID}`);
  expect(dry.out).not.toContain(`agent rename ${PANE} ${SEAT}`);
  expect(seatState()?.launched).toEqual(RECORD.launched);

  const made = sources();
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  // The recorded workspace goes without input; the seat is launched again in a new one.
  expect(made.trace.closed).toEqual([WORKSPACE]);
  expect(seatCreated(made.trace)).toEqual([SEAT]);
  expect(made.trace.typed).toEqual([]);
  // Exactly one launch, and it is the seat's own line carrying the conversation, never `claude`.
  expect(seatRuns(made.trace)).toHaveLength(1);
  expect(firstWord(seatRuns(made.trace)[0]?.command ?? '')).toBe('team-deepseek');
  expect(seatRuns(made.trace)[0]?.command).toContain(`--resume ${SESSION_ID}`);
  // The only name written is the one on the new pane: the restored pane is never renamed back.
  expect(made.trace.renamed).toEqual([{ pane: 'made-1', name: SEAT }]);
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.pane).toBe('made-1');
  expect(seatState()?.workspace).toBe('ws-1');
});

test('a seat whose launch line is the CLI itself is still adopted in place', async () => {
  setup(BARE);
  record(BARE, { ...RECORD, agent_session: SESSION_ID });
  const made = sources();
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(made.trace.renamed).toEqual([{ pane: PANE, name: SEAT }]);
  expect(made.trace.closed).toEqual([]);
  expect(seatCreated(made.trace)).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.typed).toEqual([]);
  expect(seatState()?.pane).toBe(PANE);
  expect(seatState()?.launched).toEqual({ shell: RESTORED.shell, cli: RESTORED.foreground });
  expect(seatState()?.agent_session).toBe(SESSION_ID);
});

test('a wrapper line that resumes another conversation closes nothing and holds the seat', async () => {
  const other: Spec = { ...WRAPPER, launch: 'team-deepseek --resume ses_other' };
  setup(other);
  record(other, { ...RECORD, agent_session: SESSION_ID });
  const made = sources();
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  expect(io.err).toContain(
    '  its recorded conversation cannot be resumed: its launch line resumes a different conversation; left as it is (its launch line names a conversation of its own: clear that selection from its launch line for a fresh start)\n',
  );
  expect(made.trace.closed).toEqual([]);
  expect(seatCreated(made.trace)).toEqual([]);
  expect(seatRuns(made.trace)).toEqual([]);
  expect(made.trace.renamed).toEqual([]);
  expect(seatState()?.launched).toEqual(RECORD.launched);
});

test('a drifted model on a pane whose name the restore cleared is seen and relaunched', async () => {
  setup(WRAPPER);
  // No conversation on either side: the drift alone decides, and the relaunch starts fresh.
  record(WRAPPER, RECORD, { session: null });
  const made = sources({ process: { shell: RECORD.launched.shell, foreground: RECORD.launched.cli }, session: null, screen: DRIFTED });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(made.trace.closed).toEqual([WORKSPACE]);
  expect(seatCreated(made.trace)).toEqual([SEAT]);
  expect(seatRuns(made.trace)).toHaveLength(1);
  expect(firstWord(seatRuns(made.trace)[0]?.command ?? '')).toBe('team-deepseek');
  expect(seatRuns(made.trace)[0]?.command).not.toContain('--resume');
  expect(made.trace.renamed).toEqual([{ pane: 'made-1', name: SEAT }]);
  expect(seatState()?.pane).toBe('made-1');
});
