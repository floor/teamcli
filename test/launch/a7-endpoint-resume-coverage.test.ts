// Independent cross-lab coverage for a resumed seat on its managed Codex endpoint. The scenes
// here drive the product's own resume carry (`withResume`) through the launch seam, and a whole
// `team restart` through its injected reads, rather than reusing the branch author's scenes.
//
// What they pin:
// - the endpoint is started from the *resumed* command, so the line's `-a`/`-s` reach it as
//   config even when the attach sheds them from the TUI line;
// - a restart whose live pane runs another conversation never puts the recorded thread on a
//   launch line, and a second live agent of the seat's name is refused before any effect;
// - a registry record that ran another CLI is never a resume source.
// Every pane, socket and home is synthetic; no live pane session or CLI home is read.
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DownLaunch } from '../../src/commands/down.ts';
import { runRestart, type RestartSources } from '../../src/commands/restart.ts';
import type { Launch } from '../../src/commands/up.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import type { Step } from '../../src/launch/plan.ts';
import { withResume } from '../../src/profiles/profile.ts';
import { findAgent, registerAgent } from '../../src/registry/agents.ts';
import { recordedSeatSession } from '../../src/registry/resume.ts';
import { teamIdOf } from '../../src/registry/teams.ts';
import { readState, updateState } from '../../src/state.ts';
import { emptySession } from '../../src/state.ts';
import { gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-31T09:00:00Z');
const STATE_DIR = '/tmp/acme/.agents';
const ENDPOINT_URL = 'unix:///tmp/acme/endpoint.sock';
// The seat's own line: permissions and one config pair the endpoint must keep even though the
// attached TUI sheds the permission words.
const LINE = 'codex -m gpt-6.1-sol -a never -s danger-full-access -c model_reasoning_effort=high';
const RECORDED = 'ses_01h7recorded';
// The recorded thread, selected by the product's own resume carry.
const RESUMED = withResume('codex', LINE, RECORDED) as string;

const IDLE = readFileSync(new URL('../fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');
const EXIT_TYPED = readFileSync(new URL('../fixtures/codex/0.161.0/exit-typed.txt', import.meta.url), 'utf8');

describe('the launch seam starts the endpoint from the resumed command', () => {
  type Seen = { dir: string; session: string; seat: string; cwd?: string; config?: string[]; pane?: string };

  function launchSteps(): Step[] {
    return [
      {
        kind: 'run',
        argv: [],
        do: {
          do: 'launch',
          seat: 'coder',
          label: 'coder',
          command: RESUMED,
          pane: 'p1',
          cli: 'codex',
          cwd: '/seat/folder',
          codexEndpoint: { dir: STATE_DIR },
        },
      },
      { kind: 'skip', text: 'ready', do: { do: 'record', seat: 'coder', record: { kind: 'ready' } } },
    ];
  }

  function hostOf(calls: string[], said: string[], seen: Seen[]): Host {
    return {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
      paneRun: (_session, _pane, command) => {
        calls.push(`paneRun:${command}`);
        return true;
      },
      managedCodexEndpoint: async (input: Seen) => {
        seen.push(input);
        calls.push('managed');
        return { kind: 'up', url: ENDPOINT_URL, started: true };
      },
      stopManagedCodexEndpoint: () => ({ stopped: true }),
      typeLine: () => false,
      renameAgent: () => true,
      closeWorkspace: () => true,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => [],
      classify: () => 'idle',
      sleep: async () => {},
      now: () => 0,
      allow: () => null,
      record: () => {},
      running: () => {},
      drop: () => {},
      say: (line) => { said.push(line); },
      log: () => {},
    };
  }

  test('the resumed line keeps its thread, and its permissions are the endpoint config', async () => {
    const calls: string[] = [];
    const said: string[] = [];
    const seen: Seen[] = [];
    await executePlan(launchSteps(), 'acme', hostOf(calls, said, seen));

    // The resume is carried by the product, not typed here.
    expect(RESUMED).toBe(`${LINE} resume ${RECORDED}`);
    // The endpoint is configured from the command whose thread is being resumed: the -a/-s
    // words the attached TUI cannot take are present here as their config keys, and the
    // remaining config pair rides along.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.config).toEqual([
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="danger-full-access"',
      '-c', 'model_reasoning_effort=high',
    ]);
    // And the line the pane runs selects that same thread with the permission flags shed.
    expect(calls).toEqual([
      'managed',
      `paneRun:codex -m gpt-6.1-sol -c model_reasoning_effort=high resume ${RECORDED} --remote ${ENDPOINT_URL}`,
    ]);
    expect(said.join('')).not.toContain('starts a fresh Codex thread');
  });
});

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
    launch: ${LINE}
`;

type Fixture = { base: string; root: string; home: string; file: string; dir: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-a7-resume-')));
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
  return { base, root, home, file, dir };
}

type Did = { typed: string[]; pasted: string[]; closed: string[]; created: number; runs: string[] };

/** A synthetic restart world: one recorded Codex pane whose process is still the one team
 *  launched, a registry binding, and a launcher that paints the new pane as the CLI's own idle
 *  screen. `liveSession` is the conversation the live pane reports; `phantom` adds a second
 *  live agent of the seat's name on another pane. */
function makeHarness(
  fixture: Fixture,
  opts: { liveSession?: string; phantomSession?: string; endpoint?: { configs: (string[] | undefined)[] } },
): { sources: RestartSources; did: Did } {
  const did: Did = { typed: [], pasted: [], closed: [], created: 0, runs: [] };
  let workerAlive = true;
  let oldText = IDLE;
  let shelled = false;
  let turnStarted = false;
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string; session?: string }>();

  const currentAgents = () => {
    const list = [];
    if (workerAlive) {
      list.push({
        name: 'worker', agent: 'codex', pane: 'pane-old', workspace: 'ws-old', status: 'idle',
        cwd: fixture.root,
        ...(opts.liveSession === undefined ? {} : { session: opts.liveSession }),
      });
    }
    if (opts.phantomSession !== undefined) {
      list.push({
        name: 'worker', agent: 'codex', pane: 'pane-other', workspace: 'ws-other', status: 'idle',
        cwd: fixture.root, session: opts.phantomSession,
      });
    }
    for (const [pane, slot] of newPanes) {
      if (slot.agent) {
        list.push({
          name: slot.name ?? 'worker', agent: 'codex', pane, workspace: slot.workspace, status: 'idle',
          cwd: fixture.root,
          ...(slot.session === undefined ? {} : { session: slot.session }),
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
      newPanes.set(pane, { text: IDLE, agent: false, name: null, workspace });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      const slot = newPanes.get(pane);
      if (slot) {
        slot.agent = true;
        // The measured CLI reports the thread its command selected, as the live agent list reads it.
        slot.session = /(?:^|\s)resume\s+(\S+)/.exec(command)?.[1];
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
    // The pane still holds the process this launch recorded: the pid verdict is `same`.
    processInfo: () => ({ shell: 101, foreground: [201] }),
    sleep: async () => {},
    now: () => NOW,
  };
  if (opts.endpoint !== undefined) {
    upLaunch.codexEndpoint = {
      managed: async (input) => {
        opts.endpoint!.configs.push(input.config);
        return { kind: 'up', url: 'unix:///tmp/acme/endpoint.sock', started: true };
      },
      stop: () => ({ stopped: true }),
    };
  }

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

/** A seat whose state and registry agree on the recorded conversation, in the pane whose
 *  process is still the one the state recorded. */
function recorded(opts: { liveSession?: string; phantomSession?: string } = {}, endpoint = true) {
  const fixture = makeFixture();
  const seatId = 'seat_0123456789ab';
  updateState(fixture.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.worker = {
      stage: 'ready',
      pane: 'pane-old',
      workspace: 'ws-old',
      id: seatId,
      launched: { shell: 101, cli: [201] },
      agent_session: RECORDED,
    };
  });
  registerAgent(fixture.home, {
    name: 'worker',
    signing: { model: 'GPT Sol', version: '6.1', role: 'implementer' },
    lab: 'openai',
    cli: 'codex',
    launcher: null,
    launch: LINE,
    reach: {
      team: teamIdOf(fixture.root),
      seat: 'worker',
      session: 'acme',
      pane: 'pane-old',
      address: null,
      agent_session: RECORDED,
    },
    seat_handle: seatId,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  const configs: (string[] | undefined)[] = [];
  const run = makeHarness(fixture, { ...opts, ...(endpoint ? { endpoint: { configs } } : {}) });
  return { fixture, run, configs };
}

const registrySession = (fixture: Fixture) =>
  findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })?.reach.agent_session;
const stateSession = (fixture: Fixture) => readState(fixture.dir).sessions.acme?.seats.worker?.agent_session;

describe('a managed restart of a seat whose pane still runs the recorded conversation', () => {
  test('resumes the recorded thread on an endpoint carrying the line permissions', async () => {
    const { fixture, run, configs } = recorded({ liveSession: RECORDED });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(io.err).toBe('');
    expect(run.did.closed).toContain('ws-old');
    // One launch, selecting exactly the recorded thread, with the permission flags shed.
    expect(run.did.runs).toHaveLength(1);
    const command = run.did.runs[0] ?? '';
    expect(command.match(/(?:^|\s)resume(?=\s|$)/g)).toHaveLength(1);
    expect(command.startsWith(`AGENT_UNATTENDED=1 codex -m gpt-6.1-sol -c model_reasoning_effort=high resume ${RECORDED} --no-alt-screen -c `)).toBe(true);
    expect(command.endsWith(`--remote ${ENDPOINT_URL}`)).toBe(true);
    // The permission words live on the endpoint now: the attached line carries neither them nor
    // their flags. The seat's other config and its inbox server stay on the line.
    expect(command).not.toMatch(/(?:^|\s)(?:-a|-s)(?=\s|$)/);
    expect(command).not.toContain('never');
    expect(command).not.toContain('danger-full-access');
    expect(command).toContain('mcp_servers.team_inbox.command=');
    // The endpoint was configured from the resumed command, so the attached thread's turns run
    // under the seat's permissions, not an app-server default.
    expect(configs).toHaveLength(1);
    expect(configs[0]!.slice(0, 6)).toEqual([
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="danger-full-access"',
      '-c', 'model_reasoning_effort=high',
    ]);
    expect(configs[0]!.join(' ')).toContain('mcp_servers.team_inbox.command=');
    // Both records still name the one thread now live in the new pane.
    expect(stateSession(fixture)).toBe(RECORDED);
    expect(registrySession(fixture)).toBe(RECORDED);
    expect(io.err).not.toContain('starts a fresh Codex thread');
  });

  test('a pane running another conversation is restarted fresh: the recorded thread is never launched beside it', async () => {
    const { fixture, run, configs } = recorded({ liveSession: 'ses_other' });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    // The refusal line names what was seen, and the launch line carries no resume at all.
    expect(io.err).toContain('team restart: worker: not resuming its recorded session (its live agent session is not the recorded one)');
    expect(run.did.closed).toContain('ws-old');
    expect(run.did.runs).toHaveLength(1);
    const command = run.did.runs[0] ?? '';
    expect(command.match(/(?:^|\s)resume(?=\s|$)/g)).toBeNull();
    // A fresh line keeps its own permission words, once each, and attaches as it is.
    expect(command.startsWith('AGENT_UNATTENDED=1 codex -m gpt-6.1-sol -a never -s danger-full-access -c model_reasoning_effort=high --no-alt-screen -c ')).toBe(true);
    expect(command.endsWith(`--remote ${ENDPOINT_URL}`)).toBe(true);
    expect(command.match(/(?:^|\s)-a(?=\s|$)/g)).toHaveLength(1);
    expect(command.match(/(?:^|\s)-s(?=\s|$)/g)).toHaveLength(1);
    // The endpoint still receives the line's configuration.
    expect(configs).toHaveLength(1);
    expect(configs[0]!.slice(0, 6)).toEqual([
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="danger-full-access"',
      '-c', 'model_reasoning_effort=high',
    ]);
  });

  test('a second live agent of the seat name is refused before any endpoint or stop', async () => {
    const { fixture, run, configs } = recorded({ liveSession: 'ses_other', phantomSession: RECORDED });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(1);
    expect(io.err).toContain('worker: herdr lists more than one agent of this name; left as it is');
    expect(run.did.closed).toEqual([]);
    expect(run.did.created).toBe(0);
    expect(run.did.runs).toEqual([]);
    expect(configs).toEqual([]);
    expect(stateSession(fixture)).toBe(RECORDED);
    expect(registrySession(fixture)).toBe(RECORDED);
  });
});

describe('a registry record that ran another CLI is never a resume source', () => {
  test('the record is refused, and the seat keeps launching fresh', () => {
    const fixture = makeFixture();
    const seatId = 'seat_0123456789ab';
    registerAgent(fixture.home, {
      name: 'worker',
      signing: { model: 'GPT Sol', version: '6.1', role: 'implementer' },
      lab: 'openai',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude --model claude-opus-5-5',
      reach: {
        team: teamIdOf(fixture.root),
        seat: 'worker',
        session: 'acme',
        pane: 'pane-old',
        address: null,
        agent_session: RECORDED,
      },
      seat_handle: seatId,
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    });
    const state = { stage: 'ready' as const, pane: 'pane-old', workspace: 'ws-old', id: seatId, agent_session: RECORDED };

    expect(recordedSeatSession({
      home: fixture.home,
      root: fixture.root,
      herdrSession: 'acme',
      seat: { name: 'worker', cli: 'codex' },
      state,
    })).toEqual({ kind: 'refused', why: 'the record ran claude-code, the seat now declares codex' });
  });
});
