// Independent acceptance for the display's per-seat presence qualification: baseline cc253905e,
// mixed-route fix bc51e1cb3, missing-list followup ad1ad6376, and the integrated copies
// a3a91484d (mixed route) and 00d3df3a3 (missing list). The rows come from production
// `seatRegistryRows`; the projections and state records are synthetic files under /private/tmp.
// No live pane, session, daemon or credential is touched.
//
// The scenes hold the display to the consumer's required answer:
//   - the daemon's seat list is its native-source answers, not a census of the route: a hook seat
//     sharing a healthy route with a listed Codex seat is absent from that list and still live;
//   - an expected native seat the list does not name — including an absent or undefined whole
//     list — has no classified source to inherit: its existing projection is held as last known,
//     never live;
//   - a listed entry decides over the expectation, so a healthy Codex entry is live under its
//     recorded binding, and a missing, mismatched or pending one is not;
//   - a malformed whole list, a stale route, and a genuinely absent or unreadable projection keep
//     the display's fail-closed fallback.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seatRegistryRows, type SeatRegistryRow, type SeatTraceSources } from '../src/commands/seats.ts';
import { presencePaths } from '../src/daemon/presence/spool.ts';
import type { TeamFile } from '../src/file/types.ts';
import {
  presenceChannelHealthy,
  presenceSeatsOf,
  seatPresenceProof,
  type PresenceHealthReading,
  type PresenceSeatHealth,
  type PresenceSeatsRead,
} from '../src/labels/presence.ts';
import { emptySession, type SessionState } from '../src/state.ts';
import type { Comparison, Live } from '../src/status/compare.ts';

const SESSION = 'teamcli';
const ROOT = '/private/tmp/b7-display-route-root';
const CODEX = 'codex-1';
const HOOK = 'claude-hook';
const CODEX_BINDING = 'prs_0123456789ab';
const HOOK_BINDING = 'prs_ba9876543210';
const NOW = new Date('2026-10-20T05:00:00.000Z');
const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString();

/** The followup adds the expectation flag as a fourth argument. This wrapper keeps the file's
 *  scenes on the same boolean answer while the display's newer proof also returns the applied
 *  transition the answer names; no assertion changes. */
type Qualification = (
  seats: PresenceSeatsRead | undefined,
  seat: string,
  binding: unknown,
  nativeExpected: boolean,
) => boolean;
const qualified: Qualification = (seats, seat, binding, nativeExpected) =>
  seatPresenceProof(seats, seat, binding, nativeExpected).qualified;

/** One fresh answered probe for ROOT. `seats` is the route's raw per-seat list, omitted for a
 *  hook-only route; `at` moves both the snapshot and the probe answer into the past. */
function healthReading(seats?: unknown, at: Date = NOW): PresenceHealthReading {
  const checkedAt = at.toISOString();
  return {
    roots: [{
      root: ROOT,
      presence: {
        session: SESSION,
        state: 'serving',
        healthy: true,
        checkedAt,
        why: null,
        ...(seats !== undefined ? { seats } : {}),
      },
    }],
    probe: { state: 'answered', at: checkedAt },
  };
}

/** The projection id every scene writes; a serving answer must vouch for exactly it. */
const APPLIED = `${ago(5)}-ab12cd34`;

const serving = (
  seat: string,
  binding: string = CODEX_BINDING,
  appliedEventId: string = APPLIED,
): Record<string, unknown> =>
  ({ seat, state: 'serving', healthy: true, binding, appliedEventId, why: null });

const listed = (
  entries: Array<[string, { healthy: boolean; binding: string | null; appliedEventId?: string | null }]>,
): PresenceSeatsRead => ({
  kind: 'listed',
  seats: new Map(entries.map(([seat, entry]): [string, PresenceSeatHealth] =>
    [seat, { appliedEventId: null, ...entry }])),
});

function projection(binding: string, state: 'working' | 'idle'): string {
  const since = ago(5);
  return JSON.stringify({
    v: 1,
    seq: 1,
    id: `${since}-ab12cd34`,
    state,
    source: 'runtime-hook',
    event: state === 'working' ? 'turn-start' : 'turn-end',
    binding,
    since,
    observedAt: since,
  });
}

let base = '';
let stateDir = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync('/private/tmp/b7-display-route-'));
  stateDir = join(base, '.agents');
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  if (base !== '') rmSync(base, { recursive: true, force: true });
  base = '';
  stateDir = '';
});

function projectionPath(seat: string): string {
  const paths = presencePaths(stateDir, SESSION, seat);
  if (paths === null) throw new Error('the scene names no presence folder');
  return paths.current;
}

function writeProjection(seat: string, text: string): void {
  const path = projectionPath(seat);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/** Two seats on one team: a Codex seat, whose presence is the daemon's native source, and a
 *  Claude hook seat, which no presence source lists. Both carry recorded bindings. */
function rowsFor(presenceSeats: PresenceSeatsRead | undefined): Map<string, SeatRegistryRow> {
  const team = {
    project: 'acme',
    seats: [
      {
        role: 'implementer', name: CODEX, cli: 'codex', model: 'GPT-5', version: '1',
        launch: 'codex --model gpt-5', cwd: '.',
      },
      {
        role: 'implementer', name: HOOK, cli: 'claude-code', model: 'Claude Opus', version: '5.5',
        launch: 'claude --model claude-opus-5-5', cwd: '.',
      },
    ],
  } as unknown as TeamFile;
  const state = emptySession();
  state.seats[CODEX] = {
    stage: 'ready', pane: 'w1:p1', workspace: 'w1', cli: 'codex',
    launched: { shell: 1, cli: [2] }, model: 'GPT-5', version: '1',
    launch_line: 'codex --model gpt-5', presence_binding: CODEX_BINDING,
  };
  state.seats[HOOK] = {
    stage: 'ready', pane: 'w1:p2', workspace: 'w1', cli: 'claude-code',
    launched: { shell: 3, cli: [4] }, model: 'Claude Opus', version: '5.5',
    launch_line: 'claude --model claude-opus-5-5', presence_binding: HOOK_BINDING,
  };
  const live: Live = { running: true, agents: [], workspaces: [], screens: {} };
  const comparison: Comparison = {
    rows: [
      { name: CODEX, state: 'idle', model: 'GPT-5', pane: 'w1:p1' },
      { name: HOOK, state: 'idle', model: 'Claude Opus', pane: 'w1:p2' },
    ],
    differences: [],
    notes: [],
  };
  const sources: SeatTraceSources = {
    project: 'acme',
    root: base,
    stateDir,
    session: SESSION,
    presenceChannelHealthy: true,
    ...(presenceSeats === undefined ? {} : { presenceSeats }),
  };
  const rows = seatRegistryRows(team, state, live, comparison, NOW, true, false, sources);
  return new Map(rows.map((row) => [row.name, row]));
}

/** The projection's answer for one seat, without handing a shared row object to a matcher. */
function presenceOf(rows: Map<string, SeatRegistryRow>, seat: string): {
  state: string; source: string; live: boolean;
} {
  const row = rows.get(seat);
  if (row === undefined) throw new Error(`the display emitted no row for ${seat}`);
  if (row.presence === undefined) throw new Error(`the display read no presence for ${seat}`);
  return { state: row.presence.state, source: row.presence.source, live: row.presence.live };
}

describe('a mixed route lists only its native source', () => {
  test('an unlisted hook seat stays live beside the listed Codex seat', () => {
    writeProjection(CODEX, projection(CODEX_BINDING, 'working'));
    writeProjection(HOOK, projection(HOOK_BINDING, 'working'));
    const reading = healthReading([serving(CODEX, CODEX_BINDING)]);
    expect(presenceChannelHealthy(reading, ROOT, SESSION, NOW)).toBe(true);
    const rows = rowsFor(presenceSeatsOf(reading, ROOT, SESSION, NOW));

    // The listed native source is live under the binding the seat records.
    expect(presenceOf(rows, CODEX)).toEqual({ state: 'working', source: 'runtime-hook', live: true });
    // The hook seat is expected absent from the daemon's native-source list; the healthy route's
    // own verdict still answers it, so it is live rather than held.
    expect(presenceOf(rows, HOOK)).toEqual({ state: 'working', source: 'runtime-hook', live: true });

    const seats = presenceSeatsOf(reading, ROOT, SESSION, NOW);
    expect(qualified(seats, HOOK, HOOK_BINDING, false)).toBe(true);
    expect(qualified(seats, CODEX, CODEX_BINDING, true)).toBe(true);
  });

  test('an expected Codex seat the listed route does not name is not live', () => {
    writeProjection(CODEX, projection(CODEX_BINDING, 'working'));
    writeProjection(HOOK, projection(HOOK_BINDING, 'working'));
    // The route lists the hook seat explicitly; the Codex seat's source was never classified.
    const seats = presenceSeatsOf(healthReading([serving(HOOK, HOOK_BINDING)]), ROOT, SESSION, NOW);
    const rows = rowsFor(seats);
    expect(presenceOf(rows, CODEX)).toEqual({ state: 'working', source: 'runtime-hook', live: false });
    expect(presenceOf(rows, HOOK)).toEqual({ state: 'working', source: 'runtime-hook', live: true });

    expect(qualified(seats, CODEX, CODEX_BINDING, true)).toBe(false);
    // A listed entry decides over the expectation.
    expect(qualified(seats, HOOK, HOOK_BINDING, true)).toBe(true);
    // A listed entry under another binding, or a pending one, is not proof either.
    expect(qualified(seats, HOOK, CODEX_BINDING, true)).toBe(false);
    const mismatched = listed([[CODEX, { healthy: true, binding: HOOK_BINDING }]]);
    expect(qualified(mismatched, CODEX, CODEX_BINDING, true)).toBe(false);
    const pending = listed([[CODEX, { healthy: false, binding: null }]]);
    expect(qualified(pending, CODEX, CODEX_BINDING, true)).toBe(false);
  });

  test('an absent or undefined whole list holds the expected Codex seat and keeps the hook live', () => {
    writeProjection(CODEX, projection(CODEX_BINDING, 'idle'));
    writeProjection(HOOK, projection(HOOK_BINDING, 'working'));
    // Both shapes of "the route carries no list": an explicit absent reader answer, and no seat
    // answer handed to the rows at all.
    for (const seats of [{ kind: 'absent' } as const, undefined]) {
      const rows = rowsFor(seats);
      // The old Codex projection on a fresh healthy route is the runtime's last known word: it
      // still answers the row, but without the source it expected it is never live.
      expect(presenceOf(rows, CODEX)).toEqual({ state: 'idle', source: 'runtime-hook', live: false });
      // A hook-only route is the hook seat's own route verdict.
      expect(presenceOf(rows, HOOK)).toEqual({ state: 'working', source: 'runtime-hook', live: true });
    }

    const absent = presenceSeatsOf(healthReading(), ROOT, SESSION, NOW);
    expect(absent).toEqual({ kind: 'absent' });
    expect(presenceChannelHealthy(healthReading(), ROOT, SESSION, NOW)).toBe(true);
    expect(qualified(absent, CODEX, CODEX_BINDING, true)).toBe(false);
    expect(qualified(absent, HOOK, HOOK_BINDING, false)).toBe(true);
    expect(qualified(undefined, CODEX, CODEX_BINDING, true)).toBe(false);
    expect(qualified(undefined, HOOK, HOOK_BINDING, false)).toBe(true);
  });

  test('a malformed list and an absent or unreadable projection keep the fail-closed fallback', () => {
    writeProjection(CODEX, projection(CODEX_BINDING, 'working'));
    writeProjection(HOOK, projection(HOOK_BINDING, 'working'));
    // A malformed whole list is dropped whole: no seat in it is live, whatever it expects.
    const rows = rowsFor({ kind: 'invalid', why: 'the seat list is not a non-empty list' });
    expect(presenceOf(rows, CODEX)).toEqual({ state: 'working', source: 'runtime-hook', live: false });
    expect(presenceOf(rows, HOOK)).toEqual({ state: 'working', source: 'runtime-hook', live: false });

    const malformed = healthReading([]);
    expect(presenceChannelHealthy(malformed, ROOT, SESSION, NOW)).toBe(false);
    const invalid = presenceSeatsOf(malformed, ROOT, SESSION, NOW);
    expect(invalid.kind).toBe('invalid');
    expect(qualified(invalid, CODEX, CODEX_BINDING, true)).toBe(false);
    expect(qualified(invalid, HOOK, HOOK_BINDING, false)).toBe(false);

    // A stale route is invalid too, never a projection's proof of live.
    const stale = new Date(NOW.getTime() - 5_000);
    expect(presenceSeatsOf(healthReading([serving(CODEX)], stale), ROOT, SESSION, NOW).kind).toBe('invalid');

    // A genuinely absent projection is the one case another source may answer in; the absent
    // list does not turn that fallback into a hold.
    rmSync(projectionPath(CODEX));
    const absentRows = rowsFor({ kind: 'absent' });
    const absentRow = absentRows.get(CODEX);
    if (absentRow === undefined) throw new Error('the display emitted no Codex row');
    expect(absentRow.presence).toBeUndefined();
    expect(absentRow.presence_unreadable).toBeUndefined();
    expect(absentRow.state_source).not.toBe('presence');

    // An existing but malformed projection is unreadable from presence, never a screen's answer.
    writeProjection(CODEX, 'not a projection');
    const badRow = rowsFor({ kind: 'absent' }).get(CODEX);
    if (badRow === undefined) throw new Error('the display emitted no Codex row');
    expect(badRow.presence_unreadable).toBe(true);
    expect(badRow.state_source).toBe('presence');
  });
});
