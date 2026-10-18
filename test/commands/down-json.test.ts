// The `--json` document of `team down`: one `team.down` envelope on stdout, stderr empty, the
// status saying what the run did; the dry-run plan as `plan` steps; a refusal as the `team.error`
// document named by the contract row. The harness is the one down-unnamed.test.ts uses: the
// approved five-seat fixture, state written by hand, herdr answered by closures.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../../src/approve/command.ts';
import { runDown, USAGE, type DownLaunch, type DownSources } from '../../src/commands/down.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { DOWN_OUTPUT_SCHEMA } from '../../src/output/schema.ts';
import { installKey } from '../../src/store/keys.ts';
import { emptySession, readState, updateState, type SeatState } from '../../src/state.ts';
import { testIo } from '../helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from '../helpers/output.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];
const OWNER = { kind: 'owner' as const };
const NOW = new Date('2026-10-13T12:00:00Z');
const FIVE = ['claude-coordinator-acme', 'codex-acme', 'deepseek-acme', 'deepseek-acme-2', 'grok-acme'];

let base: string;
let root: string;
let home: string;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-down-json-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/key.json'), 'utf8')));
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
  const approved = await runApprove(FILE, testIo(root, OWNER), {
    ask: async () => '5',
    waiting: () => 'empty',
    now: () => NOW,
    home,
  });
  expect(approved).toBe(0);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function unnamed(pane: string, workspace: string): HerdrAgent {
  return { name: null, agent: null, pane, workspace, status: 'idle', cwd: null };
}

function recorded(pane: string, workspace: string): SeatState {
  return {
    stage: 'launched',
    pane,
    workspace,
    waiting: { state: 'waiting-owner', classification: 'trust' },
  };
}

function writeSeats(seats: Record<string, SeatState>): void {
  updateState(join(root, '.agents'), (file) => {
    file.sessions['acme-web'] = { ...emptySession(), seats };
  });
}

type Run = { code: number; out: string; err: string; closed: string[]; seats: Record<string, SeatState> };

/** One herdr for one call, its session running unless the scene says otherwise, and its
 *  workspaces closing unless a scene names the one that does not. */
function world(agents: HerdrAgent[], options: { running?: boolean; closing?: (workspace: string) => boolean } = {}) {
  const closed: string[] = [];
  let running = options.running ?? true;
  const launch: DownLaunch = {
    typeText: () => false,
    sendKey: () => false,
    pressEnter: () => false,
    agentPanes: () => agents.filter((agent) => !closed.includes(agent.workspace)).map((agent) => agent.pane),
    closeWorkspace: (_session, workspace) => {
      if (options.closing && !options.closing(workspace)) return false;
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
  };
  return async (argv: string[]): Promise<Run> => {
    const io = testIo(root, OWNER);
    const code = await runDown([...argv, ...FILE], io, sources);
    return { code, out: io.out, err: io.err, closed: [...closed], seats: readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {} };
  };
}

describe('team down --json', () => {
  test('a stop that clears the session is the stopped document, its working lines collapsed to notes', async () => {
    const seats = Object.fromEntries(FIVE.map((name, index) => [name, recorded(`seat-${index + 1}`, `ws-${index + 1}`)]));
    writeSeats(seats);
    const run = await world(FIVE.map((name, index) => unnamed(`seat-${index + 1}`, `ws-${index + 1}`)))(['--abandon', '--json']);

    expect(run.code).toBe(0);
    expect(run.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      format: number;
      dry_run: boolean;
      status: string;
      action_summary: string;
      project: string;
      session: string;
      seats: string[];
      notes: string[];
    }>(run.out, DOWN_OUTPUT_SCHEMA);
    expect(doc.schema).toEqual({ name: 'team.down', version: 1 });
    expect(doc).toMatchObject({
      format: 1,
      dry_run: false,
      status: 'stopped',
      action_summary: 'session acme-web: stopped and cleared',
      project: 'acme-web',
      session: 'acme-web',
      seats: FIVE,
    });
    expect(doc.notes).toContain(`${FIVE[0]}: created for this seat and never named; its workspace was closed`);
    expect(doc.notes).not.toContain('session acme-web: stopped and cleared');
    expect(run.seats).toEqual({});
  });

  test('a session that is not running is the idle document, nothing on stderr', async () => {
    const run = await world([], { running: false })(['--json']);

    expect(run.code).toBe(0);
    expect(run.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      status: string;
      action_summary: string;
      seats: string[];
      notes: string[];
    }>(run.out, DOWN_OUTPUT_SCHEMA);
    expect(doc.status).toBe('idle');
    expect(doc.action_summary).toBe('session acme-web is not running: nothing to stop');
    expect(doc.seats).toEqual([]);
    expect(run.out).not.toContain('\nteam down:');
  });

  test('--dry-run prints the plan as steps and touches nothing', async () => {
    writeSeats({
      'deepseek-acme': recorded('seat-1', 'ws-1'),
      'deepseek-acme-2': recorded('seat-2', 'ws-2'),
    });
    const run = await world([unnamed('seat-1', 'ws-1'), unnamed('seat-2', 'ws-2')])(['--abandon', '--dry-run', '--json']);

    expect(run.code).toBe(0);
    expect(run.err).toBe('');
    expect(run.closed).toEqual([]);
    expect(run.seats).toHaveProperty('deepseek-acme');
    const doc = assertMatchesOutputSchema<{
      dry_run: boolean;
      status: string;
      action_summary: string;
      plan: { step: string; detail: string; seat?: string; prefix?: string }[];
    }>(run.out, DOWN_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      dry_run: true,
      status: 'dry-run',
      action_summary: 'dry run: nothing was run',
    });
    expect(doc.plan).toEqual([
      { step: 'close', seat: 'deepseek-acme', detail: 'herdr --session acme-web workspace close ws-1', prefix: '+' },
      { step: 'close', seat: 'deepseek-acme-2', detail: 'herdr --session acme-web workspace close ws-2', prefix: '+' },
      { step: 'stop', detail: 'herdr session stop acme-web', prefix: '+' },
    ]);
  });

  test('a workspace that does not close holds the run: the held refusal, exit 1', async () => {
    writeSeats({ 'deepseek-acme': recorded('seat-1', 'ws-1') });
    const run = await world([unnamed('seat-1', 'ws-1')], { closing: () => false })(['--abandon', '--json']);

    expect(run.code).toBe(1);
    expect(run.err).toBe('');
    assertJsonErrorShape(run.out, {
      id: 'down.held',
      messageContains: 'not stopped',
    });
  });

  test('a bad invocation is the usage row, without the usage text in the document', async () => {
    const run = await world([])(['--bogus', '--json']);

    expect(run.code).toBe(2);
    expect(run.err).toBe('');
    assertJsonErrorShape(run.out, { id: 'down.invocation', messageContains: '--bogus' });
    expect(run.out).not.toContain('Usage:');
    expect(USAGE).toContain("Exits 0 when the session is down or the dry-run plan is printed, 1 when the stop is refused, 2 when the invocation, team file, or herdr can't be read.");
  });
});
