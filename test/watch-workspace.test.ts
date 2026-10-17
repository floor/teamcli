// The watch's own workspace. `up` starts the watch in a workspace of the team's session,
// labelled `Watch · <project>`, and records the pane (the label, the command and the state are
// pinned beside its plan in the launch tests). An owner who runs `team watch` alone, from a
// terminal outside herdr, gets the same: the watch hands itself to that workspace, records the
// pane and returns, so the one watch `status` and `check` look for is the one running. Started
// inside its own pane, it just runs. `team status` lists the record — pane, pid, heartbeat age —
// and `team check` flags a heartbeat older than two in-force intervals, with `team watch
// --session <session>` as the repair. Fake hosts only: no herdr runs here.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { beatWatch, placedWatch } from '../src/watch/pane.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { testIo } from './helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, 'fixtures/example.yaml'), 'utf8');
const NOW = new Date('2026-10-03T14:02:00Z');
const SESSION = 'acme-web';
const FILE = ['--file', '.agents/team.yaml'];
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

let base: string;
let root: string;
let home: string;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function place(): void {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-watch-workspace-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
}

function state(): ReturnType<typeof readState> {
  return readState(join(root, '.agents'));
}

function record(watch: { pid?: number; heartbeat: string; pane?: string; workspace?: string }): void {
  updateState(join(root, '.agents'), (held) => {
    (held.sessions[SESSION] ??= emptySession()).watch = watch;
  });
}

function watchSources(over: Partial<WatchSources> = {}): WatchSources {
  return {
    live: () => ({ running: false, agents: [], workspaces: [], screens: {}, processes: {} }),
    machine: () => fine,
    standing: () => ({ kind: 'none' }),
    readChecks: () => [],
    screen: () => null,
    status: () => null,
    foreground: () => null,
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
    notify: () => {},
    now: () => NOW,
    wait: async () => false,
    alive: () => false,
    pid: 4242,
    home,
    ...over,
  };
}

/** A hand start that makes the workspace and types the command into its pane. */
function handingOver(runs: { pane: string; command: string }[] = []) {
  return {
    createWorkspace: (_session: string, _cwd: string, _label: string) => ({ pane: 'w9:p1', workspace: 'w9' }),
    paneRun: (_session: string, pane: string, command: string) => {
      runs.push({ pane, command });
      return true;
    },
    watchCommand: () => `team watch --session ${SESSION}`,
  };
}

describe("the owner's bare run hands the watch to its workspace", () => {
  test('the workspace is labelled, its pane runs the command and the state records the pane', async () => {
    place();
    const creates: { session: string; cwd: string; label: string }[] = [];
    const runs: { pane: string; command: string }[] = [];
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(FILE, io, watchSources({
      ...handingOver(runs),
      createWorkspace: (session, cwd, label) => {
        creates.push({ session, cwd, label });
        return { pane: 'w9:p1', workspace: 'w9' };
      },
    }));
    expect(code, io.out + io.err).toBe(0);
    expect(creates).toEqual([{ session: SESSION, cwd: root, label: 'Watch · acme-web' }]);
    expect(runs).toEqual([{ pane: 'w9:p1', command: `team watch --session ${SESSION}` }]);
    expect(io.out).toBe('team watch: the watch runs in its own workspace (Watch · acme-web, pane w9:p1)\n');
    expect(io.err).toBe('');
    // The state's watch pane, reused: the record `status` and the checks read, with the heartbeat
    // of the moment the pane's command started. The project's own file needs no watchdog record.
    expect(state().sessions[SESSION]?.watch).toEqual({
      pane: 'w9:p1', workspace: 'w9', heartbeat: NOW.toISOString(),
    });
    expect(state().sessions[SESSION]?.watchdog).toBeUndefined();
  });

  test('a workspace herdr refused starts no watch, and the next run tries again', async () => {
    place();
    const io = testIo(root, { kind: 'owner' });
    const refused = await runWatch(FILE, io, watchSources({
      ...handingOver(),
      paneRun: () => false,
    }));
    expect(refused).toBe(1);
    expect(io.err).toBe('team watch: the watch did not start in its workspace\n');
    expect(io.out).toBe('');
    expect(state().sessions[SESSION]?.watch).toBeUndefined();

    const again = testIo(root, { kind: 'owner' });
    const second = await runWatch(FILE, again, watchSources(handingOver()));
    expect(second, again.out + again.err).toBe(0);
    expect(state().sessions[SESSION]?.watch?.pane).toBe('w9:p1');
  });

  test('a watch already running refuses before any workspace is made', async () => {
    place();
    record({ pid: 777, heartbeat: NOW.toISOString(), pane: 'w8:p1', workspace: 'w8' });
    const creates: string[] = [];
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(FILE, io, watchSources({
      ...handingOver(),
      alive: (pid) => pid === 777,
      createWorkspace: (_session, _cwd, label) => {
        creates.push(label);
        return { pane: 'w9:p1', workspace: 'w9' };
      },
    }));
    expect(code).toBe(1);
    expect(io.err).toBe(`team watch: a watch already runs for the session "${SESSION}" (pid 777)\n`);
    expect(creates).toEqual([]);
  });

  test('the record `up` leaves — a pane, no pid — holds until two intervals pass', async () => {
    place();
    const run = async (age: number): Promise<{ code: number; io: ReturnType<typeof testIo> }> => {
      record({ pane: 'w8:p1', workspace: 'w8', heartbeat: new Date(NOW.getTime() - age * 1000).toISOString() });
      const io = testIo(root, { kind: 'owner' });
      const code = await runWatch(FILE, io, watchSources(handingOver()));
      return { code, io };
    };
    // The first pass has not landed yet: the pane beside a fresh heartbeat is the watch.
    const fresh = await run(0);
    expect(fresh.code).toBe(1);
    expect(fresh.io.err).toBe(`team watch: a watch already runs for the session "${SESSION}" (pane w8:p1)\n`);
    // Two in-force intervals is the edge, and it holds: 120s each, the file's own.
    const edge = await run(2 * 120);
    expect(edge.code).toBe(1);
    expect(edge.io.err).toContain('(pane w8:p1)');
    const past = await run(2 * 120 + 1);
    expect(past.code, past.io.out + past.io.err).toBe(0);
    expect(past.io.out).toContain('the watch runs in its own workspace');
  });

  test('--no-nudge keeps the watch in the caller\'s terminal, with no workspace made', async () => {
    place();
    const creates: string[] = [];
    // The record is read while the watch stands, before the stop clears it.
    let held: { pid?: number; heartbeat: string; pane?: string } | undefined;
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch([...FILE, '--no-nudge'], io, watchSources({
      ...handingOver(),
      wait: async () => {
        held = state().sessions[SESSION]?.watch;
        return false;
      },
      createWorkspace: (_session, _cwd, label) => {
        creates.push(label);
        return { pane: 'w9:p1', workspace: 'w9' };
      },
    }));
    expect(code, io.out + io.err).toBe(0);
    expect(creates).toEqual([]);
    expect(io.out).toContain(`watching the session "${SESSION}" every 120s, without nudges`);
    // A watch that stayed in its caller has no pane to record: its own process is the record,
    // and `status` reads it with `pane not recorded`.
    expect(held?.pid).toBe(4242);
    expect(held?.pane).toBeUndefined();
    expect(state().sessions[SESSION]?.watch).toBeUndefined();
  });

  test('started inside its own pane, it just runs and records the pane it found itself in', async () => {
    place();
    const creates: string[] = [];
    let held: { pid?: number; heartbeat: string; pane?: string; workspace?: string } | undefined;
    // The pane runs `up`'s own command, which carries no `--file`: a pane is not an owner.
    const io = testIo(root, { kind: 'pane', pane: 'w9:p1' });
    const code = await runWatch(['--session', SESSION], io, watchSources({
      ...handingOver(),
      ownPane: () => ({ pane: 'w9:p1', workspace: 'w9' }),
      wait: async () => {
        held = state().sessions[SESSION]?.watch;
        return false;
      },
      createWorkspace: (_session, _cwd, label) => {
        creates.push(label);
        return { pane: 'w9:p1', workspace: 'w9' };
      },
    }));
    expect(code, io.out + io.err).toBe(0);
    expect(creates).toEqual([]);
    expect(io.err).toBe('');
    expect(io.out).toContain(`watching the session "${SESSION}"`);
    expect(held).toEqual({ pid: 4242, heartbeat: NOW.toISOString(), pane: 'w9:p1', workspace: 'w9' });
  });

  test('the record `up` leaves admits its own pane, and no other', async () => {
    place();
    // `up` has made the workspace and typed the command: the record names the pane, and that
    // pane's first pass has not written a pid yet.
    record({ pane: 'w8:p1', workspace: 'w8', heartbeat: NOW.toISOString() });
    const here = testIo(root, { kind: 'pane', pane: 'w8:p1' });
    let held: { pid?: number; heartbeat: string; pane?: string; workspace?: string } | undefined;
    const code = await runWatch(['--session', SESSION], here, watchSources({
      ownPane: () => ({ pane: 'w8:p1', workspace: 'w8' }),
      wait: async () => {
        held = state().sessions[SESSION]?.watch;
        return false;
      },
    }));
    expect(code, here.out + here.err).toBe(0);
    expect(here.out).toContain(`watching the session "${SESSION}"`);
    // The command the pane was given is the watch: its first pass owns the record.
    expect(held).toEqual({ pid: 4242, heartbeat: NOW.toISOString(), pane: 'w8:p1', workspace: 'w8' });

    // The pane that stopped kept no record; a second call from anywhere else is refused.
    record({ pane: 'w8:p1', workspace: 'w8', heartbeat: NOW.toISOString() });
    const elsewhere = testIo(root, { kind: 'pane', pane: 'w9:p1' });
    const refused = await runWatch(['--session', SESSION], elsewhere, watchSources());
    expect(refused).toBe(1);
    expect(elsewhere.err).toBe(`team watch: a watch already runs for the session "${SESSION}" (pane w8:p1)\n`);
    expect(state().sessions[SESSION]?.watch?.pane).toBe('w8:p1');
  });
});

describe('the record `team status` lists', () => {
  async function run(now: Date): Promise<string> {
    const io = testIo(root, { kind: 'owner' });
    const sources: StatusSources = {
      live: () => ({ running: false, agents: [], workspaces: [], screens: {}, processes: {} }),
      branch: () => null,
      standing: () => ({ kind: 'none' }),
      now: () => now,
      home,
    };
    const code = await runStatus([], io, sources);
    // The reading ran; its differences belong to the seats this fixture does not run, and the
    // note is what this file is about.
    expect(code, io.err).not.toBe(2);
    return io.out;
  }

  test('names the pane, the pid and how old the last pass is', async () => {
    place();
    record({ pid: 4242, pane: 'w9:p1', workspace: 'w9', heartbeat: NOW.toISOString() });
    expect(await run(NOW)).toContain('note: watch: pane w9:p1, pid 4242, last heartbeat 0s ago\n');
  });

  test('a record before its first pass reads `pid not recorded yet`', async () => {
    place();
    record({ pane: 'w9:p1', workspace: 'w9', heartbeat: NOW.toISOString() });
    expect(await run(new Date(NOW.getTime() + 30_000)))
      .toContain('note: watch: pane w9:p1, pid not recorded yet, last heartbeat 30s ago\n');
  });

  test('a watch that never saw itself in a pane reads `pane not recorded`', async () => {
    place();
    record({ pid: 4242, heartbeat: NOW.toISOString() });
    expect(await run(new Date(NOW.getTime() + 300_000)))
      .toContain('note: watch: pane not recorded, pid 4242, last heartbeat 5 min ago\n');
  });
});

describe('`team check` and the heartbeat', () => {
  /** The coordinator running, so the session has a seat for the watch to carry. */
  const live: Live = {
    running: true,
    agents: [{
      name: 'claude-coordinator-acme',
      agent: 'claude',
      pane: 'w1:p1',
      workspace: 'w1',
      status: 'idle',
      cwd: null,
    }],
    workspaces: [],
    screens: {},
  };

  function check(now: Date): { code: number; out: string } {
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
      live: () => live,
      branch: () => 'main',
      standing: () => ({ kind: 'none' }),
      now: () => now,
      home,
    });
    return { code, out: `${io.out}${io.err}` };
  }

  test('a heartbeat older than two cycles is a difference, repaired by the run', () => {
    place();
    record({ pid: 4242, pane: 'w9:p1', workspace: 'w9', heartbeat: new Date(NOW.getTime() - 300_000).toISOString() });
    const { code, out } = check(NOW);
    expect(code).toBe(1);
    expect(out).toContain(`difference: the watch's last pass was 5 minute(s) ago\n  repair: team watch --session ${SESSION}`);
  });

  test('the edge holds: exactly two cycles is not yet a difference', () => {
    place();
    record({ pid: 4242, pane: 'w9:p1', workspace: 'w9', heartbeat: new Date(NOW.getTime() - 240_000).toISOString() });
    const { out } = check(NOW);
    expect(out).not.toContain('last pass was');
  });

  test('a session with no watch at all is a difference too', () => {
    place();
    const { code, out } = check(NOW);
    expect(code).toBe(1);
    expect(out).toContain(`difference: no watch has run for this session\n  repair: team watch --session ${SESSION}`);
  });
});

// The review of the workspace hand-over: its four edges. A lone run aimed at another session
// must not make a workspace in that session or write this team's state there; the pane's own
// first pass must read the file the hand-over recorded, though herdr names no pane to it; that
// pass must keep the pane and workspace the hand-over recorded before any pid was written; and
// a typing refused after the workspace was made must close it and unset the record.
describe('the hand-over edges', () => {
  test('a lone run aimed at another session makes no workspace there and writes no watch', async () => {
    place();
    const creates: { session: string; cwd: string; label: string }[] = [];
    const runs: { pane: string; command: string }[] = [];
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(['--session', 'other', ...FILE], io, watchSources({
      ...handingOver(runs),
      createWorkspace: (session, cwd, label) => {
        creates.push({ session, cwd, label });
        return { pane: 'w9:p1', workspace: 'w9' };
      },
    }));
    expect(code, io.out + io.err).toBe(0);
    expect(creates).toEqual([]);
    expect(runs).toEqual([]);
    expect(state().sessions.other?.watch).toBeUndefined();
    // It reads and reports here instead, naming the foreign session.
    expect(io.out).toContain('the session "other" is not this file\'s "acme-web": its readings are not saved');
  });

  test('the pane\'s own first pass reads the recorded file, though the walk cannot place it', async () => {
    place();
    updateState(join(root, '.agents'), (held) => {
      (held.sessions[SESSION] ??= emptySession()).watchdog = { file: '.agents/team.yaml', pane: 'w9:p1' };
    });
    record({ heartbeat: NOW.toISOString(), pane: 'w9:p1', workspace: 'w9' });
    const io = testIo(root, { kind: 'unplaced', reason: 'it runs in a herdr pane without an agent' });
    // The pass's own write is read inside the wait that follows it: a watch that stops clears its
    // record in the loop's finally.
    let during: ReturnType<typeof readState>['sessions'][string]['watch'];
    const code = await runWatch(['--session', SESSION], io, watchSources({
      pid: 4242,
      ownPane: () => 'gone',
      wait: async () => {
        during = state().sessions[SESSION]?.watch;
        return false;
      },
    }));
    expect(code, io.err + io.out).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain(`watching the session "${SESSION}"`);
    // The first pass records its pid and keeps the pane and workspace the hand-over recorded.
    expect(during).toEqual({
      pid: 4242, heartbeat: NOW.toISOString(), pane: 'w9:p1', workspace: 'w9',
    });
  });

  for (const [said, ownPane] of [
    ['herdr says the pane is gone', () => 'gone' as const],
    ['herdr cannot say', () => null],
  ] as const) {
    test(`a first pass where ${said} keeps the recorded pane and workspace`, () => {
      place();
      record({ heartbeat: NOW.toISOString(), pane: 'w9:p1', workspace: 'w9' });
      const found = placedWatch(join(root, '.agents'), SESSION, 4242, ownPane);
      expect(found).toBe('keep');
      beatWatch(join(root, '.agents'), SESSION, 4242, NOW.toISOString(), 'keep');
      expect(state().sessions[SESSION]?.watch).toEqual({
        pid: 4242, heartbeat: NOW.toISOString(), pane: 'w9:p1', workspace: 'w9',
      });
    });
  }

  test('a refused typing closes the workspace it made and unsets the file record', async () => {
    place();
    // A file a flagless watch would not read: the hand-over records it for the pane.
    const other = join(root, '.agents/other.yaml');
    writeFileSync(other, EXAMPLE);
    const closed: { session: string; workspace: string }[] = [];
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(['--file', '.agents/other.yaml'], io, watchSources({
      ...handingOver(),
      paneRun: () => false,
      closeWorkspace: (session, workspace) => {
        closed.push({ session, workspace });
        return true;
      },
    }));
    expect(code, io.err + io.out).toBe(1);
    expect(io.err).toBe('team watch: the watch did not start in its workspace\n');
    expect(closed).toEqual([{ session: SESSION, workspace: 'w9' }]);
    expect(state().sessions[SESSION]?.watchdog).toBeUndefined();
    expect(state().sessions[SESSION]?.watch).toBeUndefined();
  });
});
