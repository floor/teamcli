// The process identity a waiting record carries is read from the terminal host, a call with a
// 10 s timeout. It is read BEFORE the state lock: while it runs, another command's write must not
// wait on team.lock. The scene drives a real restart that leaves a seat at a question (its dialog
// mode is `keep`), with the terminal host's process read made slow by a probe that tries the
// state lock without waiting during the read. At the base revision the read runs inside the
// updateState callback, so the probe meets the lock its own run holds; at the fix the read stands
// before the write and the probe takes the lock. Fixtures only: no live pane is read or typed
// into, no CLI home is touched, and every process is synthetic.
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-21T08:00:00Z');
const SESSION = 'acme';
const SEAT = 'worker';

// A question the screen reader classifies as the agent asking, placed in the seat's new pane.
const QUESTION = 'Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';

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

type Fixture = { base: string; root: string; home: string; dir: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-pilock-')));
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
  writeFileSync(join(dir, 'team.yaml'), yaml);
  return { base, root, home, dir };
}

function seed(fixture: Fixture): void {
  updateState(fixture.dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
  });
}

type Probe = { took: number; failures: string[] };

function makeHarness(fixture: Fixture, probe: Probe): { sources: RestartSources; runs: string[] } {
  const runs: string[] = [];
  let workerAlive = true;
  let boxedText = claudeBox('');
  let shelled = false;
  let turnStarted = false;
  let clock = NOW.getTime();
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();

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
      newPanes.set('pane-new', { text: QUESTION, agent: false, name: null, workspace: 'ws-new' });
      return { pane: 'pane-new', workspace: 'ws-new' };
    },
    paneRun(_session, pane, command) {
      runs.push(command);
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
      return newPanes.get(pane)?.text ?? CLAUDE_IDLE;
    },
    typeText(_session, pane, text) {
      const slot = newPanes.get(pane);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      if (slot && pasted) slot.text = claudeBox(pasted[1] ?? '');
      return true;
    },
    pressEnter(_session, pane) {
      const slot = newPanes.get(pane);
      if (slot) {
        slot.text = QUESTION;
        turnStarted = true;
      }
      return true;
    },
    agentStatus() {
      return turnStarted ? 'working' : 'idle';
    },
    foreground: () => ['claude'],
    // The terminal-host read: while it runs, the state lock must be free. The probe is a state
    // write that waits for nobody — the shape another command makes during this read.
    processInfo() {
      try {
        updateState(fixture.dir, () => {}, { waitMs: 0 });
        probe.took += 1;
      } catch (error) {
        probe.failures.push((error as Error).message);
      }
      return { shell: 700, foreground: [701] };
    },
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
  return { sources, runs };
}

describe('a slow process read does not hold team.lock', () => {
  test('a seat left at a question: the identity is read outside the lock and still recorded', async () => {
    const fixture = makeFixture();
    seed(fixture);
    const probe: Probe = { took: 0, failures: [] };
    const { sources, runs } = makeHarness(fixture, probe);
    const io = testIo(fixture.root, { kind: 'owner' });

    const code = await runRestart([SEAT], io, sources);
    const seat = readState(fixture.dir).sessions[SESSION]?.seats[SEAT];

    // The probe ran while the terminal host's read was in flight, and the lock was free every
    // time: no failure names another team command holding it.
    expect(probe.took).toBeGreaterThan(0);
    expect(probe.failures).toEqual([]);
    // The run still records the wait and the identity it read: the fix moves the read, not it.
    expect(runs.length).toBe(1);
    expect(code).toBe(1);
    // The run still says the seat was left out, with the guidance the left-out record carries.
    expect(io.out).toContain('left out');
    expect(io.err).toContain('a lead finishes it with');
    expect(seat?.waiting?.state).toBe('waiting-owner');
    expect(seat?.waiting?.classification).toBe('question');
    expect(seat?.launched).toEqual({ shell: 700, cli: [701] });
  });
});
