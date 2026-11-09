// One read of the approval store per command: the security review's first must-fix.
// Every command takes its standing once, at its gate, and every value below it — the
// budgets, the watch values, the checks, the ceilings — derives from that snapshot.
//
// The counts go through each command's `standing` seam, which stands in for the one
// real read. The swap after the gate is real, not injected: the first ask poisons the
// record on disk, so a second read — through the seam or straight from the store —
// sees a refused record, and the command's own output would change. A command that
// still does what the gate said has read the store once.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf, notInForce, type NotVerified } from '../../src/approve/approval.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { runDown } from '../../src/commands/down.ts';
import { runInit } from '../../src/commands/init.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import { runStatus, type StatusSources } from '../../src/commands/status.ts';
import { runUp, type UpSources } from '../../src/commands/up.ts';
import type { WatchSources } from '../../src/commands/watch.ts';
import { createHostedWatch } from '../../src/daemon/watch.ts';
import { hostedWatchRun } from '../../src/daemon/watch-run.ts';
import { routeOf } from '../../src/daemon/routes.ts';
import { forgetIdleEpisodes } from '../../src/watch/dispatch.ts';
import { runWorktree, type WorktreeSources } from '../../src/commands/worktree.ts';
import type { Launch } from '../../src/commands/up.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import type { Live } from '../../src/status/compare.ts';
import { approvalStanding, storePath, writeApproval, type Standing } from '../../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo, recordRenames } from '../helpers.ts';
import type { Machine } from '../../src/watch/machine.ts';

const NOW = new Date('2026-10-04T00:00:00Z');
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const IDLE = CLAUDE_IDLE;
function makeFile(basePath: string, projPath: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${projPath}
  - ${join(basePath, 'worktrees')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  limit: 8
budgets:
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [status_line] }
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
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

let base: string;
let project: string;
let file: string;
let fileContent: string;
let home: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-one-read-')));
  project = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(project, '.agents'), { recursive: true });
  mkdirSync(home);
  file = join(project, '.agents', 'team.yaml');
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'remote', 'add', 'origin', remote);
  git(project, 'push', '-q', '-u', 'origin', 'main');
  fileContent = makeFile(base, project);
  writeFileSync(file, fileContent);
  const loaded = loadTeamFile(project, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: fileContent },
    loaded.team.seats,
    home,
    NOW,
  );
});

afterEach(() => {
  forgetIdleEpisodes();
  rmSync(base, { recursive: true, force: true });
});

const owner = { kind: 'owner' } as const;

/** A standing seam that counts its asks; the first ask poisons the record on disk, so any
 *  later read — the seam's own or a helper's straight from the store — sees a refused one. */
function gateThenPoison(): { reads(): number; standing(root: string): Standing } {
  let asks = 0;
  return {
    reads: () => asks,
    standing(root) {
      asks++;
      const standing = approvalStanding(root, home);
      if (asks === 1) writeFileSync(join(storePath('acme', project, home), 'approval.json'), '{ this is not a record');
      return standing;
    },
  };
}

/** The record broken before the command starts: a command that never reads the store is
 *  not stopped by it. */
function poison(): void {
  writeFileSync(join(storePath('acme', project, home), 'approval.json'), '{ this is not a record');
}

function doctorSources(): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

describe('one read of the approval store per command', () => {
  test('up: one gate, and the launch holds what it said', async () => {
    const gate = gateThenPoison();
    const io = testIo(project, owner);
    const code = await runUp(['--dry-run', '--file', file], io, {
      sessionRunning: () => false,
      agents: () => [],
      home,
      doctor: doctorSources(),
      standing: gate.standing,
    } satisfies Partial<UpSources> as UpSources);
    expect(code).toBe(0);
    expect(gate.reads()).toBe(1);
  });

  test('add: one gate, and the seat starts from the approved copy', async () => {
    const panes = new Map<string, { text: string; agent: boolean }>();
    let n = 0;
    const launch: Launch = {
      sessionState: () => 'running',
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace(_session, _cwd, label) {
        n++;
        panes.set(`w${n}:p1`, { text: IDLE, agent: false });
        return { pane: `w${n}:p1`, workspace: `w${n}` };
      },
      paneRun(_session, pane) {
        const known = panes.get(pane);
        if (known) known.agent = true;
        return true;
      },
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
      agents: () => [],
      paneText: (_session, pane) => panes.get(pane)?.text ?? '',
      foreground: () => ['claude'],
      sleep: async () => {},
      now: () => NOW,
    };


    recordRenames(launch);
    const gate = gateThenPoison();
    const io = testIo(project, owner);
    const code = await runAdd(['worker', '--file', file], io, {
      home,
      sessionState: () => 'running',
      agents: () => [],
      workspaces: () => [],
      doctor: doctorSources(),
      now: () => NOW,
      launch,
      standing: gate.standing,
    } satisfies AddSources);
    expect(code).toBe(0);
    expect(io.out).toContain('worker: ready');
    expect(gate.reads()).toBe(1);
  });

  test('doctor reads the gate once and does not ask to approve', async () => {
    const gate = gateThenPoison();
    const io = testIo(project, owner);
    const code = await runDoctor(['--file', file], io, { ...doctorSources(), standing: gate.standing });
    expect(code).toBe(0);
    expect(io.out).not.toContain('team approve');
    expect(io.out).not.toContain('the file is the one the owner approved');
    expect(gate.reads()).toBe(1);
  });

  test('status: one gate, and the table holds its values', async () => {
    const gate = gateThenPoison();
    const io = testIo(project, owner);
    const code = await runStatus(['--file', file, '--json'], io, {
      live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
      branch: () => 'main',
      standing: gate.standing,
      now: () => NOW,
      home,
    } satisfies StatusSources);
    expect(code).toBe(1); // the session is down: every seat is missing
    const doc = JSON.parse(io.out);
    // The gate's budgets are in the table: the account the owner approved is a row.
    expect(doc.budgets?.map((row: { account: string }) => row.account)).toEqual(['openai']);
    expect(gate.reads()).toBe(1);
  });

  test('worktree: one gate', async () => {
    const gate = gateThenPoison();
    const io = testIo(project, owner);
    const code = await runWorktree(['new', 'select-width', '--kind', 'fix', '--seat', 'lead', '--file', file], io, {
      home,
      now: () => NOW,
      standing: gate.standing,
    } satisfies WorktreeSources);
    expect(code).toBe(0);
    expect(gate.reads()).toBe(1);
  });

  test('remove --keep: one read, and only the amending branch makes it', async () => {
    const gate = gateThenPoison();
    const io = testIo(project, owner);
    const code = await runRemove(['worker', '--keep', '--file', file], io, {
      sessionRunning: () => false,
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      now: () => NOW,
      foreground: () => [],
      home,
      standing: gate.standing,
    } satisfies RemoveSources);
    expect(code).toBe(0);
    expect(gate.reads()).toBe(1);
    // The record was re-signed from the gate's own snapshot — a write, not another read —
    // so the amended file has no drift against it.
    expect(readFileSync(file, 'utf8')).toContain('stopped: true');
    const loaded = loadTeamFile(project);
    expect(loaded.ok && approvalDifferences(loaded.team, project, home)).toEqual([]);
  });

  test('remove without --keep reads the store once, and a broken one stops it with nothing written', async () => {
    poison();
    const io = testIo(project, owner);
    const code = await runRemove(['worker', '--file', file], io, {
      sessionRunning: () => false,
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      now: () => NOW,
      foreground: () => [],
      home,
    } satisfies RemoveSources);
    // Stopping a seat and editing the file need an approval in force: a store that can't be
    // read refuses, and the seat is left in the file.
    expect(code).toBe(1);
    expect(io.err).toContain('team remove: ');
    expect(io.err).toContain('the approval record cannot be read');
    expect(readFileSync(file, 'utf8')).toContain('name: worker');
  });

  test('down never reads the store, and a broken one stops nothing', async () => {
    poison();
    const io = testIo(project, owner);
    const code = await runDown(['--file', file], io, {
      sessionRunning: () => false,
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      foreground: () => [],
      now: () => NOW,
    });
    expect(code).toBe(0);
  });

  test('init --restore: one gate, and the copy it writes is the gate record\'s', async () => {
    unlinkSync(file);
    const gate = gateThenPoison();
    const io = testIo(project, owner);
    const code = await runInit(['--restore'], io, home, gate.standing);
    expect(code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(fileContent);
    expect(gate.reads()).toBe(1);
  });
});

describe('the hosted watch reads the store once per pass', () => {
  /** A hosted watch over this root: the daemon's own binding, its lines collected in `log`.
   *  A hosted watch has no timer of its own, so ticks drive its passes. */
  async function hostedPasses(
    base: WatchSources, passes: number,
  ): Promise<{ log: string; stop: () => Promise<void>; state: () => { phase: string; cycles: number } }> {
    const route = routeOf(project, 'acme', 'acme', ['lead', 'worker']);
    const log: string[] = [];
    const host = createHostedWatch({
      route,
      now: base.now,
      effects: 'open',
      run: hostedWatchRun({ route, log: (text) => log.push(text), base, pid: 4242 }),
    });
    const deadline = Date.now() + 5000;
    let beats = 0;
    const started = base.now().getTime();
    while (host.state().cycles < passes) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for the hosted watch: ${JSON.stringify(host.state())}`);
      beats += 1;
      host.tick(new Date(started + beats * 130_000));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { log: log.join(''), stop: () => host.stop('the daemon is closing'), state: () => host.state() };
  }

  test('two passes, two reads, one announce', async () => {
    let asks = 0;
    const agent = (name: string): HerdrAgent => ({ name, agent: 'claude', pane: `${name}:p1`, workspace: name, status: 'working', cwd: null });
    const scene: Live = {
      running: true,
      agents: [agent('lead'), agent('worker')],
      workspaces: [{ id: 'lead', label: 'lead' }, { id: 'worker', label: 'worker' }],
      screens: { 'lead:p1': IDLE, 'worker:p1': IDLE },
    };
    // Daemon-only watch: the passes run in the daemon's hosted loop, so the count is the
    // hosted loop's own — one read of the store per pass.
    forgetIdleEpisodes();
    const watched = await hostedPasses({
      live: () => scene,
      machine: () => fine,
      standing: (root) => {
        asks++;
        return approvalStanding(root, home);
      },
      readChecks: () => [],
      screen: () => IDLE,
      status: () => 'working',
      foreground: () => ['claude'],
      typeText: () => true,
      pressEnter: () => true,
      sleep: async () => {},
      notify: () => {},
      now: () => NOW,
      wait: async () => false,
      alive: () => false,
      pid: 4242,
      home,
    } satisfies WatchSources, 2);
    expect(asks).toBe(2);
    expect(watched.log.match(/watching the session "acme"/g)?.length).toBe(1);
    await watched.stop();
  });
});

// The second security review's crash: a shape-correct record whose generation is 2^53
// reached the canonical encoder inside the reader, and the encoder's throw escaped it —
// every reader command crashed on one record. The shape check now refuses it naming the
// field, and the reader treats any error from building or verifying the payload as a
// refusal, so no record on disk, however shaped, makes a reader throw.
describe('a record with a signed number past the safe range is refused, never a crash', () => {
  function unsafeGeneration(): void {
    const store = join(storePath('acme', project, home), 'approval.json');
    const record = JSON.parse(readFileSync(store, 'utf8')) as Record<string, unknown>;
    writeFileSync(store, `${JSON.stringify({ ...record, generation: 2 ** 53 }, null, 2)}\n`);
  }

  test('every reader command says the refusal and comes back', async () => {
    unsafeGeneration();
    const named = '"generation" is beyond the safe integer range';

    const upIo = testIo(project, owner);
    const up = await runUp(['--dry-run', '--file', file], upIo, {
      sessionRunning: () => false,
      agents: () => [],
      home,
      doctor: doctorSources(),
      now: () => NOW,
    } satisfies Partial<UpSources> as UpSources);
    expect(up).toBe(1);
    expect(upIo.out).toContain('! up would refuse: the approval record cannot be read');
    expect(upIo.out).toContain(named);

    const launch: Launch = {
      sessionState: () => 'running',
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => null,
      paneRun: () => true,
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [],
      agents: () => [],
      paneText: () => '',
      foreground: () => [],
      sleep: async () => {},
      now: () => NOW,
    };
    const addIo = testIo(project, owner);
    const add = await runAdd(['worker', '--file', file], addIo, {
      home,
      sessionState: () => 'running',
      agents: () => [],
      workspaces: () => [],
      doctor: doctorSources(),
      now: () => NOW,
      launch,
    } satisfies AddSources);
    expect(add).toBe(1);
    expect(addIo.err).toContain(`team add: the approval record cannot be read`);
    expect(addIo.err).toContain(named);

    const doctorIo = testIo(project, owner);
    const doctor = await runDoctor(['--file', file], doctorIo, doctorSources());
    expect(doctorIo.out + doctorIo.err).toContain(named);

    const statusIo = testIo(project, owner);
    const status = await runStatus(['--file', file, '--json'], statusIo, {
      live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
      branch: () => 'main',
      standing: (root) => approvalStanding(root, home),
      now: () => NOW,
      home,
    } satisfies StatusSources);
    expect(status).toBe(1); // the session is down: every seat is missing
    const doc = JSON.parse(statusIo.out);
    // The refused record is the whole case, as one difference of its own.
    expect(doc.differences.some((difference: { what: string }) => difference.what.includes(named))).toBe(true);

    const worktreeIo = testIo(project, owner);
    const worktree = await runWorktree(['new', 'unsafe-number', '--kind', 'fix', '--seat', 'lead', '--file', file], worktreeIo, {
      home,
      now: () => NOW,
      standing: (root) => approvalStanding(root, home),
    } satisfies WorktreeSources);
    expect(worktree).toBe(1);
    expect(worktreeIo.err).toContain(`team worktree: the approval record cannot be read`);

    // Daemon-only watch: the pass runs in the daemon's hosted loop; the refused record is
    // said there and the loop keeps watching — no crash, no exit.
    forgetIdleEpisodes();
    const route = routeOf(project, 'acme', 'acme', ['lead', 'worker']);
    const watchLog: string[] = [];
    const watchHost = createHostedWatch({
      route,
      now: () => NOW,
      effects: 'open',
      run: hostedWatchRun({
        route,
        log: (text) => watchLog.push(text),
        base: {
          live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
          machine: () => fine,
          standing: (root) => approvalStanding(root, home),
          readChecks: () => [],
          screen: () => IDLE,
          status: () => 'working',
          foreground: () => ['claude'],
          typeText: () => true,
          pressEnter: () => true,
          sleep: async () => {},
          notify: () => {},
          now: () => NOW,
          wait: async () => false,
          alive: () => false,
          pid: 4242,
          home,
        } satisfies WatchSources,
        pid: 4242,
      }),
    });
    const deadline = Date.now() + 5000;
    let beats = 0;
    while (watchHost.state().cycles < 1) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for the hosted watch: ${JSON.stringify(watchHost.state())}`);
      beats += 1;
      watchHost.tick(new Date(NOW.getTime() + beats * 130_000));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(watchHost.state().phase).toBe('running');
    expect(watchLog.join('')).toContain(named);
    await watchHost.stop('the daemon is closing');

    // The restore reads the same record and refuses in its own words.
    unlinkSync(file);
    const initIo = testIo(project, owner);
    const init = await runInit(['--restore'], initIo, home);
    expect(init).toBe(1);
    expect(initIo.err).toContain('team init: nothing was restored: the approval record cannot be read');
    expect(existsSync(file)).toBe(false);
  });
});

// What makes a standing that is not verified safe is the ordering, not the values it
// yields: the default budgets name no account, and `seatBudget` reads them `clear` —
// permissive as a value. A legacy or refused record still refuses before any budget is
// consulted. A missing record is the live file: `up` reaches herdr without asking the
// budget, and `add` may ask it on the defaults. The count is the pin for the two refusals.
describe('the ordering is the guard: a standing that is not verified refuses before any budget is consulted', () => {
  const refused: Standing = {
    kind: 'refused',
    why: 'the record does not carry a valid signature: it was changed after approval, or written without the key',
  };
  const notVerified: NotVerified[] = [{ kind: 'none' }, { kind: 'legacy' }, refused];

  test('up refuses a none, legacy and refused standing with the budget gate unasked: zero calls', async () => {
    for (const standing of notVerified) {
      let consulted = 0;
      const io = testIo(project, owner);
      const code = await runUp(['--file', file], io, {
        sessionRunning: () => false,
        agents: () => [],
        home,
        doctor: doctorSources(),
        now: () => NOW,
        standing: () => standing,
        seatBudget: () => {
          consulted += 1;
          throw new Error('the budget gate was consulted');
        },
      } satisfies Partial<UpSources> as UpSources);
      expect(code).toBe(1);
      expect(consulted).toBe(0);
      if (standing.kind === 'none') {
        expect(io.err).toBe('team up: this call has no way to reach herdr\n');
        expect(io.err).not.toContain('never approved');
      } else {
        expect(io.err).toContain(`team up: ${notInForce(standing)}`);
      }
    }
  });

  test('add refuses a none, legacy and refused standing with the budget gate unasked: zero calls', async () => {
    const launch: Launch = {
      sessionState: () => 'running',
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => null,
      paneRun: () => true,
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [],
      agents: () => [],
      paneText: () => '',
      foreground: () => [],
      sleep: async () => {},
      now: () => NOW,
    };
    for (const standing of notVerified) {
      let consulted = 0;
      const io = testIo(project, owner);
      const code = await runAdd(['worker', '--file', file], io, {
        home,
        sessionState: () => 'running',
        agents: () => [],
        workspaces: () => [],
        doctor: doctorSources(),
        now: () => NOW,
        launch,
        standing: () => standing,
        seatBudget: () => {
          consulted += 1;
          if (standing.kind === 'none') return { kind: 'clear' };
          throw new Error('the budget gate was consulted');
        },
      } satisfies AddSources);
      if (standing.kind === 'none') {
        // The stub launch cannot make a workspace. The pin is the missing record: the
        // never-approved miss is gone, and the default budget is the one that is asked.
        expect(code).toBe(1);
        expect(consulted).toBe(1);
        expect(io.err + io.out).not.toContain('never approved');
        expect(io.out).toContain('worker: left out: its workspace was not created; left at launched\n');
      } else {
        expect(code).toBe(1);
        expect(consulted).toBe(0);
        expect(io.err).toContain(`team add: ${notInForce(standing)}`);
      }
    }
  });
});
