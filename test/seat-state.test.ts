// TeamCLI's own seat state (src/labels/state.ts). The certainties (held, unreachable, done)
// answer first; then the daemon's presence projection for this runtime incarnation — live or
// last known, never expired by elapsed time and never overridden by a screen or trace; then the
// CLI's own screen, herdr's status, TeamCLI's traces within a window, otherwise unknown. The
// thresholds are settings (src/settings/inherit.ts) and govern only the legacy sources. Every
// screen text below is synthetic.
import { describe, expect, test } from 'bun:test';
import { observedSeatState, sayThreshold, seatState, type PresenceObservation } from '../src/labels/state.ts';
import { renderSeatsTable, type SeatRegistryRow } from '../src/commands/seats.ts';
import { DEFAULT_STATE_THRESHOLDS, STATE_THRESHOLDS } from '../src/settings/inherit.ts';
import { resolveNumberSetting, stateThresholds } from '../src/settings/resolve.ts';
import { CLAUDE_IDLE } from './helpers.ts';

const NOW = new Date('2026-10-17T12:00:00Z');
const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString();

describe('the reading, best source first', () => {
  test('a hold answers before every other source', () => {
    const reading = seatState(
      { held: true, reachable: false, present: false, screen: { kind: 'working' }, herdr: 'working', trace: NOW.toISOString() },
      NOW,
    );
    expect(reading).toEqual({ state: 'held', source: 'hold', blind: false });
  });

  test('a seat herdr cannot reach is unreachable, whatever its pane last showed', () => {
    expect(seatState({ reachable: false, screen: { kind: 'idle' } }, NOW))
      .toEqual({ state: 'unreachable', source: 'herdr', blind: false });
  });

  test('a seat whose recorded process is gone is done, screen or no screen', () => {
    expect(seatState({ present: false, screen: { kind: 'working' } }, NOW))
      .toEqual({ state: 'done', source: 'process', blind: false });
  });

  test("the CLI's own screen: working, idle, an unsent composer blocked, and every other screen blocked", () => {
    expect(seatState({ screen: { kind: 'working' } }, NOW)).toEqual({ state: 'working', source: 'cli', blind: false });
    expect(seatState({ screen: { kind: 'idle' } }, NOW)).toEqual({ state: 'idle', source: 'cli', blind: false });
    // A composer holding unsent text cannot take a typed trigger until its owner clears or sends
    // the line: the seat is blocked, and a fresh trace never hides it (the scene below).
    expect(seatState({ screen: { kind: 'unsent' } }, NOW)).toEqual({ state: 'blocked', source: 'cli', blind: false });
    expect(seatState({ screen: { kind: 'unsent' }, trace: ago(30) }, NOW))
      .toEqual({ state: 'blocked', source: 'cli', blind: false });
    for (const screen of [
      { kind: 'permission' } as const,
      { kind: 'trust' } as const,
      { kind: 'question' } as const,
      { kind: 'provider error' } as const,
    ]) {
      expect(seatState({ screen }, NOW)).toEqual({ state: 'blocked', source: 'cli', blind: false });
    }
    // A usage wall is a blocked seat, not a state word of its own: nothing can be typed into
    // that screen until it lifts, and `status` names the quota and its reset beside the word.
    expect(seatState({ screen: { kind: 'rate limit', reset: null } }, NOW))
      .toEqual({ state: 'blocked', source: 'cli', blind: false });
  });

  test("a screen this version cannot read falls through to herdr's own status", () => {
    expect(seatState({ screen: { kind: 'unknown' }, herdr: 'working' }, NOW))
      .toEqual({ state: 'working', source: 'herdr', blind: false });
    expect(seatState({ screen: { kind: 'unknown' }, herdr: 'idle' }, NOW))
      .toEqual({ state: 'idle', source: 'herdr', blind: false });
    // herdr's own word for an agent that finished is the seat done, not unheard of.
    expect(seatState({ herdr: 'done' }, NOW)).toEqual({ state: 'done', source: 'herdr', blind: false });
    // A herdr word that is neither working nor idle falls through too.
    expect(seatState({ herdr: 'unknown', trace: ago(30) }, NOW))
      .toEqual({ state: 'working', source: 'trace', blind: false });
  });

  test('a trace within the window means working; the window boundary counts as inside', () => {
    expect(seatState({ trace: ago(30) }, NOW)).toEqual({ state: 'working', source: 'trace', blind: false });
    expect(seatState({ trace: ago(DEFAULT_STATE_THRESHOLDS.trace_window_seconds) }, NOW))
      .toEqual({ state: 'working', source: 'trace', blind: false });
  });

  test('no source answers: unknown, and blind only past the blind threshold', () => {
    // A trace older than the window but younger than the blind threshold: unknown, not blind.
    expect(seatState({ trace: ago(DEFAULT_STATE_THRESHOLDS.trace_window_seconds + 60) }, NOW))
      .toEqual({ state: 'unknown', source: 'none', blind: false });
    // The blind boundary itself is not yet blind; one second past it is.
    expect(seatState({ trace: ago(DEFAULT_STATE_THRESHOLDS.blind_after_seconds) }, NOW).blind).toBe(false);
    expect(seatState({ trace: ago(DEFAULT_STATE_THRESHOLDS.blind_after_seconds + 1) }, NOW).blind).toBe(true);
    // No trace at all: nothing was ever heard, which is past every threshold.
    expect(seatState({}, NOW)).toEqual({ state: 'unknown', source: 'none', blind: true });
    expect(seatState({ trace: null }, NOW)).toEqual({ state: 'unknown', source: 'none', blind: true });
  });

  test('a caller may run the reading by its own thresholds', () => {
    const limits = {
      ...DEFAULT_STATE_THRESHOLDS,
      trace_window_seconds: 600,
      blind_after_seconds: 600,
      hook_working_seconds: 600,
    };
    expect(seatState({ trace: ago(300) }, NOW, limits)).toEqual({ state: 'working', source: 'trace', blind: false });
    expect(seatState({ trace: ago(601) }, NOW, limits)).toEqual({ state: 'unknown', source: 'none', blind: true });
  });
});

describe("the daemon's presence projection", () => {
  const presence = (
    state: 'working' | 'idle' | 'waiting-for-a-person' | 'gone',
    seconds: number,
    live = true,
  ): PresenceObservation => ({
    state,
    source: 'runtime-hook',
    event: state === 'working' ? 'turn-start'
      : state === 'idle' ? 'turn-end'
        : state === 'waiting-for-a-person' ? 'human-wait' : 'session-end',
    since: ago(seconds),
    live,
  });

  test('a working word answers before a contradictory screen and a fresh trace, however old', () => {
    const long = presence('working', 2 * 24 * 60 * 60);
    expect(seatState({ presence: presence('working', 30), screen: { kind: 'idle' }, trace: ago(30) }, NOW))
      .toMatchObject({ state: 'working', source: 'presence', blind: false });
    // Older than the hook file's whole day: the native record still stands, and neither the
    // idle prompt nor a trace inside its window replaces it.
    expect(seatState({ presence: long, screen: { kind: 'idle' }, trace: ago(30) }, NOW))
      .toMatchObject({ state: 'working', source: 'presence', blind: false });
    // No terminal at all: the same answer.
    expect(seatState({ presence: long }, NOW)).toMatchObject({ state: 'working', source: 'presence' });
  });

  test('an idle word stands over a working screen and a fresh trace', () => {
    const long = presence('idle', 2 * 24 * 60 * 60);
    expect(seatState({ presence: presence('idle', 30), trace: ago(30) }, NOW))
      .toMatchObject({ state: 'idle', source: 'presence', blind: false });
    expect(seatState({ presence: long, screen: { kind: 'working' }, trace: ago(30) }, NOW))
      .toMatchObject({ state: 'idle', source: 'presence', blind: false });
    expect(seatState({ presence: long }, NOW)).toMatchObject({ state: 'idle', source: 'presence' });
  });

  test('a blocked screen never overrides a projection', () => {
    expect(seatState({ presence: presence('working', 30), screen: { kind: 'permission' } }, NOW))
      .toMatchObject({ state: 'working', source: 'presence' });
    expect(seatState({ presence: presence('idle', 30), screen: { kind: 'permission' } }, NOW))
      .toMatchObject({ state: 'idle', source: 'presence' });
  });

  test('a person the runtime waits on is blocked, and the canonical word survives the mapping', () => {
    const reading = seatState(
      { presence: presence('waiting-for-a-person', 30), screen: { kind: 'idle' }, trace: ago(30) }, NOW,
    );
    expect(reading).toMatchObject({
      state: 'blocked',
      source: 'presence',
      blind: false,
      presence: {
        state: 'waiting-for-a-person', source: 'runtime-hook', event: 'human-wait', live: true,
      },
    });
  });

  test('a session end is done, and the canonical word survives the mapping', () => {
    expect(seatState({ presence: presence('gone', 30), trace: ago(30) }, NOW)).toMatchObject({
      state: 'done',
      source: 'presence',
      presence: { state: 'gone', event: 'session-end' },
    });
  });

  test('last known still answers as itself, marked not live', () => {
    const reading = seatState({ presence: presence('idle', 30, false), screen: { kind: 'working' } }, NOW);
    expect(reading).toMatchObject({ state: 'idle', source: 'presence', presence: { live: false } });
  });

  test('an existing projection this build cannot read as this seat\'s is unknown from presence, never a screen', () => {
    // Malformed, unfenced or another incarnation's: the runtime speaks, so no screen answers.
    expect(seatState({ presenceUnreadable: true, screen: { kind: 'working' }, trace: ago(30) }, NOW))
      .toEqual({ state: 'unknown', source: 'presence', blind: false, presenceUnreadable: true });
    expect(seatState({ presenceUnreadable: true, screen: { kind: 'idle' }, trace: ago(30) }, NOW))
      .toEqual({ state: 'unknown', source: 'presence', blind: false, presenceUnreadable: true });
    expect(seatState({ presenceUnreadable: true, screen: { kind: 'permission' } }, NOW))
      .toEqual({ state: 'unknown', source: 'presence', blind: false, presenceUnreadable: true });
    // The certainties above it still answer: a hold is not something the projection speaks to.
    expect(seatState({ presenceUnreadable: true, held: true }, NOW))
      .toMatchObject({ state: 'held', source: 'hold' });
  });

  test('presence answers before the hook file a second signal from the same launch', () => {
    expect(seatState({ presence: presence('idle', 30), hook: { state: 'working', since: ago(30) } }, NOW))
      .toMatchObject({ state: 'idle', source: 'presence' });
    // Without a projection the hook keeps answering exactly as before.
    expect(seatState({ hook: { state: 'working', since: ago(30) } }, NOW))
      .toEqual({ state: 'working', source: 'cli-hook', blind: false });
  });
});

describe('the gatherer the readers share', () => {
  test('an idle pane reads idle from the CLI itself', () => {
    const reading = observedSeatState({
      cli: 'claude-code',
      agent: { pane: 'w1:p1', status: 'idle' },
      screenText: CLAUDE_IDLE,
      trace: ago(3600),
      now: NOW,
    });
    expect(reading).toEqual({ state: 'idle', source: 'cli', blind: false });
  });

  test('a trace inside the window beats an idle word, and never a blocked screen', () => {
    // The seat committed, acked or ran a command 30s ago: idle at its prompt, but working.
    expect(observedSeatState({ cli: 'claude-code', screenText: CLAUDE_IDLE, trace: ago(30), now: NOW }))
      .toEqual({ state: 'working', source: 'trace', blind: false });
    expect(observedSeatState({ cli: 'claude-code', agent: { pane: 'w1:p1', status: 'idle' }, trace: ago(30), now: NOW }))
      .toEqual({ state: 'working', source: 'trace', blind: false });
    // A dialog or a question is someone's attention wanted: a fresh trace never hides it.
    expect(seatState({ screen: { kind: 'permission' }, trace: ago(30) }, NOW))
      .toEqual({ state: 'blocked', source: 'cli', blind: false });
  });

  test('a stopped seat is done before its stale record is judged blind', () => {
    const reading = observedSeatState({
      cli: 'claude-code',
      stopped: true,
      trace: ago(7200),
      reachable: true,
      now: NOW,
    });
    expect(reading).toEqual({ state: 'done', source: 'process', blind: false });
  });

  test('a seat the comparison calls missing is done; a reachless session is unreachable', () => {
    expect(observedSeatState({ cli: 'claude-code', gone: true, now: NOW }).state).toBe('done');
    expect(observedSeatState({ cli: 'claude-code', reachable: false, now: NOW }))
      .toEqual({ state: 'unreachable', source: 'herdr', blind: false });
  });

  test('an agent with no screen read and a stale trace is unknown, and blind', () => {
    const reading = observedSeatState({
      cli: 'claude-code',
      agent: { pane: 'w1:p1', status: 'unknown' },
      trace: ago(7200),
      now: NOW,
    });
    expect(reading).toEqual({ state: 'unknown', source: 'none', blind: true });
  });
});

describe('the thresholds are settings', () => {
  test('nothing declared keeps the shipped fallbacks', () => {
    expect(stateThresholds({})).toEqual(DEFAULT_STATE_THRESHOLDS);
    // The liveness windows ship at five to the lead, fifteen to the owner, five to blind.
    expect(DEFAULT_STATE_THRESHOLDS).toEqual({
      idle_lead_seconds: 300,
      idle_owner_seconds: 900,
      blind_after_seconds: 300,
      trace_window_seconds: 120,
      hook_working_seconds: 120,
    });
  });

  test('a team may tighten any threshold freely, and the other fields are untouched', () => {
    expect(stateThresholds({ team: { blind_after_seconds: 120 } }))
      .toEqual({ ...DEFAULT_STATE_THRESHOLDS, blind_after_seconds: 120 });
    expect(stateThresholds({ seat: { trace_window_seconds: 10, blind_after_seconds: 60 } }))
      .toEqual({ ...DEFAULT_STATE_THRESHOLDS, trace_window_seconds: 10, blind_after_seconds: 60 });
    // The hook's own window: a team may make the screen win sooner, never later.
    expect(stateThresholds({ team: { hook_working_seconds: 30 } }))
      .toEqual({ ...DEFAULT_STATE_THRESHOLDS, hook_working_seconds: 30 });
  });

  test('a team may not loosen: the word is refused and the inherited value stands', () => {
    expect(stateThresholds({ team: { blind_after_seconds: 7200 } })).toEqual(DEFAULT_STATE_THRESHOLDS);
    expect(stateThresholds({ team: { hook_working_seconds: 900 } })).toEqual(DEFAULT_STATE_THRESHOLDS);
    // The project may open the trace, hook and blind windows: the blind threshold is the one
    // liveness setting whose level above may loosen it.
    expect(stateThresholds({ project: { blind_after_seconds: 7200, hook_working_seconds: 900 } }))
      .toEqual({ ...DEFAULT_STATE_THRESHOLDS, blind_after_seconds: 7200, hook_working_seconds: 900 });
  });

  test('the resolver the settings share reports what it set aside', () => {
    const resolution = resolveNumberSetting(
      STATE_THRESHOLDS.blind_after_seconds,
      [{ level: 'team', value: 7200 }, { level: 'seat', value: 60 }],
    );
    expect(resolution.value).toBe(60);
    expect(resolution.source).toBe('seat');
    // The word set aside carries the value it would have replaced, so a report names both.
    expect(resolution.refused).toEqual([{ level: 'team', value: 7200, inherited: 300 }]);
    // A word equal to the value in force is no word at all.
    expect(resolveNumberSetting(STATE_THRESHOLDS.blind_after_seconds, [{ level: 'entity', value: 300 }]).source).toBeNull();
  });
});

describe('the words a report says', () => {
  test('sayThreshold', () => {
    expect(sayThreshold(45)).toBe('45s');
    expect(sayThreshold(1800)).toBe('30m');
    expect(sayThreshold(7200)).toBe('2h');
  });
});

describe('the table shows the state and its source', () => {
  const row = (over: Partial<SeatRegistryRow>): SeatRegistryRow => ({
    name: 'builder-1',
    id: null,
    role: 'builder',
    cli: 'claude-code',
    model: 'Claude Opus',
    effort: null,
    status: 'ready',
    state: 'idle',
    state_source: 'cli',
    blind: false,
    last_active: null,
    last_active_display: '-',
    pane: 'w1:p1',
    launch_line: null,
    ...over,
  });

  test('a blind seat is flagged where its word stands', () => {
    const rendered = renderSeatsTable([
      row({ name: 'builder-1', state: 'working', state_source: 'cli' }),
      row({ name: 'builder-2', state: 'unknown', state_source: 'none', blind: true }),
    ]);
    const lines = rendered.trimEnd().split('\n');
    expect(lines[0]).toContain('STATE');
    expect(lines[0]).toContain('SOURCE');
    expect(lines[1]).toContain('working');
    expect(lines[2]).toContain('unknown (blind)');
    expect(lines[2]).toContain('none');
  });
});
