// Independent verification of fix/c75-seat-lock-start-time (36e0aea7a).
//
// Behaviour covered:
// 1. A reused pid with a different start time is stale (acquireSeatLock takes over; seatLockHolder is null).
// 2. A matching pid and start is held (exact match, within 2 s tolerance, and when a foreign live pid's start cannot be read).
// 3. A start-less lock with a live pid stays held whatever its file age (no boot-time rule), and is stale only when its pid is dead.
// 4. A taker whose adapter start read fails still writes a token with a start taken from the process itself (ownStart), and a token naming this process is judged by its own start.
// 5. Two racing takers leave one holder across fresh publication and stale-lock takeover windows.
// 6. Refusal and busy strings name pid and start when recorded, "pid N, no start time recorded" when start-less, and unreadable when corrupt.
// 7. A leftover lock file of a dead process (or a reused pid) does not divert a send off the socket.
//
// Synthetic process facts only; never touches real process tables.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { runLockText } from '../src/launch/run-lock.ts';
import {
  acquireSeatLock,
  holderText,
  lockSteps,
  seatLockHolder,
  seatLockPath,
  type LockSteps,
  type SeatLock,
} from '../src/launch/seat-lock.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { readHistory } from '../src/send/history.ts';
import { LOG_FILE } from '../src/state.ts';
import { fake, owner, world, type World } from './send-native-fixtures.ts';

const ORIGINAL_STEPS: LockSteps = { ...lockSteps };
const tempDirs: string[] = [];
let extraCleanup: () => void = () => {};

afterEach(() => {
  Object.assign(lockSteps, ORIGINAL_STEPS);
  extraCleanup();
  extraCleanup = () => {};
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

const SYNTH_PID = 5150;
const OTHER_PID = 6260;
const DEAD_PID = 7370;
const EARLIER_MS = Date.parse('2026-11-05T08:00:00.000Z');
const START_MS = Date.parse('2026-11-05T09:30:00.000Z');

function makePlace(slot = 'alpha'): { dir: string; path: string; claim: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-lock-ind-')));
  tempDirs.push(dir);
  const path = seatLockPath(dir, 'acme', slot);
  mkdirSync(join(dir, 'seat-locks', 'acme'), { recursive: true });
  return { dir, path, claim: `${path}.steal` };
}

function syntheticSteps(overrides: Partial<LockSteps> = {}): Partial<LockSteps> {
  return {
    pid: () => SYNTH_PID,
    nonce: () => '112233445566',
    ownStart: () => START_MS,
    alive: (pid) => pid === SYNTH_PID || pid === OTHER_PID,
    startOf: (pid) => (pid === SYNTH_PID || pid === OTHER_PID ? START_MS : null),
    ...overrides,
  };
}

function readToken(path: string): string {
  return readFileSync(path, 'utf8').trim();
}

function isOwned(lock: SeatLock): lock is { release(): void } {
  return 'release' in lock;
}

describe('1. a reused pid with a different start time is stale', () => {
  test('acquireSeatLock takes over a lock whose live pid started before or after the recorded instant beyond tolerance', () => {
    const { dir, path, claim } = makePlace();

    // Token from an earlier process at a foreign live PID (judged via startOf).
    writeFileSync(path, `${OTHER_PID} aabbccddeeff ${EARLIER_MS - 120_000}\n`);
    const lock1 = acquireSeatLock(dir, 'acme', 'alpha', syntheticSteps());
    expect(isOwned(lock1)).toBe(true);
    expect(readToken(path)).toBe(`${SYNTH_PID} 112233445566 ${START_MS}`);
    expect(statSync(claim, { throwIfNoEntry: false })).toBeUndefined();
    if (isOwned(lock1)) lock1.release();
    expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();

    // Token whose recorded start sits just outside the 2_000 ms rounding tolerance (2_001 ms away).
    writeFileSync(path, `${OTHER_PID} aabbccddeeff ${START_MS - 2_001}\n`);
    const lock2 = acquireSeatLock(dir, 'acme', 'alpha', syntheticSteps({ nonce: () => '998877665544' }));
    expect(isOwned(lock2)).toBe(true);
    expect(readToken(path)).toBe(`${SYNTH_PID} 998877665544 ${START_MS}`);
    if (isOwned(lock2)) lock2.release();
  });

  test('seatLockHolder reports null for a reused pid or dead pid without removing the file', () => {
    const { dir, path } = makePlace();
    const staleToken = `${OTHER_PID} aabbccddeeff ${START_MS - 60_000}`;
    writeFileSync(path, `${staleToken}\n`);

    expect(seatLockHolder(dir, 'acme', 'alpha', syntheticSteps())).toBeNull();
    expect(seatLockHolder(dir, 'acme', 'alpha', syntheticSteps({ alive: () => false }))).toBeNull();
    expect(readToken(path)).toBe(staleToken);
  });

  test('a leftover .steal claim with a reused pid is treated as stale and does not block takeover', () => {
    const { dir, path, claim } = makePlace();
    writeFileSync(path, `${DEAD_PID} deadbeef0000 ${START_MS - 90_000}\n`);
    writeFileSync(claim, `${OTHER_PID} cafefeed1111 ${START_MS - 90_000}\n`);

    const lock = acquireSeatLock(dir, 'acme', 'alpha', syntheticSteps());
    expect(isOwned(lock)).toBe(true);
    expect(readToken(path)).toBe(`${SYNTH_PID} 112233445566 ${START_MS}`);
    expect(statSync(claim, { throwIfNoEntry: false })).toBeUndefined();
    if (isOwned(lock)) lock.release();
  });
});

describe('2. a matching pid and start is held', () => {
  test('exact start match and readings within the 2_000 ms rounding window keep the lock held', () => {
    const { dir, path } = makePlace();
    const existing = `${OTHER_PID} cafefeed2222 ${START_MS}`;
    writeFileSync(path, `${existing}\n`);

    // Exact match.
    expect(acquireSeatLock(dir, 'acme', 'alpha', syntheticSteps())).toEqual({
      held: OTHER_PID,
      startedAt: START_MS,
    });
    expect(seatLockHolder(dir, 'acme', 'alpha', syntheticSteps())).toEqual({
      held: OTHER_PID,
      startedAt: START_MS,
    });

    // At the +2_000 ms and -2_000 ms tolerance boundaries.
    expect(
      acquireSeatLock(dir, 'acme', 'alpha', syntheticSteps({ startOf: () => START_MS + 2_000 })),
    ).toEqual({ held: OTHER_PID, startedAt: START_MS });
    expect(
      acquireSeatLock(dir, 'acme', 'alpha', syntheticSteps({ startOf: () => START_MS - 2_000 })),
    ).toEqual({ held: OTHER_PID, startedAt: START_MS });
    expect(readToken(path)).toBe(existing);
  });

  test('a live pid whose start cannot be read stays held rather than being mistaken for a reused pid', () => {
    const { dir, path } = makePlace();
    const existing = `${OTHER_PID} cafefeed2222 ${START_MS}`;
    writeFileSync(path, `${existing}\n`);

    expect(
      acquireSeatLock(dir, 'acme', 'alpha', syntheticSteps({ startOf: () => null })),
    ).toEqual({ held: OTHER_PID, startedAt: START_MS });
    expect(
      seatLockHolder(dir, 'acme', 'alpha', syntheticSteps({ startOf: () => null })),
    ).toEqual({ held: OTHER_PID, startedAt: START_MS });
    expect(readToken(path)).toBe(existing);
  });
});

describe('3. a start-less lock with a live pid stays held whatever its file age, and is stale only when its pid is dead', () => {
  test('a start-less lock with a live pid stays held even when its file is ancient or recent', () => {
    const { dir, path } = makePlace();
    writeFileSync(path, `${OTHER_PID} cafefeed0001\n`);

    // Backdate the file to epoch + 1s (ancient file age).
    const ancient = new Date(1_000);
    utimesSync(path, ancient, ancient);
    expect(acquireSeatLock(dir, 'acme', 'alpha', syntheticSteps())).toEqual({
      held: OTHER_PID,
      startedAt: null,
    });
    expect(seatLockHolder(dir, 'acme', 'alpha', syntheticSteps())).toEqual({
      held: OTHER_PID,
      startedAt: null,
    });
    expect(readToken(path)).toBe(`${OTHER_PID} cafefeed0001`);

    // Recent file age.
    const recent = new Date(START_MS);
    utimesSync(path, recent, recent);
    expect(acquireSeatLock(dir, 'acme', 'alpha', syntheticSteps())).toEqual({
      held: OTHER_PID,
      startedAt: null,
    });
    expect(seatLockHolder(dir, 'acme', 'alpha', syntheticSteps())).toEqual({
      held: OTHER_PID,
      startedAt: null,
    });
    expect(readToken(path)).toBe(`${OTHER_PID} cafefeed0001`);
  });

  test('a start-less lock whose pid is dead is stale and taken over', () => {
    const { dir, path, claim } = makePlace();
    writeFileSync(path, `${DEAD_PID} cafefeed0002\n`);
    writeFileSync(claim, `${DEAD_PID} cafefeed0003\n`);

    expect(seatLockHolder(dir, 'acme', 'alpha', syntheticSteps())).toBeNull();
    const lock = acquireSeatLock(dir, 'acme', 'alpha', syntheticSteps());
    expect(isOwned(lock)).toBe(true);
    expect(readToken(path)).toBe(`${SYNTH_PID} 112233445566 ${START_MS}`);
    expect(statSync(claim, { throwIfNoEntry: false })).toBeUndefined();
    if (isOwned(lock)) lock.release();
  });

  test('a start-less .steal claim with a live pid blocks takeover whatever its file age', () => {
    const { dir, path, claim } = makePlace();
    writeFileSync(path, `${DEAD_PID} deadbeef0000\n`);
    writeFileSync(claim, `${OTHER_PID} cafefeed0010\n`);
    const ancient = new Date(1_000);
    utimesSync(claim, ancient, ancient);

    expect(acquireSeatLock(dir, 'acme', 'alpha', syntheticSteps())).toEqual({
      held: -1,
      startedAt: null,
    });
    expect(readToken(path)).toBe(`${DEAD_PID} deadbeef0000`);
    expect(readToken(claim)).toBe(`${OTHER_PID} cafefeed0010`);
  });
});

describe('4. a taker whose adapter start read fails still writes a token with a start, and a token naming this process is judged by its own start', () => {
  test('acquireSeatLock always records a start from ownStart even when startOf returns null', () => {
    const { dir, path } = makePlace();
    let tableQueries = 0;
    const lock = acquireSeatLock(
      dir,
      'acme',
      'alpha',
      syntheticSteps({
        startOf: () => {
          tableQueries += 1;
          return null;
        },
      }),
    );
    expect(isOwned(lock)).toBe(true);
    expect(tableQueries).toBe(0);
    expect(readToken(path)).toBe(`${SYNTH_PID} 112233445566 ${START_MS}`);
    if (isOwned(lock)) lock.release();
    expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('a token naming this process is judged by ownStart rather than the process-table adapter', () => {
    const { dir, path } = makePlace();

    // Matching ownStart stays held even if startOf would report a different time.
    writeFileSync(path, `${SYNTH_PID} cafefeed4444 ${START_MS}\n`);
    expect(
      acquireSeatLock(dir, 'acme', 'alpha', syntheticSteps({ startOf: () => EARLIER_MS - 500_000 })),
    ).toEqual({ held: SYNTH_PID, startedAt: START_MS });
    expect(
      seatLockHolder(dir, 'acme', 'alpha', syntheticSteps({ startOf: () => EARLIER_MS - 500_000 })),
    ).toEqual({ held: SYNTH_PID, startedAt: START_MS });

    // Non-matching ownStart is stale and taken over even when startOf returns null.
    writeFileSync(path, `${SYNTH_PID} cafefeed4444 ${EARLIER_MS - 500_000}\n`);
    expect(seatLockHolder(dir, 'acme', 'alpha', syntheticSteps({ startOf: () => null }))).toBeNull();
    const taken = acquireSeatLock(dir, 'acme', 'alpha', syntheticSteps({ startOf: () => null }));
    expect(isOwned(taken)).toBe(true);
    expect(readToken(path)).toBe(`${SYNTH_PID} 112233445566 ${START_MS}`);
    if (isOwned(taken)) taken.release();
  });
});

describe('5. two racing takers leave one holder', () => {
  test('two takers racing to publish a fresh lock leave exactly one holder and one refusal', () => {
    const { dir, path } = makePlace();
    const takerAStart = START_MS + 1_000;
    const takerBStart = START_MS + 5_000;
    let lockB: SeatLock | undefined;
    let intercepted = false;

    const sharedFacts = (pid: number): number | null => {
      if (pid === SYNTH_PID) return takerAStart;
      if (pid === OTHER_PID) return takerBStart;
      return null;
    };

    const stepsA = syntheticSteps({
      pid: () => SYNTH_PID,
      nonce: () => 'aaaaaaaaaaaa',
      ownStart: () => takerAStart,
      startOf: sharedFacts,
      publish: (from, to) => {
        if (to === path && !intercepted) {
          intercepted = true;
          lockB = acquireSeatLock(
            dir,
            'acme',
            'alpha',
            syntheticSteps({
              pid: () => OTHER_PID,
              nonce: () => 'bbbbbbbbbbbb',
              ownStart: () => takerBStart,
              startOf: sharedFacts,
            }),
          );
        }
        lockSteps.publish(from, to);
      },
    });

    const lockA = acquireSeatLock(dir, 'acme', 'alpha', stepsA);
    expect(lockB).toBeDefined();
    expect(isOwned(lockB!)).toBe(true);
    expect(lockA).toEqual({ held: OTHER_PID, startedAt: takerBStart });
    expect(readToken(path)).toBe(`${OTHER_PID} bbbbbbbbbbbb ${takerBStart}`);
    expect(readdirSync(join(dir, 'seat-locks', 'acme'))).toEqual(['alpha']);
    if (isOwned(lockB!)) lockB.release();
    expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('two takers racing to take over a reused-pid stale lock serialize on .steal and leave one holder', () => {
    const { dir, path } = makePlace();
    // Stale token: SYNTH_PID is live at START_MS, but the token records an earlier start.
    writeFileSync(path, `${SYNTH_PID} 000000000000 ${EARLIER_MS - 300_000}\n`);

    let lockB: SeatLock | undefined;
    let racedAtDrop = false;
    const stepsA = syntheticSteps({
      pid: () => SYNTH_PID,
      nonce: () => 'aaaa11112222',
      drop: (target) => {
        if (target === path && !racedAtDrop) {
          racedAtDrop = true;
          // Taker B arrives while Taker A holds .steal and is about to drop the stale lock.
          lockB = acquireSeatLock(
            dir,
            'acme',
            'alpha',
            syntheticSteps({
              pid: () => OTHER_PID,
              nonce: () => 'bbbb33334444',
            }),
          );
        }
        lockSteps.drop(target);
      },
    });

    const lockA = acquireSeatLock(dir, 'acme', 'alpha', stepsA);
    expect(isOwned(lockA)).toBe(true);
    expect(lockB).toBeDefined();
    expect('held' in lockB!).toBe(true);
    expect(readToken(path)).toBe(`${SYNTH_PID} aaaa11112222 ${START_MS}`);
    if (isOwned(lockA)) lockA.release();
    expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('a taker whose unlink of a stale lock is followed by another taker publishing before re-link is refused', () => {
    const { dir, path } = makePlace();
    writeFileSync(path, `${SYNTH_PID} 000000000000 ${EARLIER_MS - 300_000}\n`);

    let lockB: SeatLock | undefined;
    let racedAfterDrop = false;
    const stepsA = syntheticSteps({
      pid: () => SYNTH_PID,
      nonce: () => 'aaaa55556666',
      drop: (target) => {
        lockSteps.drop(target);
        if (target === path && !racedAfterDrop) {
          racedAfterDrop = true;
          lockB = acquireSeatLock(
            dir,
            'acme',
            'alpha',
            syntheticSteps({
              pid: () => OTHER_PID,
              nonce: () => 'bbbb77778888',
            }),
          );
        }
      },
    });

    const lockA = acquireSeatLock(dir, 'acme', 'alpha', stepsA);
    expect('held' in lockA).toBe(true);
    expect(lockB).toBeDefined();
    expect(isOwned(lockB!)).toBe(true);
    expect(readToken(path)).toBe(`${OTHER_PID} bbbb77778888 ${START_MS}`);
    if (isOwned(lockB!)) lockB.release();
  });
});

describe('6. the refusal names pid and start', () => {
  test('holderText and runLockText include pid and ISO start when present, no-start wording when start-less, and unreadable when -1', () => {
    const { dir } = makePlace();
    const iso = new Date(START_MS).toISOString();

    expect(holderText({ held: SYNTH_PID, startedAt: START_MS })).toBe(`pid ${SYNTH_PID}, started ${iso}`);
    expect(holderText({ held: SYNTH_PID, startedAt: null })).toBe(`pid ${SYNTH_PID}, no start time recorded`);
    expect(holderText({ held: -1, startedAt: null })).toBe('an unreadable lock');

    expect(runLockText(SYNTH_PID, 'acme', dir, START_MS)).toBe(
      `another session-mutating run is holding session acme (pid ${SYNTH_PID}, started ${iso}); try again when it is done`,
    );
    expect(runLockText(SYNTH_PID, 'acme', dir, null)).toBe(
      `another session-mutating run is holding session acme (pid ${SYNTH_PID}, no start time recorded); try again when it is done`,
    );
    expect(runLockText(-1, 'acme', dir, null)).toContain('its lock cannot be read');
  });

  test('a send that meets a held seat lock records the holder pid and start time in its refusal/busy reason', async () => {
    const made = world(['drop']);
    extraCleanup = made.cleanup;
    mkdirSync(join(made.dir, 'seat-locks', 'acme'), { recursive: true });
    const lockPath = seatLockPath(made.dir, 'acme', 'lead');
    writeFileSync(lockPath, `${OTHER_PID} cafefeed9999 ${START_MS}\n`);

    Object.assign(lockSteps, syntheticSteps());
    const io = owner(made.root);
    const code = await runSend(['lead', 'hello'], io, fake(made));

    expect(code).toBe(0);
    const logText = readFileSync(join(made.dir, LOG_FILE), 'utf8');
    expect(logText).toContain(
      `another command holds the seat (pid ${OTHER_PID}, started ${new Date(START_MS).toISOString()})`,
    );
  });
});

describe('7. a leftover file of a dead process does not divert a send off the socket', () => {
  function prepareAcceptingSocketWorld(): World {
    const made = world(null);
    extraCleanup = made.cleanup;
    const teamYamlPath = join(made.dir, 'team.yaml');
    const lobby = resolveLobby(made.home, { entity: 'acme-corp' });
    mkdirSync(lobby, { recursive: true });
    const text = readFileSync(teamYamlPath, 'utf8').replace(lobbyDir(made.home), lobby);
    writeFileSync(teamYamlPath, `${text}entity: acme-corp\n`);

    const settingsPath = cliHookSettingsPath(made.dir, 'acme', 'lead');
    if (settingsPath === null) throw new Error('expected a settings path');
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: 'accept' }));
    const socket = join(made.sockets, '222.sock');
    writeFileSync(socket, '');
    const past = new Date(Date.now() - 60_000);
    utimesSync(settingsPath, past, past);
    mkdirSync(join(made.dir, 'seat-locks', 'acme'), { recursive: true });
    return made;
  }

  test('a leftover lock file of a dead process does not divert a send off the socket', async () => {
    const made = prepareAcceptingSocketWorld();
    const lockPath = seatLockPath(made.dir, 'acme', 'lead');
    Object.assign(
      lockSteps,
      syntheticSteps({
        alive: (pid) => pid !== DEAD_PID,
      }),
    );

    const frames: string[] = [];
    const host = fake(made, {
      agents: () => {
        // Place the dead process's lock file right before the socket fast path inspects seatLockHolder.
        writeFileSync(lockPath, `${DEAD_PID} deadbeef1234 ${START_MS}\n`);
        return [{ name: 'lead', pane: 'fixture-pane-lead' }];
      },
      deliver: async (_path: string, frame: string) => {
        frames.push(frame);
        return { ok: true };
      },
    });

    const code = await runSend(['lead', 'socket message'], owner(made.root), host);
    expect(code).toBe(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('socket message');

    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.at(-1)).toMatchObject({ to: 'lead', outcome: 'delivered', via: 'socket' });
  });

  test('a leftover lock file of a reused pid also walks the socket, while a genuinely held lock diverts off the socket', async () => {
    const made = prepareAcceptingSocketWorld();
    const lockPath = seatLockPath(made.dir, 'acme', 'lead');
    Object.assign(lockSteps, syntheticSteps());

    // First send: lock file has OTHER_PID (live in syntheticSteps at START_MS), but token records an older start.
    const framesReused: string[] = [];
    const hostReused = fake(made, {
      agents: () => {
        writeFileSync(lockPath, `${OTHER_PID} 0123456789ab ${EARLIER_MS - 60_000}\n`);
        return [{ name: 'lead', pane: 'fixture-pane-lead' }];
      },
      deliver: async (_path: string, frame: string) => {
        framesReused.push(frame);
        return { ok: true };
      },
    });

    const code1 = await runSend(['lead', 'through reused pid lock'], owner(made.root), hostReused);
    expect(code1).toBe(0);
    expect(framesReused).toHaveLength(1);

    // Second send: lock file has OTHER_PID with matching START_MS (genuinely held) -> diverts off the socket.
    const framesHeld: string[] = [];
    const hostHeld = fake(made, {
      agents: () => {
        writeFileSync(lockPath, `${OTHER_PID} fedcba987654 ${START_MS}\n`);
        return [{ name: 'lead', pane: 'fixture-pane-lead' }];
      },
      deliver: async (_path: string, frame: string) => {
        framesHeld.push(frame);
        return { ok: true };
      },
    });

    const code2 = await runSend(['lead', 'diverted while held'], owner(made.root), hostHeld);
    expect(code2).toBe(0);
    expect(framesHeld).toHaveLength(0);
  });
});
