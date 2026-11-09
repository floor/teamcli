import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../../src/approve/approval.ts';
import { runRemove } from '../../src/commands/remove.ts';
import { runWorktree } from '../../src/commands/worktree.ts';
import { judgeTemporary, judgeWorktree } from '../../src/watch/close.ts';
import { hostedLoop } from '../helpers/hosted-watch.ts';
import { runWatch, type WatchSources } from '../../src/commands/watch.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import type { Live } from '../../src/status/compare.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { testIo } from '../helpers.ts';

const RULE = '─'.repeat(40);
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n`;

const FILE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
  base: main
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

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

let dir: string;
let file: string;

function agent(name: string, status: string): HerdrAgent {
  return { name, agent: 'claude', pane: `${name}:p1`, workspace: name, status, cwd: null };
}

function scene(extra: HerdrAgent[] = []): Live {
  const agents = [agent('lead', 'working'), agent('worker', 'working'), ...extra];
  return {
    running: true,
    agents,
    workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })),
    screens: Object.fromEntries(agents.map((one) => [one.pane, idle])),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-watch-close-'));
  mkdirSync(join(dir, '.agents'));
  mkdirSync(join(dir, 'home'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, FILE);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The file as approved, with no drift: a synthetic verified standing, so the watch
// exercises the same derivations a real store's snapshot would drive.
function approved(): WatchSources['standing'] {
  return (root) => {
    const parsed = validateTeamFile(FILE);
    return parsed.ok ? verifiedOf(parsed.team, FILE, root) : { kind: 'none' };
  };
}

function sources(over: Partial<WatchSources> = {}): WatchSources {
  return {
    // Daemon-only watch never closes seat workspaces; cleanup is explicit.
    hosted: hostedLoop(),
    home: join(dir, 'home'),
    live: () => scene(),
    machine: () => fine,
    standing: approved(),
    readChecks: () => [],
    screen: () => idle,
    status: () => 'idle',
    foreground: () => ['claude'],
    typeText: () => true,
    pressEnter: () => true,
    sleep: async () => {},
    notify: () => {},
    now: () => new Date('2026-10-03T14:00:00Z'),
    wait: async () => false,
    alive: () => false,
    pid: 7,
    ...over,
  };
}

describe('hosted watch leaves cleanup to explicit commands', () => {
  test('a temporary seat whose result exists, and that has worked and is free, is left', async () => {
    writeFileSync(join(dir, 'done.md'), 'done\n');
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats['worker-tmp-1'] = {
        stage: 'ready', worked: true, temporary: { like: 'worker', until: 'result:done.md' },
      };
    });
    const stopped: string[] = [];
    const io = testIo(dir, { kind: 'owner' });
    const tmp = agent('worker-tmp-1', 'idle');
    await runWatch(['--file', file, '--no-nudge'], io, sources({
      live: () => scene([tmp]),
      stopSeat: async (_session, seat) => { stopped.push(seat.name); return true; },
    }));
    expect(stopped).toEqual([]);
    const cleanup = testIo(dir, { kind: 'owner' });
    expect(await runRemove(['worker-tmp-1', '--file', file], cleanup, {
      home: join(dir, 'home'), now: () => new Date('2026-10-03T14:00:00Z'),
      sessionRunning: () => true, agents: () => [tmp], alive: () => false,
      screen: () => ({ kind: 'idle' }), screenText: () => idle, status: () => 'idle', foreground: () => ['claude'],
      standing: approved(),
    })).toBe(1);
    expect(cleanup.err).toContain('worker-tmp-1: its record is not a declared seat; left as it is (the owner cleans it: team remove worker-tmp-1 --abandon)');
    expect(readState(join(dir, '.agents')).sessions.acme?.seats['worker-tmp-1']).toBeDefined();
    expect(readFileSync(file, 'utf8')).not.toContain('tmp');
  });

  test('a seat that has not worked, or whose merge is not proved, is left', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats['worker-tmp-1'] = {
        stage: 'ready', temporary: { like: 'worker', until: 'result:done.md', own_commits: false },
      };
      session.seats['worker-tmp-2'] = {
        stage: 'ready', worked: true, temporary: { like: 'worker', until: 'merged:fix/fresh' },
      };
    });
    writeFileSync(join(dir, 'done.md'), 'done\n');
    const stopped: string[] = [];
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file, '--no-nudge'], io, sources({
      live: () => scene([agent('worker-tmp-1', 'idle'), agent('worker-tmp-2', 'idle')]),
      stopSeat: async (_session, seat) => { stopped.push(seat.name); return true; },
      readEnd: (_root, until) => until.startsWith('result:')
        ? { kind: 'result', exists: true }
        : { kind: 'merged', verdict: 'unproven', detail: 'the fetch failed; nothing is removed', ownNow: 0 },
    }));
    expect(stopped).toEqual([]);
    // Keep the end-proof rules covered even though a hosted pass never acts on them.
    expect(judgeTemporary({ worked: false, free: true, ownBefore: false,
      end: { kind: 'result', exists: true } }).close).toBe(false);
    const unproved = judgeTemporary({ worked: true, free: true, ownBefore: true,
      end: { kind: 'merged', verdict: 'unproven', detail: 'the fetch failed; nothing is removed', ownNow: 0 } });
    expect(unproved.close).toBe(false);
    expect(unproved.report).toContain('fetch failed');
    expect(readState(join(dir, '.agents')).sessions.acme?.seats['worker-tmp-1']).toBeDefined();
  });

  test('merge proof distinguishes an old branch; only explicit cleanup removes its worktree', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.worktrees.fresh = { path: 'work/fresh', branch: 'fix/fresh', own_commits: false, setup: 'ok' };
      session.worktrees.done = { path: 'work/done', branch: 'fix/done', own_commits: true, setup: 'ok' };
    });
    const automatic: string[] = [];
    await runWatch(['--file', file, '--no-nudge'], testIo(dir, { kind: 'owner' }), sources({
      readEnd: () => ({ kind: 'merged', verdict: 'merged', detail: 'its own commits are in the base', ownNow: 0 }),
      removeWorktree: (task) => { automatic.push(task); return 0; },
    }));
    expect(automatic).toEqual([]);
    const before = readState(join(dir, '.agents')).sessions.acme!.worktrees;
    expect(Object.keys(before).sort()).toEqual(['done', 'fresh']);
    const end = { kind: 'merged' as const, verdict: 'merged' as const, detail: 'its own commits are in the base', ownNow: 0 };
    expect(judgeWorktree({ policy: 'on-merge', occupied: false, ownBefore: false, end }).close).toBe(false);
    expect(judgeWorktree({ policy: 'on-merge', occupied: false, ownBefore: true, end }).close).toBe(true);
    expect(await runWorktree(['remove', 'done', '--file', file], testIo(dir, { kind: 'owner' }), {
      home: join(dir, 'home'), now: () => new Date('2026-10-03T14:00:00Z'), standing: approved(),
    })).toBe(0);
    const after = readState(join(dir, '.agents')).sessions.acme!.worktrees;
    const removed = Object.keys(before).filter((task) => after[task] === undefined);
    expect(removed).toEqual(['done']);
    expect(after.fresh).toBeDefined();
  });

  // Exercise the real explicit cleanup, including the already-gone folder path.
  test('a merged worktree whose folder is already gone is removed by the real worktree removal', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.worktrees.done = { path: 'work/done', branch: 'fix/done', own_commits: true, setup: 'ok' };
    });
    const io = testIo(dir, { kind: 'owner' });
    await runWatch(['--file', file, '--no-nudge'], io, sources({
      readEnd: () => ({ kind: 'merged', verdict: 'merged', detail: 'its own commits are in the base', ownNow: 0 }),
    }));
    expect(readState(join(dir, '.agents')).sessions.acme?.worktrees.done).toBeDefined();
    expect(await runWorktree(['remove', 'done', '--file', file], io, {
      home: join(dir, 'home'), now: () => new Date('2026-10-03T14:00:00Z'), standing: approved(),
    })).toBe(0);
    expect(readState(join(dir, '.agents')).sessions.acme?.worktrees.done).toBeUndefined();
    expect(io.out).toContain('removed the record of done; its folder was already gone');
    expect(io.out).not.toContain('worktree done was not removed');
  });
});
