// A hand-run `team watch` is a read-only view of the daemon's watch. It prints whether
// the daemon hosts the session and writes nothing: no workspace, no pane, no state. A
// recorded pane watch is still what `team status` lists — pane, pid, heartbeat age — and
// what `team check` flags when it is missing or older than two in-force intervals. The
// repair is the daemon's. Fake hosts only: no herdr runs here.
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
const REPAIR = 'team daemon status, or the lead runs team daemon install';
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

function absentLine(session: string): string {
  return `team watch: the daemon does not host session ${session}\n`;
}

function hostedLine(session: string): string {
  return `team watch: running in the daemon for session ${session}\n`;
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

/** The daemon health a hand-run watch reads. The root is the canonical checkout. */
function daemonOf(session: string, phase: string): WatchSources['daemonHealth'] {
  return async () => ({
    roots: [{ root: realpathSync(root), watch: { session, phase } }],
  });
}

describe('a hand-run team watch only prints the daemon view', () => {
  test('an owner run prints that the daemon does not host the session and writes nothing', async () => {
    place();
    const creates: string[] = [];
    const runs: { pane: string; command: string }[] = [];
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(FILE, io, watchSources({
      createWorkspace: (_session, _cwd, label) => {
        creates.push(label);
        return { pane: 'w9:p1', workspace: 'w9' };
      },
      paneRun: (_session, pane, command) => {
        runs.push({ pane, command });
        return true;
      },
    }));
    expect(code, io.out + io.err).toBe(0);
    expect(io.out).toBe(absentLine(SESSION));
    expect(io.err).toBe('');
    expect(creates).toEqual([]);
    expect(runs).toEqual([]);
    expect(state().sessions[SESSION]?.watch).toBeUndefined();
    expect(state().sessions[SESSION]?.watchdog).toBeUndefined();
  });

  test('a pane herdr would refuse is never asked, and the view still writes nothing', async () => {
    place();
    let asked = false;
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(FILE, io, watchSources({
      paneRun: () => {
        asked = true;
        return false;
      },
    }));
    expect(code, io.out + io.err).toBe(0);
    expect(io.out).toBe(absentLine(SESSION));
    expect(io.err).toBe('');
    expect(asked).toBe(false);
    expect(state().sessions[SESSION]?.watch).toBeUndefined();
  });

  test('a record already on disk is left as it stands', async () => {
    place();
    const held = { pid: 777, heartbeat: NOW.toISOString(), pane: 'w8:p1', workspace: 'w8' };
    record(held);
    const creates: string[] = [];
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(FILE, io, watchSources({
      alive: (pid) => pid === 777,
      createWorkspace: (_session, _cwd, label) => {
        creates.push(label);
        return { pane: 'w9:p1', workspace: 'w9' };
      },
    }));
    expect(code, io.out + io.err).toBe(0);
    expect(io.out).toBe(absentLine(SESSION));
    expect(io.err).toBe('');
    expect(creates).toEqual([]);
    expect(state().sessions[SESSION]?.watch).toEqual(held);
  });

  test('a record of any age is left as it stands', async () => {
    place();
    for (const age of [0, 2 * 120, 2 * 120 + 1]) {
      const held = { pane: 'w8:p1', workspace: 'w8', heartbeat: new Date(NOW.getTime() - age * 1000).toISOString() };
      record(held);
      const io = testIo(root, { kind: 'owner' });
      const code = await runWatch(FILE, io, watchSources());
      expect(code, io.out + io.err).toBe(0);
      expect(io.out).toBe(absentLine(SESSION));
      expect(state().sessions[SESSION]?.watch).toEqual(held);
    }
  });

  test('--no-nudge still only prints the view and makes no workspace', async () => {
    place();
    const creates: string[] = [];
    let waited = false;
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch([...FILE, '--no-nudge'], io, watchSources({
      wait: async () => {
        waited = true;
        return false;
      },
      createWorkspace: (_session, _cwd, label) => {
        creates.push(label);
        return { pane: 'w9:p1', workspace: 'w9' };
      },
    }));
    expect(code, io.out + io.err).toBe(0);
    expect(io.out).toBe(absentLine(SESSION));
    expect(creates).toEqual([]);
    expect(waited).toBe(false);
    expect(state().sessions[SESSION]?.watch).toBeUndefined();
  });

  test('a pane start prints the view and records nothing', async () => {
    place();
    const creates: string[] = [];
    let waited = false;
    const io = testIo(root, { kind: 'pane', pane: 'pane-a' });
    const code = await runWatch(['--session', SESSION], io, watchSources({
      ownPane: () => ({ pane: 'pane-a', workspace: 'w9' }),
      wait: async () => {
        waited = true;
        return false;
      },
      createWorkspace: (_session, _cwd, label) => {
        creates.push(label);
        return { pane: 'pane-a', workspace: 'w9' };
      },
    }));
    expect(code, io.out + io.err).toBe(0);
    expect(io.out).toBe(absentLine(SESSION));
    expect(io.err).toBe('');
    expect(creates).toEqual([]);
    expect(waited).toBe(false);
    expect(state().sessions[SESSION]?.watch).toBeUndefined();
  });

  test('the daemon hosting this session is the view, and another session or a stopped phase is not', async () => {
    place();
    const hosted = testIo(root, { kind: 'owner' });
    const hostedCode = await runWatch(FILE, hosted, watchSources({
      daemonHealth: daemonOf(SESSION, 'running'),
    }));
    expect(hostedCode, hosted.out + hosted.err).toBe(0);
    expect(hosted.out).toBe(hostedLine(SESSION));
    expect(state().sessions[SESSION]?.watch).toBeUndefined();

    const other = testIo(root, { kind: 'owner' });
    expect(await runWatch(FILE, other, watchSources({ daemonHealth: daemonOf('other', 'running') }))).toBe(0);
    expect(other.out).toBe(absentLine(SESSION));

    const stopped = testIo(root, { kind: 'owner' });
    expect(await runWatch(FILE, stopped, watchSources({ daemonHealth: daemonOf(SESSION, 'stopped') }))).toBe(0);
    expect(stopped.out).toBe(absentLine(SESSION));
    expect(state().sessions[SESSION]?.watch).toBeUndefined();
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

  test('a heartbeat older than two cycles is a difference, repaired by the daemon', () => {
    place();
    record({ pid: 4242, pane: 'w9:p1', workspace: 'w9', heartbeat: new Date(NOW.getTime() - 300_000).toISOString() });
    const { code, out } = check(NOW);
    expect(code).toBe(1);
    expect(out).toContain(`difference: the watch's last pass was 5 minutes ago\n  repair: ${REPAIR}`);
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
    expect(out).toContain(`difference: no watch has run for this session\n  repair: ${REPAIR}`);
  });
});

// A hand-run watch aimed at another session writes nothing there. A pane the walk cannot
// place still only prints the view. The record helpers keep a pane they already hold.
// A typing the old hand-over would have refused is never attempted.
describe('the hand-over edges', () => {
  test('a lone run aimed at another session makes no workspace there and writes no watch', async () => {
    place();
    const creates: { session: string; cwd: string; label: string }[] = [];
    const runs: { pane: string; command: string }[] = [];
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(['--session', 'other', ...FILE], io, watchSources({
      createWorkspace: (session, cwd, label) => {
        creates.push({ session, cwd, label });
        return { pane: 'w9:p1', workspace: 'w9' };
      },
      paneRun: (_session, pane, command) => {
        runs.push({ pane, command });
        return true;
      },
    }));
    expect(code, io.out + io.err).toBe(0);
    expect(io.out).toBe(absentLine('other'));
    expect(io.err).toBe('');
    expect(creates).toEqual([]);
    expect(runs).toEqual([]);
    expect(state().sessions.other?.watch).toBeUndefined();
    expect(state().sessions[SESSION]?.watch).toBeUndefined();
  });

  test('a pane the walk cannot place only prints the view and leaves the record', async () => {
    place();
    updateState(join(root, '.agents'), (held) => {
      (held.sessions[SESSION] ??= emptySession()).watchdog = { file: '.agents/team.yaml', pane: 'pane-c' };
    });
    record({ heartbeat: NOW.toISOString(), pane: 'pane-c', workspace: 'w9' });
    const before = state().sessions[SESSION]?.watch;
    let waited = false;
    const io = testIo(root, { kind: 'unplaced', reason: 'it runs in a herdr pane without an agent' });
    const code = await runWatch(['--session', SESSION], io, watchSources({
      pid: 4242,
      ownPane: () => 'gone',
      wait: async () => {
        waited = true;
        return false;
      },
    }));
    expect(code, io.err + io.out).toBe(0);
    expect(io.out).toBe(absentLine(SESSION));
    expect(io.err).toBe('');
    expect(waited).toBe(false);
    expect(state().sessions[SESSION]?.watch).toEqual(before);
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

  test('a refused typing is never attempted and unsets nothing', async () => {
    place();
    const other = join(root, '.agents/other.yaml');
    writeFileSync(other, EXAMPLE);
    const closed: { session: string; workspace: string }[] = [];
    let asked = false;
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(['--file', '.agents/other.yaml'], io, watchSources({
      paneRun: () => {
        asked = true;
        return false;
      },
      closeWorkspace: (session, workspace) => {
        closed.push({ session, workspace });
        return true;
      },
    }));
    expect(code, io.err + io.out).toBe(0);
    expect(io.out).toBe(absentLine(SESSION));
    expect(io.err).toBe('');
    expect(asked).toBe(false);
    expect(closed).toEqual([]);
    expect(state().sessions[SESSION]?.watchdog).toBeUndefined();
    expect(state().sessions[SESSION]?.watch).toBeUndefined();
  });
});
