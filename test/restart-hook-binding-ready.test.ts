// Independent synthetic probe of the restart lifecycle's fresh hook binding: what the launch's
// settings file carries against what the project state persists, read at the first readiness
// poll and once the run returns. No live pane, no CLI home: every pane, screen and process here
// is synthetic, and the settings and state files are the run's own under a temp project root.
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-21T08:00:00Z');
const SESSION = 'acme';
const SEAT = 'worker';

const TEAM_YAML = `format: 1
project: acme
coordinator: lead
operator: ops
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

  - role: coordinator
    name: ops
    label: ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

type Fixture = { base: string; root: string; home: string; file: string; dir: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-rh-')));
  made.push(base);
  const root = join(base, SESSION);
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

/** What the two files say at one instant: the binding the launch's settings file carries in its
 *  presence hooks, and the binding the project state persists for the seat. */
type Snap = {
  settingsBinding?: string;
  stateBinding?: string;
  stage?: string;
  pane?: string;
  launched?: unknown;
  hasPane?: boolean;
};

function snap(fixture: Fixture): Snap {
  const path = cliHookSettingsPath(fixture.dir, SESSION, SEAT);
  const text = path !== null && existsSync(path) ? readFileSync(path, 'utf8') : '';
  const named = /--binding\s+'?([A-Za-z0-9_]+)'?/.exec(text);
  const seat = readState(fixture.dir).sessions[SESSION]?.seats[SEAT];
  return {
    settingsBinding: named?.[1],
    stateBinding: seat?.presence_binding,
    stage: seat?.stage,
    pane: seat?.pane,
    launched: seat?.launched,
    hasPane: seat?.pane !== undefined,
  };
}

function seed(fixture: Fixture): void {
  updateState(fixture.dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
  });
}

type Harness = {
  sources: RestartSources;
  did: { typed: string[]; pasted: string[]; closed: string[]; created: number; runs: string[] };
};

function makeHarness(
  fixture: Fixture,
  opts: { onFirstNewPanePoll?: () => void; runFails?: boolean; newPaneScreen?: string; agentBusy?: boolean } = {},
): Harness {
  const did = { typed: [] as string[], pasted: [] as string[], closed: [] as string[], created: 0, runs: [] as string[] };
  let workerAlive = true;
  let boxedText = claudeBox('');
  let shelled = false;
  let turnStarted = false;
  let clock = NOW.getTime();
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();
  let polled = false;
  const polledOnce = (): void => {
    if (polled) return;
    polled = true;
    opts.onFirstNewPanePoll?.();
  };
  const newPane = (): string | undefined => (newPanes.has('pane-new') ? 'pane-new' : undefined);

  const currentAgents = (): HerdrAgent[] => {
    const list: HerdrAgent[] = [
      { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: fixture.root },
      { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle', cwd: fixture.root },
    ];
    if (workerAlive) {
      list.push({ name: SEAT, agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle', cwd: fixture.root });
    }
    for (const [pane, slot] of newPanes) {
      if (slot.agent) {
        list.push({ name: slot.name ?? '', agent: 'claude-code', pane, workspace: slot.workspace, status: 'idle', cwd: fixture.root });
      }
    }
    return list;
  };

  const downLaunch: DownLaunch = {
    typeText(_session, _pane, text) {
      did.typed.push(text);
      boxedText = claudeBox(text);
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
    now: () => new Date(clock),
  };

  const upLaunch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      did.created += 1;
      const pane = did.created === 1 ? 'pane-new' : `pane-new-${did.created}`;
      const workspace = did.created === 1 ? 'ws-new' : `ws-new-${did.created}`;
      newPanes.set(pane, { text: opts.newPaneScreen ?? CLAUDE_IDLE, agent: false, name: null, workspace });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      if (opts.runFails === true) return false;
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
      if (pane === newPane()) polledOnce();
      const slot = newPanes.get(pane);
      return slot?.text ?? CLAUDE_IDLE;
    },
    typeText(_session, pane, text) {
      did.pasted.push(text);
      const slot = newPanes.get(pane);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      if (slot && pasted) slot.text = claudeBox(pasted[1] ?? '');
      return true;
    },
    pressEnter(_session, pane) {
      const slot = newPanes.get(pane);
      if (slot) {
        // The rules line reaches the CLI: the composer clears and its first turn starts.
        slot.text = opts.newPaneScreen ?? CLAUDE_IDLE;
        turnStarted = true;
      }
      return true;
    },
    agentStatus(_session, pane) {
      if (pane === newPane()) polledOnce();
      if (opts.agentBusy === true) return 'working';
      return turnStarted ? 'working' : 'idle';
    },
    foreground: () => ['claude'],
    sleep: async () => {
      clock += 2000;
    },
    now: () => new Date(clock),
  };

  const doctor: DoctorSources = {
    version: () => '2.1.303',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => new Date(clock),
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
    screenText: () => boxedText,
    status: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : ['claude']),
    now: () => new Date(clock),
    sleep: async () => {
      clock += 2000;
    },
    launch: downLaunch,
    upLaunch,
    doctor,
  };
  return { sources, did };
}

describe('the restart lifecycle keeps one fresh hook binding', () => {
  test('a ready relaunch: settings and state name the same binding at the first poll and at the end', async () => {
    const fixture = makeFixture();
    seed(fixture);
    let atPoll: Snap | undefined;
    const { sources, did } = makeHarness(fixture, { onFirstNewPanePoll: () => { atPoll = snap(fixture); } });
    const io = testIo(fixture.root, { kind: 'owner' });

    const code = await runRestart([SEAT], io, sources);
    const atEnd = snap(fixture);

    expect(code).toBe(0);
    expect(did.created).toBe(1);
    expect(did.runs.length).toBe(1);
    // The CLI was handed the generated settings file.
    expect(did.runs[0] ?? '').toContain('--settings');
    expect(atPoll).toBeDefined();
    expect(atPoll?.settingsBinding).toBeDefined();
    // Measured claim: one binding, written before the launch and still the one the state holds
    // while the new pane is being read for readiness, and once the seat is ready.
    expect(atPoll?.stateBinding).toBe(atPoll?.settingsBinding);
    expect(atEnd.stateBinding).toBe(atEnd.settingsBinding);
    expect(atEnd.stage).toBe('ready');
    expect(atEnd.pane).toBe('pane-new');
  });

  test('a relaunch that never reaches its prompt: same binding at the poll and at the timeout', async () => {
    const fixture = makeFixture();
    seed(fixture);
    let atPoll: Snap | undefined;
    const { sources } = makeHarness(fixture, {
      onFirstNewPanePoll: () => { atPoll = snap(fixture); },
      // A screen the profile does not recognise while herdr keeps reporting the agent working:
      // the idle wait runs to its deadline.
      newPaneScreen: '\n',
      agentBusy: true,
    });
    const io = testIo(fixture.root, { kind: 'owner' });

    const code = await runRestart([SEAT], io, sources);
    const atEnd = snap(fixture);

    expect(code).toBe(1);
    expect(io.err).toContain('timed out after 90 s waiting for its idle prompt');
    expect(atPoll?.settingsBinding).toBeDefined();
    expect(atPoll?.stateBinding).toBe(atPoll?.settingsBinding);
    expect(atEnd.stateBinding).toBe(atEnd.settingsBinding);
    // Left at launched in the pane the run created, with no process identity: the screen was
    // never read as its prompt. The binding is the fresh one in both files.
    expect(atEnd.stage).toBe('launched');
    expect(atEnd.pane).toBe('pane-new');
    expect(atEnd.hasPane).toBe(true);
    expect(atEnd.launched).toBeUndefined();
  });

  test('a launch line that never runs: the fresh binding is recorded, but nothing ran', async () => {
    const fixture = makeFixture();
    seed(fixture);
    const { sources, did } = makeHarness(fixture, { runFails: true });
    const io = testIo(fixture.root, { kind: 'owner' });

    const code = await runRestart([SEAT], io, sources);
    const atEnd = snap(fixture);

    expect(code).toBe(1);
    expect(io.err).toContain('did not reach a ready prompt');
    expect(did.created).toBe(1);
    // The run stops with the record at launched in the pane it created and no process identity.
    expect(atEnd.stage).toBe('launched');
    expect(atEnd.pane).toBe('pane-new');
    expect(atEnd.hasPane).toBe(true);
    expect(atEnd.launched).toBeUndefined();
    // What the two files say about the binding is the measurement this scene contributes: the
    // fresh binding is recorded, and no process ever loaded the settings file that carries it.
    expect(atEnd.settingsBinding).toBeDefined();
    expect(atEnd.stateBinding).toBe(atEnd.settingsBinding);
  });
});
