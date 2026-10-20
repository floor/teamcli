// The display's read of the daemon's presence projection (src/labels/presence.ts): one small
// file per seat, fenced by the binding the seat's state records. A projection a predecessor
// launch wrote is not this seat's reading and lets the screen answer; a projection under the
// recorded binding is answered even when the channel is not healthy — the runtime's last known
// word, marked not live. Only a genuinely absent file is `absent`, and a malformed projection is
// `bad` (unknown from presence, never a screen). The channel-health flag is the caller's, from a
// fresh daemon answer; this module never reads a persisted status word. Every projection below
// is synthetic and written under a fresh temporary state folder.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { presencePaths } from '../src/daemon/presence/spool.ts';
import { presenceChannelHealthy, readPresenceForSeat } from '../src/labels/presence.ts';

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

  test('a projection a predecessor wrote is not this seat reading, so the screen may answer', () => {
    writeCurrent(projection());
    expect(readPresenceForSeat(stateDir, SESSION, SEAT, PREDECESSOR, true)).toEqual({ kind: 'predecessor' });
  });

  test('no recorded binding, or a value that is not one, is no fence to open', () => {
    writeCurrent(projection());
    for (const binding of [undefined, null, '', 'prs_nothex', BINDING.toUpperCase(), 42]) {
      expect(readPresenceForSeat(stateDir, SESSION, SEAT, binding, true)).toEqual({ kind: 'predecessor' });
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
    at = AT,
    state: 'answered' | 'refused' | 'unanswered' | 'unknown' = 'answered',
  ) => ({ roots, probe: { state, at } });

  test('a serving, healthy verdict for this session makes the channel healthy', () => {
    expect(presenceChannelHealthy(reading([verdict()]), ROOT, SESSION)).toBe(true);
  });

  test('pending, unhealthy, another session or another root is not healthy', () => {
    expect(presenceChannelHealthy(reading([verdict({ state: 'pending', healthy: false, why: 'backlog' })]), ROOT, SESSION)).toBe(false);
    expect(presenceChannelHealthy(reading([verdict({ healthy: false })]), ROOT, SESSION)).toBe(false);
    expect(presenceChannelHealthy(reading([verdict({ session: 'other' })]), ROOT, SESSION)).toBe(false);
    expect(presenceChannelHealthy(reading([verdict()]), '/srv/other', SESSION)).toBe(false);
  });

  test('the verdict must belong to this probe: no older checkedAt and no probe that did not answer', () => {
    // A record from an earlier probe, ten minutes before the answer, is not fresh.
    expect(presenceChannelHealthy(reading([verdict()], '2026-10-17T12:10:00.000Z'), ROOT, SESSION)).toBe(false);
    expect(presenceChannelHealthy(reading([verdict()], '2026-10-17T12:10:01.000Z'), ROOT, SESSION)).toBe(false);
    expect(presenceChannelHealthy(reading([verdict({ checkedAt: 'not-a-date' })]), ROOT, SESSION)).toBe(false);
    for (const state of ['refused', 'unanswered', 'unknown'] as const) {
      expect(presenceChannelHealthy(reading([verdict()], AT, state), ROOT, SESSION)).toBe(false);
    }
  });

  test('no verdict for the route, or no roots at all, defaults closed', () => {
    expect(presenceChannelHealthy(reading([{ root: ROOT }]), ROOT, SESSION)).toBe(false);
    expect(presenceChannelHealthy(reading([]), ROOT, SESSION)).toBe(false);
    // The persisted close record carries no `healthy` and can never be proof.
    expect(presenceChannelHealthy(reading([{ root: ROOT, presence: { state: 'pending', why: 'closed' } }]), ROOT, SESSION)).toBe(false);
  });
});
