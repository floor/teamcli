// A Cursor seat the terminal host restored, read by `team up` and `team status`.
//
// The incident this pins: three live Grok 4.7 seats on the Cursor CLI showed as `restored, not
// launched by team` with model `-`. Their launch records named no conversation (the launch-side
// gap is pinned in `launch-records-cursor-session.test.ts`), so the strong proof — the pane's
// conversation is the recorded one — could not fire. What was left in `up` and `team check` was
// the restore proof, and it refused every Cursor pane before reading its place: herdr attributes
// a Cursor pane to the agent kind `cursor`, which is the profile's `cli`, while the proof
// compared the kind with the process names alone (`cursor-agent`). The owner was told the
// nonsense sentence "its pane's agent says cursor; the seat's launch line runs cursor".
//
// Two scenes are red on that source: a Cursor pane with no conversation on either side is
// adopted by the weak proof (the declared CLI, alone in its workspace, at an idle prompt), as
// every other CLI's is; and a pane running another conversation than the record names is
// refused for that, not for the CLI it obviously is. The rest stay green: the strong proof
// adopts a seat whose conversation ties, and another CLI's kind, or a shell in front, is still
// never the seat.
//
// The screen is the captured Grok 4.7 ready frame in `test/fixtures/cursor/2026.10.16/`, whose
// paths are already the fixture's; the pane, workspace and process readings are synthetic. No
// live herdr, CLI home, transcript or credential is read.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runStatus } from '../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import type { Live } from '../src/status/compare.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T09:15:00Z');
const SESSION = 'acme';
const SEAT = 'worker';
const PANE = 'fixture-pane-one';
const WORKSPACE = 'fixture-space';
const GROK_IDLE = readFileSync(new URL('./fixtures/cursor/2026.10.16/idle.txt', import.meta.url), 'utf8');
const SESSION_ID = 'ses_grok_live';
// The record a launch wrote before the host restore: the pane, the workspace, the pids then.
const RECORD = { stage: 'ready' as const, pane: PANE, workspace: WORKSPACE, launched: { shell: 100, cli: [200] } };
// The pids the pane holds now: the host restored the process, so they are not the launched ones.
const RESTORED = { shell: 101, foreground: [201] };
const RESTORED_LINE = 'restored; left as it is';

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

function teamText(): string {
  return `format: 1
project: acme
coordinator: ${SEAT}
operator: ${SEAT}
session: ${SESSION}
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${SEAT}
    label: ${SEAT}
    cli: cursor
    vendor: cursor
    model: Grok
    version: "4.7"
    launch: cursor-agent --model grok-4.7-high
`;
}

/** The seat state a launch left before the restore, and the registry's binding of the seat to a
 *  conversation — `null` for a record that names none, as the incident's seats did. */
function record(over: Record<string, unknown> = {}, registry: { session?: string | null } = {}): void {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = { ...RECORD, ...over } as never;
  });
  registerAgent(home, {
    name: SEAT,
    signing: { model: 'Grok', version: '4.7', role: 'coordinator' },
    lab: 'cursor',
    cli: 'cursor',
    launcher: null,
    launch: 'cursor-agent --model grok-4.7-high',
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

function setup(): void {
  const text = teamText();
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
  runs: string[];
};

/** Herdr's list naming the seat on the restored pane, attributed to the Cursor agent kind, with
 *  `live` as the conversation it reports (`undefined`: none reported); the pane's process
 *  reading is the restored one. */
function agentEntry(live: string | undefined, status = 'idle'): HerdrAgent {
  return {
    name: SEAT, agent: 'cursor', pane: PANE, workspace: WORKSPACE, status, cwd: root,
    ...(live === undefined ? {} : { session: live }),
  };
}

function sources(
  live: string | undefined,
  opts: { agent?: string | null; foreground?: string[] } = {},
): { sources: UpSources; trace: Trace } {
  const trace: Trace = { created: [], closed: [], typed: [], runs: [] };
  const agents = (): HerdrAgent[] => [{ ...agentEntry(live), ...(opts.agent === undefined ? {} : { agent: opts.agent }) }];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      trace.created.push(label);
      return { pane: 'made-pane', workspace: 'made-space' };
    },
    paneRun(_session, _pane, command) {
      trace.runs.push(command);
      return true;
    },
    typeText(_session, _pane, text) {
      trace.typed.push(text);
      return true;
    },
    renameWorkspace: () => true,
    reportDisplayAgent: () => true,
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    agentPanes: () => [PANE],
    agents,
    paneText: () => GROK_IDLE,
    foreground: () => opts.foreground ?? ['cursor-agent'],
    processInfo: () => RESTORED,
    sleep: async () => {},
    now: () => NOW,
  };
  const doctor: DoctorSources = {
    version: () => '2026.10.22',
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

/** The world `team status` reads after the run: the same pane, process and conversation. */
function liveWorld(live: string | undefined): Live {
  return {
    running: true,
    agents: [agentEntry(live)],
    workspaces: [{ id: WORKSPACE, label: SEAT }],
    screens: { [PANE]: GROK_IDLE },
    processes: { [PANE]: RESTORED },
  };
}

/** What the run did to the seat itself: a Watch workspace of its own is not the seat's. */
function touchedSeat(trace: Trace): { created: string[]; closed: string[]; typed: string[]; runs: string[] } {
  return {
    created: trace.created.filter((label) => label === SEAT),
    closed: trace.closed,
    typed: trace.typed,
    runs: trace.runs.filter((command) => command.includes('cursor-agent')),
  };
}

const seatState = () => readState(dir).sessions[SESSION]?.seats[SEAT];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-cursor-restored-')));
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

test("a restored Cursor seat whose records name no conversation is adopted by the CLI's own proof", async () => {
  // The incident's shape, one step short: the pane runs the declared CLI alone in its workspace
  // at an idle prompt, and neither record names a conversation. The weak proof is the only one
  // there is, and it adopts — as it does for every other CLI.
  record({}, { session: null });
  const reTied = 'restored and re-tied: its pane runs cursor alone in its workspace, at an idle prompt';
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, sources(undefined).sources)).toBe(0);
  expect(dry.out).toContain(`  skip ${SEAT}: ${reTied}`);

  const made = sources(undefined);
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(io.err).toContain(reTied);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], runs: [] });
  expect(seatState()?.launched).toEqual({ shell: RESTORED.shell, cli: RESTORED.foreground });
});

test('a pane running another conversation is refused for that, not for the CLI it is', async () => {
  // The incident's records name no conversation; herdr reports one on the pane. One-sided ids
  // are refused, and the reason must be the conversation — never "its pane's agent says cursor".
  record({}, { session: null });
  const why = 'its pane holds a conversation (ses_other) the record\'s launch never named';
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, sources('ses_other').sources)).toBe(1);
  expect(io.out).toContain(`${SEAT}: left out: ${why}\n`);
  expect(io.err).toContain(why);
  expect(seatState()?.launched).toEqual(RECORD.launched);
  // And a record that names one conversation while the pane runs another says so too.
  record();
  const other = testIo(root, { kind: 'owner' });
  expect(await runUp([], other, sources('ses_other').sources)).toBe(1);
  expect(other.err).toContain(`its pane holds another conversation (ses_other; the record's launch ran ${SESSION_ID})`);
});

test('the strong proof still adopts a seat whose conversation ties, and status reads it', async () => {
  // The state after one restart on the fixed source: the launch recorded herdr's Cursor reading,
  // so the restored pane's own conversation ties it to the seat. `up` skips it where it stands,
  // takes the pids the pane holds now, and `team status` shows the running seat under its model.
  record();
  const made = sources(SESSION_ID);
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(io.err).toContain(RESTORED_LINE);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], runs: [] });
  expect(seatState()?.launched).toEqual({ shell: RESTORED.shell, cli: RESTORED.foreground });
  expect(seatState()?.agent_session).toBe(SESSION_ID);

  const statusIo = testIo(root, { kind: 'owner' });
  const code = await runStatus(['--json'], statusIo, {
    live: () => liveWorld(SESSION_ID),
    branch: () => 'main',
    standing: () => ({ kind: 'none' } as const),
    now: () => NOW,
    home,
  });
  const doc = JSON.parse(statusIo.out) as { rows: { name: string; state: string; model: string }[] };
  const row = doc.rows.find((entry) => entry.name === SEAT);
  expect(code).toBe(0);
  expect(row?.state).toBe('idle');
  expect(row?.model.toLowerCase()).toBe('grok 4.7');
});

test("another CLI's kind is never this seat", async () => {
  record({}, { session: null });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, sources(undefined, { agent: 'codex' }).sources)).toBe(1);
  expect(io.err).toContain("its pane's agent says codex; the seat's launch line runs cursor");
  expect(seatState()?.launched).toEqual(RECORD.launched);
});

test('the weak proof still needs the declared CLI in the foreground', async () => {
  record({}, { session: null });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, sources(undefined, { foreground: ['fixture-shell'] }).sources)).toBe(1);
  expect(io.err).toContain("its pane runs fixture-shell; the seat's launch line runs cursor");
  expect(seatState()?.launched).toEqual(RECORD.launched);
});
