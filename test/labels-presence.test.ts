// The display's read of the daemon's presence projection (src/labels/presence.ts): one small
// file per seat, fenced by the binding the seat's state records. A projection a predecessor
// launch wrote is not this seat's reading; a missing, malformed or mismatched file is no reading
// at all, and the caller falls back to the screen labels it already has. Every projection below
// is synthetic and written under a fresh temporary state folder.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { presencePaths } from '../src/daemon/presence/spool.ts';
import { readPresenceForSeat } from '../src/labels/presence.ts';

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
  test('a projection under the recorded binding is the seat reading', () => {
    writeCurrent(projection());
    expect(readPresenceForSeat(stateDir, SESSION, SEAT, BINDING))
      .toEqual({ state: 'idle', since: SINCE });
  });

  test('a projection a predecessor wrote is not this seat reading', () => {
    writeCurrent(projection());
    expect(readPresenceForSeat(stateDir, SESSION, SEAT, PREDECESSOR)).toBeNull();
  });

  test('no recorded binding, or a value that is not one, is no fence to open', () => {
    writeCurrent(projection());
    for (const binding of [undefined, null, '', 'prs_nothex', BINDING.toUpperCase(), 42]) {
      expect(readPresenceForSeat(stateDir, SESSION, SEAT, binding)).toBeNull();
    }
  });

  test('a missing projection, malformed JSON, or a projection this build cannot mean is no reading', () => {
    expect(readPresenceForSeat(stateDir, SESSION, SEAT, BINDING)).toBeNull();
    writeCurrent('{not json');
    expect(readPresenceForSeat(stateDir, SESSION, SEAT, BINDING)).toBeNull();
    // The state does not match its event: refused whole, never repaired.
    writeCurrent(projection({ state: 'working', event: 'turn-end' }));
    expect(readPresenceForSeat(stateDir, SESSION, SEAT, BINDING)).toBeNull();
    // `since` is the event time embedded in the id, checked part by part.
    writeCurrent(projection({ since: '2026-10-17T11:58:00Z' }));
    expect(readPresenceForSeat(stateDir, SESSION, SEAT, BINDING)).toBeNull();
  });

  test('a session or seat that cannot name a folder is no reading', () => {
    writeCurrent(projection());
    expect(readPresenceForSeat(stateDir, '', SEAT, BINDING)).toBeNull();
    expect(readPresenceForSeat(stateDir, SESSION, 'not/a/seat', BINDING)).toBeNull();
  });

  test('one seat reading never leaks into another seat', () => {
    writeCurrent(projection());
    expect(readPresenceForSeat(stateDir, SESSION, 'other', BINDING)).toBeNull();
  });
});
