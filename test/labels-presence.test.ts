// The display's read of the daemon's presence projection (src/labels/presence.ts): one small
// file per seat, fenced by the binding the seat's state records. A projection a predecessor
// launch wrote, or one no recorded binding can fence, is invalid as this seat's reading: it is
// never genuine absence, so no screen answers in its place. A projection under the recorded
// binding is answered even when the channel is not healthy — the runtime's last known word,
// marked not live. Only a genuinely absent file is `absent`, and a malformed projection is
// `bad` (unknown from presence, never a screen). The channel-health flag is the caller's, from a
// fresh daemon answer; this module never reads a persisted status word. Every projection below
// is synthetic and written under a fresh temporary state folder.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { presencePaths } from '../src/daemon/presence/spool.ts';
import { nativePresenceExpected, presenceChannelHealthy, presenceSeatsOf, readPresenceForSeat, seatPresenceQualified } from '../src/labels/presence.ts';

const SESSION = 'session-one';
const SEAT = 'worker';
const BINDING = 'prs_0123456789ab';
const PREDECESSOR = 'prs_ba9876543210';
const SINCE = '2026-10-17T11:59:00Z';

const projection = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  v: 1,
  seq: 3,
  id: `${SINCE}-ab12cd34`,
  state: 'idle',
  source: 'runtime-hook',
  event: 'turn-end',
  binding: BINDING,
  since: SINCE,
  observedAt: '2026-10-17T11:59:01.250Z',
  ...overrides,
});

let base: string;
let stateDir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'team-presence-display-'));
  stateDir = join(base, '.agents');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const writeCurrent = (text: string, seat = SEAT): string => {
  const paths = presencePaths(stateDir, SESSION, seat);
  if (paths === null) throw new Error('the scene names no presence folder');
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.current, text);
  return paths.current;
};

describe("the display's read of current.json", () => {
  test('a qualified projection under the recorded binding is live and carries its provenance', () => {
    writeCurrent(projection());
    expect(readPresenceForSeat(stateDir, SESSION, SEAT, BINDING, true)).toEqual({
      kind: 'ok',
      observation: {
        state: 'idle',
        source: 'runtime-hook',
        event: 'turn-end',
        since: SINCE,
        live: true,
      },
    });
  });

  test('a projection a predecessor wrote is invalid, never genuine absence', () => {
    writeCurrent(projection());
    const read = readPresenceForSeat(stateDir, SESSION, SEAT, PREDECESSOR, true);
    expect(read.kind).toBe('invalid');
    expect(read.kind === 'invalid' ? read.why : '').toContain('runtime incarnation');
  });

  test('no recorded binding, or a value that is not one, leaves the projection unfenced', () => {
    writeCurrent(projection());
    for (const binding of [undefined, null, '', 'prs_nothex', BINDING.toUpperCase(), 42]) {
      const read = readPresenceForSeat(stateDir, SESSION, SEAT, binding, true);
      expect(read.kind).toBe('invalid');
      expect(read.kind === 'invalid' ? read.why : '').toContain('no runtime binding');
    }
  });

  test('an unqualified channel keeps the word and marks it not live', () => {
    writeCurrent(projection());
    const read = readPresenceForSeat(stateDir, SESSION, SEAT, BINDING, false);
    expect(read).toMatchObject({ kind: 'ok', observation: { live: false, state: 'idle' } });
  });

  test('only a missing projection is absent; a malformed one is bad, never silently skipped', () => {
    expect(readPresenceForSeat(stateDir, SESSION, SEAT, BINDING, true)).toEqual({ kind: 'absent' });
    writeCurrent('{not json');
    expect(readPresenceForSeat(stateDir, SESSION, SEAT, BINDING, true).kind).toBe('bad');
    // The state does not match its event: refused whole, never repaired.
    writeCurrent(projection({ state: 'working', event: 'turn-end' }));
    expect(readPresenceForSeat(stateDir, SESSION, SEAT, BINDING, true).kind).toBe('bad');
    // `since` is the event time embedded in the id, checked part by part.
    writeCurrent(projection({ since: '2026-10-17T11:58:00Z' }));
    expect(readPresenceForSeat(stateDir, SESSION, SEAT, BINDING, true).kind).toBe('bad');
  });

  test('a session or seat that cannot name a folder is absent', () => {
    expect(readPresenceForSeat(stateDir, '', SEAT, BINDING, true)).toEqual({ kind: 'absent' });
    expect(readPresenceForSeat(stateDir, SESSION, 'not/a/seat', BINDING, true)).toEqual({ kind: 'absent' });
  });

  test('one seat reading never leaks into another seat', () => {
    writeCurrent(projection());
    expect(readPresenceForSeat(stateDir, SESSION, 'other', BINDING, true)).toEqual({ kind: 'absent' });
  });
});

describe('the fresh daemon health verdict is the only proof of live', () => {
  const ROOT = '/srv/acme';
  const AT = '2026-10-17T12:00:00.000Z';
  const NOW = new Date(AT);
  const at = (deltaMs: number): string => new Date(Date.parse(AT) + deltaMs).toISOString();
  const verdict = (over: Record<string, unknown> = {}) => ({
    root: ROOT,
    presence: {
      session: SESSION,
      state: 'serving' as const,
      healthy: true,
      checkedAt: AT,
      why: null,
      ...over,
    },
  });
  const reading = (
    roots: readonly { root: string; presence?: Record<string, unknown> }[],
    probeAt = AT,
    state: 'answered' | 'refused' | 'unanswered' | 'unknown' = 'answered',
  ) => ({ roots, probe: { state, at: probeAt } });

  test('a serving, healthy verdict for this session makes the channel healthy', () => {
    expect(presenceChannelHealthy(reading([verdict()]), ROOT, SESSION, NOW)).toBe(true);
  });

  test('pending, unhealthy, another session or another root is not healthy', () => {
    expect(presenceChannelHealthy(reading([verdict({ state: 'pending', healthy: false, why: 'backlog' })]), ROOT, SESSION, NOW)).toBe(false);
    expect(presenceChannelHealthy(reading([verdict({ healthy: false })]), ROOT, SESSION, NOW)).toBe(false);
    expect(presenceChannelHealthy(reading([verdict({ session: 'other' })]), ROOT, SESSION, NOW)).toBe(false);
    expect(presenceChannelHealthy(reading([verdict()]), '/srv/other', SESSION, NOW)).toBe(false);
  });

  test('the verdict and its probe must belong to this display instant: the grace boundary is exact', () => {
    // Both instants inside the shared two-second grace: live at exactly 2s, not at 2s and 1ms.
    const twoSecondsLater = new Date(Date.parse(AT) + 2_000);
    const past = new Date(Date.parse(AT) + 2_001);
    expect(presenceChannelHealthy(reading([verdict()], AT), ROOT, SESSION, twoSecondsLater)).toBe(true);
    expect(presenceChannelHealthy(reading([verdict()], AT), ROOT, SESSION, past)).toBe(false);
    // An answer from an earlier probe is a snapshot, never proof of live now — however well
    // its own checkedAt and probe instant agree with each other.
    expect(presenceChannelHealthy(reading([verdict({ checkedAt: at(-600_000) })], at(-600_000)), ROOT, SESSION, NOW)).toBe(false);
    // A fresh probe with a verdict from an earlier request instant is stale too.
    expect(presenceChannelHealthy(reading([verdict({ checkedAt: at(-3_000) })], AT), ROOT, SESSION, NOW)).toBe(false);
    expect(presenceChannelHealthy(reading([verdict({ checkedAt: 'not-a-date' })]), ROOT, SESSION, NOW)).toBe(false);
    for (const state of ['refused', 'unanswered', 'unknown'] as const) {
      expect(presenceChannelHealthy(reading([verdict()], AT, state), ROOT, SESSION, NOW)).toBe(false);
    }
  });

  test('no verdict for the route, or no roots at all, defaults closed', () => {
    expect(presenceChannelHealthy(reading([{ root: ROOT }]), ROOT, SESSION, NOW)).toBe(false);
    expect(presenceChannelHealthy(reading([]), ROOT, SESSION, NOW)).toBe(false);
    // The persisted close record carries no `healthy` and can never be proof.
    expect(presenceChannelHealthy(reading([{ root: ROOT, presence: { state: 'pending', why: 'closed' } }]), ROOT, SESSION, NOW)).toBe(false);
  });

  // The route's per-seat answers are the second half of live: a seat carried by the seat list
  // is live only by its own serving entry, sampled under the binding the seat's state records.
  // A hook-only route carries no seat list and keeps the route's own verdict. The list holds
  // native-source seats, never a census: an unlisted hook seat sharing the route is expected
  // and keeps the route verdict, while an unlisted seat that explicitly expects a native
  // channel was never classified and inherits nothing.
  describe("the route's per-seat answers", () => {
    const serving = (seat: string, binding: string | null = BINDING) => ({
      seat, state: 'serving', healthy: true, binding, why: null,
    });
    const withSeats = (seats: unknown) => reading([verdict({ seats })]);

    test('a hook-only route has no seat list: a hook seat keeps the route verdict, an expected native seat is held', () => {
      const seats = presenceSeatsOf(withSeats(undefined), ROOT, SESSION, NOW);
      expect(seats).toEqual({ kind: 'absent' });
      expect(seatPresenceQualified(seats, SEAT, BINDING, false)).toBe(true);
      // With no list at all, the source an expected native seat needed was never classified:
      // route health cannot stand in for it, exactly as a missing entry cannot.
      expect(seatPresenceQualified(seats, SEAT, BINDING, true)).toBe(false);
      // No health answer at all carries no route verdict either; the caller's route gate is
      // false there, and the expectation alone still closes an expected native seat.
      expect(seatPresenceQualified(undefined, SEAT, BINDING, false)).toBe(true);
      expect(seatPresenceQualified(undefined, SEAT, BINDING, true)).toBe(false);
    });

    test('a listed seat is live only when serving and sampled under the recorded binding', () => {
      const seats = presenceSeatsOf(withSeats([serving(SEAT)]), ROOT, SESSION, NOW);
      expect(seats.kind).toBe('listed');
      expect(seatPresenceQualified(seats, SEAT, BINDING, true)).toBe(true);
      // A sampled binding that differs from the seat's own record is a predecessor's run, or a
      // relaunch the display has not caught up with: last known, never live by route health.
      expect(seatPresenceQualified(seats, SEAT, PREDECESSOR, true)).toBe(false);
      // Membership never overrides the fence, whichever class the seat is.
      expect(seatPresenceQualified(seats, SEAT, PREDECESSOR, false)).toBe(false);
      expect(seatPresenceQualified(seats, SEAT, undefined, true)).toBe(false);
    });

    test('an absent entry means held for an expected native seat, route health for a hook seat', () => {
      const seats = presenceSeatsOf(withSeats([serving(SEAT)]), ROOT, SESSION, NOW);
      // The native source this seat expects was never classified: no proof to inherit.
      expect(seatPresenceQualified(seats, 'other', BINDING, true)).toBe(false);
      // A hook seat absent from the native list is the ordinary mixed-route case.
      expect(seatPresenceQualified(seats, 'other', BINDING, false)).toBe(true);
    });

    test('a whole absent list holds an expected native seat exactly as a missing entry does', () => {
      const absent = presenceSeatsOf(withSeats(undefined), ROOT, SESSION, NOW);
      const listed = presenceSeatsOf(withSeats([serving(SEAT)]), ROOT, SESSION, NOW);
      for (const seats of [absent, listed]) {
        expect(seatPresenceQualified(seats, 'other', BINDING, true)).toBe(false);
        expect(seatPresenceQualified(seats, 'other', BINDING, false)).toBe(true);
      }
      // A listed entry still decides over the conservative expectation: the daemon's own
      // classification is authoritative, and its serving binding fence is the proof.
      expect(seatPresenceQualified(listed, SEAT, BINDING, true)).toBe(true);
      expect(seatPresenceQualified(absent, SEAT, BINDING, false)).toBe(true);
    });

    test('a pending entry is not proof for a seat of either class', () => {
      const pending = presenceSeatsOf(withSeats([
        serving(SEAT),
        { seat: 'other', state: 'pending', healthy: false, binding: null, why: 'hook not yet seen' },
      ]), ROOT, SESSION, NOW);
      expect(pending.kind).toBe('listed');
      expect(seatPresenceQualified(pending, SEAT, BINDING, true)).toBe(true);
      expect(seatPresenceQualified(pending, 'other', BINDING, true)).toBe(false);
      expect(seatPresenceQualified(pending, 'other', BINDING, false)).toBe(false);
      // `serving` with `healthy: false` is the daemon client's disagreement case: dropped whole.
      const unhealthy = withSeats([{ seat: SEAT, state: 'serving', healthy: false, binding: BINDING, why: null }]);
      expect(presenceSeatsOf(unhealthy, ROOT, SESSION, NOW).kind).toBe('invalid');
      expect(seatPresenceQualified(presenceSeatsOf(unhealthy, ROOT, SESSION, NOW), SEAT, BINDING, true)).toBe(false);
      expect(presenceChannelHealthy(unhealthy, ROOT, SESSION, NOW)).toBe(false);
    });

    test('a malformed seat list is dropped whole and leaves the route unqualified', () => {
      const malformed: unknown[] = [
        [],
        'not a list',
        [serving(SEAT), serving(SEAT)],
        [{ seat: '', state: 'serving', healthy: true, binding: BINDING, why: null }],
        [{ seat: SEAT, state: 'absent', healthy: true, binding: BINDING, why: null }],
        [{ seat: SEAT, state: 'serving', healthy: true, binding: null, why: null }],
        [{ seat: SEAT, state: 'serving', healthy: true, binding: 'not-a-binding', why: null }],
        [{ seat: SEAT, state: 'serving', healthy: true, binding: BINDING, why: 7 }],
        [{ seat: SEAT, state: 'pending', healthy: false, binding: null, why: null }],
        [{ seat: SEAT, state: 'pending', healthy: false, binding: null, why: '' }],
        [null],
        [[serving(SEAT)]],
      ];
      for (const seats of malformed) {
        const route = withSeats(seats);
        expect(presenceChannelHealthy(route, ROOT, SESSION, NOW)).toBe(false);
        expect(presenceSeatsOf(route, ROOT, SESSION, NOW).kind).toBe('invalid');
        expect(seatPresenceQualified(presenceSeatsOf(route, ROOT, SESSION, NOW), SEAT, BINDING, true)).toBe(false);
        expect(seatPresenceQualified(presenceSeatsOf(route, ROOT, SESSION, NOW), SEAT, BINDING, false)).toBe(false);
      }
    });

    test('a stale, other-session or other-root verdict carries no usable seat list', () => {
      const stale = reading([verdict({ seats: [serving(SEAT)] })], at(-600_000));
      const otherSession = reading([verdict({ session: 'other', seats: [serving(SEAT)] })]);
      const otherRoot = reading([verdict({ seats: [serving(SEAT)] })]);
      for (const route of [stale, otherSession]) {
        expect(presenceSeatsOf(route, ROOT, SESSION, NOW).kind).toBe('invalid');
        expect(seatPresenceQualified(presenceSeatsOf(route, ROOT, SESSION, NOW), SEAT, BINDING, true)).toBe(false);
      }
      expect(presenceSeatsOf(otherRoot, '/srv/other', SESSION, NOW).kind).toBe('invalid');
      // A fresh, serving route with a well-formed list stays healthy.
      expect(presenceChannelHealthy(reading([verdict({ seats: [serving(SEAT)] })]), ROOT, SESSION, NOW)).toBe(true);
    });

    test('explicit native expectation comes from the seat, not from list absence', () => {
      expect(nativePresenceExpected('codex')).toBe(true);
      for (const cli of ['claude', 'cursor', 'gemini', '-', '', null, undefined]) {
        expect(nativePresenceExpected(cli)).toBe(false);
      }
    });

    test('a mixed route: the listed native seat and the unlisted hook seat are both live', () => {
      // Same route, same fresh serving answer; the seat list names only the Codex seat.
      writeCurrent(projection(), 'codex-seat');
      writeCurrent(projection({ binding: PREDECESSOR }), 'hook-seat');
      const route = withSeats([serving('codex-seat')]);
      const seats = presenceSeatsOf(route, ROOT, SESSION, NOW);
      const healthy = presenceChannelHealthy(route, ROOT, SESSION, NOW);
      const codexQualified = healthy
        && seatPresenceQualified(seats, 'codex-seat', BINDING, nativePresenceExpected('codex'));
      const hookQualified = healthy
        && seatPresenceQualified(seats, 'hook-seat', PREDECESSOR, nativePresenceExpected('claude'));
      expect(codexQualified).toBe(true);
      expect(hookQualified).toBe(true);
      expect(readPresenceForSeat(stateDir, SESSION, 'codex-seat', BINDING, codexQualified))
        .toMatchObject({ kind: 'ok', observation: { state: 'idle', live: true } });
      expect(readPresenceForSeat(stateDir, SESSION, 'hook-seat', PREDECESSOR, hookQualified))
        .toMatchObject({ kind: 'ok', observation: { state: 'idle', live: true } });
      // A second Codex seat the route expected but never listed stays last known: no fallback.
      expect(healthy
        && seatPresenceQualified(seats, 'codex-missing', BINDING, nativePresenceExpected('codex')))
        .toBe(false);
    });
  });
});
