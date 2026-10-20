// The display's read of the daemon's presence projection (src/labels/presence.ts): one small
// file per seat, fenced by the binding the seat's state records. A projection a predecessor
// launch wrote, or one no recorded binding can fence, is invalid as this seat's reading: it is
// never genuine absence, so no screen answers in its place. A projection under the recorded
// binding is answered even when the channel is not healthy — the runtime's last known word,
// marked not live. Only a genuinely absent file is `absent`, and a malformed projection is
// `bad` (unknown from presence, never a screen). The channel-health flag is the caller's, from a
// fresh daemon answer; this module never reads a persisted status word. The same fresh answer's
// complete per-seat list, with each seat's explicit source class, decides which projections are
// live: a runtime seat's projection id must be exactly the applied transition it proved, while
// a hook seat is judged by the route's fresh ingest. Every projection below is synthetic and
// written under a fresh temporary state folder.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { presencePaths } from '../src/daemon/presence/spool.ts';
import { presenceChannelHealthy, presenceSeatsOf, readPresenceForSeat, seatPresenceProof } from '../src/labels/presence.ts';

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
      // A serving route carries its complete per-seat answer; route health is only trustworthy
      // with one.
      seats: [{
        seat: SEAT, state: 'serving' as const, healthy: true, source: 'hook' as const,
        binding: BINDING, appliedEventId: null, why: null,
      }],
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

  // The route's per-seat answers are the second half of live: the list is complete for every
  // declared seat and each entry states its source class. A list that is missing, repeated,
  // empty or malformed is an incomplete answer, never a hook-only route. A seat is live only by
  // its own serving entry under the binding its state records. A runtime entry names the applied
  // transition it proved and the projection's id must be exactly that; a hook entry names no
  // transition and is judged by the route's fresh ingest; an unknown source never serves.
  describe("the route's per-seat answers", () => {
    const APPLIED = `${SINCE}-ab12cd34`;
    const runtime = (seat: string, binding: string | null = BINDING, appliedEventId: string | null = APPLIED) => ({
      seat, state: 'serving', healthy: true, source: 'runtime', binding, appliedEventId, why: null,
    });
    const hook = (seat: string, binding: string | null = BINDING) => ({
      seat, state: 'serving', healthy: true, source: 'hook', binding, appliedEventId: null, why: null,
    });
    const pending = (
      seat: string,
      source: 'runtime' | 'hook' | 'unknown' = 'hook',
      why: string | null = 'hook not yet seen',
      binding: string | null = null,
    ) => ({ seat, state: 'pending', healthy: false, source, binding, appliedEventId: null, why });
    const withSeats = (seats: unknown) => reading([verdict({ seats })]);
    const proof = (
      seats: ReturnType<typeof presenceSeatsOf> | undefined,
      seat = SEAT,
      binding: unknown = BINDING,
    ) => seatPresenceProof(seats, seat, binding);
    const qualified = (
      seats: ReturnType<typeof presenceSeatsOf> | undefined,
      seat = SEAT,
      binding: unknown = BINDING,
    ): boolean => proof(seats, seat, binding).qualified;

    test('a missing seat list is an incomplete answer, never a hook-only route', () => {
      const seats = presenceSeatsOf(withSeats(undefined), ROOT, SESSION, NOW);
      expect(seats).toEqual({ kind: 'invalid', why: 'the route carries no seat list' });
      // No health answer at all carries no route verdict either: the source was never classified,
      // so route health cannot stand in for it.
      expect(qualified(seats)).toBe(false);
      expect(qualified(undefined)).toBe(false);
      expect(presenceChannelHealthy(withSeats(undefined), ROOT, SESSION, NOW)).toBe(false);
    });

    test('a runtime seat is live only when serving under the recorded binding', () => {
      const seats = presenceSeatsOf(withSeats([runtime(SEAT)]), ROOT, SESSION, NOW);
      expect(seats.kind).toBe('listed');
      expect(proof(seats)).toEqual({ qualified: true, appliedEventId: APPLIED });
      // A sampled binding that differs from the seat's own record is a predecessor's run, or a
      // relaunch the display has not caught up with: last known, never live by route health.
      expect(qualified(seats, SEAT, PREDECESSOR)).toBe(false);
      expect(seatPresenceProof(seats, SEAT, undefined).qualified).toBe(false);
    });

    test('a hook seat is qualified by the route ingest and names no applied transition', () => {
      const seats = presenceSeatsOf(withSeats([hook(SEAT)]), ROOT, SESSION, NOW);
      expect(proof(seats)).toEqual({ qualified: true, appliedEventId: null });
      // The binding fence still holds: a hook entry sampled under another incarnation is held.
      expect(qualified(seats, SEAT, PREDECESSOR)).toBe(false);
      // A hook entry that names an id (the schema permits it) is still judged on the route: the
      // id is never used to compare against the projection.
      const named = presenceSeatsOf(withSeats([{ ...hook(SEAT), appliedEventId: APPLIED }]), ROOT, SESSION, NOW);
      expect(proof(named)).toEqual({ qualified: true, appliedEventId: null });
    });

    test('a missing entry is held, because every declared seat is classified', () => {
      const seats = presenceSeatsOf(withSeats([runtime(SEAT), hook('other')]), ROOT, SESSION, NOW);
      expect(qualified(seats, 'someone-else')).toBe(false);
      // The listed seats are unaffected by their sibling's absence from a reader's team file.
      expect(qualified(seats)).toBe(true);
      expect(qualified(seats, 'other')).toBe(true);
    });

    test('a pending entry is not proof for any source class', () => {
      const listed = presenceSeatsOf(withSeats([
        runtime(SEAT),
        pending('hook-pending'),
        pending('runtime-pending', 'runtime', 'the runtime event has not been reconciled'),
        pending('unknown-pending', 'unknown', 'the runtime subscriptions were not built'),
      ]), ROOT, SESSION, NOW);
      expect(listed.kind).toBe('listed');
      expect(qualified(listed)).toBe(true);
      for (const seat of ['hook-pending', 'runtime-pending', 'unknown-pending']) {
        expect(qualified(listed, seat, null)).toBe(false);
      }
      // `serving` with `healthy: false` is the daemon client's disagreement case: dropped whole.
      const unhealthy = withSeats([
        { seat: SEAT, state: 'serving', healthy: false, source: 'runtime', binding: BINDING, appliedEventId: APPLIED, why: null },
      ]);
      expect(presenceSeatsOf(unhealthy, ROOT, SESSION, NOW).kind).toBe('invalid');
      expect(qualified(presenceSeatsOf(unhealthy, ROOT, SESSION, NOW))).toBe(false);
      expect(presenceChannelHealthy(unhealthy, ROOT, SESSION, NOW)).toBe(false);
    });

    test('a serving runtime entry must name the applied transition it vouches for', () => {
      const noId: unknown[] = [
        [{ seat: SEAT, state: 'serving', healthy: true, source: 'runtime', binding: BINDING, why: null }],
        [{ ...runtime(SEAT), appliedEventId: null }],
        [{ ...runtime(SEAT), appliedEventId: undefined }],
        [{ ...runtime(SEAT), appliedEventId: 'not-a-record-id' }],
        [{ ...runtime(SEAT), appliedEventId: `${SINCE}-ABCDEF12` }],
        [{ ...runtime(SEAT), appliedEventId: 42 }],
      ];
      for (const seats of noId) {
        const route = withSeats(seats);
        expect(presenceChannelHealthy(route, ROOT, SESSION, NOW)).toBe(false);
        expect(presenceSeatsOf(route, ROOT, SESSION, NOW).kind).toBe('invalid');
        expect(qualified(presenceSeatsOf(route, ROOT, SESSION, NOW))).toBe(false);
      }
    });

    test('a serving unknown source, a missing or foreign source class, and any other malformed entry drop the list whole', () => {
      const malformed: unknown[] = [
        [],
        'not a list',
        [runtime(SEAT), runtime(SEAT)],
        [{ ...runtime(SEAT), seat: '' }],
        [{ ...runtime(SEAT), state: 'absent' }],
        [{ ...runtime(SEAT), source: 'unknown' }],
        [{ ...runtime(SEAT), source: 'agent' }],
        [{ seat: SEAT, state: 'serving', healthy: true, binding: BINDING, appliedEventId: APPLIED, why: null }],
        [{ ...runtime(SEAT), binding: null }],
        [{ ...runtime(SEAT), binding: 'not-a-binding' }],
        [{ ...runtime(SEAT), why: 7 }],
        [{ ...runtime(SEAT), state: 'pending', healthy: false }],
        [pending(SEAT, 'hook', null)],
        [pending(SEAT, 'hook', '')],
        [null],
        [[runtime(SEAT)]],
      ];
      for (const seats of malformed) {
        const route = withSeats(seats);
        expect(presenceChannelHealthy(route, ROOT, SESSION, NOW)).toBe(false);
        expect(presenceSeatsOf(route, ROOT, SESSION, NOW).kind).toBe('invalid');
        expect(qualified(presenceSeatsOf(route, ROOT, SESSION, NOW))).toBe(false);
        expect(qualified(presenceSeatsOf(route, ROOT, SESSION, NOW), 'other')).toBe(false);
      }
    });

    test('a stale, other-session or other-root verdict carries no usable seat list', () => {
      const stale = reading([verdict({ seats: [runtime(SEAT)] })], at(-600_000));
      const otherSession = reading([verdict({ session: 'other', seats: [runtime(SEAT)] })]);
      const otherRoot = reading([verdict({ seats: [runtime(SEAT)] })]);
      for (const route of [stale, otherSession]) {
        expect(presenceSeatsOf(route, ROOT, SESSION, NOW).kind).toBe('invalid');
        expect(qualified(presenceSeatsOf(route, ROOT, SESSION, NOW))).toBe(false);
      }
      expect(presenceSeatsOf(otherRoot, '/srv/other', SESSION, NOW).kind).toBe('invalid');
      // A fresh, serving route with a well-formed list stays healthy.
      expect(presenceChannelHealthy(reading([verdict({ seats: [runtime(SEAT)] })]), ROOT, SESSION, NOW)).toBe(true);
    });

    test('the applied transition id must match the projection the reader holds', () => {
      writeCurrent(projection());
      const seats = presenceSeatsOf(withSeats([runtime(SEAT)]), ROOT, SESSION, NOW);
      const held = proof(seats);
      expect(held).toEqual({ qualified: true, appliedEventId: APPLIED });
      expect(readPresenceForSeat(stateDir, SESSION, SEAT, BINDING, true, held.appliedEventId))
        .toMatchObject({ kind: 'ok', observation: { state: 'idle', live: true } });
      // A projection that has advanced past the proof, or a proof naming another application,
      // is not this answer's: the word stays last known, never live on route health alone.
      expect(readPresenceForSeat(stateDir, SESSION, SEAT, BINDING, true, `${SINCE}-ffffffff`))
        .toMatchObject({ kind: 'ok', observation: { state: 'idle', live: false } });
      writeCurrent(projection({ id: `${SINCE}-ffffffff`, seq: 4 }));
      expect(readPresenceForSeat(stateDir, SESSION, SEAT, BINDING, true, held.appliedEventId))
        .toMatchObject({ kind: 'ok', observation: { state: 'idle', live: false } });
      // A hook answer names no applied id and keeps the route answer, even when the projection
      // has advanced: no comparison exists for it.
      expect(readPresenceForSeat(stateDir, SESSION, SEAT, BINDING, true, null))
        .toMatchObject({ kind: 'ok', observation: { state: 'idle', live: true } });
    });

    test('a mixed route: the runtime seat and the hook sibling are both live', () => {
      // Same route, same fresh serving answer; each entry states its own source class.
      writeCurrent(projection(), 'codex-seat');
      writeCurrent(projection({ binding: PREDECESSOR }), 'hook-seat');
      const route = withSeats([runtime('codex-seat'), hook('hook-seat', PREDECESSOR)]);
      const seats = presenceSeatsOf(route, ROOT, SESSION, NOW);
      const healthy = presenceChannelHealthy(route, ROOT, SESSION, NOW);
      const codex = proof(seats, 'codex-seat', BINDING);
      const hookSeat = proof(seats, 'hook-seat', PREDECESSOR);
      expect(healthy && codex.qualified).toBe(true);
      expect(healthy && hookSeat.qualified).toBe(true);
      expect(codex.appliedEventId).toBe(APPLIED);
      expect(hookSeat.appliedEventId).toBeNull();
      expect(readPresenceForSeat(stateDir, SESSION, 'codex-seat', BINDING, healthy && codex.qualified, codex.appliedEventId))
        .toMatchObject({ kind: 'ok', observation: { state: 'idle', live: true } });
      expect(readPresenceForSeat(stateDir, SESSION, 'hook-seat', PREDECESSOR, healthy && hookSeat.qualified, hookSeat.appliedEventId))
        .toMatchObject({ kind: 'ok', observation: { state: 'idle', live: true } });
      // A declared seat the complete list does not carry is an incomplete answer: held, with no
      // route-health fallback for either class.
      expect(healthy && proof(seats, 'missing-seat', BINDING).qualified).toBe(false);
    });
  });
});
