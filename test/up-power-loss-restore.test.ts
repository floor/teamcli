// The power-loss restore: a terminal host that comes back keeps the places (session, pane,
// workspace) and clears every agent name. These scenes drive the real `team up` against that
// world and pin the re-tie: the seat's own conversation, or — where no session id exists on
// either side — the declared CLI alone in its workspace at an idle prompt. Every refusal is
// pinned too: another conversation, a one-sided session, another CLI, another name, another
// pane, a stale record. All of it is synthetic: no live terminal host, no CLI, no signals.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, recordRenames, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T00:10:00Z');
const SESSION = 'acme';
const IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');

const SEAT = 'worker';
// Neutral place ids: a restore keeps the pane and the workspace, never a name.
const PANE = 'pane-restored';
const WORKSPACE = 'ws-restored';
// The record a launch wrote before the host restore: the pane, the workspace and the pids then.
const RECORD = { stage: 'ready' as const, pane: PANE, workspace: WORKSPACE, launched: { shell: 100, cli: [200] } };
// The pids the pane holds now: the host restored the process, so they are not the launched ones.
const RESTORED = { shell: 101, foreground: [201] };
const SESSION_ID = 'ses_codex';
const RESTORED_LINE = 'restored and re-tied';
const DOUBT = 'its pane holds a process this record cannot tie to the launch';

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

/** The state record and the registry binding, written together. `record` is the seat state (no
 *  session copy unless a scene gives one), `registry` what the agent record says the launch ran. */
function record(
  seatRecord: Record<string, unknown>,
  registry: { session?: string | null } = {},
): void {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = seatRecord as never;
  });
  registerAgent(home, {
    name: SEAT,
    signing: { model: 'GPT Sol', version: '6.1', role: 'coordinator' },
    lab: 'openai',
    cli: 'codex',
    launcher: null,
    launch: 'codex -m gpt-6.1-sol',
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
  renamed: { pane: string; name: string }[];
  reported: { pane: string; text: string }[];
};

type Scene = {
  /** The entry's name: null (the restore cleared it) unless a scene says otherwise. */
  name?: string | null;
  status?: string;
  /** The session the entry reports; null omits it as the host does when it reports none. */
  session?: string | null;
  foreground?: string[] | null;
  workspace?: string;
  agents?: HerdrAgent[] | null;
};

/** The readings one run takes: the host's list with the seat's pane unnamed, and a pane whose
 *  process is the restored one. */
function sources(scene: Scene = {}): { sources: UpSources; trace: Trace } {
  const trace: Trace = { created: [], closed: [], typed: [], runs: [], renamed: [], reported: [] };
  const madePanes = new Map<string, string>();
  const agents = (): HerdrAgent[] | null => scene.agents === null
    ? null
    : (scene.agents ?? [{
        name: scene.name === undefined ? null : scene.name,
        agent: 'codex',
        pane: PANE,
        workspace: scene.workspace ?? WORKSPACE,
        status: scene.status ?? 'idle',
        cwd: root,
        ...(scene.session === null ? {} : { session: scene.session ?? SESSION_ID }),
      }]);
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
    renameWorkspace: () => true,
    reportDisplayAgent(_session, pane, text) {
      trace.reported.push({ pane, text });
      return true;
    },
    renameAgent(_session, pane, name) {
      trace.renamed.push({ pane, name });
      return true;
    },
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    agentPanes: () => [PANE, ...madePanes.keys()],
    agents,
    paneText: (_session, pane) => madePanes.get(pane) ?? IDLE,
    foreground: () => (scene.foreground === undefined ? ['codex'] : scene.foreground),
    processInfo: () => RESTORED,
    sleep: async () => {},
    now: () => NOW,
  };
  recordRenames(launch);
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

/** Effects on the seat: an adoption creates nothing, closes nothing and types nothing. */
function touchedSeat(trace: Trace): { created: string[]; closed: string[]; typed: string[]; renamed: Trace['renamed'] } {
  return {
    created: trace.created.filter((label) => label === SEAT),
    closed: trace.closed,
    typed: trace.typed,
    renamed: trace.renamed,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-power-loss-')));
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

test('a restored pane the host lists unnamed, running the recorded conversation, is re-tied', async () => {
  record(RECORD);
  // The plan says both lines before anything runs: the rename and its sidebar line, then the
  // re-tie's own record line.
  const dry = testIo(root, { kind: 'owner' });
  expect(await runUp(['--dry-run'], dry, sources().sources)).toBe(0);
  expect(dry.out).toContain(`agent rename ${PANE} ${SEAT}`);
  expect(dry.out).toContain(`pane report-metadata ${PANE} --source team --display-agent 'GPT Sol 6.1 default'`);
  expect(dry.out).toContain(`skip ${SEAT}: ${RESTORED_LINE}: its conversation is the one the record names; left as it is`);
  expect(dry.out).not.toContain(DOUBT);
  // The dry run wrote nothing: the record still holds the old pids and no name was set.
  expect(seatState()?.launched).toEqual(RECORD.launched);

  const made = sources();
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(made.trace.renamed).toEqual([{ pane: PANE, name: SEAT }]);
  expect(made.trace.reported).toEqual([{ pane: PANE, text: 'GPT Sol 6.1 default' }]);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], renamed: [{ pane: PANE, name: SEAT }] });
  // The record takes the pids the pane holds now and the conversation the proof named.
  expect(seatState()?.stage).toBe('ready');
  expect(seatState()?.launched).toEqual({ shell: RESTORED.shell, cli: RESTORED.foreground });
  expect(seatState()?.agent_session).toBe(SESSION_ID);
  expect(seatState()?.pane).toBe(PANE);
  expect(seatState()?.workspace).toBe(WORKSPACE);
});

test('a restored pane with no session id on either side proves the declared CLI alone and idle', async () => {
  record(RECORD, { session: null });
  const made = sources({ session: null });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);
  expect(made.trace.renamed).toEqual([{ pane: PANE, name: SEAT }]);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], renamed: [{ pane: PANE, name: SEAT }] });
  expect(seatState()?.launched).toEqual({ shell: RESTORED.shell, cli: RESTORED.foreground });
  // A weak proof writes no conversation: the record never names one it did not see.
  expect(seatState()?.agent_session).toBeUndefined();
});

test('a pane holding another conversation is refused with its reason, never re-tied', async () => {
  record(RECORD);
  const made = sources({ session: 'ses_other' });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  const why = `its pane holds another conversation (ses_other; the record's launch ran ${SESSION_ID})`;
  expect(io.out).toContain(`${SEAT}: left out: ${why}\n`);
  expect(io.err).toContain(why);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], renamed: [] });
  expect(seatState()?.launched).toEqual(RECORD.launched);
});

test('a recorded conversation the pane does not report is refused, never weakened to the CLI', async () => {
  record(RECORD);
  const made = sources({ session: null });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  const why = `its pane reports no conversation; the record's launch ran ${SESSION_ID}`;
  expect(io.out).toContain(`${SEAT}: left out: ${why}\n`);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], renamed: [] });
  expect(seatState()?.launched).toEqual(RECORD.launched);
});

test('a pane reporting a conversation the record never named is refused the same way', async () => {
  record(RECORD, { session: null });
  const made = sources({ session: 'ses_live' });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  const why = 'its pane holds a conversation (ses_live) the record\'s launch never named';
  expect(io.out).toContain(`${SEAT}: left out: ${why}\n`);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], renamed: [] });
});

test('a matching conversation in a pane running another CLI is refused: both proofs check the CLI', async () => {
  record(RECORD);
  const made = sources({ foreground: ['claude'] });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  const why = `its pane runs claude; the seat's launch line runs codex`;
  expect(io.out).toContain(`${SEAT}: left out: ${why}\n`);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], renamed: [] });
});

test('a pane another seat is named on is never adopted over', async () => {
  record(RECORD);
  const made = sources({ name: 'other' });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  const why = 'its pane is named other; team never adopts a pane another seat owns';
  expect(io.out).toContain(`${SEAT}: left out: ${why}\n`);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], renamed: [] });
});

test('a pane in another workspace is refused with the record\'s place', async () => {
  record(RECORD);
  const made = sources({ workspace: 'ws-moved' });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  const why = `its pane is in workspace ws-moved; the record puts it in ${WORKSPACE}`;
  expect(io.out).toContain(`${SEAT}: left out: ${why}\n`);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], renamed: [] });
});

test('the weak proof refuses a workspace holding another pane', async () => {
  record(RECORD, { session: null });
  const made = sources({
    session: null,
    agents: [
      { name: null, agent: 'codex', pane: PANE, workspace: WORKSPACE, status: 'idle', cwd: root },
      { name: null, agent: 'codex', pane: 'pane-other', workspace: WORKSPACE, status: 'idle', cwd: root },
    ],
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  const why = 'its workspace holds another pane; team cannot tell which one is the seat';
  expect(io.out).toContain(`${SEAT}: left out: ${why}\n`);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], renamed: [] });
});

test('a seat whose record never reached ready is not a launch record and is never adopted', async () => {
  // Rules were never delivered to this seat: the record it left is not the launch record the
  // proof re-ties, and a pane the host cleared the name on proves nothing before ready. The run
  // refuses the session rather than guess.
  const incomplete = { stage: 'named' as const, pane: PANE, workspace: WORKSPACE };
  record(incomplete);
  const made = sources();
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  expect(io.err).toContain("this file's state doesn't record");
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], renamed: [] });
  expect(seatState()).toEqual(incomplete);
});

test('an unreadable agent list refuses the run and adopts nothing', async () => {
  record(RECORD);
  const made = sources({ agents: null });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(1);
  expect(io.err).toContain(`session ${SESSION} runs, and its agents can't be read`);
  expect(touchedSeat(made.trace)).toEqual({ created: [], closed: [], typed: [], renamed: [] });
  expect(seatState()?.launched).toEqual(RECORD.launched);
});

test('after adoption the next up leaves the seat as it is: the record is what proves it now', async () => {
  record(RECORD);
  const first = sources();
  expect(await runUp([], testIo(root, { kind: 'owner' }), first.sources)).toBe(0);
  expect(first.trace.renamed).toEqual([{ pane: PANE, name: SEAT }]);

  // The second run sees the name back and the process the record now names: nothing to do.
  const second = sources({ name: SEAT });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, second.sources)).toBe(0);
  expect(second.trace.renamed).toEqual([]);
  expect(second.trace.created).toEqual([]);
  expect(second.trace.closed).toEqual([]);
  expect(second.trace.typed).toEqual([]);
  expect(seatState()?.launched).toEqual({ shell: RESTORED.shell, cli: RESTORED.foreground });
  expect(seatState()?.agent_session).toBe(SESSION_ID);
});
