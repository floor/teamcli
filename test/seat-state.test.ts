// TeamCLI's own seat state (src/labels/state.ts). The reading is best source
// first — the CLI's own screen, herdr's status, TeamCLI's traces within a window, otherwise
// unknown — with the certainties (held, unreachable, done) answered before any screen is read.
// `unknown` past the blind threshold counts as not working. The thresholds are settings
// (src/settings/inherit.ts). Every screen text below is synthetic.
import { describe, expect, test } from 'bun:test';
import { observedSeatState, sayThreshold, seatState } from '../src/labels/state.ts';
import { renderSeatsTable, type SeatRegistryRow } from '../src/commands/seats.ts';
import { DEFAULT_STATE_THRESHOLDS, resolveNumberSetting, stateThresholds, STATE_THRESHOLDS } from '../src/settings/inherit.ts';
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
      { kind: 'rate limit', reset: null } as const,
    ]) {
      expect(seatState({ screen }, NOW)).toEqual({ state: 'blocked', source: 'cli', blind: false });
    }
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
    const limits = { trace_window_seconds: 600, blind_after_seconds: 600, hook_working_seconds: 600 };
    expect(seatState({ trace: ago(300) }, NOW, limits)).toEqual({ state: 'working', source: 'trace', blind: false });
    expect(seatState({ trace: ago(601) }, NOW, limits)).toEqual({ state: 'unknown', source: 'none', blind: true });
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
    // The blind window is a liveness default now: five minutes, and no level may lengthen it.
    expect(DEFAULT_STATE_THRESHOLDS)
      .toEqual({ trace_window_seconds: 120, blind_after_seconds: 300, hook_working_seconds: 120 });
  });

  test('a team may tighten any threshold freely, and the other fields are untouched', () => {
    expect(stateThresholds({ team: { blind_after_seconds: 120 } }))
      .toEqual({ trace_window_seconds: 120, blind_after_seconds: 120, hook_working_seconds: 120 });
    expect(stateThresholds({ seat: { trace_window_seconds: 10, blind_after_seconds: 60 } }))
      .toEqual({ trace_window_seconds: 10, blind_after_seconds: 60, hook_working_seconds: 120 });
    // The hook's own window: a team may make the screen win sooner, never later.
    expect(stateThresholds({ team: { hook_working_seconds: 30 } }))
      .toEqual({ trace_window_seconds: 120, blind_after_seconds: 300, hook_working_seconds: 30 });
  });

  test('a team may not loosen: the word is refused and the inherited value stands', () => {
    expect(stateThresholds({ team: { blind_after_seconds: 7200 } }))
      .toEqual({ trace_window_seconds: 120, blind_after_seconds: 300, hook_working_seconds: 120 });
    expect(stateThresholds({ team: { hook_working_seconds: 900 } }))
      .toEqual({ trace_window_seconds: 120, blind_after_seconds: 300, hook_working_seconds: 120 });
    // The project may open the trace and hook windows, the same level `seats_cross_teams`
    // allows — but the blind threshold is liveness, and only ever tightens.
    expect(stateThresholds({ project: { blind_after_seconds: 7200, hook_working_seconds: 900 } }))
      .toEqual({ trace_window_seconds: 120, blind_after_seconds: 300, hook_working_seconds: 900 });
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
