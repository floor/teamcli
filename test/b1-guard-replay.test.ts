// Independent replay of the launch guard for a launch that stopped before ready: the record is
// left at `launched` with its pane and workspace still listed, the host's agent list reads but
// names no seat, and no process identity can be read. The plan runs the seat's launch line again
// in that recorded pane, so the entity model rule must judge that line before it runs.
//
// The scene is built here from the public `up` surface; it does not import the fix's own
// regression. Run at the fix's tip the refused line is left out (dry plan: would refuse; live:
// exit 1, no pane run) and an allowed line still runs once in the same pane. Run at the base the
// refused line is executed in the recorded pane.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-22T10:00:00Z');
const FILE = ['--file', '.agents/team.yaml'];
const OWNER = { kind: 'owner' } as const;
const PANE = 'w7:p1';
const WORKSPACE = 'w7';

const SENTENCE =
  'the model "claude-opus-5-5" runs under the lab "anthropic", which the entity model rule in force does not allow on this seat';

const BASE = `format: 1
project: acme
entity: lab
session: acme
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
    mode: shared
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: openai
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
budgets:
  accounts:
    anthropic: { kind: subscription, reserve: 20%, sources: [status_line] }
    openai: { kind: subscription, reserve: 10%, sources: [status_line] }
`;

/** The worker's own entry refuses the lab its launch line names; every other seat may run it. */
const REFUSED = 'worker=!anthropic; *=anthropic';
/** The same rule naming a lab this line never runs under: the launch passes. */
const ALLOWED = 'worker=!openai; *=anthropic';

describe('a recorded pane with no live agent under the entity model rule', () => {
  let base: string;
  let root: string;
  let home: string;

  function setRule(value: string): void {
    const wrote = writePolicySet(home, { level: 'entity', target: 'lab', name: 'model-rule', value }, { now: NOW });
    if (!wrote.ok) throw new Error(wrote.why);
  }

  function writeTeamYaml(): void {
    const entityLobby = join(home, '.config', 'team', 'lobbies', 'lab');
    const yaml = BASE.replace(
      'coordinator: lead\n',
      `coordinator: lead\ntrust:\n  - ~/.config/team/lobby\n  - ${root}\n  - ${entityLobby}\n`,
    );
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
  }

  function approve(): void {
    writeTeamYaml();
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    writeApproval(
      storePath(loaded.team.project, loaded.root, home),
      { approval: approvalOf(loaded.team, loaded.root), file: readFileSync(join(root, '.agents', 'team.yaml'), 'utf8') },
      loaded.team.seats,
      home,
    );
  }

  type World = {
    launch: Launch;
    session: 'absent' | 'running';
    runs: { pane: string; command: string }[];
    seed(pane: string, text: string): void;
  };

  function world(): World {
    const panes = new Map<string, string>();
    let made = 0;
    const runs: { pane: string; command: string }[] = [];
    const w: World = {
      launch: {} as Launch,
      session: 'absent',
      runs,
      seed: (pane, text) => panes.set(pane, text),
    };
    w.launch = {
      sessionState: () => w.session,
      startServer() {
        w.session = 'running';
        return true;
      },
      sessionUp: () => w.session === 'running',
      createWorkspace(_session, _cwd, _label) {
        made += 1;
        panes.set(`w${made}:p1`, CLAUDE_IDLE);
        return { pane: `w${made}:p1`, workspace: `w${made}` };
      },
      paneRun(_session, pane, command) {
        runs.push({ pane, command });
        return true;
      },
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [],
      agents: () => [],
      paneText: (_session, pane) => panes.get(pane) ?? null,
      foreground: () => ['claude', 'codex'],
      sleep: async () => {},
      now: () => NOW,
    };
    return w;
  }

  /** The state a launch that never reached ready leaves: the record is `launched`, the host
   *  still lists its workspace, the agent list is readable and names no seat, and the launch
   *  surface carries no process identity read. Only the workspace listing keeps the record
   *  live enough to plan a relaunch in its own pane. */
  function stoppedLaunch(w: World): void {
    updateState(join(root, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'launched', pane: PANE, workspace: WORKSPACE, launched: { shell: 1, cli: [2] } };
    });
    w.seed(PANE, CLAUDE_IDLE);
    w.session = 'running';
  }

  async function up(argv: string[], w: World): Promise<{ code: number; out: string; err: string }> {
    const io = testIo(root, OWNER);
    const sources: UpSources = {
      sessionRunning: () => w.session === 'running',
      sessionState: () => w.session,
      agents: () => [],
      workspaces: () => [{ id: WORKSPACE, label: 'worker' }],
      home,
      now: () => NOW,
      launch: w.launch,
    };
    const code = await runUp([...argv, ...FILE], io, sources);
    return { code, out: io.out, err: io.err };
  }

  function expectRecorded(): void {
    const held = readState(join(root, '.agents')).sessions.acme?.seats.worker;
    expect(held).toMatchObject({ stage: 'launched', pane: PANE, workspace: WORKSPACE });
  }

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-b1-replay-')));
    root = join(base, 'acme');
    home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    approve();
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test('the dry plan refuses the line the recorded pane would run', async () => {
    setRule(REFUSED);
    const w = world();
    stoppedLaunch(w);
    expectRecorded();
    const dry = await up(['--dry-run'], w);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`  skip worker: would refuse: ${SENTENCE}\n`);
    expect(dry.out).not.toContain('<pane of worker>');
    expect(w.runs).toEqual([]);
  });

  test('the live run leaves the seat out and executes nothing in the recorded pane', async () => {
    setRule(REFUSED);
    const w = world();
    stoppedLaunch(w);
    expectRecorded();
    const live = await up([], w);
    expect(live.code).toBe(1);
    expect(live.out).toContain(`worker: left out: refused: ${SENTENCE}\n`);
    expect(w.runs.filter((run) => run.pane === PANE)).toEqual([]);
  });

  test('an allowed line still runs once in that same recorded pane', async () => {
    setRule(ALLOWED);
    const w = world();
    stoppedLaunch(w);
    const dry = await up(['--dry-run'], w);
    expect(dry.code).toBe(0);
    expect(dry.out).not.toContain('would refuse');

    const live = await up([], w);
    expect(live.code).toBe(0);
    const runs = w.runs.filter((run) => run.pane === PANE);
    expect(runs.length).toBe(1);
    expect(runs[0]?.command).toContain('claude --model claude-opus-5-5');
  });
});
