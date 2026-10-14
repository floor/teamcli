import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { runApprove } from '../../src/commands/approve.ts';
import { runDown, type DownLaunch, type DownSources } from '../../src/commands/down.ts';
import type { HerdrAgent, PaneProcesses } from '../../src/herdr.ts';
import type { LaunchedIdentity } from '../../src/launch/identity.ts';
import { installKey } from '../../src/store/keys.ts';
import { emptySession, readState, updateState, type SeatState } from '../../src/state.ts';
import { testIo } from '../helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];
const OWNER = { kind: 'owner' as const };
const NOW = new Date('2026-10-13T12:00:00Z');
const FIVE = ['claude-coordinator-acme', 'codex-acme', 'deepseek-acme', 'deepseek-acme-2', 'grok-acme'];

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-down-unnamed-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/key.json'), 'utf8')));
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function unnamed(pane: string, workspace: string): HerdrAgent {
  return { name: null, agent: null, pane, workspace, status: 'idle', cwd: null };
}

function titled(name: string, pane: string, workspace: string): HerdrAgent {
  return { name, agent: 'codex', pane, workspace, status: 'idle', cwd: null };
}

function recorded(pane: string, workspace: string, launched?: LaunchedIdentity): SeatState {
  return {
    stage: 'launched',
    pane,
    workspace,
    waiting: { state: 'waiting-owner', classification: 'trust' },
    ...(launched ? { launched } : {}),
  };
}

function writeSeats(seats: Record<string, SeatState>): void {
  updateState(join(root, '.agents'), (file) => {
    file.sessions['acme-web'] = { ...emptySession(), seats };
  });
}

async function down(
  argv: string[],
  agents: HerdrAgent[],
  processes?: (pane: string) => PaneProcesses | null,
  caller: Caller = OWNER,
) {
  const io = testIo(root, caller);
  const closed: string[] = [];
  let running = true;
  const launch: DownLaunch = {
    typeText: () => false,
    sendKey: () => false,
    pressEnter: () => false,
    agentPanes: () => agents.map((agent) => agent.pane),
    closeWorkspace: (_session, workspace) => {
      closed.push(workspace);
      return true;
    },
    stopSession: () => {
      running = false;
      return true;
    },
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };
  const sources: DownSources = {
    sessionRunning: () => running,
    agents: () => agents,
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => null,
    now: () => NOW,
    home,
    launch,
    ...(processes ? { processes: (_session, pane) => processes(pane) } : {}),
  };
  const code = await runDown(caller.kind === 'owner' ? [...argv, ...FILE] : argv, io, sources);
  return { code, out: io.out, err: io.err, closed, seats: readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {} };
}

describe('an unnamed pane this team recorded', () => {
  beforeEach(async () => {
    const approved = await runApprove(FILE, testIo(root, OWNER), {
      ask: async () => '5',
      waiting: () => 'empty',
      now: () => NOW,
      home,
    });
    expect(approved).toBe(0);
  });

  test('five never-named seats are closed by --abandon, and their records go', async () => {
    const seats = Object.fromEntries(FIVE.map((name, index) => [name, recorded(`seat-${index + 1}`, `ws-${index + 1}`)]));
    writeSeats(seats);
    const run = await down(['--abandon'], FIVE.map((name, index) => unnamed(`seat-${index + 1}`, `ws-${index + 1}`)));
    expect(run.code).toBe(0);
    expect(run.closed).toEqual(['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5']);
    expect(run.seats).toEqual({});
    expect(run.out).toContain('session acme-web: stopped and cleared\n');
    expect(run.out).not.toContain('not stopped');
    for (const name of FIVE) {
      expect(run.out).toContain(`${name}: created for this seat and never named; its workspace was closed\n`);
    }
  });

  test('two leftovers of an earlier up do not leave the session running', async () => {
    writeSeats({
      'deepseek-acme': recorded('seat-1', 'ws-1'),
      'deepseek-acme-2': recorded('seat-2', 'ws-2'),
    });
    const run = await down([], [unnamed('seat-1', 'ws-1'), unnamed('seat-2', 'ws-2')]);
    expect(run.code).toBe(0);
    expect(run.closed).toEqual(['ws-1', 'ws-2']);
    expect(run.seats).toEqual({});
    expect(run.out).toContain('session acme-web: stopped and cleared\n');
    expect(run.out).not.toContain('not stopped, 2 agents left');
  });

  test('a pane made outside team stays, and the output names it', async () => {
    writeSeats({ 'deepseek-acme': recorded('seat-1', 'ws-1') });
    const run = await down([], [unnamed('seat-1', 'ws-1'), unnamed('outside-1', 'outside-ws')]);
    expect(run.code).toBe(0);
    expect(run.closed).toEqual(['ws-1']);
    expect(run.seats).toEqual({});
    expect(run.out).toContain('pane outside-1: not recorded for a seat of this team; left as it is\n');
    expect(run.out).toContain('session acme-web: not stopped, 1 agent left in it\n');
  });

  test('a recorded process that is no longer in the pane is left alone and named', async () => {
    writeSeats({ 'deepseek-acme': recorded('proof-1', 'proof-ws', { shell: 10, cli: [11] }) });
    const run = await down([], [unnamed('proof-1', 'proof-ws')], () => ({ shell: 99, foreground: [50] }));
    expect(run.code).toBe(0);
    expect(run.closed).toEqual([]);
    expect(run.seats['deepseek-acme']?.pane).toBe('proof-1');
    expect(run.out).toContain('deepseek-acme: pane proof-1 is not the process this team launched; left as it is\n');
    expect(run.out).toContain('session acme-web: not stopped, 1 agent left in it\n');
  });

  test('a pane titled with something other than the seat name is closed when the ids match', async () => {
    writeSeats({
      'deepseek-acme': recorded('seat-1', 'ws-1'),
      'deepseek-acme-2': recorded('seat-2', 'ws-2'),
    });
    const run = await down([], [titled('Codex', 'seat-1', 'ws-1'), titled('Claude', 'seat-2', 'ws-2')]);
    expect(run.code).toBe(0);
    expect(run.closed).toEqual(['ws-1', 'ws-2']);
    expect(run.seats).toEqual({});
    expect(run.out).toContain('deepseek-acme: titled Codex, not its seat name; the state records its pane and workspace, so its workspace was closed\n');
    expect(run.out).toContain('deepseek-acme-2: titled Claude, not its seat name; the state records its pane and workspace, so its workspace was closed\n');
    expect(run.out).toContain('session acme-web: stopped and cleared\n');
    expect(run.out).not.toContain('not an approved seat');
    expect(run.out).not.toContain('not stopped');
  });

  test('a name the file does not know is left when no seat record accounts for it', async () => {
    writeSeats({ 'deepseek-acme': recorded('seat-1', 'ws-1') });
    const run = await down([], [unnamed('seat-1', 'ws-1'), titled('reviewer', 'review-1', 'review-ws')]);
    expect(run.code).toBe(0);
    expect(run.closed).toEqual(['ws-1']);
    expect(run.seats).toEqual({});
    expect(run.out).toContain('reviewer: its record is not an approved seat; left running (the owner cleans it: team remove reviewer --abandon)\n');
    expect(run.out).toContain('session acme-web: not stopped, 1 agent left in it\n');
    expect(run.out).not.toContain('titled reviewer');
  });
});

const KEEP = "left running; only the owner stops the orchestrator's or the operator's seat";
const LAUNCHED = { shell: 10, cli: [11] };
const SAME: PaneProcesses = { shell: 10, foreground: [11] };
const ORCHESTRATOR: Caller = { kind: 'seat', name: 'claude-coordinator-acme', pane: 'seat-1', session: 'acme-web' };
const OPERATOR: Caller = { kind: 'seat', name: 'codex-acme', pane: 'seat-2', session: 'acme-web' };

function distinctOperatorFile(): string {
  return EXAMPLE.replace(/^operator: .*$/m, 'operator: codex-acme').replace(/^    parked: true\s*$/m, '');
}

async function approve(text: string): Promise<void> {
  writeFileSync(join(root, '.agents/team.yaml'), text);
  const approved = await runApprove(FILE, testIo(root, OWNER), {
    ask: async () => '5',
    waiting: () => 'empty',
    now: () => NOW,
    home,
  });
  expect(approved).toBe(0);
}

describe('a seat-run down keeps a lead whatever herdr calls its pane', () => {
  async function kept(name: string, agent: HerdrAgent, caller: Caller) {
    writeSeats({ [name]: recorded(agent.pane, agent.workspace, LAUNCHED) });
    const run = await down([], [agent], () => SAME, caller);
    expect(run.code).toBe(0);
    expect(run.closed).toEqual([]);
    expect(run.out).toContain(`${name}: ${KEEP}\n`);
    expect(run.out).not.toContain('workspace was closed');
    expect(run.seats[name]?.pane).toBe(agent.pane);
    return run;
  }

  describe('the orchestrator', () => {
    beforeEach(() => approve(EXAMPLE));

    test('the owner still closes its unnamed pane', async () => {
      writeSeats({ 'claude-coordinator-acme': recorded('seat-1', 'ws-1', LAUNCHED) });
      const run = await down([], [unnamed('seat-1', 'ws-1')], () => SAME);
      expect(run.code).toBe(0);
      expect(run.closed).toEqual(['ws-1']);
      expect(run.out).toContain('claude-coordinator-acme: created for this seat and never named; its workspace was closed\n');
    });

    test('an unnamed pane is kept', async () => {
      await kept('claude-coordinator-acme', unnamed('seat-1', 'ws-1'), ORCHESTRATOR);
    });

    test('a pane titled something else is kept', async () => {
      await kept('claude-coordinator-acme', titled('Claude Code', 'seat-1', 'ws-1'), ORCHESTRATOR);
    });
  });

  describe('a distinct operator', () => {
    beforeEach(() => approve(distinctOperatorFile()));

    test('an unnamed pane is kept', async () => {
      await kept('codex-acme', unnamed('seat-2', 'ws-2'), OPERATOR);
    });

    test('a pane titled something else is kept', async () => {
      await kept('codex-acme', titled('Codex', 'seat-2', 'ws-2'), OPERATOR);
    });
  });
});
