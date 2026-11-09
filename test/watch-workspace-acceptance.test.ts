// The daemon hosts the session's watch. `up` creates no `Watch · <team>` workspace and runs no
// watch command; a second `up` still creates none. A pane watch already on disk is what
// `status` lists — pane, pid, heartbeat age — and what `check` flags when its heartbeat is
// older than two in-force intervals. The host is fake throughout — no herdr, no session, no pane.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../src/approve/command.ts';
import { runTeamCheck, type CheckSources } from '../src/check/team.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Key, Terminal } from '../src/launch/terminal.ts';
import { installKey } from '../src/store/keys.ts';
import { approvalStanding } from '../src/store/store.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo, recordRenames } from './helpers.ts';

const NOW = new Date('2026-10-17T09:00:00Z');
const PROJECT = 'acme';
const SESSION = 'acme';
/** The label the issue names, written out rather than read back from the code under test. */
const WATCH = `Watch · ${PROJECT}`;
const FILE = ['--file', '.agents/team.yaml'];
const SEAT = 'lead';
const SEAT_PANE = 'w1:p1';
const WATCH_WORKSPACE = 'w2';

let base: string;
let root: string;
let home: string;
let file: string;

/** The team's file: one lead seat, the lobby trusted, and an interval whose two cycles are
 *  four minutes, so a heartbeat is compared against a number the test can say. */
function text(): string {
  return `format: 1
project: ${PROJECT}
session: ${SESSION}
coordinator: ${SEAT}
operator: ${SEAT}
trust:
  - ${join(home, '.config/team/lobby')}
  - ${root}
watch:
  interval: 120s
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${SEAT}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
`;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-watch-workspace-')));
  root = join(base, PROJECT);
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  file = join(root, '.agents/team.yaml');
  writeFileSync(file, text());
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/key.json'), 'utf8')));
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

async function approve(): Promise<void> {
  const io = testIo(root, { kind: 'owner' });
  const code = await runApprove(FILE, io, { ask: async () => '5', waiting: () => 'empty', now: () => NOW, home });
  expect(code).toBe(0);
}

type Created = { session: string; cwd: string; label: string; pane: string; workspace: string };

/** A fake herdr: the session and the workspaces this run made, and every pane it typed into. */
type World = {
  launch: Launch;
  session: 'absent' | 'running';
  created: Created[];
  runs: { session: string; pane: string; command: string }[];
  typed: { pane: string; text: string }[];
  enters: string[];
  /** The panes herdr lists an agent for: a pane the run started a command in. */
  started: string[];
  /** The agents herdr lists: none until a seat has actually launched and stayed listed. */
  agents: HerdrAgent[];
  /** Herdr's workspace list as the run would read it back: the labels it created. */
  list(): { id: string; label: string }[];
  paneOf(label: string): string | undefined;
};

function world(): World {
  const made: World = {
    launch: {} as Launch,
    session: 'absent',
    created: [],
    runs: [],
    typed: [],
    enters: [],
    started: [],
    agents: [],
    list: () => made.created.map(({ workspace, label }) => ({ id: workspace, label })),
    paneOf: (label) => made.created.find((entry) => entry.label === label)?.pane,
  };
  let n = 0;
  made.launch = {
    sessionState: () => null,
    startServer() {
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
    createWorkspace(session, cwd, label) {
      n += 1;
      const workspace = `w${n}`;
      const pane = `${workspace}:p1`;
      made.created.push({ session, cwd, label, pane, workspace });
      return { pane, workspace };
    },
    paneRun(session, pane, command) {
      made.runs.push({ session, pane, command });
      if (!made.started.includes(pane)) made.started.push(pane);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => made.started,
    agents: () => made.agents,
    workspacePanes: () => [],
    paneText: () => CLAUDE_IDLE,
    typeText(_session, pane, typed) {
      made.typed.push({ pane, text: typed });
      return true;
    },
    pressEnter(_session, pane) {
      made.enters.push(pane);
      return true;
    },
    foreground: () => ['claude'],
    focus: () => true,
    sleep: async () => {},
    now: () => NOW,
  };

  recordRenames(made.launch);
  return made;
}

const terminal: Terminal = {
  async key(): Promise<Key> {
    throw new Error('the run read the terminal, and no key was queued');
  },
  drain() {},
};

function upSources(made: World, extra: Partial<UpSources> = {}): UpSources {
  return {
    sessionRunning: () => made.session === 'running',
    agents: () => made.agents,
    workspaces: () => made.list(),
    home,
    now: () => NOW,
    sleep: async () => {},
    alive: () => false,
    launch: made.launch,
    terminal: () => terminal,
    ...extra,
  };
}

async function up(made: World, extra: Partial<UpSources> = {}) {
  const io = testIo(root, { kind: 'owner' });
  const code = await runUp(FILE, io, upSources(made, extra));
  return { code, out: io.out, err: io.err };
}

/** The session's state as `up` leaves it: the seat ready in its pane and the watch recorded. */
function seed(heartbeat: string, watch: { pane?: string; workspace?: string; pid?: number } = {}): void {
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = { stage: 'ready', pane: SEAT_PANE, workspace: 'w1' };
    session.watch = { ...watch, heartbeat };
  });
  // The launch delivered the general brief before it typed: the seat's record and its state entry.
  deliverBriefs({ dir: join(root, '.agents'), root, session: SESSION, seats: [SEAT], home, at: NOW.toISOString() });
}

function quiet(seatLabel: string): Live {
  return {
    running: true,
    agents: [{ name: SEAT, agent: 'claude', pane: SEAT_PANE, workspace: 'w1', status: 'idle', cwd: null }],
    workspaces: [
      { id: 'w1', label: seatLabel },
      { id: WATCH_WORKSPACE, label: WATCH },
    ],
    screens: { [SEAT_PANE]: CLAUDE_IDLE },
  };
}

function statusSources(live: Live): StatusSources {
  return {
    live: () => live,
    branch: () => 'main',
    standing: (at) => approvalStanding(at, home),
    now: () => NOW,
    home,
  };
}

function checkSources(live: Live): CheckSources {
  return {
    live: () => live,
    branch: () => 'main',
    standing: (at) => approvalStanding(at, home),
    now: () => NOW,
    home,
  };
}

function seatLabel(): string {
  const parsed = validateTeamFile(readFileSync(file, 'utf8'));
  if (!parsed.ok) throw new Error(`the test's own file does not validate: ${JSON.stringify(parsed.errors)}`);
  return workspaceLabel(parsed.team.seats[0]!);
}

describe('the daemon hosts the watch', () => {
  test('up creates no Watch workspace and runs no watch command', async () => {
    await approve();
    const made = world();
    const run = await up(made);
    expect(run.code).toBe(0);
    expect(made.created.filter((entry) => entry.label === WATCH)).toEqual([]);
    expect(made.created.some((entry) => entry.session === SESSION)).toBe(true);
    expect(made.runs.some((entry) => entry.command.includes('watch --session'))).toBe(false);
    expect(made.typed).toEqual([]);
    expect(made.enters).toEqual([]);
    expect(readState(join(root, '.agents')).sessions[SESSION]?.watch).toBeUndefined();
  });

  test('a second up still creates no Watch workspace', async () => {
    await approve();
    const made = world();
    expect((await up(made)).code).toBe(0);
    const first = made.created.length;
    const seat = made.created[0]!;
    made.agents.push({ name: SEAT, agent: 'claude', pane: seat.pane, workspace: seat.workspace, status: 'idle', cwd: null });
    const second = await up(made);
    expect(second.code).toBe(0);
    expect(made.created).toHaveLength(first);
    expect(made.created.filter((entry) => entry.label === WATCH)).toEqual([]);
    expect(second.err).not.toContain('watch: started');
    expect(made.runs.some((entry) => entry.command.includes('watch --session'))).toBe(false);
    expect(made.typed).toEqual([]);
    expect(readState(join(root, '.agents')).sessions[SESSION]?.watch).toBeUndefined();
    // A live pid on a planted record does not start a pane watch either.
    updateState(join(root, '.agents'), (state) => {
      const session = (state.sessions[SESSION] ??= emptySession());
      session.watch = { pid: 4242, heartbeat: NOW.toISOString() };
    });
    const third = await up(made, { alive: () => true });
    expect(third.code).toBe(0);
    expect(made.created).toHaveLength(first);
    expect(made.created.filter((entry) => entry.label === WATCH)).toEqual([]);
    expect(third.err).not.toContain('watch: started');
    expect(made.typed).toEqual([]);
  });

  test('status lists the watch pane, its pid and the age of its heartbeat', async () => {
    await approve();
    seed(new Date(NOW.getTime() - 30_000).toISOString(), { pane: 'w9:p1', workspace: 'w9', pid: 4242 });
    const io = testIo(root, { kind: 'owner' });
    const code = await runStatus(['--file', file], io, statusSources(quiet(seatLabel())));
    expect(code).toBe(0);
    expect(io.out).toContain('note: watch: pane w9:p1, pid 4242, last heartbeat 30s ago\n');
  });

  test('check flags a heartbeat older than two in-force intervals, with the repair', async () => {
    await approve();
    const live = quiet(seatLabel());
    // Two 120-second intervals are four minutes; five minutes is past them.
    seed(new Date(NOW.getTime() - 5 * 60_000).toISOString(), { pane: 'w9:p1', workspace: 'w9', pid: 4242 });
    const stale = testIo(root, { kind: 'owner' });
    expect(runTeamCheck({ file: '.agents/team.yaml' }, stale, checkSources(live))).toBe(1);
    expect(`${stale.out}${stale.err}`).toContain(
      `difference: the watch's last pass was 5 minutes ago\n  repair: team daemon status, or the lead runs team daemon install\n`,
    );
    // Inside the two intervals there is nothing to repair.
    seed(new Date(NOW.getTime() - 60_000).toISOString(), { pane: 'w9:p1', workspace: 'w9', pid: 4242 });
    const fresh = testIo(root, { kind: 'owner' });
    expect(runTeamCheck({ file: '.agents/team.yaml' }, fresh, checkSources(live))).toBe(0);
    expect(`${fresh.out}${fresh.err}`).not.toContain("the watch's last pass was");
    expect(`${fresh.out}${fresh.err}`).toContain('no differences');
  });
});
