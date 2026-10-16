// A record written before records were signed, with the team's seats running: only the
// commands that need an approval in force refuse, each with the one-line repair; the watch
// keeps watching, `status` keeps reporting, `down` stops nobody, `remove` refuses too (it
// stops a seat and edits the file), and no running seat is stopped or disturbed. A record
// the verification refused is heard the same way, in its own words.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import type { Caller } from '../../src/caller.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { runDown } from '../../src/commands/down.ts';
import { runInit } from '../../src/commands/init.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import { standingSource, runStatus, type StatusSources } from '../../src/commands/status.ts';
import { runUp, type Launch } from '../../src/commands/up.ts';
import { runWatch, type WatchSources } from '../../src/commands/watch.ts';
import { runWorktree } from '../../src/commands/worktree.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { approvalStanding, LEGACY_LINE, readApproval, storePath, writeApproval } from '../../src/store/store.ts';
import type { Live } from '../../src/status/compare.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { testIo } from '../helpers.ts';

const EXAMPLE = readFileSync(new URL('../fixtures/example.yaml', import.meta.url), 'utf8');
const OWNER: Caller = { kind: 'owner' };
const NOW = new Date('2026-10-04T09:00:00Z');
const FILE = ['--file', '.agents/team.yaml'];
const LINE = LEGACY_LINE;

let base: string;
let root: string;
let home: string;
let example: string;

function makeExample(basePath: string, rootPath: string): string {
  return EXAMPLE.replace(
    /trust:[\s\S]*?workspace:/,
    `trust:\n  - ~/.config/team/lobby\n  - ${rootPath}\n  - ${join(basePath, 'worktrees')}\n\nworkspace:`,
  );
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-legacy-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  example = makeExample(base, root);
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), example);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const store = () => storePath('acme-web', root, home);

/** What an earlier `team` wrote: format 1, no generation, no signature. */
function legacy(): void {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  mkdirSync(store(), { recursive: true });
  writeFileSync(
    join(store(), 'approval.json'),
    `${JSON.stringify({ ...approvalOf(loaded.team, loaded.root, NOW), format: 1, file: example }, null, 2)}\n`,
  );
}

/** Approves as the owner would, signing the record. */
function signed(): void {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(store(), { approval: approvalOf(loaded.team, loaded.root, NOW), file: example }, loaded.team.seats, home, NOW);
}

/** Rewrites the stored copy under the signature the owner's key made. */
function tamper(): void {
  const record: Record<string, unknown> = JSON.parse(readFileSync(join(store(), 'approval.json'), 'utf8'));
  writeFileSync(
    join(store(), 'approval.json'),
    `${JSON.stringify({ ...record, file: String(record.file).replace('interval: 120s', 'interval: 120m') }, null, 2)}\n`,
  );
}

const agent = (name: string, status = 'idle'): HerdrAgent => ({ name, agent: 'claude', pane: `${name}:p1`, workspace: name, status, cwd: null });
const RUNNING = ['claude-coordinator-acme', 'deepseek-acme'];

/** The state a running team leaves, so the seats the stubs report are the file's own. */
function runningState(): void {
  writeFileSync(
    join(root, '.agents/team.state.json'),
    JSON.stringify({
      format: 1,
      sessions: { 'acme-web': { seats: Object.fromEntries(RUNNING.map((name) => [name, { stage: 'ready' }])), worktrees: {} } },
    }),
  );
}

const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const loaded_machine: Machine = { ...fine, loadPerCore: 6.5 };

function live(): Live {
  const agents = RUNNING.map((name) => agent(name));
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens: {} };
}

function doctorSources(): DoctorSources {
  return {
    version: () => '2.1.288 (Claude Code)',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  };
}

describe('a legacy record, with the team\'s seats running', () => {
  test('up refuses with the one-line repair, and launches nothing', async () => {
    legacy();
    runningState();
    const io = testIo(root, OWNER);
    const code = await runUp(FILE, io, { sessionRunning: () => true, agents: () => RUNNING.map((name) => agent(name)), home });
    expect(code).toBe(1);
    expect(io.err).toBe(`team up: ${LINE}\n`);
    expect(io.out).toBe('');

    const dry = testIo(root, OWNER);
    expect(await runUp(['--dry-run', ...FILE], dry, { sessionRunning: () => true, agents: () => RUNNING.map((name) => agent(name)), home })).toBe(1);
    expect(dry.out).toContain(`! up would refuse: ${LINE}\n`);
  });

  test('add refuses with the one-line repair', async () => {
    legacy();
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
      foreground: () => ['claude'],
      sleep: async () => {},
      now: () => NOW,
    };
    const io = testIo(root, OWNER);
    const code = await runAdd(['codex-acme'], io, {
      home,
      sessionState: () => 'running',
      agents: () => RUNNING.map((name) => agent(name)),
      workspaces: () => [],
      doctor: doctorSources(),
      now: () => NOW,
      launch,
    });
    expect(code).toBe(1);
    expect(io.err).toBe(`team add: ${LINE}\n`);
  });

  test('worktree refuses with the one-line repair', async () => {
    legacy();
    const io = testIo(root, OWNER);
    const code = await runWorktree(['new', 'select-width', '--kind', 'fix'], io, { home, now: () => NOW });
    expect(code).toBe(1);
    expect(io.err).toBe(`team worktree: ${LINE}\n`);
  });

  test('init --restore restores nothing, and says which case it was', async () => {
    legacy();
    rmSync(join(root, '.agents'), { recursive: true });
    const io = testIo(root, OWNER);
    expect(await runInit(['--restore'], io, home)).toBe(1);
    expect(io.err).toBe(`team init: nothing was restored: the record for this folder was ${LINE}.\n`);
    expect(existsSync(join(root, '.agents', 'team.yaml'))).toBe(false);
  });

  test('status keeps reporting, with the case as a difference of its own', async () => {
    legacy();
    runningState();
    const sources: StatusSources = {
      live: () => live(),
      branch: () => 'main',
      standing: standingSource(home),
      now: () => NOW,
      home,
    };
    const io = testIo(root, OWNER);
    expect(await runStatus(FILE, io, sources)).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme');
    expect(io.out).toContain(`difference: ${LINE}\n`);
    expect(io.out).toContain('  repair: the live file is what the commands read\n');
    expect(io.out).not.toContain('the file was never approved on this machine');
  });

  test('doctor shows the case as a miss of its own', async () => {
    legacy();
    const io = testIo(root, OWNER);
    expect(await runDoctor(FILE, io, doctorSources())).toBe(1);
    expect(io.out).toContain(`MISS  ${LINE}\n`);
  });

  test('the watch keeps watching: it says the case once, turns no check off, disturbs no seat', async () => {
    legacy();
    runningState();
    // The file turns the load check off; an approval in force is what that needs, so the
    // check runs, and a load above the file's maximum is still reported.
    writeFileSync(join(root, '.agents/team.yaml'), example.replace('  interval: 120s', '  interval: 120s\n  checks:\n    load: off'));
    let passes = 2;
    const io = testIo(root, OWNER);
    const code = await runWatch(FILE, io, {
      live: () => live(),
      machine: () => loaded_machine,
      standing: standingSource(home),
      readChecks: () => [],
      screen: () => IDLE,
      status: () => 'idle',
      foreground: () => ['claude'],
      typeText: () => true,
      pressEnter: () => true,
      sleep: async () => {},
      notify: () => {},
      now: () => NOW,
      wait: async () => --passes > 0,
      alive: () => false,
      pid: 4242,
      home,
    } satisfies WatchSources);
    expect(code).toBe(0);
    // Said once, however many passes run — and never as "never approved".
    expect(io.out.split(LINE).length - 1).toBe(1);
    expect(io.out).not.toContain('the file was never approved on this machine');
    // The check the file tried to turn off still ran, and no seat was closed.
    expect(io.out).toContain('the load is 6.5 per core, above 6');
    expect(io.out).not.toContain('closed ');
    expect(io.out).toContain('the watch of "acme-web" stopped');
  });

  test('down dry-run with no approval record still prints the plan', async () => {
    const io = testIo(root, OWNER);
    const code = await runDown(['--dry-run', ...FILE], io, {
      sessionRunning: () => true,
      agents: () => [agent('claude-coordinator-acme'), agent('deepseek-acme')],
      alive: () => true,
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      foreground: () => ['claude'],
      now: () => NOW,
      home,
    });
    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).not.toContain('never approved');
    expect(io.out).toContain('dry run: nothing was run');
  });

  test('down stops nobody while the record is legacy', async () => {
    legacy();
    const io = testIo(root, OWNER);
    const code = await runDown(['--dry-run', ...FILE], io, {
      sessionRunning: () => true,
      agents: () => [agent('claude-coordinator-acme'), agent('deepseek-acme'), agent('deepseek-acme-2', 'working')],
      alive: () => true,
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      foreground: () => ['claude'],
      now: () => NOW,
      home,
    });
    expect(code).toBe(1);
    expect(io.err).toBe(`team down: ${LINE}\n`);
    expect(io.out).toBe('');
  });

  test('remove refuses while the record is legacy, and the file is not amended', async () => {
    legacy();
    const before = readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
    const io = testIo(root, OWNER);
    const code = await runRemove(['--keep', 'deepseek-acme'], io, {
      sessionRunning: () => true,
      agents: () => [agent('claude-coordinator-acme')],
      alive: () => true,
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      foreground: () => ['claude'],
      now: () => NOW,
      sleep: async () => {},
      home,
    });
    expect(code).toBe(1);
    expect(io.err).toBe(`team remove: ${LINE}\n`);
    expect(io.out).toBe('');
    // Nothing was stopped and nothing was written: the file is byte-identical, and the
    // record is what it was, unsigned and still reported as legacy.
    expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).toBe(before);
    expect(readApproval(store())?.approval.format).toBe(1);
    expect(approvalStanding(root, home)).toEqual({ kind: 'legacy' });
  });
});

describe('a record the verification refused, through the same commands', () => {
  const WHY = 'the record does not carry a valid signature: it was changed after approval, or written without the key';

  test('down stops nobody, and names the refused record', async () => {
    signed();
    tamper();
    const io = testIo(root, OWNER);
    const code = await runDown(['--dry-run', ...FILE], io, {
      sessionRunning: () => true,
      agents: () => [agent('claude-coordinator-acme'), agent('deepseek-acme')],
      alive: () => true,
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      foreground: () => ['claude'],
      now: () => NOW,
      home,
    });
    expect(code).toBe(1);
    expect(io.err).toBe(`team down: ${WHY}\n`);
    expect(io.out).toBe('');
  });

  test('up and status say the case in its own words', async () => {
    signed();
    tamper();
    runningState();
    const up = testIo(root, OWNER);
    expect(await runUp(FILE, up, { sessionRunning: () => true, agents: () => RUNNING.map((name) => agent(name)), home })).toBe(1);
    expect(up.err).toBe(`team up: ${WHY}\n`);

    const io = testIo(root, OWNER);
    const sources: StatusSources = {
      live: () => live(),
      branch: () => 'main',
      standing: standingSource(home),
      now: () => NOW,
      home,
    };
    expect(await runStatus(FILE, io, sources)).toBe(1);
    expect(io.out).toContain(`difference: ${WHY}\n`);
  });

  test('doctor shows the miss, and the watch says the case once and keeps watching', async () => {
    signed();
    tamper();
    const doctor = testIo(root, OWNER);
    expect(await runDoctor(FILE, doctor, doctorSources())).toBe(1);
    expect(doctor.out).toContain(`MISS  ${WHY}\n`);

    let passes = 2;
    const io = testIo(root, OWNER);
    const code = await runWatch(FILE, io, {
      live: () => live(),
      machine: () => fine,
      standing: standingSource(home),
      readChecks: () => [],
      screen: () => IDLE,
      status: () => 'idle',
      foreground: () => ['claude'],
      typeText: () => true,
      pressEnter: () => true,
      sleep: async () => {},
      notify: () => {},
      now: () => NOW,
      wait: async () => --passes > 0,
      alive: () => false,
      pid: 4242,
      home,
    } satisfies WatchSources);
    expect(code).toBe(0);
    expect(io.out.split(WHY).length - 1).toBe(1);
    expect(io.out).not.toContain('the file was never approved on this machine');
  });
});
