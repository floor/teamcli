// Independent runtime regressions for the queued model swap: the boundary it may run at and the
// abort a failed declaration write must be. The contract is the owner's decisions of 2026-10-19
// (a failed declaration write is a truthful abort: the
// swap ends non-zero, keeps the queue, reports, and launches nothing), read through
// docs/design/model-rule.md: a swap waits for "a done report, or idle with nothing queued", and
// the design's boundary is quiet, not working, not at a prompt or dialog, holding no task lease,
// and with no work drop waiting for it.
//
// The scenes drive the real runtime (`team swap --run` through `runSwap`) with the herdr and
// launch seams faked at their documented types and synthetic temporary homes, so what is pinned
// is the command's own behavior, not a reading of its source. The fixture ('lyra') is this
// file's own. Cleanup uses the system trash per the standing rule: no recursive rm.
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runSwap } from '../src/commands/swap.ts';
import type { RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { beginSession } from '../src/sessions/registry.ts';
import { enqueueSwap } from '../src/swap/queue.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T09:00:00Z');
const SESSION = 'lyra';
const OWNER: Caller = { kind: 'owner' };
const IDLE = CLAUDE_IDLE;
const EXIT_TEXT = '/exit';
const RULE = '*=!openai';
const HANDOVER_WORDS = /successor to /;

const LEAD_SEAT = `  - role: project coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true`;

const WORKER_SEAT = `  - role: implementer
    name: worker
    cli: claude-code
    vendor: openai
    model: gpt-5
    version: "1.0"
    launch: claude --model gpt-5`;

const SCRIBE_SEAT = `  - role: implementer
    name: scribe
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
    human: true`;

/** The seat the recipe moves worker to: the new declaration the queue record carries. */
const RECIPE = {
  cli: 'claude-code',
  vendor: 'anthropic',
  model: 'Claude Opus',
  version: '5.5',
  display: 'Claude Opus 5.5',
  launch: 'claude --model claude-opus-5-5',
};

type Fixture = { base: string; root: string; home: string; file: string; dir: string; yaml: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) spawnSync('trash', [dir], { stdio: 'ignore' });
});

function teamText(root: string, home: string): string {
  return `format: 1
project: lyra
session: lyra
entity: lab
visibility: public
operator: lead
trust:
  - ${root}
  - ${home}/.config/team/lobbies/lab
workspace:
  mode: shared
seats:
${LEAD_SEAT}
${WORKER_SEAT}
${SCRIBE_SEAT}
`;
}

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-queued-swap-')));
  made.push(base);
  const root = join(base, 'lyra');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  const yaml = teamText(root, home);
  const file = join(dir, 'team.yaml');
  writeFileSync(file, yaml);
  return { base, root, home, file, dir, yaml };
}

/** The same file with the worker seat taken out: the change another process could make while a
 *  swap's handover is being asked for. */
function withoutWorker(text: string): string {
  return text.replace(`${WORKER_SEAT}\n`, '');
}

function queue(fx: Fixture, seat: 'worker' | 'scribe' = 'worker'): string {
  const from = seat === 'worker'
    ? { cli: 'claude-code', vendor: 'openai', model: 'gpt-5', version: '1.0', display: 'gpt-5 1.0' }
    : { cli: 'claude-code', vendor: 'anthropic', model: 'Claude Sonnet', version: '5.5', display: 'Claude Sonnet 5.5' };
  const record = enqueueSwap(fx.dir, {
    seat,
    from,
    to: RECIPE,
    reason: 'model-rule',
    waitSeconds: 1800,
    waitFor: "the seat's boundary (quiet, no turn, no dialog, no lease, no work drop)",
    rule: RULE,
    now: NOW,
  });
  return record.queuedAt;
}

function workerState(fx: Fixture): void {
  updateState(fx.dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
  });
}

/** An unread message drop, of the shape `team send` writes: a record named by its id. */
function messageDrop(fx: Fixture): void {
  const dropDir = join(fx.dir, 'send-drops', SESSION, 'worker');
  mkdirSync(dropDir, { recursive: true });
  writeFileSync(join(dropDir, '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f'), '{"payload":{"kind":"message"}}\n');
}

/** An unread work drop, of the shape the watch writes: `work-<uuid>`, a nudge the seat has not
 *  taken yet. */
function workDrop(fx: Fixture): void {
  const dropDir = join(fx.dir, 'send-drops', SESSION, 'worker');
  mkdirSync(dropDir, { recursive: true });
  writeFileSync(join(dropDir, 'work-7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d'), 'a task for the seat\n');
}

/** Assigned work on disk: a worktree the session records as the worker's own. */
function assignedWorktree(fx: Fixture): void {
  updateState(fx.dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.worktrees['task-1'] = { path: join(fx.base, 'wt-task-1'), branch: 'work/task-1', seat: 'worker', setup: 'ok' };
  });
}

/** A live task lease in the clone's `.agents/leases`, held by the worker. */
function liveLease(fx: Fixture): void {
  const dir = join(fx.dir, 'leases');
  mkdirSync(dir, { recursive: true });
  const until = new Date(NOW.getTime() + 30 * 60 * 1000).toISOString();
  writeFileSync(
    join(dir, 'task-1.json'),
    `${JSON.stringify({
      format: 1,
      id: 'task-1',
      seat: 'worker',
      pane: 'pane-old',
      acquiredAt: NOW.toISOString(),
      renewedAt: NOW.toISOString(),
      until,
    }, null, 2)}\n`,
  );
}

type Harness = {
  sources: RestartSources;
  did: { downTyped: string[]; typed: string[]; runs: string[]; closed: string[]; created: string[] };
  world: {
    alive: boolean;
    status: 'idle' | 'done' | 'working';
    screen: 'idle' | 'unsent';
    onHandover?: (path: string) => void;
  };
};

/** A live world at the seam the run reads: worker at `pane-old`, a launch opening `pane-new`,
 *  and the old conversation's handover written when the request is typed. */
function harness(fx: Fixture, over: Partial<Harness['world']> = {}): Harness {
  const did = { downTyped: [] as string[], typed: [] as string[], runs: [] as string[], closed: [] as string[], created: [] as string[] };
  let clock = NOW.getTime();
  let shelled = false;
  let created = 0;
  let boxed = claudeBox('');
  const newPanes = new Map<string, { agent: boolean; name: string | null; workspace: string }>();
  const world: Harness['world'] = { alive: true, status: 'idle', screen: 'idle', ...over };

  const currentAgents = (): HerdrAgent[] => {
    const list: HerdrAgent[] = [
      { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: fx.root },
    ];
    if (world.alive) {
      list.push({ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: world.status, cwd: fx.root });
    }
    for (const [pane, slot] of newPanes) {
      if (slot.agent) {
        list.push({ name: slot.name ?? '', agent: 'claude-code', pane, workspace: slot.workspace, status: 'idle', cwd: fx.root });
      }
    }
    return list;
  };

  const closeWorkspace = (_session: string, workspace: string): boolean => {
    if (workspace === 'ws-old') world.alive = false;
    did.closed.push(workspace);
    return true;
  };

  const downLaunch: DownLaunch = {
    typeText(_session, _pane, text) {
      did.downTyped.push(text);
      boxed = claudeBox(text);
      return true;
    },
    sendKey: () => true,
    pressEnter: () => {
      shelled = true;
      return true;
    },
    agentPanes: () => currentAgents().map((agent) => agent.pane),
    closeWorkspace,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };

  const upLaunch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      created += 1;
      const pane = created === 1 ? 'pane-new' : `pane-new-${created}`;
      const workspace = `ws-new${created === 1 ? '' : `-${created}`}`;
      newPanes.set(pane, { agent: false, name: null, workspace });
      did.created.push(pane);
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
    closeWorkspace,
    agentPanes: () => currentAgents().map((agent) => agent.pane),
    agents: () => currentAgents(),
    paneText: (_session, pane) => (pane === 'pane-old' ? boxed : IDLE),
    typeText(_session, _pane, text) {
      did.typed.push(text);
      const asked = /successor to (.+?):/.exec(text);
      if (asked) {
        writeFileSync(asked[1]!, 'the handover\n');
        world.onHandover?.(asked[1]!);
      }
      return true;
    },
    pressEnter: () => true,
    agentStatus: (_session, pane) => (pane === 'pane-old' ? world.status : 'idle'),
    foreground: () => ['claude'],
    shellBack: () => false,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };

  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => new Date(clock),
    home: fx.home,
  };

  const sources: RestartSources = {
    home: fx.home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => currentAgents(),
    workspaces: () => currentAgents().map((agent) => ({ id: agent.workspace })),
    alive: () => true,
    screen: (_session, pane) => (pane === 'pane-old' ? { kind: world.screen } : { kind: 'idle' }),
    screenText: (_session, pane) => (pane === 'pane-old' ? boxed : IDLE),
    status: (_session, pane) => (pane === 'pane-old' ? world.status : 'idle'),
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : ['claude']),
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    launch: downLaunch,
    upLaunch,
    doctor,
  };
  return { sources, did, world };
}

async function run(fx: Fixture, h: Harness): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(fx.root, OWNER);
  const code = await runSwap(['--run'], io, { home: fx.home, now: () => new Date(h.sources.now()), sources: h.sources });
  return { code, out: io.out, err: io.err };
}

function held(fx: Fixture, seat = 'worker') {
  return readState(fx.dir).swaps?.[seat];
}

function seatPane(fx: Fixture): string | undefined {
  return readState(fx.dir).sessions[SESSION]?.seats.worker?.pane;
}

/** What a queued seat that is not at a boundary must leave behind: the record, the old pane, and
 *  no launch, hook, stop or swapped word. */
function stays(fx: Fixture, h: Harness, queuedAt: string): void {
  expect(held(fx)?.queuedAt).toBe(queuedAt);
  expect(h.did.runs).toEqual([]);
  expect(h.did.created).toEqual([]);
  expect(h.did.closed).toEqual([]);
  expect(seatPane(fx)).toBe('pane-old');
  expect(existsSync(join(fx.dir, 'hooks'))).toBe(false);
  const log = join(fx.dir, 'team.log');
  if (existsSync(log)) expect(readFileSync(log, 'utf8')).not.toContain('worker: swapped');
}

describe('a queued swap runs only at a boundary with nothing waiting on the seat', () => {
  test('a done seat with nothing waiting is a boundary and the swap runs', async () => {
    const fx = makeFixture();
    workerState(fx);
    const queuedAt = queue(fx);
    const h = harness(fx, { status: 'done' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('swapped: worker');
    expect(h.did.runs).toHaveLength(1);
    expect(h.did.created).toEqual(['pane-new']);
    expect(held(fx)).toBeUndefined();
    expect(seatPane(fx)).toBe('pane-new');
    expect(readFileSync(join(fx.dir, 'team.log'), 'utf8')).toContain('worker: swapped');
    expect(queuedAt).toBe(NOW.toISOString());
  });

  test('an idle seat with nothing waiting is a boundary and the swap runs', async () => {
    const fx = makeFixture();
    workerState(fx);
    queue(fx);
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('swapped: worker');
    expect(h.did.runs).toHaveLength(1);
    expect(held(fx)).toBeUndefined();
    expect(seatPane(fx)).toBe('pane-new');
  });

  test('an idle seat holding an unread message is not a boundary', async () => {
    const fx = makeFixture();
    workerState(fx);
    const queuedAt = queue(fx);
    messageDrop(fx);
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('worker: stays queued');
    stays(fx, h, queuedAt);
  });

  test('an idle seat holding an unread work drop is not a boundary', async () => {
    const fx = makeFixture();
    workerState(fx);
    const queuedAt = queue(fx);
    workDrop(fx);
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('worker: stays queued');
    stays(fx, h, queuedAt);
  });

  test('an idle seat with assigned work on disk is not a boundary', async () => {
    const fx = makeFixture();
    workerState(fx);
    const queuedAt = queue(fx);
    assignedWorktree(fx);
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('worker: stays queued');
    stays(fx, h, queuedAt);
  });

  test('an idle seat holding a live task lease is not a boundary', async () => {
    const fx = makeFixture();
    workerState(fx);
    const queuedAt = queue(fx);
    liveLease(fx);
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('worker: stays queued');
    stays(fx, h, queuedAt);
  });

  test('an idle seat holding unsent text is not a boundary', async () => {
    const fx = makeFixture();
    workerState(fx);
    const queuedAt = queue(fx);
    const h = harness(fx, { status: 'idle', screen: 'unsent' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('worker: stays queued');
    stays(fx, h, queuedAt);
  });

  test('a seat whose pane is not running waits and keeps its record', async () => {
    const fx = makeFixture();
    workerState(fx);
    const queuedAt = queue(fx);
    const h = harness(fx, { alive: false });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('worker: stays queued');
    expect(held(fx)?.queuedAt).toBe(queuedAt);
    expect(h.did.runs).toEqual([]);
    expect(seatPane(fx)).toBe('pane-old');
  });

  test('a queued seat no longer in the file is refused and its record removed', async () => {
    const fx = makeFixture();
    workerState(fx);
    queue(fx);
    writeFileSync(fx.file, withoutWorker(fx.yaml));
    const h = harness(fx);

    const result = await run(fx, h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('worker is no longer declared in the team file');
    expect(held(fx)).toBeUndefined();
    expect(h.did.runs).toEqual([]);
  });

  test('a same-CLI swap passes the recorded session instead of asking for a handover', async () => {
    const fx = makeFixture();
    workerState(fx);
    queue(fx);
    const loaded = loadTeamFile(fx.root, { home: fx.home });
    if (!loaded.ok) throw new Error('the fixture team does not load');
    const worker = loaded.team.seats.find((seat) => seat.name === 'worker');
    if (worker === undefined) throw new Error('the fixture team does not declare worker');
    const begun = beginSession({
      home: fx.home,
      root: fx.root,
      team: loaded.team,
      session: SESSION,
      seat: worker,
      pane: 'pane-old',
      workspace: 'ws-old',
      cli_session: 'ses_0123456789ab',
      now: NOW,
    });
    if ('note' in begun) throw new Error(begun.note);
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(0);
    expect(result.out).toContain('swapped: worker');
    expect(h.did.runs).toHaveLength(1);
    expect(h.did.runs[0]).toContain('ses_0123456789ab');
    expect(h.did.typed.some((text) => HANDOVER_WORDS.test(text))).toBe(false);
    expect(readFileSync(join(fx.dir, 'team.log'), 'utf8')).toContain('resuming session ses_0123456789ab');
    expect(held(fx)).toBeUndefined();
  });

  test('a human pane is never launched over', async () => {
    const fx = makeFixture();
    workerState(fx);
    const queuedAt = queue(fx, 'scribe');
    const h = harness(fx, { status: 'idle' });

    const result = await run(fx, h);
    expect(result.code).toBe(1);
    expect(result.err).toContain("scribe is a human's pane");
    expect(held(fx, 'scribe')?.queuedAt).toBe(queuedAt);
    expect(h.did.runs).toEqual([]);
    expect(h.did.created).toEqual([]);
  });
});

describe('a declaration write that returns ok:false aborts before hooks and launch', () => {
  test('a seat taken out of the file during the handover wait ends non-zero, keeps the queue and launches nothing', async () => {
    const fx = makeFixture();
    workerState(fx);
    const queuedAt = queue(fx);
    const h = harness(fx, { status: 'idle' });
    // The handover wait is the window: while the old conversation is asked for its file, the
    // team file loses the seat. The write's read then refuses without throwing.
    h.world.onHandover = () => writeFileSync(fx.file, withoutWorker(fx.yaml));

    const result = await run(fx, h);
    expect(result.code).toBe(1);
    expect(result.err).toContain('worker is no longer in the file');
    expect(result.err).not.toContain('swapped');
    // The queue record is the one this run read: same seat, same moment.
    expect(held(fx)?.queuedAt).toBe(queuedAt);
    // Nothing was launched and no new pane was recorded. Whether the old conversation had
    // already been closed is the sequence's own fact, not the ruling's; only the stop's exit
    // text may have been typed.
    expect(h.did.downTyped.every((text) => text === EXIT_TEXT)).toBe(true);
    expect(h.did.runs).toEqual([]);
    expect(h.did.created).toEqual([]);
    expect(seatPane(fx)).not.toBe('pane-new');
    // No state hook landed and no word claims a swap.
    expect(existsSync(join(fx.dir, 'hooks'))).toBe(false);
    const log = readFileSync(join(fx.dir, 'team.log'), 'utf8');
    expect(log).not.toContain('worker: swapped');
  });
});
