import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSeatLock, holderText, lockSteps, seatLockHolder, seatLockPath, type LockSteps, type SeatLock } from '../../src/launch/seat-lock.ts';

const DEAD = 2147483646;

function place(): { dir: string; path: string; claim: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-lock-')));
  const path = seatLockPath(dir, 'acme', 'lead');
  mkdirSync(join(dir, 'seat-locks', 'acme'), { recursive: true });
  return { dir, path, claim: `${path}.steal` };
}

// Synthetic process facts for every scene: no scene reads the real process table. `HOLDER` is the
// taker's own pid number and `FOREIGN` another process's; whether it is alive and when it started
// are the scene's to say. The taker's own start is a fact of this process, so `facts()` gives it
// too, and a scene that fails the table's read still has one.
const HOLDER = 4242;
const FOREIGN = 5151;
const BOOT = Date.parse('2026-11-05T09:00:00Z');
const START = Date.parse('2026-11-05T10:00:00Z');

function facts(overrides: Partial<LockSteps> = {}): Partial<LockSteps> {
  return {
    pid: () => HOLDER,
    ownStart: () => START,
    alive: (pid) => pid !== DEAD,
    startOf: () => START,
    ...overrides,
  };
}

const token = (path: string): string => readFileSync(path, 'utf8').trim();
const own = (lock: SeatLock): lock is { release(): void } => 'release' in lock;
const fresh = new RegExp(`^${HOLDER} [0-9a-f]+ ${START}$`);

describe('the seat lock', () => {
  test('a dead holder is taken over, and a live one is left alone', () => {
    const { dir, path } = place();
    writeFileSync(path, `${DEAD} deadbeef\n`);
    const taken = acquireSeatLock(dir, 'acme', 'lead', facts());
    expect(own(taken)).toBe(true);
    expect(token(path)).toMatch(fresh);
    if (own(taken)) taken.release();
    expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();

    // A token from before starts were recorded, whose pid is alive: it carries nothing to
    // compare, so it is held exactly as it always was.
    writeFileSync(path, `${HOLDER} deadbeef\n`);
    const held = acquireSeatLock(dir, 'acme', 'lead', facts());
    expect(held).toEqual({ held: HOLDER, startedAt: null });
    expect(token(path)).toBe(`${HOLDER} deadbeef`);
  });

  test('the reviewer interleaving has no instant to land in: a taker stops before its one atomic step', () => {
    // The old lock published an empty file and wrote the pid after; a second taker read
    // that empty file as pid 0, renamed it away and took a fresh lock, and the first
    // taker then wrote into its unlinked inode and proceeded. Here the second taker is
    // run in the instant after the first has staged its token and before its `link`,
    // which is the only window the link-based lock has.
    const { dir, path } = place();
    let b: SeatLock | undefined;
    let stopped = false;
    const steps: Partial<LockSteps> = {
      ...facts(),
      nonce: () => 'aaaaaaaaaaaa',
      publish: (from, to) => {
        if (to === path && !stopped) {
          stopped = true;
          b = acquireSeatLock(dir, 'acme', 'lead', facts());
        }
        lockSteps.publish(from, to);
      },
    };
    const a = acquireSeatLock(dir, 'acme', 'lead', steps);
    expect(b).toBeDefined();
    expect(own(b as SeatLock)).toBe(true);
    expect('held' in a).toBe(true);
    // The taker that paused before publishing never saw, and never left, an empty lock:
    // the name only ever came into being with a complete token.
    expect(token(path)).toMatch(/^[1-9]\d* [0-9a-f]+(?: \d+)?$/);
    expect(readdirSync(join(dir, 'seat-locks', 'acme'))).toEqual(['lead']);
    if (own(b as SeatLock)) (b as { release(): void }).release();
    expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('a takeover claim keeps a second taker from removing the lock its holder publishes', () => {
    // Without the claim: both takers read the stale token, the first removes it and
    // publishes, the second then removes that fresh lock and publishes its own.
    const { dir, path } = place();
    const stale = `${DEAD} deadbeef\n`;
    writeFileSync(path, stale);
    let b: SeatLock | undefined;
    let ran = false;
    const steps: Partial<LockSteps> = {
      ...facts(),
      drop: (target) => {
        if (target === path && !ran) {
          ran = true;
          b = acquireSeatLock(dir, 'acme', 'lead', facts());
        }
        lockSteps.drop(target);
      },
    };
    const a = acquireSeatLock(dir, 'acme', 'lead', steps);
    expect(own(a)).toBe(true);
    expect(b).toBeDefined();
    expect('held' in (b as SeatLock)).toBe(true);
    // B was refused at the claim, so the lock A published is A's own and still there.
    expect(token(path)).toMatch(fresh);
    if (own(a)) a.release();
  });

  test('a taker that loses the re-link after removing a stale lock is refused, not a second holder', () => {
    const { dir, path } = place();
    writeFileSync(path, `${DEAD} deadbeef\n`);
    let c: SeatLock | undefined;
    let ran = false;
    const steps: Partial<LockSteps> = {
      ...facts(),
      drop: (target) => {
        lockSteps.drop(target);
        if (target === path && !ran) {
          ran = true;
          c = acquireSeatLock(dir, 'acme', 'lead', facts());
        }
      },
    };
    const a = acquireSeatLock(dir, 'acme', 'lead', steps);
    expect('held' in a).toBe(true);
    expect(c).toBeDefined();
    expect(own(c as SeatLock)).toBe(true);
    expect(token(path)).toMatch(fresh);
    if (own(c as SeatLock)) (c as { release(): void }).release();
  });

  test('a lock that cannot be read or parsed is held, never stale', () => {
    const { dir, path } = place();
    writeFileSync(path, '');
    expect(acquireSeatLock(dir, 'acme', 'lead', facts())).toEqual({ held: -1, startedAt: null });
    expect(readFileSync(path, 'utf8')).toBe('');

    writeFileSync(path, 'nonsense\n');
    expect(acquireSeatLock(dir, 'acme', 'lead', facts())).toEqual({ held: -1, startedAt: null });
    expect(readFileSync(path, 'utf8')).toBe('nonsense\n');

    // A directory cannot be read as a token and cannot be replaced by `link`.
    lockSteps.drop(path);
    mkdirSync(path);
    expect(acquireSeatLock(dir, 'acme', 'lead', facts())).toEqual({ held: -1, startedAt: null });
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readdirSync(join(dir, 'seat-locks', 'acme'))).toEqual(['lead']);
  });

  test('release removes only a lock that still carries this taker\'s token', () => {
    const { dir, path } = place();
    const lock = acquireSeatLock(dir, 'acme', 'lead', facts());
    expect(own(lock)).toBe(true);
    if (!own(lock)) return;
    const mine = token(path);
    writeFileSync(path, `${DEAD} other\n`);
    lock.release();
    expect(readFileSync(path, 'utf8')).toBe(`${DEAD} other\n`);
    writeFileSync(path, `${mine}\n`);
    if (own(lock)) lock.release();
    expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('a claim left by a dead taker blocks nobody', () => {
    const { dir, path, claim } = place();
    writeFileSync(path, `${DEAD} deadbeef\n`);
    writeFileSync(claim, `${DEAD} deadbeef\n`);
    const lock = acquireSeatLock(dir, 'acme', 'lead', facts());
    expect(own(lock)).toBe(true);
    expect(token(path)).toMatch(fresh);
    if (own(lock)) lock.release();
  });

  test('a claim held by a live taker refuses the takeover and leaves the stale lock', () => {
    const { dir, path, claim } = place();
    writeFileSync(path, `${DEAD} deadbeef\n`);
    writeFileSync(claim, `${HOLDER} cafefeed\n`);
    expect(acquireSeatLock(dir, 'acme', 'lead', facts())).toEqual({ held: -1, startedAt: null });
    expect(readFileSync(path, 'utf8')).toBe(`${DEAD} deadbeef\n`);
    expect(readFileSync(claim, 'utf8')).toBe(`${HOLDER} cafefeed\n`);
  });

  // A token records the holder's start: `<pid> <nonce> <startedAtMs>`. After a reboot the OS can
  // hand a pid to an unrelated process, so liveness alone is not ownership; the lock is held only
  // when the live process at that pid started when the token says it did.
  describe('a lock is held only by the process that wrote it', () => {
    test('a lock from a previous boot whose pid now names another process is taken over', () => {
      const { dir, path, claim } = place();
      writeFileSync(path, `${HOLDER} cafefeed ${BOOT - 60_000}\n`);
      const lock = acquireSeatLock(dir, 'acme', 'lead', facts());
      expect(own(lock)).toBe(true);
      // The new token records this process's own start, so the lock is provably this process's.
      expect(token(path)).toMatch(fresh);
      expect(statSync(claim, { throwIfNoEntry: false })).toBeUndefined();
      if (own(lock)) lock.release();
    });

    test('a lock whose pid and start both match is held, and its holder carries the recorded start', () => {
      const { dir, path } = place();
      writeFileSync(path, `${HOLDER} cafefeed ${START}\n`);
      expect(acquireSeatLock(dir, 'acme', 'lead', facts())).toEqual({ held: HOLDER, startedAt: START });
      expect(token(path)).toBe(`${HOLDER} cafefeed ${START}`);
    });

    test('a start inside the start line\'s one-second resolution still matches', () => {
      const { dir, path } = place();
      writeFileSync(path, `${FOREIGN} cafefeed ${START}\n`);
      const lock = acquireSeatLock(dir, 'acme', 'lead', facts({ startOf: () => START + 1_500 }));
      expect(lock).toEqual({ held: FOREIGN, startedAt: START });
    });

    test('a pid whose start differs is a reused pid, and the lock is taken over', () => {
      const { dir, path } = place();
      writeFileSync(path, `${HOLDER} cafefeed ${START - 120_000}\n`);
      const lock = acquireSeatLock(dir, 'acme', 'lead', facts());
      expect(own(lock)).toBe(true);
      expect(token(path)).toMatch(fresh);
      if (own(lock)) lock.release();
    });

    test('a live pid whose start cannot be read is held, and the taker still records its own', () => {
      const { dir, path } = place();
      // A live process the table cannot describe is held, never taken for a reused pid.
      writeFileSync(path, `${FOREIGN} cafefeed ${START}\n`);
      expect(acquireSeatLock(dir, 'acme', 'lead', facts({ startOf: () => null }))).toEqual({ held: FOREIGN, startedAt: START });

      // With the name free, the same failing table read changes nothing: the taker's own start
      // is a fact of the process itself, so the token it publishes records one.
      lockSteps.drop(path);
      const lock = acquireSeatLock(dir, 'acme', 'lead', facts({ startOf: () => null }));
      expect(own(lock)).toBe(true);
      expect(token(path)).toMatch(fresh);
    });

    // A token written before tokens recorded a start has nothing to compare. A live pid at it
    // keeps it held, whatever the file's own time says: after a clock step a file this boot's
    // holder wrote can look older than the boot, and taking that lock would admit a second
    // writer over a live one. Only a dead pid shows the token is not its writer's.
    test('a start-less live lock whose file predates this boot stays held under a stepped clock', () => {
      const { dir, path } = place();
      writeFileSync(path, `${HOLDER} cafefeed\n`);
      // The clock stepped back after the file was written: its mtime now reads an hour before
      // the boot instant, while the process that wrote it is still alive.
      const stepped = new Date(BOOT - 3_600_000);
      utimesSync(path, stepped, stepped);
      expect(acquireSeatLock(dir, 'acme', 'lead', facts())).toEqual({ held: HOLDER, startedAt: null });
      expect(token(path)).toBe(`${HOLDER} cafefeed`);
    });

    test('a start-less lock whose pid is alive stays held, whatever its file\'s time', () => {
      const { dir, path } = place();
      writeFileSync(path, `${HOLDER} cafefeed\n`);
      expect(acquireSeatLock(dir, 'acme', 'lead', facts())).toEqual({ held: HOLDER, startedAt: null });
      expect(token(path)).toBe(`${HOLDER} cafefeed`);
    });

    test('a start-less claim with a live pid refuses the takeover too', () => {
      // The claim's taker wrote no start either. Its pid is alive, so the claim is held, and the
      // stale lock behind it is left exactly as it was.
      const { dir, path, claim } = place();
      writeFileSync(path, `${DEAD} deadbeef\n`);
      writeFileSync(claim, `${HOLDER} cafefeed\n`);
      const stepped = new Date(BOOT - 60_000);
      utimesSync(claim, stepped, stepped);
      expect(acquireSeatLock(dir, 'acme', 'lead', facts())).toEqual({ held: -1, startedAt: null });
      expect(readFileSync(path, 'utf8')).toBe(`${DEAD} deadbeef\n`);
      expect(readFileSync(claim, 'utf8')).toBe(`${HOLDER} cafefeed\n`);
    });
  });

  // The send fast path reads a lock without taking it: a live holder keeps the send off the
  // socket, and a file with no live holder behind it does not.
  describe('a lock is read without being taken', () => {
    test('no file is no holder, and the file is still absent after the read', () => {
      const { dir, path } = place();
      expect(seatLockHolder(dir, 'acme', 'lead', facts())).toBeNull();
      expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();
    });

    test('a live holder behind a matching start is reported, and its lock is left in place', () => {
      const { dir, path } = place();
      writeFileSync(path, `${HOLDER} cafefeed ${START}\n`);
      expect(seatLockHolder(dir, 'acme', 'lead', facts())).toEqual({ held: HOLDER, startedAt: START });
      expect(token(path)).toBe(`${HOLDER} cafefeed ${START}`);
    });

    test('a dead pid and a pid whose start moved are both no holder', () => {
      const { dir, path } = place();
      writeFileSync(path, `${FOREIGN} cafefeed ${START}\n`);
      expect(seatLockHolder(dir, 'acme', 'lead', facts({ alive: () => false }))).toBeNull();
      expect(seatLockHolder(dir, 'acme', 'lead', facts({ startOf: () => START - 120_000 }))).toBeNull();
    });

    // The taker's own start is never asked of the process table, so the table cannot contradict
    // a lock this very process holds: the token it wrote is judged by the start it wrote.
    test('a token naming this process is judged by this process\'s own start, not the table\'s', () => {
      const { dir, path } = place();
      writeFileSync(path, `${HOLDER} cafefeed ${START}\n`);
      expect(seatLockHolder(dir, 'acme', 'lead', facts({ startOf: () => START - 120_000 }))).toEqual({ held: HOLDER, startedAt: START });
    });

    test('a start-less lock with a live pid is a holder, whatever its file\'s time', () => {
      const { dir, path } = place();
      writeFileSync(path, `${HOLDER} cafefeed\n`);
      const stepped = new Date(BOOT - 3_600_000);
      utimesSync(path, stepped, stepped);
      expect(seatLockHolder(dir, 'acme', 'lead', facts())).toEqual({ held: HOLDER, startedAt: null });
    });

    test('a lock that cannot be read is reported as an unreadable holder, and never removed', () => {
      const { dir, path } = place();
      writeFileSync(path, 'nonsense\n');
      expect(seatLockHolder(dir, 'acme', 'lead', facts())).toEqual({ held: -1, startedAt: null });
      expect(readFileSync(path, 'utf8')).toBe('nonsense\n');
    });
  });

  describe('a refusal names the holder it found', () => {
    test('a token with a start names the pid and the instant it records', () => {
      expect(holderText({ held: HOLDER, startedAt: START })).toBe(`pid ${HOLDER}, started ${new Date(START).toISOString()}`);
    });

    test('a token with no start names the pid and says the start is missing', () => {
      expect(holderText({ held: HOLDER, startedAt: null })).toBe(`pid ${HOLDER}, no start time recorded`);
    });

    test('an unreadable lock names no pid', () => {
      expect(holderText({ held: -1, startedAt: null })).toBe('an unreadable lock');
    });
  });
});
