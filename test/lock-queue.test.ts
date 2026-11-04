// The fair queue on a machine lock: waiters take numbered places in
// arrival order, a holder whose recorded shell pid is dead is reclaimed safely by the head of
// the queue, and every take records the long-lived shell's pid — never the pid of the
// short-lived `team lock` process, which is dead as soon as it prints.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLock } from '../src/commands/lock.ts';
import { runUnlock } from '../src/commands/unlock.ts';
import {
  formatWho,
  lockDirectory,
  locksRoot,
  parseWho,
  queueDirectory,
  type LockIdentity,
  type LockSources,
} from '../src/lock/machine.ts';
import { testIo } from './helpers.ts';

const A: LockIdentity = { team: 'beacon', by: 'owner' };
const B: LockIdentity = { team: 'beacon', by: 'seat-b' };
const C: LockIdentity = { team: 'other', by: 'owner' };
const AT = Date.parse('2026-10-04T09:00:00Z');

let base = '';
afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function homeOf(): string {
  base = mkdtempSync(join(tmpdir(), 'team-lock-queue-'));
  return join(base, 'home');
}

type Clock = { at: number };
/** Sources on a fake clock: each sleep advances it, exactly as the lock docs' world does. */
function sources(
  home: string,
  identity: LockIdentity,
  clock: Clock,
  extra: Partial<LockSources> = {},
): LockSources {
  return {
    home,
    identity,
    now: () => new Date(clock.at),
    sleep: (ms) => {
      clock.at += ms;
    },
    pid: () => 4242,
    waiterPid: () => 777,
    alive: () => true,
    ...extra,
  };
}

const whoPath = (home: string) => join(lockDirectory(home, 'heavy-run'), 'who');
const tickets = (home: string): string[] => {
  const dir = queueDirectory(home, 'heavy-run');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

describe('the recorded pid', () => {
  test('a take records the long-lived shell pid as a fifth holder line', async () => {
    const home = homeOf();
    const clock: Clock = { at: AT };
    const io = testIo(base, { kind: 'owner' });
    expect(await runLock(['heavy-run', '--for', 'release CI'], io, sources(home, A, clock))).toBe(0);
    expect(io.out).toBe(
      'heavy-run: taken\nteam: beacon\nrun: release CI\nby: owner\nat: 2026-10-04T09:00:00Z\npid: 4242\n',
    );
    const parsed = parseWho(readFileSync(whoPath(home), 'utf8'));
    expect(parsed).toEqual({ team: 'beacon', run: 'release CI', by: 'owner', at: '2026-10-04T09:00:00Z', pid: 4242 });
    // A four-line holder written before the pid existed still parses, with no pid.
    expect(parseWho('team: beacon\nrun: release CI\nby: owner\nat: 2026-10-04T09:00:00Z\n')).toEqual({
      team: 'beacon', run: 'release CI', by: 'owner', at: '2026-10-04T09:00:00Z',
    });
    // And the holder still releases it.
    const out = testIo(base, { kind: 'owner' });
    expect(await runUnlock(['heavy-run'], out, { home, identity: A })).toBe(0);
  });

  test('formatWho omits the pid line when no shell pid is known', () => {
    expect(formatWho({ team: 'beacon', run: '', by: 'owner', at: '2026-10-04T09:00:00Z' }))
      .toBe('team: beacon\nrun: \nby: owner\nat: 2026-10-04T09:00:00Z\n');
  });
});

describe('the queue', () => {
  test('waiters are served in arrival order, and a non-waiting take never jumps the queue', async () => {
    const home = homeOf();
    const clock: Clock = { at: AT };
    // A holds.
    expect(await runLock(['heavy-run'], testIo(base, { kind: 'owner' }), sources(home, A, clock))).toBe(0);

    // B waits, then C waits. Each takeLock runs to its first sleep before we look: both hold
    // tickets, B's ahead of C's. The sleeps are gated so neither can move until released.
    let releaseSleeps = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSleeps = resolve;
    });
    const gated = (identity: LockIdentity, waiterPid: number): LockSources => sources(home, identity, clock, {
      waiterPid: () => waiterPid,
      sleep: async (ms) => {
        await gate;
        clock.at += ms;
      },
    });
    const bRun = runLock(['heavy-run', '--wait', '600'], testIo(base, { kind: 'seat', name: 'seat-b', pane: 'pane-2' }), gated(B, 1001));
    for (let i = 0; i < 50 && tickets(home).length < 1; i++) await Promise.resolve();
    clock.at += 1000;
    const cRun = runLock(['heavy-run', '--wait', '600'], testIo(base, { kind: 'owner' }), gated(C, 1002));
    for (let i = 0; i < 50 && tickets(home).length < 2; i++) await Promise.resolve();
    expect(tickets(home)).toHaveLength(2);

    // A releases. A fresh non-waiting take is refused while the queue stands: it would jump B.
    expect(await runUnlock(['heavy-run'], testIo(base, { kind: 'owner' }), { home, identity: A })).toBe(0);
    const jumper = testIo(base, { kind: 'owner' });
    expect(await runLock(['heavy-run'], jumper, sources(home, C, clock))).toBe(1);
    expect(jumper.err).toContain('2 waiting');

    // Let the waiters run: B takes first, and only then does C's turn come.
    releaseSleeps();
    expect(await bRun).toBe(0);
    expect(parseWho(readFileSync(whoPath(home), 'utf8'))?.by).toBe('seat-b');
    expect(await runUnlock(['heavy-run'], testIo(base, { kind: 'seat', name: 'seat-b', pane: 'pane-2' }), { home, identity: B })).toBe(0);
    expect(await cRun).toBe(0);
    expect(parseWho(readFileSync(whoPath(home), 'utf8'))?.team).toBe('other');
    expect(tickets(home)).toEqual([]);
  });

  test('a wait that times out takes its ticket with it', async () => {
    const home = homeOf();
    const clock: Clock = { at: AT };
    expect(await runLock(['heavy-run'], testIo(base, { kind: 'owner' }), sources(home, A, clock))).toBe(0);
    const io = testIo(base, { kind: 'seat', name: 'seat-b', pane: 'pane-2' });
    expect(await runLock(['heavy-run', '--wait', '3'], io, sources(home, B, clock))).toBe(1);
    expect(io.err).toContain('heavy-run: held since');
    expect(tickets(home)).toEqual([]);
  });

  test('a non-ticket file in the queue folder never wedges or counts', async () => {
    // Pinned from review on 29713c1be: `.DS_Store` sorts before every ticket, and a listing
    // that counts it as a live waiter ahead wedges the queue permanently.
    const home = homeOf();
    const clock: Clock = { at: AT };
    const dir = queueDirectory(home, 'heavy-run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.DS_Store'), 'finder droppings');
    writeFileSync(join(dir, 'notes.txt'), 'not a ticket either');

    // The lock stands free: the take goes through at once, and the strays are left untouched.
    expect(await runLock(['heavy-run'], testIo(base, { kind: 'owner' }), sources(home, A, clock))).toBe(0);
    expect(readFileSync(join(dir, '.DS_Store'), 'utf8')).toBe('finder droppings');
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('not a ticket either');

    // A refused take counts only real waiters: with none queued, the held line names no queue.
    const io = testIo(base, { kind: 'seat', name: 'seat-b', pane: 'pane-2' });
    expect(await runLock(['heavy-run'], io, sources(home, B, clock))).toBe(1);
    expect(io.err).toContain('heavy-run: held since');
    expect(io.err).not.toContain('waiting');
  });

  test('a dead waiter ahead is pruned, and the next in line is served', async () => {
    const home = homeOf();
    const clock: Clock = { at: AT };
    expect(await runLock(['heavy-run'], testIo(base, { kind: 'owner' }), sources(home, A, clock))).toBe(0);
    // A ticket from a waiter process that is gone (pid 999 in its name), ahead of everyone.
    const dir = queueDirectory(home, 'heavy-run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${String(AT).padStart(15, '0')}-999-deadbeef`), formatWho({
      team: 'gone', run: 'an abandoned run', by: 'owner', at: '2026-10-04T09:00:00Z', pid: 999,
    }));
    expect(await runUnlock(['heavy-run'], testIo(base, { kind: 'owner' }), { home, identity: A })).toBe(0);
    const io = testIo(base, { kind: 'seat', name: 'seat-b', pane: 'pane-2' });
    const alive = (pid: number) => pid !== 999;
    expect(await runLock(['heavy-run', '--wait', '30'], io, sources(home, B, clock, { alive }))).toBe(0);
    expect(tickets(home)).toEqual([]);
  });
});

describe('a stale holder', () => {
  function staleHome(holderPid: number | undefined): string {
    const home = homeOf();
    const dir = lockDirectory(home, 'heavy-run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'who'), formatWho({
      team: 'beacon', run: 'release CI', by: 'owner', at: '2026-10-04T09:00:00Z',
      ...(holderPid === undefined ? {} : { pid: holderPid }),
    }));
    return home;
  }

  test('a holder whose recorded shell is dead is reclaimed by the next take', async () => {
    const home = staleHome(31337);
    const clock: Clock = { at: AT + 60_000 };
    const io = testIo(base, { kind: 'seat', name: 'seat-b', pane: 'pane-2' });
    const alive = (pid: number) => pid !== 31337;
    expect(await runLock(['heavy-run', '--for', 'next run'], io, sources(home, B, clock, { alive }))).toBe(0);
    expect(io.out).toContain('heavy-run: taken');
    expect(parseWho(readFileSync(whoPath(home), 'utf8'))).toEqual({
      team: 'beacon', run: 'next run', by: 'seat-b', at: '2026-10-04T09:01:00Z', pid: 4242,
    });
    expect(readdirSync(locksRoot(home)).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  test('a holder whose shell still lives is never reclaimed, however long the wait', async () => {
    const home = staleHome(31337);
    const clock: Clock = { at: AT + 60_000 };
    const io = testIo(base, { kind: 'seat', name: 'seat-b', pane: 'pane-2' });
    expect(await runLock(['heavy-run', '--wait', '3'], io, sources(home, B, clock, { alive: () => true }))).toBe(1);
    expect(parseWho(readFileSync(whoPath(home), 'utf8'))?.by).toBe('owner');
  });

  test('a stale proof behind a symlink at the lock path is never read or cleared through it', async () => {
    const home = homeOf();
    const clock: Clock = { at: AT + 60_000 };
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    const text = formatWho({ team: 'beacon', run: 'release CI', by: 'owner', at: '2026-10-04T09:00:00Z', pid: 31337 });
    writeFileSync(join(outside, 'who'), text);
    mkdirSync(locksRoot(home), { recursive: true });
    symlinkSync(outside, lockDirectory(home, 'heavy-run'));
    const io = testIo(base, { kind: 'seat', name: 'seat-b', pane: 'pane-2' });
    expect(await runLock(['heavy-run'], io, sources(home, B, clock, { alive: () => false }))).toBe(1);
    expect(readFileSync(join(outside, 'who'), 'utf8')).toBe(text);
  });

  test('a holder with no recorded pid is never reclaimed: nothing proves it stale', async () => {
    const home = staleHome(undefined);
    const clock: Clock = { at: AT + 60_000 };
    const io = testIo(base, { kind: 'seat', name: 'seat-b', pane: 'pane-2' });
    expect(await runLock(['heavy-run', '--wait', '3'], io, sources(home, B, clock, { alive: () => false }))).toBe(1);
    expect(parseWho(readFileSync(whoPath(home), 'utf8'))?.by).toBe('owner');
  });
});
