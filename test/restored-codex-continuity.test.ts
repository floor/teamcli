// Independent coverage for recognizing a host-restored Codex seat. Codex's launch line carries
// no resume flag, and a state file written before the restore may carry no session copy at all;
// the only proof that the process in the seat's pane is the seat is the agent registry's own
// binding, compared with the live agent's session. These scenes drive `team restart` end to end
// through its injected reads: a restored Codex pane is replaced and relaunched through its
// declared line, a pane running another conversation is still left as it is, and an explicit
// `--abandon` closes a doubt pane without typing into it.
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
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { findAgent } from '../src/registry/agents.ts';
import { testIo, gitEnv } from './helpers.ts';

const NOW = new Date('2026-10-21T07:45:00Z');
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

type Fixture = { base: string; root: string; home: string; file: string; dir: string; yaml: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-codex-restore-')));
  made.push(base);
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

/** The injected reads a restart takes: one old Codex pane, herdr's listing, and a launcher that
 *  paints the new pane as the CLI's own idle screen. The restored process has different pids
 *  from the ones the seat's state recorded, exactly as a host restore leaves it. */
function makeHarness(
  fixture: Fixture,
  opts: { liveSession: string },
): { sources: RestartSources; did: Did } {
  const did: Did = { typed: [], pasted: [], closed: [], created: 0, runs: [] };
  let workerAlive = true;
  let oldText = IDLE;
  let shelled = false;
  let turnStarted = false;
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();

  const currentAgents = () => {
    const list = [];
    if (workerAlive) {
      list.push({
        name: 'worker', agent: 'codex', pane: 'pane-old', workspace: 'ws-old', status: 'idle',
        cwd: fixture.root, session: opts.liveSession,
      });
    }
    for (const [pane, slot] of newPanes) {
      if (slot.agent) {
        list.push({ name: slot.name ?? 'worker', agent: 'codex', pane, workspace: slot.workspace, status: 'idle', cwd: fixture.root });
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
      newPanes.set(pane, { text: IDLE, agent: false, name: null, workspace });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      const slot = newPanes.get(pane);
      if (slot) slot.agent = true;
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
    // The rules line arrives as a bracketed paste; the CLI's composer replaces its placeholder.
    typeText(_session, pane, text) {
      did.pasted.push(text);
      const slot = newPanes.get(pane);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      // This CLI takes the rules as a plain line, as `-a never` launches it here: the composer
      // draws the text with or without the bracketed-paste markers.
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

/** A seat restored by the host: its state has the launched pids and the pane, and no session
 *  copy. The registry holds the conversation it resumed; herdr's live agent reports that same
 *  session (`liveSession` changes only the conversation the pane is running). */
function restored(liveSession = 'ses_codex') {
  const fixture = makeFixture();
  updateState(fixture.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.worker = {
      stage: 'ready',
      pane: 'pane-old',
      workspace: 'ws-old',
      id: 'seat_0123456789ab',
      launched: { shell: 100, cli: [200] },
    };
  });
  registerAgent(fixture.home, {
    name: 'worker',
    signing: { model: 'GPT Sol', version: '6.1', role: 'implementer' },
    lab: 'openai',
    cli: 'codex',
    launcher: null,
    launch: 'codex -m gpt-6.1-sol',
    reach: {
      team: teamIdOf(fixture.root),
      seat: 'worker',
      session: 'acme',
      pane: 'pane-old',
      address: null,
      agent_session: 'ses_codex',
    },
    seat_handle: 'seat_0123456789ab',
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  return { fixture, run: makeHarness(fixture, { liveSession }) };
}

const recordedSession = (fixture: Fixture) =>
  findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })?.reach.agent_session;

describe('a host-restored Codex seat keeps its registry conversation', () => {
  test('the registry binding alone proves the pane and the seat is relaunched through its line', async () => {
    const { fixture, run } = restored();
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.closed).toContain('ws-old');
    expect(run.did.created).toBe(1);
    expect(run.did.runs.join('\n')).toContain('codex -m gpt-6.1-sol');
    // Codex has no resume flag: the conversation stays the registry's, and the launch is bare.
    expect(run.did.runs.join('\n')).not.toContain('--resume');
    expect(io.err).toBe('');
    // The record keeps the conversation the restored process ran.
    expect(recordedSession(fixture)).toBe('ses_codex');
  });

  test('a restored pane running another conversation is left as it is', async () => {
    const { fixture, run } = restored('ses_other');
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(1);
    expect(io.err).toContain('has a process in its old pane that is not the signed seat; left as it is');
    expect(run.did.closed).toEqual([]);
    expect(run.did.created).toBe(0);
    expect(run.did.runs).toEqual([]);
  });

  test('--abandon closes a doubt pane without typing and relaunches the seat', async () => {
    // The live reviewer shape: herdr names the seat on its recorded pane, the pids are not the
    // launched ones, and no recorded session proves what came back. The caller's explicit
    // --abandon takes the pane: the workspace is closed without a key, and the launcher starts
    // a fresh one. Nothing is read out of the pane or typed into it first.
    const { fixture, run } = restored('ses_other');
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--abandon'], io, run.sources)).toBe(0);
    expect(run.did.typed).toEqual([]);
    expect(run.did.closed).toContain('ws-old');
    expect(run.did.created).toBe(1);
    expect(run.did.runs.join('\n')).toContain('codex -m gpt-6.1-sol');
    // Fresh start, and the run says why: the record no longer binds the live session, so the
    // resume was dropped under the run lock before the launch.
    expect(io.err).toBe(
      'team restart: worker: not resuming its recorded session (its live agent session is not the recorded one)\n',
    );
  });

  test('the refusal names the command that would take the pane', async () => {
    const { fixture, run } = restored('ses_other');
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--json'], io, run.sources)).toBe(1);
    const doc = JSON.parse(io.out) as { error: { id: string; message: string; repair: string | null } };
    expect(doc.error.id).toBe('restart.replaced');
    expect(doc.error.repair).toBe('team restart worker --abandon');
    expect(run.did.closed).toEqual([]);
  });
});
