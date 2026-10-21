// Independent coverage for the resumed relaunch of a restored Codex seat. Recognition can prove
// the seat from the agent registry alone, and the new launch line must carry the exact recorded
// id, built on the launcher the registry recorded; the records must then follow what the new pane
// really runs. These scenes drive `team restart` end to end through its injected reads. The
// launcher is a synthetic fixture: in this fixture a launch that names no conversation starts a
// fresh one, so the fake's new pane reports the conversation its argv names. A bare launch can
// therefore never pass as a resumed one, and a record that carries the old id without the line
// carrying it is a false healing.
//
// Every pane, socket and home here is synthetic; no live herdr session or CLI home is read.
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { findAgent, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-21T09:10:00Z');
// The captured idle screen, with the banner naming the model this scene's file declares.
const IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');
const EXIT_TYPED = readFileSync(new URL('./fixtures/codex/0.161.0/exit-typed.txt', import.meta.url), 'utf8');

const TEAM_YAML = `format: 1
project: acme
coordinator: lead
operator: lead
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
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
`;

const SEAT = 'worker';
const SESSION = 'acme';
const SESSION_ID = 'ses_codex';
// The line the registry recorded for the launch, distinct from the file's declaration: a repair
// built on the recorded launcher keeps this argument, one that ignores the record does not.
const RECORDED_LAUNCH = 'codex -m gpt-6.1-sol --profile recorded';
const DECLARED_LAUNCH = 'codex -m gpt-6.1-sol';
const FRESH = 'ses_fresh';
const REPLACED = 'has a process in its old pane that is not the signed seat; left as it is';

type Fixture = { base: string; root: string; home: string; file: string; dir: string; yaml: string };

const madeDirs: string[] = [];
afterEach(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-codex-resume-')));
  madeDirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  const yaml = TEAM_YAML.replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:\n`);
  const file = join(dir, 'team.yaml');
  writeFileSync(file, yaml);
  return { base, root, home, file, dir, yaml };
}

type Did = { typed: string[]; pasted: string[]; closed: string[]; created: number; runs: string[] };

function makeHarness(
  fixture: Fixture,
  opts: { liveSession: string; listedPane?: string },
): { sources: RestartSources; did: Did } {
  const did: Did = { typed: [], pasted: [], closed: [], created: 0, runs: [] };
  let workerAlive = true;
  let oldText = IDLE;
  let shelled = false;
  let turnStarted = false;
  // The new pane's herdr listing reports the conversation the launch argv names. A bare launch
  // starts a fresh one; only a line carrying the recorded id reports that id back. This is what
  // makes a record that keeps the old id without resuming it a false healing.
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string; session: string }>();

  const currentAgents = () => {
    const list = [];
    if (workerAlive) {
      list.push({
        name: SEAT, agent: 'codex', pane: opts.listedPane ?? 'pane-old', workspace: 'ws-old', status: 'idle',
        cwd: fixture.root, session: opts.liveSession,
      });
    }
    for (const [pane, slot] of newPanes) {
      if (slot.agent) {
        list.push({
          name: slot.name ?? SEAT, agent: 'codex', pane, workspace: slot.workspace, status: 'idle',
          cwd: fixture.root, session: slot.session,
        });
      }
    }
    return list;
  };

  const downLaunch: DownLaunch = {
    typeText(_session, _pane, text) {
      did.typed.push(text);
      oldText = text === '/exit' ? EXIT_TYPED : IDLE.replace('› Ask Codex to do anything', `› ${text}`);
      return true;
    },
    sendKey: () => true,
    pressEnter() {
      shelled = true;
      return true;
    },
    agentPanes: () => currentAgents().map((agent) => agent.pane),
    closeWorkspace(_session, workspace) {
      did.closed.push(workspace);
      if (workspace === 'ws-old') workerAlive = false;
      return true;
    },
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
      did.created += 1;
      const pane = did.created === 1 ? 'pane-new' : `pane-new-${did.created}`;
      const workspace = did.created === 1 ? 'ws-new' : `ws-new-${did.created}`;
      newPanes.set(pane, { text: IDLE, agent: false, name: null, workspace, session: FRESH });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      const slot = newPanes.get(pane);
      if (slot) {
        slot.agent = true;
        slot.session = command.includes(SESSION_ID) ? SESSION_ID : FRESH;
      }
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = newPanes.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace: downLaunch.closeWorkspace,
    agentPanes: () => currentAgents().map((agent) => agent.pane),
    agents: () => currentAgents(),
    paneText(_session, pane) {
      if (pane === 'pane-old') return oldText;
      return newPanes.get(pane)?.text ?? IDLE;
    },
    typeText(_session, pane, text) {
      did.pasted.push(text);
      const slot = newPanes.get(pane);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      if (slot) slot.text = IDLE.replace('› Ask Codex to do anything', `› ${pasted ? (pasted[1] ?? '') : text}`);
      return true;
    },
    pressEnter(_session, pane) {
      const slot = newPanes.get(pane);
      if (slot) {
        slot.text = IDLE;
        turnStarted = true;
      }
      return true;
    },
    agentStatus: () => (turnStarted ? 'working' : 'idle'),
    foreground: () => ['codex'],
    // The restored process: not the pids the seat's state recorded.
    processInfo: () => ({ shell: 101, foreground: [201] }),
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
    agents: () => currentAgents(),
    workspaces: () => currentAgents().map((agent) => ({ id: agent.workspace })),
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: (_session, pane) => (pane === 'pane-old' ? oldText : newPanes.get(pane)?.text ?? IDLE),
    status: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : ['codex']),
    now: () => NOW,
    sleep: async () => {},
    launch: downLaunch,
    upLaunch,
    doctor,
  };

  return { sources, did };
}

/** A seat restored by the host: its state has the launched pids and the pane. The registry holds
 *  the conversation it ran and the launcher it ran it through. `stateSession` writes the state's
 *  own session copy; omitted, the record is registry-only, as a pre-restore state may be. */
function restored(opts: {
  liveSession?: string;
  stateSession?: string;
  cli?: string;
  registrySession?: string | null;
  listedPane?: string;
} = {}) {
  const fixture = makeFixture();
  updateState(fixture.dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = {
      stage: 'ready',
      pane: 'pane-old',
      workspace: 'ws-old',
      id: 'seat_0123456789ab',
      launched: { shell: 100, cli: [200] },
      ...(opts.stateSession === undefined ? {} : { agent_session: opts.stateSession }),
    };
  });
  const cli = opts.cli ?? 'codex';
  registerAgent(fixture.home, {
    name: SEAT,
    signing: { model: 'GPT Sol', version: '6.1', role: 'implementer' },
    lab: cli === 'claude-code' ? 'anthropic' : 'openai',
    cli,
    launcher: null,
    launch: cli === 'claude-code' ? 'claude --model claude-opus-5-5' : RECORDED_LAUNCH,
    reach: {
      team: teamIdOf(fixture.root),
      seat: SEAT,
      session: SESSION,
      pane: 'pane-old',
      address: null,
      ...(opts.registrySession === null
        ? {}
        : { agent_session: opts.registrySession ?? (cli === 'claude-code' ? 'ses_claude' : SESSION_ID) }),
    },
    seat_handle: 'seat_0123456789ab',
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  return {
    fixture,
    run: makeHarness(fixture, { liveSession: opts.liveSession ?? SESSION_ID, ...(opts.listedPane ? { listedPane: opts.listedPane } : {}) }),
  };
}

const recordedSession = (fixture: Fixture) =>
  findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: SEAT })?.reach.agent_session;
const stateSession = (fixture: Fixture) =>
  readState(fixture.dir).sessions[SESSION]?.seats[SEAT]?.agent_session;

describe('a restored Codex seat resumes the conversation the registry recorded', () => {
  test('the repair relaunches into the exact conversation through the recorded launcher', async () => {
    const { fixture, run } = restored();
    // The dry run already says the line the launch would run: the recorded launcher plus the id.
    const dry = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart([SEAT, '--dry-run'], dry, run.sources)).toBe(0);
    expect(dry.out).toContain('--profile recorded');
    expect(dry.out).toContain(SESSION_ID);

    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart([SEAT], io, run.sources)).toBe(0);
    expect(io.err).toBe('');
    expect(run.did.closed).toContain('ws-old');
    // One line, built on the launcher the registry recorded, carrying the exact conversation.
    expect(run.did.runs.length).toBe(1);
    const line = run.did.runs[0] ?? '';
    expect(line).toContain('--profile recorded');
    expect(line).toContain(SESSION_ID);
    expect(line).not.toBe(DECLARED_LAUNCH);
    // The new pane really runs that conversation, and both records follow the pane.
    expect(stateSession(fixture)).toBe(SESSION_ID);
    expect(recordedSession(fixture)).toBe(SESSION_ID);
  });

  test('a state copy naming another session refuses the repair and resumes nothing', async () => {
    const { fixture, run } = restored({ stateSession: 'ses_stale' });
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart([SEAT], io, run.sources)).toBe(1);
    expect(io.err).toContain(REPLACED);
    expect(run.did.runs).toEqual([]);
    expect(run.did.closed).toEqual([]);
    expect(run.did.typed).toEqual([]);
    // Neither record is re-pointed at a conversation the run could not prove.
    expect(stateSession(fixture)).toBe('ses_stale');
    expect(recordedSession(fixture)).toBe(SESSION_ID);
  });

  test('a record that ran another CLI refuses the repair and resumes nothing', async () => {
    const { fixture, run } = restored({ cli: 'claude-code', liveSession: 'ses_claude' });
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart([SEAT], io, run.sources)).toBe(1);
    expect(run.did.runs).toEqual([]);
    expect(run.did.closed).toEqual([]);
  });

  test('a seat herdr names on another pane refuses the repair and resumes nothing', async () => {
    const { fixture, run } = restored({ listedPane: 'pane-other' });
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart([SEAT], io, run.sources)).toBe(1);
    expect(run.did.runs).toEqual([]);
    expect(run.did.closed).toEqual([]);
  });

  test('a live conversation that is not the recorded one refuses the repair', async () => {
    const { fixture, run } = restored({ liveSession: 'ses_other' });
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart([SEAT], io, run.sources)).toBe(1);
    expect(io.err).toContain(REPLACED);
    expect(run.did.runs).toEqual([]);
    expect(run.did.closed).toEqual([]);
  });

  test('--abandon is explicitly fresh: no recorded id on the line and no stale session in the record', async () => {
    // The caller takes the pane knowing its conversation is not the seat's. The relaunch is a
    // fresh one: neither the registry's id nor the pane's appears in the argv, and the record
    // follows the conversation the new pane actually runs.
    const { fixture, run } = restored({ liveSession: 'ses_other' });
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart([SEAT, '--abandon'], io, run.sources)).toBe(0);
    expect(run.did.typed).toEqual([]);
    expect(run.did.closed).toContain('ws-old');
    expect(run.did.runs.length).toBe(1);
    const line = run.did.runs[0] ?? '';
    expect(line).not.toContain(SESSION_ID);
    expect(line).not.toContain('ses_other');
    // The fresh launch's pane reports a new conversation; the records carry that one, never the
    // abandoned id masquerading as resumed.
    expect(stateSession(fixture)).toBe(FRESH);
    expect(recordedSession(fixture)).toBe(FRESH);
  });
});
