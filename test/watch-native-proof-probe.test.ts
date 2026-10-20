// Independent probe for the native presence proof the idle pickup and its hosted binding rest
// on: the verdict is proved field by field, a channel answer is per seat, and a seat the caller
// cannot prove is held without taking a sibling's health. Calls the production predicates and
// snapshot directly; no watch loop, runtime or pane is started.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { presenceId, type PresenceReading } from '../src/daemon/presence/contract.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { SessionState } from '../src/state.ts';
import { idleWorkReport } from '../src/watch/idle-work.ts';
import {
  nativeAllowsTyping,
  presenceSeatOf,
  presenceVerdict,
  type PresenceRead,
  type PresenceSeat,
} from '../src/watch/presence.ts';

const NOW = new Date('2026-10-19T10:00:00.000Z');
const SINCE = '2026-10-19T09:50:00.000Z';
const OBSERVED = '2026-10-19T09:50:02.000Z';
const LAST_ACTIVE = '2026-10-19T09:49:00.000Z';
const BINDING = 'prs_0123456789ab';
const SEAT_ID = 'seat_0123456789ab';
const ID = presenceId(SINCE, 'a1b2c3d4');
if (ID === null) throw new Error('the probe instant is not a presence instant');
const PRESENCE_ID: string = ID;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function reading(over: Partial<PresenceReading> = {}): PresenceReading {
  return {
    v: 1,
    seq: 3,
    id: PRESENCE_ID,
    state: 'idle',
    source: 'runtime-hook',
    event: 'turn-end',
    binding: BINDING,
    since: SINCE,
    observedAt: OBSERVED,
    ...over,
  };
}

function seat(over: Partial<PresenceSeat> = {}): PresenceSeat {
  return {
    seat: 'worker-a',
    seatId: SEAT_ID,
    binding: BINDING,
    fence: { seat_id: SEAT_ID, binding: BINDING, seq: 3, applied_at: OBSERVED },
    lastActive: LAST_ACTIVE,
    channelHealthy: true,
    ...over,
  };
}

const native = (over: Partial<PresenceReading> = {}): PresenceRead => ({ kind: 'native', reading: reading(over) });
const clock = (thresholdSeconds = 300) => ({ now: NOW, thresholdSeconds });

function world(seats: string[] = ['worker-a', 'worker-b', 'worker-c']): {
  root: string;
  team: TeamFile;
  state: SessionState;
} {
  const root = mkdtempSync('/private/tmp/b7native-');
  roots.push(root);
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'queue.yaml'), '');
  const crew = seats.map((name) => `  - role: worker
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude`).join('\n');
  const text = `format: 1
project: acme
session: crew
coordinator: boss
operator: boss
workspace:
  mode: shared
seats:
  - role: project coordinator
    name: boss
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude
${crew}
`;
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const state: SessionState = { seats: {}, worktrees: {} };
  for (const name of seats) {
    state.seats[name] = {
      stage: 'ready',
      last_active: LAST_ACTIVE,
      id: SEAT_ID,
      presence_binding: BINDING,
      presence_applied: { seat_id: SEAT_ID, binding: BINDING, seq: 3, applied_at: OBSERVED },
    };
  }
  return { root, team: parsed.team, state };
}

describe('the native proof is exact, field by field', () => {
  test('a coherent idle projection is idle; every field the proof names is load-bearing', () => {
    const good = presenceVerdict(native(), seat(), clock());
    expect(good).toEqual({ idle: true, source: 'runtime-hook', nativeSince: SINCE, observedAt: OBSERVED });

    const breaks: Array<[string, PresenceRead, PresenceSeat]> = [
      ['an unknown source', native({ source: 'terminal-host' as PresenceReading['source'] }), seat()],
      ['an unknown event', native({ event: 'nope' as PresenceReading['event'] }), seat()],
      ['a state that disagrees with its event', native({ state: 'working' }), seat()],
      ['a predecessor binding', native({ binding: 'prs_ffffffffffff' }), seat()],
      ['a seat without a binding', native(), seat({ binding: null })],
      ['a seat without a managed id', native(), seat({ seatId: null })],
      ['a missing fence', native(), seat({ fence: undefined })],
      ['a fence for another seat', native(), seat({
        fence: { seat_id: 'seat_ffffffffffff', binding: BINDING, seq: 3, applied_at: OBSERVED },
      })],
      ['a fence on another incarnation', native(), seat({
        fence: { seat_id: SEAT_ID, binding: 'prs_ffffffffffff', seq: 3, applied_at: OBSERVED },
      })],
      ['a fence at another sequence', native(), seat({
        fence: { seat_id: SEAT_ID, binding: BINDING, seq: 4, applied_at: OBSERVED },
      })],
      ['a future fence instant', native(), seat({
        fence: { seat_id: SEAT_ID, binding: BINDING, seq: 3, applied_at: '2026-10-19T10:02:00.000Z' },
      })],
      ['an unhealthy channel', native(), seat({ channelHealthy: false })],
      ['a future observedAt', native({ observedAt: '2026-10-19T10:02:00.000Z' }), seat()],
      ['a since later than its own ingest', native({ since: '2026-10-19T09:50:03.000Z' }), seat({
        fence: { seat_id: SEAT_ID, binding: BINDING, seq: 3, applied_at: '2026-10-19T09:50:04.000Z' },
      })],
      ['an id naming another instant', native({ id: `${'2026-10-19T09:49:59.000Z'}-a1b2c3d4` }), seat()],
      ['a missing persisted stamp', native(), seat({ lastActive: undefined })],
      ['a persisted stamp older than the transition', native(), seat({ lastActive: '2026-10-19T09:40:00.000Z' })],
    ];
    for (const [name, read, facts] of breaks) {
      const verdict = presenceVerdict(read, facts, clock());
      expect({ name, idle: verdict.idle, reason: verdict.idle ? null : verdict.reason })
        .toEqual({ name, idle: false, reason: 'invalid' });
      expect(nativeAllowsTyping(verdict)).toBe(false);
    }
  });

  test('the idle window is checked on the persisted and the native clock', () => {
    // Ten minutes on both clocks: idle at the default. A threshold above either clock's age holds
    // with its own reason, not as an unproven channel.
    expect(presenceVerdict(native(), seat(), clock(10 * 60))).toMatchObject({ idle: true });
    expect(presenceVerdict(native(), seat(), clock(10 * 60 + 1))).toMatchObject({ idle: false, reason: 'too-recent' });
    expect(presenceVerdict(native(), seat({ lastActive: '2026-10-19T09:50:01.000Z' }), clock(10 * 60)))
      .toMatchObject({ idle: false, reason: 'too-recent' });
  });

  test('working, a person wait and a session end never wake, and only absence licenses the screen', () => {
    expect(presenceVerdict(native({ event: 'turn-start', state: 'working' }), seat(), clock()))
      .toMatchObject({ idle: false, reason: 'working' });
    expect(presenceVerdict(native({ event: 'human-wait', state: 'waiting-for-a-person' }), seat(), clock()))
      .toMatchObject({ idle: false, reason: 'waiting-for-a-person' });
    const gone = presenceVerdict(
      native({ event: 'session-end', state: 'gone' }),
      seat({ channelHealthy: false }),
      clock(),
    );
    // A canonical session end is the one non-idle conclusion an unhealthy channel does not hide.
    expect(gone).toMatchObject({ idle: false, reason: 'gone' });
    expect(nativeAllowsTyping(gone)).toBe(false);
    // Absence and unsupported are the labelled terminal-host fallback, and only they allow it.
    for (const read of [
      { kind: 'absent', why: 'no projection' } as const,
      { kind: 'unsupported', why: 'no channel' } as const,
    ]) {
      const verdict = presenceVerdict(read, seat({ channelHealthy: false }), clock());
      expect(verdict.idle).toBe(false);
      expect(nativeAllowsTyping(verdict)).toBe(true);
    }
  });
});

describe('the channel answer is this seat’s, never the route’s', () => {
  test('presenceSeatOf asks for its own seat and treats anything but true as held', () => {
    const asked: string[] = [];
    const facts = presenceSeatOf(
      { seats: { 'worker-a': { stage: 'ready', id: SEAT_ID, presence_binding: BINDING } }, worktrees: {} },
      'worker-a',
      (name) => {
        asked.push(name);
        return name === 'worker-a';
      },
    );
    expect(asked).toEqual(['worker-a']);
    expect(facts).toMatchObject({ seat: 'worker-a', seatId: SEAT_ID, binding: BINDING, channelHealthy: true });
    expect(presenceSeatOf({ seats: {}, worktrees: {} }, 'worker-a', () => false).channelHealthy).toBe(false);
    expect(presenceSeatOf({ seats: {}, worktrees: {} }, 'worker-a', undefined).channelHealthy).toBe(false);
  });

  test('the idle snapshot counts a proven seat and holds its sibling the caller cannot prove', () => {
    const { root, team, state } = world();
    const presence = new Map<string, PresenceRead>([
      ['worker-a', native()],
      ['worker-b', native()],
      ['worker-c', native({ event: 'turn-start', state: 'working' })],
    ]);
    const asked: string[] = [];
    const report = idleWorkReport({
      root,
      team,
      state,
      live: null,
      now: NOW,
      presence,
      presenceChannelHealthy: (name) => {
        asked.push(name);
        return name === 'worker-a';
      },
    });
    // Each declared worker was asked about on its own; no route-wide answer was borrowed.
    expect(asked.sort()).toEqual(['worker-a', 'worker-b', 'worker-c']);
    expect(report.idle.map((one) => one.seat)).toEqual(['worker-a']);
    // The sibling's valid projection was not believed without its own health answer.
    expect(report.presence_unknown).toContain('worker-b');
    expect(report.presence_unknown).toContain('the presence channel is not known healthy this pass');
  });

  test('with no per-seat answer every native projection is held', () => {
    const { root, team, state } = world();
    const report = idleWorkReport({
      root,
      team,
      state,
      live: null,
      now: NOW,
      presence: new Map([['worker-a', native()], ['worker-b', native()], ['worker-c', native()]]),
    });
    expect(report.idle).toEqual([]);
    // A hold is reported for the first held seat only, with its reason.
    expect(report.presence_unknown).toBe('worker-a: the presence channel is not known healthy this pass');
  });
});
