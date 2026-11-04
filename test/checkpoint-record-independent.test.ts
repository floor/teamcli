// Independent verification of context-reset slice 1 (`src/checkpoint/checkpoint.ts`,
// `src/handover/paths.ts`, and the `readState` checkpoint sanitizer in `src/state.ts`):
// 1. A checkpoint record whose `path` is not the exact path `handoverPath(dir, seat, new Date(at))`
//    mints for that seat at its `at` is dropped at the read door — including `/etc/passwd`,
//    another seat's minted path, the same seat's path at another instant, another project's path,
//    or a traversal path, even when every other field (`by`, `session`, `at`, `deadline`) is valid.
// 2. Malformed deadlines, stale/foreign terminal-host sessions, and superseded asks are dropped or
//    replaced cleanly, while an ask whose deadline has passed in the current session remains
//    visible so restart can still consume a late handover or report a stale ask.
// 3. Restart's reader (`latestCheckpoint(readState(dir), seat, session)`) returns only a record
//    that passed the state read-door verification and matches the active session.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askCheckpoint, BOUNDARY_WAIT_MS, latestCheckpoint } from '../src/checkpoint/checkpoint.ts';
import { handoverPath } from '../src/handover/paths.ts';
import { readState, STATE_FILE, updateState, type CheckpointRecord } from '../src/state.ts';
import { handoverPath as swapHandoverPath } from '../src/swap/queue.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const T0 = new Date('2026-11-04T09:00:00.000Z');
const T1 = new Date('2026-11-04T09:15:00.000Z');
const T2 = new Date('2026-11-04T09:45:00.000Z');

const owned: string[] = [];
afterEach(() => {
  for (const dir of owned.splice(0)) {
    discardFixtures([dir]);
  }
});

function makeProjectDir(prefix = 'ctx-reset-s1-ind-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  owned.push(dir);
  return dir;
}

function writeRawCheckpoints(dir: string, checkpoints: unknown): void {
  const base = existsSync(join(dir, STATE_FILE))
    ? (JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as Record<string, unknown>)
    : { format: 1, sessions: {} };
  writeFileSync(
    join(dir, STATE_FILE),
    `${JSON.stringify({ ...base, checkpoints }, null, 2)}\n`,
  );
}

describe('context-reset slice 1 independent verification', () => {
  test('1. handoverPath is shared with the swap queue and deterministic per (dir, seat, instant)', () => {
    const dir = makeProjectDir();
    const expected = join(dir, 'handovers', 'builder-2026-11-04T09-00-00-000Z.md');
    expect(handoverPath(dir, 'builder', T0)).toBe(expected);
    expect(swapHandoverPath(dir, 'builder', T0)).toBe(expected);

    const asked = askCheckpoint(dir, 'builder', 'vega', 'lead', T0);
    expect(asked.path).toBe(expected);
    expect(asked.at).toBe(T0.toISOString());
    expect(asked.deadline).toBe(new Date(T0.getTime() + BOUNDARY_WAIT_MS).toISOString());
    expect(BOUNDARY_WAIT_MS).toBe(30 * 60_000);
    // Asking never creates the handovers folder or file on disk.
    expect(existsSync(join(dir, 'handovers'))).toBe(false);
    expect(existsSync(asked.path)).toBe(false);
  });

  test('2. a checkpoint record whose path is not the one an ask mints for that seat at its at is dropped', () => {
    const dir = makeProjectDir();
    const otherDir = makeProjectDir('ctx-reset-other-');
    const validDeadline = new Date(T0.getTime() + BOUNDARY_WAIT_MS).toISOString();

    // Mint a real checkpoint for `architect` at T0.
    const validArchitect = askCheckpoint(dir, 'architect', 'vega', 'owner', T0);

    writeRawCheckpoints(dir, {
      // Valid record for `architect` at T0: must survive.
      architect: validArchitect,
      // `/etc/passwd` with a valid deadline and valid fields: must be dropped.
      passwdSeat: {
        by: 'owner',
        path: '/etc/passwd',
        session: 'vega',
        at: T0.toISOString(),
        deadline: validDeadline,
      },
      // Another seat's (`architect`'s) minted path placed under `builder`: must be dropped.
      builder: {
        by: 'owner',
        path: handoverPath(dir, 'architect', T0),
        session: 'vega',
        at: T0.toISOString(),
        deadline: validDeadline,
      },
      // Same seat (`reviewer`), but path was minted for T1 while `at` is T0: must be dropped.
      reviewer: {
        by: 'owner',
        path: handoverPath(dir, 'reviewer', T1),
        session: 'vega',
        at: T0.toISOString(),
        deadline: validDeadline,
      },
      // Same seat (`tester`) and instant (`T0`), but path was minted for another project dir: must be dropped.
      tester: {
        by: 'owner',
        path: handoverPath(otherDir, 'tester', T0),
        session: 'vega',
        at: T0.toISOString(),
        deadline: validDeadline,
      },
      // Path traversal inside the project's handovers folder: must be dropped.
      curator: {
        by: 'owner',
        path: join(dir, 'handovers', '..', 'team.state.json'),
        session: 'vega',
        at: T0.toISOString(),
        deadline: validDeadline,
      },
      // Invalid lock/seat key (`../escape`) even if path matches `handoverPath`: must be dropped.
      '../escape': {
        by: 'owner',
        path: handoverPath(dir, '../escape', T0),
        session: 'vega',
        at: T0.toISOString(),
        deadline: validDeadline,
      },
    });

    const state = readState(dir);
    expect(Object.keys(state.checkpoints ?? {})).toEqual(['architect']);
    expect(state.checkpoints?.architect).toEqual(validArchitect);

    // None of the dropped seats are ever returned to restart's reader (`latestCheckpoint`).
    for (const rejected of ['passwdSeat', 'builder', 'reviewer', 'tester', 'curator', '../escape']) {
      expect(latestCheckpoint(state, rejected, 'vega')).toBeNull();
    }
    expect(latestCheckpoint(state, 'architect', 'vega')).toEqual(validArchitect);
  });

  test('3. malformed deadlines, missing fields, and non-object checkpoints maps are dropped at the read door', () => {
    const dir = makeProjectDir();
    const valid = askCheckpoint(dir, 'architect', 'vega', 'owner', T0);
    const validDeadline = new Date(T0.getTime() + BOUNDARY_WAIT_MS).toISOString();

    writeRawCheckpoints(dir, {
      architect: valid,
      badDeadlineText: {
        by: 'owner',
        path: handoverPath(dir, 'badDeadlineText', T0),
        session: 'vega',
        at: T0.toISOString(),
        deadline: 'not-a-timestamp',
      },
      emptyDeadline: {
        by: 'owner',
        path: handoverPath(dir, 'emptyDeadline', T0),
        session: 'vega',
        at: T0.toISOString(),
        deadline: '',
      },
      badAtText: {
        by: 'owner',
        path: handoverPath(dir, 'badAtText', T0),
        session: 'vega',
        at: 'not-a-timestamp',
        deadline: validDeadline,
      },
      emptyBy: {
        by: '',
        path: handoverPath(dir, 'emptyBy', T0),
        session: 'vega',
        at: T0.toISOString(),
        deadline: validDeadline,
      },
      emptySession: {
        by: 'owner',
        path: handoverPath(dir, 'emptySession', T0),
        session: '',
        at: T0.toISOString(),
        deadline: validDeadline,
      },
      arrayValue: [],
      nullValue: null,
    });

    const state = readState(dir);
    expect(Object.keys(state.checkpoints ?? {})).toEqual(['architect']);
    expect(state.checkpoints?.architect).toEqual(valid);

    // If `checkpoints` in `team.state.json` is not an object (e.g., a string or number), the key is deleted.
    writeRawCheckpoints(dir, 'corrupted-checkpoints-map');
    const stateFromScalar = readState(dir);
    expect(stateFromScalar.checkpoints).toBeUndefined();
  });

  test('4. stale session asks and superseded asks are not offered, while a verified ask stays readable for restart', () => {
    const dir = makeProjectDir();

    // 1. Initial ask at T0 in `old-session`:
    const oldAsk = askCheckpoint(dir, 'builder', 'old-session', 'lead', T0);
    // Restart running in `new-session` never sees `old-session`'s stale checkpoint ask.
    expect(latestCheckpoint(readState(dir), 'builder', 'new-session')).toBeNull();
    expect(latestCheckpoint(readState(dir), 'builder', 'old-session')).toEqual(oldAsk);

    // 2. A new ask for `builder` at T1 in `new-session` supersedes the earlier T0 ask:
    const newAsk = askCheckpoint(dir, 'builder', 'new-session', 'owner', T1);
    expect(latestCheckpoint(readState(dir), 'builder', 'old-session')).toBeNull();
    expect(latestCheckpoint(readState(dir), 'builder', 'new-session')).toEqual(newAsk);
    expect(newAsk.path).not.toBe(oldAsk.path);
    expect(newAsk.at).toBe(T1.toISOString());

    // 3. Even after `newAsk.deadline` (`T1 + 30m = 09:45`) is reached at `T2`, `latestCheckpoint`
    //    returns the verified record so `performRestart` can consume a late file or report the stale ask.
    expect(Date.parse(newAsk.deadline)).toBeLessThanOrEqual(T2.getTime());
    expect(latestCheckpoint(readState(dir), 'builder', 'new-session')).toEqual(newAsk);

    // 4. If `team.state.json` is hand-edited to tamper with `builder`'s `path` (e.g. pointing to an
    //    arbitrary file while keeping `newAsk`'s `at`, `deadline`, `by`, and `session`), restart's
    //    reader (`latestCheckpoint(readState(dir), ...)`) drops it and returns `null`, and the next
    //    `updateState` persists the cleaned map without the tampered entry.
    const tampered: CheckpointRecord = {
      ...newAsk,
      path: join(dir, 'handovers', 'builder-tampered.md'),
    };
    writeRawCheckpoints(dir, { builder: tampered });
    expect(latestCheckpoint(readState(dir), 'builder', 'new-session')).toBeNull();

    updateState(dir, () => {});
    const persisted = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as {
      checkpoints?: Record<string, unknown>;
    };
    expect(persisted.checkpoints).toEqual({});
  });
});
