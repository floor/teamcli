import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logLine } from '../src/log.ts';
import {
  LOCK_FILE,
  LOG_FILE,
  LockBusyError,
  SEAT_ID_PATTERN,
  STATE_FILE,
  emptySession,
  isSeatId,
  mintSeatId,
  readState,
  updateState,
  withLock,
  writeAtomic,
} from '../src/state.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the state file', () => {
  test('a missing file is an empty state', () => {
    expect(readState(dir)).toEqual({ format: 1, sessions: {} });
  });

  test('is keyed by session, and written whole', () => {
    updateState(dir, (state) => {
      state.sessions.one = { ...emptySession(), seats: { a: { stage: 'ready' } } };
      state.sessions.two = emptySession();
    });
    const state = readState(dir);
    expect(Object.keys(state.sessions)).toEqual(['one', 'two']);
    expect(state.sessions.one?.seats.a?.stage).toBe('ready');
    expect(readdirSync(dir)).toEqual([STATE_FILE]);
  });

  test('an old seat record loads with neither field, with one, or with both', () => {
    const neither = { stage: 'ready' as const };
    const startOnly = { stage: 'ready' as const, start_cwd: '/lobby' };
    const waitingOnly = {
      stage: 'launched' as const,
      waiting: { state: 'waiting-owner' as const, classification: 'trust' as const },
    };
    const both = {
      stage: 'ready' as const,
      start_cwd: '/lobby',
      waiting: { state: 'trust-sent-recovery' as const, classification: 'trust' as const },
    };
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({
      format: 1,
      sessions: {
        neither: { seats: { a: neither }, worktrees: {} },
        started: { seats: { a: startOnly }, worktrees: {} },
        held: { seats: { a: waitingOnly }, worktrees: {} },
        both: { seats: { a: both }, worktrees: {} },
      },
    }));
    const state = readState(dir);
    expect(state.sessions.neither?.seats.a).toEqual(neither);
    expect(state.sessions.started?.seats.a).toEqual(startOnly);
    expect(state.sessions.held?.seats.a).toEqual(waitingOnly);
    expect(state.sessions.both?.seats.a).toEqual(both);
  });

  test('a seat record from before the process identity loads as it is, and is written back without one', () => {
    // The field is additive: an old file — a seat with a pane and a workspace, no `launched` —
    // reads name by name, and a command that writes another field leaves it with no identity.
    writeFileSync(
      join(dir, STATE_FILE),
      JSON.stringify({
        format: 1,
        sessions: { one: { seats: { a: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' } }, worktrees: {} } },
      }),
    );
    expect(readState(dir).sessions.one?.seats.a).toEqual({ stage: 'ready', pane: 'w1:p1', workspace: 'w1' });
    updateState(dir, (state) => {
      const seat = state.sessions.one?.seats.a;
      if (seat) seat.worked = true;
    });
    expect(readState(dir).sessions.one?.seats.a).toEqual({ stage: 'ready', pane: 'w1:p1', workspace: 'w1', worked: true });
  });

  test('a file that is not a state is an error, never replaced', () => {
    writeFileSync(join(dir, STATE_FILE), '{"format": 2}');
    expect(() => readState(dir)).toThrow(/not a team state of format 1/);
    expect(() => updateState(dir, () => {})).toThrow();
    expect(readFileSync(join(dir, STATE_FILE), 'utf8')).toBe('{"format": 2}');
    writeFileSync(join(dir, STATE_FILE), '{half');
    expect(() => readState(dir)).toThrow(/not valid JSON/);
  });

  test('a stored classification outside the closed list reads as unknown; the closed list reads as itself', () => {
    // The state file is the one door a classification from outside the program enters through.
    // A probe carrying an escape sequence and a fake line, a wrong case, a trailing space, an
    // empty string, a number, a null and a missing field all read as `unknown` — the log line,
    // the status row and the prompt take their words from here, so none can print the raw value.
    const probes: Record<string, unknown> = {
      injected: 'trust\x1b[2J\r\ninjected',
      case: 'Trust',
      spaced: 'permission ',
      empty: '',
      number: 7,
      nothing: null,
      missing: undefined,
    };
    const closed = ['trust', 'permission', 'question', 'provider error', 'rate limit', 'vendor notice', 'login', 'unknown', 'unsent', 'timeout'] as const;
    const seats: Record<string, unknown> = {};
    for (const [seat, classification] of Object.entries(probes)) {
      seats[seat] = { stage: 'launched', waiting: { state: 'waiting-owner', classification } };
    }
    for (const classification of closed) {
      seats[`ok-${classification.replace(' ', '-')}`] = { stage: 'launched', waiting: { state: 'waiting-owner', classification } };
    }
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ format: 1, sessions: { one: { seats, worktrees: {} } } }));
    const state = readState(dir);
    for (const seat of Object.keys(probes)) {
      expect([seat, state.sessions.one?.seats[seat]?.waiting?.classification]).toEqual([seat, 'unknown']);
    }
    for (const classification of closed) {
      const seat = `ok-${classification.replace(' ', '-')}`;
      expect([seat, state.sessions.one?.seats[seat]?.waiting?.classification]).toEqual([seat, classification]);
    }
  });

  test('mints seat_<12 lowercase hex> handles and validates seat registry fields at readState', () => {
    const first = mintSeatId();
    const second = mintSeatId();
    const third = mintSeatId();
    expect(SEAT_ID_PATTERN.test(first)).toBe(true);
    expect(isSeatId(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(isSeatId('seat_ABCDEF123456')).toBe(false);
    expect(isSeatId('seat_12345')).toBe(false);
    expect(isSeatId(42)).toBe(false);

    writeFileSync(
      join(dir, STATE_FILE),
      JSON.stringify({
        format: 1,
        sessions: {
          one: {
            seats: {
              valid: {
                id: first,
                stage: 'ready',
                model: 'opus',
                version: '4.7',
                effort: 'max',
                launch_line: 'claude --model claude-opus-4-7',
                last_active: '2026-10-14T12:00:00.000Z',
              },
              corrupt: {
                id: 'not-a-seat-id',
                stage: 'ready',
                model: 99,
                version: null,
                effort: ['high'],
                launch_line: 123,
                last_active: false,
              },
            },
            retained_seats: {
              kept: { id: second, last_active: '2026-10-14T11:00:00.000Z' },
              badId: { id: 'bad', last_active: '2026-10-14T11:00:00.000Z' },
              badTime: { id: third, last_active: 12345 },
            },
            worktrees: {},
          },
        },
      }),
    );
    const loaded = readState(dir).sessions.one;
    expect(loaded?.seats.valid).toEqual({
      id: first,
      stage: 'ready',
      model: 'opus',
      version: '4.7',
      effort: 'max',
      launch_line: 'claude --model claude-opus-4-7',
      last_active: '2026-10-14T12:00:00.000Z',
    });
    expect(loaded?.seats.corrupt).toEqual({ stage: 'ready' });
    expect(loaded?.retained_seats).toEqual({
      kept: { id: second, last_active: '2026-10-14T11:00:00.000Z' },
      badTime: { id: third },
    });
  });

  test('an atomic write leaves no temporary file', () => {
    writeAtomic(join(dir, 'x.json'), 'one');
    writeAtomic(join(dir, 'x.json'), 'two');
    expect(readFileSync(join(dir, 'x.json'), 'utf8')).toBe('two');
    expect(readdirSync(dir)).toEqual(['x.json']);
  });
});

describe('the lock', () => {
  test('holds the pid while the work runs, and is gone after', () => {
    const seen = withLock(dir, () => readFileSync(join(dir, LOCK_FILE), 'utf8').trim());
    expect(seen).toBe(String(process.pid));
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  test('is released when the work throws', () => {
    expect(() => withLock(dir, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  test('a lock whose holder is alive is waited for, then refused', () => {
    // pid 1 is always alive and is never this process.
    writeFileSync(join(dir, LOCK_FILE), '1\n');
    expect(() => withLock(dir, () => 'ran', { waitMs: 120 })).toThrow(/another team command \(pid 1\) holds/);
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe('1\n');
  });

  test('a lock whose holder is dead is taken over, and that is reported', () => {
    const dead = Bun.spawnSync(['sh', '-c', 'echo $$']).stdout.toString().trim();
    writeFileSync(join(dir, LOCK_FILE), `${dead}\n`);
    const stale: number[] = [];
    expect(withLock(dir, () => 'ran', { onStale: (pid) => stale.push(pid) })).toBe('ran');
    expect(stale).toEqual([Number(dead)]);
  });

  test('a lock file just created and still empty is not taken over', () => {
    // `openSync(path, 'wx')` creates the file before its writer writes the pid; for that moment
    // it reads as 0, which names no process.
    writeFileSync(join(dir, LOCK_FILE), '');
    const path = join(dir, LOCK_FILE);
    const before = statSync(path);
    expect(() => withLock(dir, () => 'ran', { waitMs: 0 })).toThrow(LockBusyError);
    const after = statSync(path);
    expect(after.ino).toBe(before.ino);
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  test('a young lock file holding 0 is not taken over either', () => {
    writeFileSync(join(dir, LOCK_FILE), '0\n');
    expect(() => withLock(dir, () => 'ran', { waitMs: 0 })).toThrow(LockBusyError);
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe('0\n');
  });

  test('an old lock file with no pid is taken over', () => {
    writeFileSync(join(dir, LOCK_FILE), '');
    const past = new Date(Date.now() - 5_000);
    utimesSync(join(dir, LOCK_FILE), past, past);
    expect(withLock(dir, () => 'ran', { waitMs: 0 })).toBe('ran');
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });
});

describe('the log', () => {
  test('one line per change: when, which command, who, what', () => {
    logLine(dir, 'init', 'owner', 'wrote the\nfile', new Date('2026-10-03T14:00:00Z'));
    expect(readFileSync(join(dir, LOG_FILE), 'utf8')).toBe('2026-10-03T14:00:00.000Z init [owner] wrote the file\n');
  });

  test('the line is cleaned at the function: the gate reason\'s CR and escape bytes, and each class of the rule', () => {
    // A caller that logs a gate reason holding a carriage return and `ESC[31m` used to write
    // the escape sequence raw — the file's bytes held `1b 5b 33 31 6d`, the CR alone being
    // folded to a space by the old whitespace collapse. The cleaning is here now, at the one
    // sink every command logs through, so the same call writes the cleaned words whatever
    // calls it.
    logLine(dir, 'watch', 'watch', 'gate\r\x1b[31mWORD', new Date('2026-10-03T14:00:00Z'));
    // Each class of the rule: the soft hyphen U+00AD, U+180E, the tag characters, a bidi
    // override — all gone; U+2028/U+2029 fold to one space as a line feed does.
    logLine(dir, 'init', 'owner', 'soft\u00adhyphen U+180E:\u180e tag \u{e0001}\u{e0020}\u{e007f} rlo \u202e bidi\u2028sep\u2029end', new Date('2026-10-03T14:00:01Z'));
    // The variation selectors stay: they only choose how the character before them is drawn.
    logLine(dir, 'up', 'owner', 'keeps \u{fe0f}\u{e0100} selectors', new Date('2026-10-03T14:00:02Z'));
    const log = readFileSync(join(dir, LOG_FILE), 'utf8');
    expect(log).toBe(
      '2026-10-03T14:00:00.000Z watch [watch] gateWORD\n'
        + '2026-10-03T14:00:01.000Z init [owner] softhyphen U+180E: tag rlo bidi sep end\n'
        + '2026-10-03T14:00:02.000Z up [owner] keeps \u{fe0f}\u{e0100} selectors\n',
    );
    for (const byte of Buffer.from(log, 'utf8')) expect(byte === 0x0a || byte >= 0x20).toBe(true);
  });

  test('the caller is cleaned like the text, and ordinary text is written byte for byte', () => {
    // The caller is a caller-built string too (`describeCaller` reads the environment), so it
    // is cleaned with the text; and a line that holds none of the removed characters is the
    // bytes it always was.
    logLine(dir, 'up', 'own\u202eer', 'ready', new Date('2026-10-03T14:00:00Z'));
    logLine(dir, 'add', 'owner', 'worker-tmp-1: ready', new Date('2026-10-03T14:00:01Z'));
    expect(readFileSync(join(dir, LOG_FILE), 'utf8')).toBe(
      '2026-10-03T14:00:00.000Z up [owner] ready\n'
        + '2026-10-03T14:00:01.000Z add [owner] worker-tmp-1: ready\n',
    );
  });

  test('rotates at 1 MB and keeps three files', () => {
    const path = join(dir, LOG_FILE);
    for (let round = 1; round <= 4; round++) {
      writeFileSync(path, `${String(round).repeat(1_000_000)}\n`);
      logLine(dir, 'watch', 'watch', `round ${round}`);
    }
    expect(readdirSync(dir).sort()).toEqual([LOG_FILE, `${LOG_FILE}.1`, `${LOG_FILE}.2`]);
    expect(statSync(path).size).toBeLessThan(200);
    expect(readFileSync(`${path}.1`, 'utf8')[0]).toBe('4');
    expect(readFileSync(`${path}.2`, 'utf8')[0]).toBe('3');
  });
});
