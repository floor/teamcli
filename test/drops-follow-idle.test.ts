// The wait between `team drops --follow` reads. An idle follow must sit on a file event in the
// drop folder (one watch, one slow fallback timer), never re-read the folder in a hot loop; a
// dropped event or a folder that did not exist yet is caught by the fallback.
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPoll, FOLLOW_FALLBACK_MS, type FollowWaiters } from '../src/commands/drops.ts';

class FakeWatcher extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

type Waiters = {
  waiters: FollowWaiters;
  seen: Array<{ dir: string; options: { persistent: boolean } }>;
  watchers: FakeWatcher[];
  timers: Array<() => void>;
  cleared: () => number;
};

/** The wait's two seams, recorded instead of armed: no folder and no real timer is touched. */
function fakeWaiters(): Waiters {
  const seen: Array<{ dir: string; options: { persistent: boolean } }> = [];
  const watchers: FakeWatcher[] = [];
  const timers: Array<() => void> = [];
  let cleared = 0;
  const waiters: FollowWaiters = {
    watch: (dir, options) => {
      seen.push({ dir, options });
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher as unknown as FSWatcher;
    },
    setTimer: (run) => {
      timers.push(run);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      cleared += 1;
    },
  };
  return { waiters, seen, watchers, timers, cleared: () => cleared };
}

describe('the --follow wait', () => {
  test('an idle follow arms one watch on the drop folder and one slow fallback timer', async () => {
    const { waiters, seen, watchers, timers } = fakeWaiters();
    let resolved = false;
    const poll = defaultPoll('/the/drop-folder', waiters).then((again) => {
      resolved = true;
      return again;
    });
    expect(seen).toEqual([{ dir: '/the/drop-folder', options: { persistent: false } }]);
    expect(watchers).toHaveLength(1);
    expect(timers).toHaveLength(1);
    // Nothing wakes it on its own: the wait resolves only on an event or the fallback.
    await Promise.resolve();
    expect(resolved).toBe(false);
    watchers[0]!.emit('rename', 'drop.yaml', 'drop.yaml');
    expect(await poll).toBe(true);
    expect(watchers[0]!.closed).toBe(true);
  });

  test('a change event wakes the read without waiting for the fallback', async () => {
    const { waiters, watchers, timers } = fakeWaiters();
    const poll = defaultPoll('/the/drop-folder', waiters);
    watchers[0]!.emit('change', 'rename');
    expect(await poll).toBe(true);
    // Exactly one timer was ever armed, and the one watch was closed: no loop, no leak.
    expect(timers).toHaveLength(1);
    expect(watchers[0]!.closed).toBe(true);
  });

  test('the fallback timer wakes the read when no file event comes', async () => {
    const { waiters, watchers, timers, cleared } = fakeWaiters();
    const poll = defaultPoll('/the/drop-folder', waiters);
    timers[0]!();
    expect(await poll).toBe(true);
    expect(watchers[0]!.closed).toBe(true);
    expect(cleared()).toBe(1);
  });

  test('a folder that cannot be watched still waits on the fallback', async () => {
    const { waiters, timers } = fakeWaiters();
    const poll = defaultPoll('/not/there/yet', {
      ...waiters,
      watch: () => {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      },
    });
    expect(timers).toHaveLength(1);
    timers[0]!();
    expect(await poll).toBe(true);
  });

  test('an idle follow takes no read pass over a short window, and a drop wakes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drops-follow-idle-'));
    let resolved = false;
    let fallbackFired = false;
    const poll = defaultPoll(dir, {
      // The real fallback timer, but recorded: a wake before it fires came from the real watch.
      setTimer: (run, ms) =>
        setTimeout(() => {
          fallbackFired = true;
          run();
        }, ms),
    }).then((again) => {
      resolved = true;
      return again;
    });
    // The fallback is seconds away, so an idle wait must still be waiting: a hot read loop would
    // have resolved (and read) long before this window closes.
    await new Promise((run) => setTimeout(run, 300));
    expect(resolved).toBe(false);
    writeFileSync(join(dir, 'drop.yaml'), 'a drop\n');
    expect(await poll).toBe(true);
    // The write woke the wait through the real folder watch, well before the fallback was due.
    expect(fallbackFired).toBe(false);
    expect(FOLLOW_FALLBACK_MS).toBeGreaterThanOrEqual(1000);
  });
});
