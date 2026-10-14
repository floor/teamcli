// The pairing cases down-unnamed.test.ts does not reach, each pinned here in its own right:
// a pane created outside team, even under --abandon, is never closed and is named in the output;
// a recorded pane whose process was replaced — or whose pane cannot be read at all — is left
// alone; the match itself needs both the pane id and the workspace id of one record; a run twice
// over the same team stops nothing the second time; an up interrupted between creating a
// workspace and recording it leaves a pane no record names, and --dry-run closes and drops
// nothing. The harness is the one down-unnamed.test.ts uses: the approved five-seat fixture,
// state written by hand, herdr answered by closures.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

let base: string;
let root: string;
let home: string;
let stateFile: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-down-leftovers-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/key.json'), 'utf8')));
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
  stateFile = join(root, '.agents', 'team.state.json');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function unnamed(pane: string, workspace: string): HerdrAgent {
  return { name: null, agent: null, pane, workspace, status: 'idle', cwd: null };
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

type Run = { code: number; out: string; err: string; closed: string[]; seats: Record<string, SeatState> };

/** One herdr that stays put across calls: the agents herdr lists are the ones whose workspace has
 *  not been closed, and a session that was stopped stays stopped. What `run` returns is the
 *  reading after that call; `closed` grows across the calls. */
function world(agents: HerdrAgent[], processes?: (pane: string) => PaneProcesses | null) {
  const closed: string[] = [];
  let running = true;
  const launch: DownLaunch = {
    typeText: () => false,
    sendKey: () => false,
    pressEnter: () => false,
    agentPanes: () => agents.filter((agent) => !closed.includes(agent.workspace)).map((agent) => agent.pane),
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
    agents: () => agents.filter((agent) => !closed.includes(agent.workspace)),
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
  const run = async (argv: string[]): Promise<Run> => {
    const io = testIo(root, OWNER);
    const code = await runDown([...argv, ...FILE], io, sources);
    return { code, out: io.out, err: io.err, closed: [...closed], seats: readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {} };
  };
  return { run, closed };
}

/** The one-call shape of the same herdr, for the cases that need no second look. */
async function down(argv: string[], agents: HerdrAgent[], processes?: (pane: string) => PaneProcesses | null): Promise<Run> {
  return world(agents, processes).run(argv);
}

describe('down over a team it already stopped', () => {
  beforeEach(async () => {
    const approved = await runApprove(FILE, testIo(root, OWNER), {
      ask: async () => '5',
      waiting: () => 'empty',
      now: () => NOW,
      home,
    });
    expect(approved).toBe(0);
  });

  test('a second run stops nothing: the session is already gone and the records went with it', async () => {
    writeSeats({ 'deepseek-acme': recorded('seat-1', 'ws-1') });
    const herdr = world([unnamed('seat-1', 'ws-1')]);
    const first = await herdr.run([]);
    expect(first.code).toBe(0);
    expect(first.closed).toEqual(['ws-1']);
    expect(first.seats).toEqual({});
    expect(first.out).toContain('session acme-web: stopped and cleared\n');

    const second = await herdr.run([]);
    expect(second.code).toBe(0);
    expect(second.out).toContain('session acme-web is not running: nothing to stop\n');
    // The pane herdr listed is closed exactly once, and no record came back.
    expect(second.closed).toEqual(['ws-1']);
    expect(second.seats).toEqual({});
  });
});

describe('the record the pane must match', () => {
  beforeEach(async () => {
    const approved = await runApprove(FILE, testIo(root, OWNER), {
      ask: async () => '5',
      waiting: () => 'empty',
      now: () => NOW,
      home,
    });
    expect(approved).toBe(0);
  });

  test('a pane id alone is not a record: the workspace id must be the recorded one too', async () => {
    writeSeats({ 'deepseek-acme': recorded('seat-1', 'ws-9') });
    const run = await down([], [unnamed('seat-1', 'ws-1')]);
    expect(run.code).toBe(0);
    expect(run.closed).toEqual([]);
    expect(run.out).toContain('pane seat-1: not recorded for a seat of this team; left as it is\n');
    expect(run.out).toContain('session acme-web: not stopped, 1 agent left in it\n');
    expect(run.seats['deepseek-acme']?.pane).toBe('seat-1');
  });

  test('a workspace id alone is not a record either: the pane id must be the recorded one', async () => {
    writeSeats({ 'deepseek-acme': recorded('seat-9', 'ws-1') });
    const run = await down([], [unnamed('seat-1', 'ws-1')]);
    expect(run.code).toBe(0);
    expect(run.closed).toEqual([]);
    expect(run.out).toContain('pane seat-1: not recorded for a seat of this team; left as it is\n');
    expect(run.seats['deepseek-acme']?.workspace).toBe('ws-1');
  });
});

describe('a record that holds the process team launched', () => {
  beforeEach(async () => {
    const approved = await runApprove(FILE, testIo(root, OWNER), {
      ask: async () => '5',
      waiting: () => 'empty',
      now: () => NOW,
      home,
    });
    expect(approved).toBe(0);
  });

  test('a pane whose process cannot be read is left alone, and named', async () => {
    writeSeats({ 'deepseek-acme': recorded('proof-1', 'proof-ws', { shell: 10, cli: [11] }) });
    const run = await down([], [unnamed('proof-1', 'proof-ws')], () => null);
    expect(run.code).toBe(0);
    expect(run.closed).toEqual([]);
    expect(run.out).toContain('deepseek-acme: pane proof-1 is not the process this team launched; left as it is\n');
    expect(run.out).toContain('session acme-web: not stopped, 1 agent left in it\n');
    expect(run.seats['deepseek-acme']?.pane).toBe('proof-1');
  });

  test('a new process in front of the recorded shell is another one: left alone, and named', async () => {
    writeSeats({ 'deepseek-acme': recorded('proof-1', 'proof-ws', { shell: 10, cli: [11] }) });
    const run = await down([], [unnamed('proof-1', 'proof-ws')], () => ({ shell: 10, foreground: [12] }));
    expect(run.code).toBe(0);
    expect(run.closed).toEqual([]);
    expect(run.out).toContain('deepseek-acme: pane proof-1 is not the process this team launched; left as it is\n');
    expect(run.seats['deepseek-acme']?.launched).toEqual({ shell: 10, cli: [11] });
  });
});

describe('what no record names, under --abandon', () => {
  beforeEach(async () => {
    const approved = await runApprove(FILE, testIo(root, OWNER), {
      ask: async () => '5',
      waiting: () => 'empty',
      now: () => NOW,
      home,
    });
    expect(approved).toBe(0);
  });

  test('an up interrupted between its workspace and its record leaves a pane --abandon still closes nothing for', async () => {
    // The first attempt made ws-1 and never recorded it; the seat's record carries no pane. The
    // second attempt made ws-2 and recorded it.
    writeSeats({
      'grok-acme': { stage: 'launched', waiting: { state: 'waiting-owner', classification: 'trust' } },
      'deepseek-acme': recorded('seat-2', 'ws-2'),
    });
    const run = await down(['--abandon'], [unnamed('seat-1', 'ws-1'), unnamed('seat-2', 'ws-2')]);
    expect(run.code).toBe(0);
    expect(run.closed).toEqual(['ws-2']);
    expect(run.out).toContain('pane seat-1: not recorded for a seat of this team; left as it is\n');
    expect(run.out).toContain('deepseek-acme: created for this seat and never named; its workspace was closed\n');
    expect(run.out).toContain('session acme-web: not stopped, 1 agent left in it\n');
    // The half-recorded seat keeps what it has; the recorded one is gone.
    expect(run.seats['grok-acme']?.stage).toBe('launched');
    expect(run.seats['grok-acme']?.pane).toBeUndefined();
    expect(run.seats['deepseek-acme']).toBeUndefined();
  });
});

describe('down --dry-run', () => {
  beforeEach(async () => {
    const approved = await runApprove(FILE, testIo(root, OWNER), {
      ask: async () => '5',
      waiting: () => 'empty',
      now: () => NOW,
      home,
    });
    expect(approved).toBe(0);
  });

  test('prints the close it would make and closes and drops nothing', async () => {
    writeSeats({ 'deepseek-acme': recorded('seat-2', 'ws-2') });
    const before = readFileSync(stateFile, 'utf8');
    const run = await down(['--dry-run'], [unnamed('seat-1', 'ws-1'), unnamed('seat-2', 'ws-2')]);
    expect(run.code).toBe(0);
    expect(run.closed).toEqual([]);
    // The plan names the close of the recorded pane, and the leftover pane by its pane id.
    expect(run.out).toContain('created for this seat and never named; closed without typing');
    expect(run.out).toContain('pane seat-1: not recorded for a seat of this team; left as it is\n');
    expect(run.out).toContain('dry run: nothing was run\n');
    // Nothing was written: the records stand exactly as they were.
    expect(readFileSync(stateFile, 'utf8')).toBe(before);
  });
});
