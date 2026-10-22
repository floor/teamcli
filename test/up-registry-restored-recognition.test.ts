// Independent coverage for the registry-backed recognition of a restored Codex seat in `team up`.
// Codex's launch line carries no resume flag, and a record written before a host restore can hold
// no state session copy at all: the only proof that the process in the seat's pane is the seat is
// the agent registry's own binding, read against the live agent's session. These scenes drive the
// real `team up` — a dry run for the plan line, a real run for the record and the effects — and
// pin both sides: the registry-only record is recognized and left as it is, while a record whose
// session, CLI or pane disagrees, a seat running another conversation, and a working seat are all
// left alone. No live herdr: every reading is a fixture.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-21T08:15:00Z');
const SESSION = 'acme';
// The captured idle screen, with the banner naming the model this scene's file declares.
const IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');

const SEAT = 'worker';
// The record a launch wrote before a host restore: the pane, the workspace and the pids then.
const RECORD = { stage: 'ready' as const, pane: 'w2:p1', workspace: 'w2', launched: { shell: 100, cli: [200] } };
// The pids the pane holds now: the host restored the process, so they are not the launched ones.
const RESTORED = { shell: 101, foreground: [201] };
const SESSION_ID = 'ses_codex';
const DOUBT = 'its pane holds a process this record cannot tie to the launch';
const WORKING = 'the process in its pane is working; nothing closed (stop it there, or run team remove worker)';
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

/** One Codex seat, alone in its team: the only seat every run can touch. */
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
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
`;
}

/** The state record and the registry binding, written together: `record` is the seat state (no
 *  session copy unless a scene gives one), `registry` what the agent record says the launch ran. */
function record(
  record: Record<string, unknown>,
  registry: { cli?: string; session?: string | null; pane?: string } = {},
): void {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = record as never;
  });
  registerAgent(home, {
    name: SEAT,
    signing: { model: 'GPT Sol', version: '6.1', role: 'coordinator' },
    lab: registry.cli === 'claude-code' ? 'anthropic' : 'openai',
    cli: registry.cli ?? 'codex',
    launcher: null,
    launch: registry.cli === 'claude-code' ? 'claude --model claude-opus-5-5' : 'codex -m gpt-6.1-sol',
    reach: {
      team: teamIdOf(root),
      seat: SEAT,
      session: SESSION,
      pane: registry.pane ?? 'w2:p1',
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

type Trace = { created: string[]; closed: string[]; typed: string[]; runs: string[] };

/** The readings one run takes: herdr's list naming the seat on `pane` with `live` as the
 *  conversation it runs, and a pane whose process is the restored one. */
function sources(live: string, opts: { pane?: string; status?: string } = {}): { sources: UpSources; trace: Trace } {
  const trace: Trace = { created: [], closed: [], typed: [], runs: [] };
  const madePanes = new Map<string, string>();
  const pane = opts.pane ?? 'w2:p1';
  const agents = () => [
    {
      name: SEAT, agent: 'codex', pane, workspace: pane.split(':')[0] ?? 'w2',
      status: opts.status ?? 'idle', cwd: root, session: live,
    },
  ];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      const pane = `made-${trace.created.length + 1}`;
      trace.created.push(label);
      madePanes.set(pane, IDLE);
      return { pane, workspace: `ws-${trace.created.length}` };
    },
    paneRun(_session, pane, command) {
      trace.runs.push(command);
      madePanes.set(pane, IDLE);
      return true;
    },
    typeText(_session, _pane, text) {
      trace.typed.push(text);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    agentPanes: () => [opts.pane ?? 'w2:p1', ...madePanes.keys()],
    agents,
    paneText: (_session, pane) => madePanes.get(pane) ?? IDLE,
    foreground: () => ['codex'],
    processInfo: () => RESTORED,
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
      workspaces: () => [{ id: 'w2', label: SEAT }],
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

/** Effects on the seat: the run may create its own Watch workspace and nothing else. */
function touchedSeat(trace: Trace): { created: string[]; closed: string[]; typed: string[] } {
  return {
    created: trace.created.filter((label) => label === SEAT),
    closed: trace.closed,
    typed: trace.typed,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-registry-restored-')));
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

test('a registry-only restored record is recognized: the seat is left as it is and the record takes the registry session', async () => {
  record(RECORD);
  // The dry run first: the plan line is the recognition, said before anything would run.
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, sources(SESSION_ID).sources)).toBe(0);
  expect(dry.out).toContain(`  skip ${SEAT}: ${RESTORED_LINE}`);
  expect(dry.out).not.toContain(DOUBT);

  // The real run: nothing is closed and nothing is typed into the pane.
  const made = sources(SESSION_ID);
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(io.err).toContain(RESTORED_LINE);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [] });
  // The record takes the pids the pane holds now, and the conversation the registry proved.
  expect(seatState()?.launched).toEqual({ shell: RESTORED.shell, cli: RESTORED.foreground });
  expect(seatState()?.agent_session).toBe(SESSION_ID);
});

test('a live conversation that is not the recorded one is left as it is', async () => {
  record(RECORD);
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, sources('ses_other').sources)).toBe(0);
  expect(dry.out).toContain(`  skip ${SEAT}: ${DOUBT}`);

  const made = sources('ses_other');
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  // The doubt is refused and held: the record says left out with the reason, the summary counts
  // the refusal, and the run exits nonzero even though nothing was touched.
  expect(io.out).toContain(`${SEAT}: left out: ${DOUBT}\n`);
  expect(io.err).toContain(DOUBT);
  expect(io.err).toContain(`0 seats repaired, 0 skipped (working), 1 refused (${SEAT}: ${DOUBT})\n`);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [] });
  // The record is not re-pointed at a conversation it cannot prove.
  expect(seatState()?.agent_session).toBeUndefined();
  expect(seatState()?.launched).toEqual(RECORD.launched);
});

test('a state naming another session withholds the registry binding', async () => {
  record({ ...RECORD, agent_session: 'ses_stale' });
  const made = sources(SESSION_ID);
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  // The two records disagree: neither speaks for the seat.
  expect(io.out).toContain(`${SEAT}: left out: ${DOUBT}\n`);
  expect(io.err).toContain(DOUBT);
  expect(io.err).toContain(`0 seats repaired, 0 skipped (working), 1 refused (${SEAT}: ${DOUBT})\n`);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [] });
  expect(seatState()?.agent_session).toBe('ses_stale');
});

test('a record that ran another CLI is not this seat', async () => {
  record(RECORD, { cli: 'claude-code', session: 'ses_claude' });
  const made = sources('ses_claude');
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  expect(io.out).toContain(`${SEAT}: left out: ${DOUBT}\n`);
  expect(io.err).toContain(DOUBT);
  expect(io.err).toContain(`0 seats repaired, 0 skipped (working), 1 refused (${SEAT}: ${DOUBT})\n`);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [] });
});

test('a seat herdr names on another pane is not adopted', async () => {
  record(RECORD);
  const made = sources(SESSION_ID, { pane: 'w9:p1' });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  expect(io.out).toContain(`${SEAT}: left out: ${DOUBT}\n`);
  expect(io.err).toContain(DOUBT);
  expect(io.err).toContain(`0 seats repaired, 0 skipped (working), 1 refused (${SEAT}: ${DOUBT})\n`);
  // The recorded workspace is not closed: the match on the pane is what would allow it.
  expect(made.trace.closed).toEqual([]);
  expect(made.trace.typed).toEqual([]);
});

test('a working seat the registry proves is left as it is: nothing closed and nothing typed', async () => {
  record(RECORD);
  // The seat is the signed one — the record's conversation is the one the pane runs — and it is
  // mid-turn. Recognition does not take the pane: the run must not close it or type into it.
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, sources(SESSION_ID, { status: 'working' }).sources)).toBe(0);
  expect(dry.out).toContain(`  skip ${SEAT}: ${RESTORED_LINE}`);

  const made = sources(SESSION_ID, { status: 'working' });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(io.err).toContain(RESTORED_LINE);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [] });
  expect(seatState()?.agent_session).toBe(SESSION_ID);
});

test('a working pane nothing ties is left out as a working skip, nothing closed and nothing typed', async () => {
  record(RECORD);
  // The pane runs another conversation and reads working: this is the doubt the close refuses
  // to resolve. A working doubt is a restore skip, not a failed run: the record stays ready,
  // the reason is on stderr, and the run exits clean (`skipped (working)` is M in the owner
  // summary).
  const made = sources('ses_other', { status: 'working' });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(io.err).toContain(`  ${WORKING}`);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [] });
  expect(seatState()?.agent_session).toBeUndefined();
});

test('a record that names no session proves nothing and is left as it is', async () => {
  record(RECORD, { session: null });
  const made = sources(SESSION_ID);
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  expect(io.out).toContain(`${SEAT}: left out: ${DOUBT}\n`);
  expect(io.err).toContain(DOUBT);
  expect(io.err).toContain(`0 seats repaired, 0 skipped (working), 1 refused (${SEAT}: ${DOUBT})\n`);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [] });
});
