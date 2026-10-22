// Coverage: what `up` leaves in the agent registry when a launch replaces a seat's pane but
// stops short of ready. The contract this pins:
//
//  1. A launch that actually ran (sessionStarted) and left a live partial pane — `launched` or
//     `named` — must move the same agent id to that pane, with the conversation the launch
//     measured, and must not keep a closed previous pane current. Readiness is not claimed:
//     the record follows the live session, not the plan's outcome.
//  2. A failed launch after a proven close leaves no live successor: the dead route is cleared
//     (pane null, lifecycle no longer running), while the stable agent id, signing and
//     conversation history stay.
//  3. A failed launch that closed nothing must leave a prior record exactly as it was — the
//     route, its session and its measured conversation binding are not rewritten from the file.
//  4. A working identity doubt and a stopped seat are left/ended exactly as today: nothing is
//     closed, typed or re-signed behind a seat that is working, and a stopped seat's record is
//     ended with its pane cleared.
//  5. A pending record already consistent with its pane is left pending and unchanged.
//
// Every reading is a fixture: no live terminal host, no registry outside the disposable home.
// The three partial-replacement scenes are the positive cases; the failed-launch, working-doubt,
// stopped and pending scenes are the negative controls.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { findAgent, registerAgent } from '../../src/registry/agents.ts';
import { teamIdOf } from '../../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import type { HerdrAgent, HerdrWorkspace, PaneProcesses } from '../../src/herdr.ts';
import { gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-22T05:40:00Z');
const SESSION = 'acme';
const SEAT = 'worker';
const OLD_PANE = 'w1:p1';
const OLD_WORKSPACE = 'w1';
const NEW_PANE = 'w2:p1';
const NEW_WORKSPACE = 'w2';
const OLD_LAUNCHED = { shell: 100, cli: [200] };
const NEW_LAUNCHED = { shell: 300, cli: [400] };
const LEAD = 'lead';
const LEAD_PANE = 'l1:p1';
const LEAD_WORKSPACE = 'l1';
const LEAD_SESSION = 'ses_lead';
const LEAD_LAUNCHED = { shell: 500, cli: [600] };
const FOREIGN_PID = 999;
// The run's own watch pane, distinct from any seat's: a watch is started beside the team.
const WATCH_PANE = 'w9:p1';
const WATCH_WORKSPACE = 'w9';
const OLD_SESSION = 'ses_old';
const NEW_SESSION = 'ses_new';
const HANDLE = 'seat_0123456789ab';
const SIGNING = { model: 'GPT Sol', version: '6.1', role: 'coordinator' };
const DECLARED_LAUNCH = 'codex -m gpt-6.1-sol';
// An idle prompt the file's own model is shown at, and the same screen mid-turn.
const IDLE = readFileSync(new URL('../fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');
const WORKING = readFileSync(new URL('../fixtures/codex/0.161.0/working.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');
const DOUBT = 'its pane holds a process this record cannot tie to the launch';
const WORKING_REASON = `the process in its pane is working; nothing closed (stop it there, or run team remove ${SEAT})`;

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

/** One Codex seat (a first-message rules profile), alone in its team: the only seat a run can
 *  touch. `stopped` writes the file's own stop, which the run never launches; a lead cannot be a
 *  stopped seat, so that file carries a second, running lead beside the stopped seat. */
function teamText(stopped = false): string {
  if (stopped) {
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
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: ${DECLARED_LAUNCH}
  - role: implementer
    name: ${SEAT}
    label: ${SEAT}
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: ${DECLARED_LAUNCH}
    stopped: true
`;
  }
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
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: ${DECLARED_LAUNCH}
`;
}

function setup(stopped = false): void {
  const text = teamText(stopped);
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

/** A seat's state record, as a launch left it. */
function state(record: Record<string, unknown>, name = SEAT): void {
  updateState(dir, (file) => {
    const session = (file.sessions[SESSION] ??= emptySession());
    session.seats[name] = record as never;
  });
}

/** The agent record a previous launch wrote. `differing` gives the record a signing and launch
 *  the file a later run reads does not declare: a write from the declaration is then visible. */
function registry(opts: { pane?: string; session?: string; live?: string; differing?: boolean } = {}): string {
  const differing = opts.differing === true;
  return registerAgent(home, {
    name: SEAT,
    signing: differing ? { model: 'GPT Old', version: '5.2', role: 'coordinator' } : SIGNING,
    lab: 'openai',
    cli: 'codex',
    launcher: null,
    launch: differing ? 'codex -m gpt-5.2-old' : DECLARED_LAUNCH,
    reach: {
      team: teamIdOf(root),
      seat: SEAT,
      session: opts.session ?? SESSION,
      pane: opts.pane ?? OLD_PANE,
      address: null,
      agent_session: opts.live ?? OLD_SESSION,
    },
    seat_handle: HANDLE,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  }).id;
}

const seatState = () => readState(dir).sessions[SESSION]?.seats[SEAT];

function agentNow() {
  const found = findAgent(home, { team: teamIdOf(root), seat: SEAT });
  if (found === null) throw new Error('the run left no agent record for the seat');
  return found;
}

type Trace = { created: string[]; closed: string[]; runs: { pane: string; command: string }[]; renames: string[]; typed: string[] };

/** The readings one run takes. Before the replacement's fresh workspace exists, the terminal
 *  host lists the seat on its old pane with `live` as its conversation and `status` as its own
 *  status (the working-doubt scene); after the create, it lists the new pane and the conversation
 *  measured there. `create` false is a world where the new pane already exists (a pending record). */
function sources(opts: {
  run?: boolean;
  named?: boolean;
  absent?: boolean;
  live?: string;
  status?: string;
  screen?: string | null;
  after?: string;
  pending?: { pane: string; workspace: string; live: string };
  /** The old pane holds a live process the record does not name (a `replaced` verdict). */
  foreign?: boolean;
  /** The team's running lead, at its own ready pane: present only in the stopped-seat file. */
  lead?: boolean;
} = {}): { sources: UpSources; trace: Trace } {
  const trace: Trace = { created: [], closed: [], runs: [], renames: [], typed: [] };
  let created = false;
  const createdNow = () => created || opts.pending !== undefined;
  const listed = (): HerdrAgent[] => {
    if (opts.lead === true) {
      return [{ name: LEAD, agent: 'codex', pane: LEAD_PANE, workspace: LEAD_WORKSPACE, status: 'idle', cwd: root, session: LEAD_SESSION }];
    }
    if (opts.pending !== undefined) {
      return [{ name: SEAT, agent: 'codex', pane: opts.pending.pane, workspace: opts.pending.workspace, status: 'idle', cwd: root, session: opts.pending.live }];
    }
    if (createdNow()) {
      return [{ name: null, agent: 'codex', pane: NEW_PANE, workspace: NEW_WORKSPACE, status: 'idle', cwd: root, session: NEW_SESSION }];
    }
    if (opts.absent === true) return [];
    return [{ name: SEAT, agent: 'codex', pane: OLD_PANE, workspace: OLD_WORKSPACE, status: opts.status ?? 'idle', cwd: root, session: opts.live ?? OLD_SESSION }];
  };
  const processes = (pane: string): PaneProcesses | null => {
    if (pane === OLD_PANE) {
      return opts.foreign === true
        ? { shell: OLD_LAUNCHED.shell, foreground: [FOREIGN_PID] }
        : { shell: OLD_LAUNCHED.shell, foreground: [OLD_LAUNCHED.shell] };
    }
    if (pane === NEW_PANE) return { shell: NEW_LAUNCHED.shell, foreground: NEW_LAUNCHED.cli };
    if (pane === LEAD_PANE) return { shell: LEAD_LAUNCHED.shell, foreground: LEAD_LAUNCHED.cli };
    return null;
  };
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      trace.created.push(label);
      // The watch starts in its own workspace; the seat's repair creates the seat's.
      if (label.startsWith('Watch')) return { pane: WATCH_PANE, workspace: WATCH_WORKSPACE };
      created = true;
      return { pane: NEW_PANE, workspace: NEW_WORKSPACE };
    },
    paneRun(_session, pane, command) {
      trace.runs.push({ pane, command });
      return opts.run ?? true;
    },
    typeText(_session, _pane, text) {
      trace.typed.push(text);
      return false;
    },
    renameAgent(_session, pane, name) {
      trace.renames.push(`${pane}: ${name}`);
      // A partial launch: the pane runs, but it never gets the seat's name.
      return opts.named !== false;
    },
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    agentPanes: () => listed().map((agent) => agent.pane),
    agents: () => listed(),
    workspacePanes: (_session, workspace) => workspace === OLD_WORKSPACE
      ? [OLD_PANE]
      : workspace === NEW_WORKSPACE
        ? [NEW_PANE]
        : workspace === LEAD_WORKSPACE
          ? [LEAD_PANE]
          : workspace === WATCH_WORKSPACE
            ? [WATCH_PANE]
            : null,
    paneText: (_session, pane) => {
      if (pane === OLD_PANE) return opts.screen ?? null;
      if (pane === NEW_PANE) return opts.after ?? IDLE;
      if (pane === LEAD_PANE) return IDLE;
      return null;
    },
    foreground: (_session, pane) => pane === OLD_PANE ? ['bash'] : ['codex'],
    agentStatus: () => null,
    processInfo: (_session, pane) => processes(pane),
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
  const workspaces = (): HerdrWorkspace[] => opts.lead === true
    ? [{ id: LEAD_WORKSPACE, label: LEAD }]
    : [{ id: OLD_WORKSPACE, label: SEAT }, { id: NEW_WORKSPACE, label: SEAT }];
  return {
    trace,
    sources: {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => listed(),
      workspaces,
      home,
      doctor,
      launch,
      now: () => NOW,
    },
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-partial-launch-registry-')));
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

test('a replacement that stops at launched moves the agent to the pane that is running', async () => {
  const id = registry();
  state({ stage: 'ready', pane: OLD_PANE, workspace: OLD_WORKSPACE, launched: OLD_LAUNCHED, agent_session: OLD_SESSION });
  // The old pane is only its shell: the plan repairs, closes the workspace, makes a fresh one,
  // runs the line, and the rename never lands — the seat stops at `launched`.
  const made = sources({ named: false });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);

  expect(io.out).toContain(`${SEAT}: left out: was not named in time; left at launched\n`);
  expect(io.err).toContain(`0 seats repaired, 0 skipped (working), 1 refused (${SEAT}: was not named in time; left at launched)\n`);
  // The close was the proven one, and the launch ran on the pane the state now names; nothing
  // this run started ran on the closed old pane.
  expect(made.trace.closed).toEqual([OLD_WORKSPACE]);
  expect(made.trace.runs.some((run) => run.pane === NEW_PANE)).toBe(true);
  expect(made.trace.runs.filter((run) => run.pane === OLD_PANE)).toEqual([]);
  expect(seatState()).toMatchObject({
    stage: 'launched',
    pane: NEW_PANE,
    workspace: NEW_WORKSPACE,
    launched: NEW_LAUNCHED,
    agent_session: NEW_SESSION,
  });

  // The record follows the live session; it never claims ready, and the closed old pane is not
  // left current.
  const agent = agentNow();
  expect(agent.id).toBe(id);
  expect(agent.reach.pane).toBe(NEW_PANE);
  expect(agent.reach.session).toBe(SESSION);
  expect(agent.reach.agent_session).toBe(NEW_SESSION);
  expect(agent.lifecycle).toBe('running');
  expect(agent.signing).toEqual(SIGNING);
  expect(agent.launch).toBe(DECLARED_LAUNCH);
  expect(agent.seat_handle).toBe(HANDLE);
});

test('a replacement that stops at named moves the agent to the pane that is running', async () => {
  const id = registry();
  state({ stage: 'ready', pane: OLD_PANE, workspace: OLD_WORKSPACE, launched: OLD_LAUNCHED, agent_session: OLD_SESSION });
  // The name lands; the rules do not, so the seat stays `named` with the live pane recorded.
  const made = sources();
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);

  expect(io.out).toContain(`${SEAT}: left out: rules not typed`);
  expect(io.err).toContain(`1 refused (${SEAT}: rules not typed`);
  expect(seatState()).toMatchObject({
    stage: 'named',
    pane: NEW_PANE,
    workspace: NEW_WORKSPACE,
    launched: NEW_LAUNCHED,
    agent_session: NEW_SESSION,
  });

  const agent = agentNow();
  expect(agent.id).toBe(id);
  expect(agent.reach.pane).toBe(NEW_PANE);
  expect(agent.reach.agent_session).toBe(NEW_SESSION);
  expect(agent.lifecycle).toBe('running');
  expect(agent.signing).toEqual(SIGNING);
  expect(agent.seat_handle).toBe(HANDLE);
});

test('a failed launch after a proven close clears the dead route and keeps the agent', async () => {
  const id = registry();
  state({ stage: 'ready', pane: OLD_PANE, workspace: OLD_WORKSPACE, launched: OLD_LAUNCHED, agent_session: OLD_SESSION });
  // The old workspace closes, the fresh pane exists, and the line never runs: no successor.
  const made = sources({ run: false });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);

  expect(io.out).toContain(`${SEAT}: left out: its launch command did not run; left at launched\n`);
  expect(made.trace.closed).toEqual([OLD_WORKSPACE]);
  expect(seatState()).toMatchObject({ stage: 'launched', pane: NEW_PANE, workspace: NEW_WORKSPACE });

  // The pane the record named is gone for good: it must not stay current, and the agent must
  // not keep claiming a session it no longer has. Its id, signing and conversation stay.
  const agent = agentNow();
  expect(agent.id).toBe(id);
  expect(agent.reach.pane).toBeNull();
  expect(agent.lifecycle).toBe('stopped');
  expect(agent.reach.agent_session).toBe(OLD_SESSION);
  expect(agent.signing).toEqual(SIGNING);
  expect(agent.seat_handle).toBe(HANDLE);
});

test('a failed launch that closed nothing leaves the prior record exactly as it was', async () => {
  // The registry knows a seat in another terminal-host session, on a pane this run never reads. The
  // file declares a different model and line: a write taken from the declaration would rewrite
  // the signing, the line and the session, which is the outcome this scene forbids.
  const id = registry({ session: 'other', differing: true });
  const made = sources({ run: false, absent: true });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);

  expect(io.out).toContain(`${SEAT}: left out: its launch command did not run; left at launched\n`);
  expect(made.trace.closed).toEqual([]);
  const agent = agentNow();
  expect(agent.id).toBe(id);
  expect(agent.reach).toMatchObject({ session: 'other', pane: OLD_PANE, agent_session: OLD_SESSION });
  expect(agent.lifecycle).toBe('running');
  expect(agent.signing).toEqual({ model: 'GPT Old', version: '5.2', role: 'coordinator' });
  expect(agent.launch).toBe('codex -m gpt-5.2-old');
  expect(agent.seat_handle).toBe(HANDLE);
});

test('a working identity doubt is held without closing or touching the record', async () => {
  const id = registry();
  state({ stage: 'ready', pane: OLD_PANE, workspace: OLD_WORKSPACE, launched: OLD_LAUNCHED, agent_session: OLD_SESSION });
  // A process this record cannot tie to the launch, running the seat's conversation elsewhere,
  // mid-turn. Nothing may be closed, typed or rewritten.
  const made = sources({ live: 'ses_other', status: 'working', screen: WORKING, foreign: true });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);

  // The record stays ready: the seat is skipped working, and the reason is the run's detail.
  expect(io.out).toContain(`${SEAT}: ready\n`);
  expect(io.err).toContain(WORKING_REASON);
  expect(io.err).toContain('0 seats repaired, 1 skipped (working), 0 refused\n');
  // The run's watch starts in its own workspace; nothing runs on the doubted pane and no line
  // is typed into it.
  expect(made.trace.closed).toEqual([]);
  expect(made.trace.runs.filter((run) => run.pane === OLD_PANE)).toEqual([]);
  expect(made.trace.runs.some((run) => run.command.includes(DECLARED_LAUNCH))).toBe(false);
  expect(made.trace.typed).toEqual([]);
  expect(seatState()).toMatchObject({ stage: 'ready', pane: OLD_PANE, launched: OLD_LAUNCHED, agent_session: OLD_SESSION });

  const agent = agentNow();
  expect(agent.id).toBe(id);
  expect(agent.reach).toMatchObject({ pane: OLD_PANE, session: SESSION, agent_session: OLD_SESSION });
  expect(agent.lifecycle).toBe('running');
});

test('a stopped seat ends its record and clears the pane without touching the pane', async () => {
  // A lead cannot be stopped, so the file carries a running lead beside the stopped seat. The
  // lead is ready and untouched: it is the run's only other seat.
  setup(true);
  const id = registry();
  state({ stage: 'ready', pane: OLD_PANE, workspace: OLD_WORKSPACE, launched: OLD_LAUNCHED, agent_session: OLD_SESSION });
  state({ stage: 'ready', pane: LEAD_PANE, workspace: LEAD_WORKSPACE, launched: LEAD_LAUNCHED, agent_session: LEAD_SESSION }, LEAD);
  const made = sources({ lead: true });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);

  expect(io.err).toContain('0 seats repaired, 0 skipped (working), 0 refused\n');
  expect(made.trace.closed).toEqual([]);
  // The run's watch starts beside the team, never on the stopped seat's pane, and the seat's
  // own line never runs.
  expect(made.trace.runs.filter((run) => run.pane === OLD_PANE)).toEqual([]);
  expect(made.trace.runs.some((run) => run.command.includes(DECLARED_LAUNCH))).toBe(false);
  expect(made.trace.renames).toEqual([]);
  // The seat is the same agent, stopped, with no pane a later send could reach.
  const agent = agentNow();
  expect(agent.id).toBe(id);
  expect(agent.reach.pane).toBeNull();
  expect(agent.lifecycle).toBe('stopped');
  expect(agent.reach.agent_session).toBe(OLD_SESSION);
  expect(agent.signing).toEqual(SIGNING);
  expect(agent.seat_handle).toBe(HANDLE);
});

test('a pending record consistent with its pane is left pending and unchanged', async () => {
  const id = registry({ pane: NEW_PANE, live: NEW_SESSION });
  state({ stage: 'named', pane: NEW_PANE, workspace: NEW_WORKSPACE, launched: NEW_LAUNCHED, agent_session: NEW_SESSION });
  // The seat is still at `named`; this run retries its rules delivery, which fails again. The
  // record it was already described by stays as it is.
  const made = sources({ pending: { pane: NEW_PANE, workspace: NEW_WORKSPACE, live: NEW_SESSION } });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);

  expect(io.out).toContain(`${SEAT}: left out: rules not typed`);
  expect(made.trace.closed).toEqual([]);
  expect(seatState()).toMatchObject({ stage: 'named', pane: NEW_PANE, workspace: NEW_WORKSPACE, launched: NEW_LAUNCHED, agent_session: NEW_SESSION });

  const agent = agentNow();
  expect(agent.id).toBe(id);
  expect(agent.reach).toMatchObject({ pane: NEW_PANE, session: SESSION, agent_session: NEW_SESSION });
  expect(agent.lifecycle).toBe('running');
  expect(agent.signing).toEqual(SIGNING);
});
