// Synthetic transitions for the native observation candidate. Tokens are fixtures. Nothing here
// reads a session, a clock, or a credential. The naïve helper is a labelled control, not a
// description of any deployed mapping.
import { describe, expect, test } from 'bun:test';
import {
  establishContext,
  initialNativeCandidate,
  reduceNativeObservation,
  resyncSequence,
  resetIncarnation,
  type NativeCandidateState,
  type NativeKind,
} from '../src/status/native-observation.ts';

const CONTEXT = { seatId: 'id-a', incarnation: 'inc-a', mainTurn: 'turn-a' };

function observation(seq: number, kind: NativeKind, extra: Record<string, unknown> = {}) {
  return {
    source: 'native',
    seq,
    kind,
    seatId: 'id-a',
    incarnation: 'inc-a',
    mainTurn: 'turn-a',
    lane: 'main',
    ...extra,
  };
}

function opened(): NativeCandidateState {
  const established = establishContext(initialNativeCandidate(), CONTEXT);
  const reduced = reduceNativeObservation(established.state, observation(1, 'permission-gate', {
    toolId: 'tool-a',
    gateId: 'gate-a',
    binding: 'bind-a',
  }));
  return reduced.state;
}

function clearOf(seq: number, extra: Record<string, unknown> = {}) {
  return observation(seq, 'permission-clear', {
    toolId: 'tool-a',
    gateId: 'gate-a',
    binding: 'bind-a',
    ...extra,
  });
}

/** Synthetic control: treats tool-start as permission to close the open main gate. */
function naiveClearOnToolStart(state: NativeCandidateState): NativeCandidateState {
  if (state.gate === null) return state;
  return {
    context: state.context,
    lastSeq: state.lastSeq,
    continuity: state.continuity,
    gate: null,
    advisory: 'working',
    processConfirmation: state.processConfirmation,
  };
}

function survives(state: NativeCandidateState): boolean {
  return state.gate?.gateId === 'gate-a' && state.gate.ownerRequired === true;
}

describe('native observation candidate', () => {
  test('establishes context once and refuses a missing context', () => {
    const initial = initialNativeCandidate();
    const bad = establishContext(initial, { seatId: 'id-a' });
    expect(bad.state).toBe(initial);
    expect(bad.outcome.reason).toBe('malformed');
    const established = establishContext(initial, CONTEXT);
    expect(established.outcome).toEqual({ accepted: false, applied: true, reason: 'established' });
    expect(established.state.context).toEqual(CONTEXT);
    const again = establishContext(established.state, CONTEXT);
    expect(again.state).toBe(established.state);
    expect(again.outcome.reason).toBe('unsupported');
    const early = reduceNativeObservation(initial, observation(1, 'heartbeat'));
    expect(early.state).toBe(initial);
    expect(early.outcome.reason).toBe('missing_context');
  });

  test('the literal token bad opens a gate and clears it in each correlation field', () => {
    for (const field of ['toolId', 'gateId', 'binding'] as const) {
      const ids = { toolId: 'tool-a', gateId: 'gate-a', binding: 'bind-a', [field]: 'bad' };
      const state = establishContext(initialNativeCandidate(), CONTEXT).state;
      const opened = reduceNativeObservation(state, observation(1, 'permission-gate', ids));
      expect(opened.outcome.reason).toBe('gate_opened');
      expect(opened.state.gate?.[field]).toBe('bad');
      const cleared = reduceNativeObservation(opened.state, observation(2, 'permission-clear', ids));
      expect(cleared.outcome.reason).toBe('gate_cleared');
      expect(cleared.state.gate).toBeNull();
    }
    const state = establishContext(initialNativeCandidate(), CONTEXT).state;
    const empty = reduceNativeObservation(state, observation(1, 'permission-gate', {
      toolId: '',
      gateId: 'gate-a',
      binding: 'bind-a',
    }));
    expect(empty.state).toBe(state);
    expect(empty.outcome.reason).toBe('malformed');
  });

  test('opens one owner-required gate and ignores a false owner flag', () => {
    const state = establishContext(initialNativeCandidate(), CONTEXT).state;
    const reduced = reduceNativeObservation(state, observation(1, 'permission-gate', {
      toolId: 'tool-a',
      gateId: 'gate-a',
      binding: 'bind-a',
      ownerRequired: false,
    }));
    expect(reduced.outcome.reason).toBe('owner_required_preserved');
    expect(reduced.state.gate).toEqual({
      gateId: 'gate-a',
      toolId: 'tool-a',
      mainTurn: 'turn-a',
      binding: 'bind-a',
      ownerRequired: true,
    });
    expect(reduced.state.advisory).toBe('gated');
  });

  test('keeps the first gate when a second gate is ambiguous', () => {
    const state = opened();
    const second = reduceNativeObservation(state, observation(2, 'permission-gate', {
      toolId: 'tool-b',
      gateId: 'gate-b',
      binding: 'bind-b',
    }));
    expect(second.outcome).toEqual({ accepted: true, applied: false, reason: 'ambiguous_gate' });
    expect(survives(second.state)).toBe(true);
    const sameId = reduceNativeObservation(second.state, observation(3, 'permission-gate', {
      toolId: 'tool-b',
      gateId: 'gate-a',
      binding: 'bind-a',
    }));
    expect(sameId.outcome.reason).toBe('ambiguous_gate');
    expect(sameId.state.gate?.toolId).toBe('tool-a');
  });

  test('synthetic control: a naïve tool-start clear fails the invariant the reducer holds', () => {
    const state = opened();
    const started = observation(2, 'tool-start', { toolId: 'tool-b' });
    const naive = naiveClearOnToolStart(state);
    const real = reduceNativeObservation(state, started);
    expect(survives(naive)).toBe(false);
    expect(real.outcome.reason).toBe('gate_preserved');
    expect(survives(real.state)).toBe(true);
    expect(real.state.advisory).toBe('gated');
  });

  test('does not clear on subagent activity, unrelated completion, or a mismatched correlation', () => {
    const state = opened();
    const cases: Record<string, unknown>[] = [
      observation(2, 'tool-start', { lane: 'subagent', toolId: 'tool-a' }),
      observation(2, 'tool-end', { lane: 'subagent', toolId: 'tool-a', gateId: 'gate-a', binding: 'bind-a' }),
      observation(2, 'subagent', { lane: 'subagent', toolId: 'tool-a', gateId: 'gate-a', binding: 'bind-a' }),
      observation(2, 'tool-end', { toolId: 'tool-b', gateId: 'gate-a', binding: 'bind-a' }),
      clearOf(2, { mainTurn: 'turn-b' }),
      clearOf(2, { gateId: 'gate-b' }),
      clearOf(2, { binding: 'bind-b' }),
      clearOf(2, { seatId: 'id-b' }),
    ];
    for (const input of cases) {
      const reduced = reduceNativeObservation(state, input);
      expect(survives(reduced.state)).toBe(true);
      if (input.seatId === 'id-b') {
        expect(reduced.state).toBe(state);
        expect(reduced.outcome.reason).toBe('context_mismatch');
      }
    }
    const missingGate = reduceNativeObservation(state, observation(2, 'turn-end', { binding: 'bind-a' }));
    expect(missingGate.outcome.reason).toBe('correlation_mismatch');
    expect(survives(missingGate.state)).toBe(true);
  });

  test('closes only a fully correlated main-thread clear, tool-end, or turn-end', () => {
    const byClear = reduceNativeObservation(opened(), clearOf(2));
    const byTool = reduceNativeObservation(opened(), observation(2, 'tool-end', {
      toolId: 'tool-a',
      gateId: 'gate-a',
      binding: 'bind-a',
    }));
    const byTurn = reduceNativeObservation(opened(), observation(2, 'turn-end', {
      gateId: 'gate-a',
      binding: 'bind-a',
    }));
    for (const reduced of [byClear, byTool, byTurn]) {
      expect(reduced.outcome.reason).toBe('gate_cleared');
      expect(reduced.state.gate).toBeNull();
      expect(reduced.state.advisory).toBe('unknown');
      expect(Object.keys(reduced.outcome).sort()).toEqual(['accepted', 'applied', 'reason']);
      expect(JSON.stringify(reduced.state)).not.toContain('done');
      expect(JSON.stringify(reduced.state)).not.toContain('idle');
      expect(JSON.stringify(reduced.outcome)).not.toContain('author');
    }
  });

  test('rejects duplicate, late, and gapped sequences without applying a skipped clear', () => {
    const state = opened();
    const duplicate = reduceNativeObservation(state, observation(1, 'permission-clear', {
      toolId: 'tool-a',
      gateId: 'gate-a',
      binding: 'bind-a',
    }));
    expect(duplicate.state).toBe(state);
    expect(duplicate.outcome.reason).toBe('duplicate_sequence');
    const gap = reduceNativeObservation(state, clearOf(3));
    expect(gap.outcome.reason).toBe('sequence_gap');
    expect(gap.state.continuity).toBe('unproven');
    expect(gap.state.lastSeq).toBe(1);
    expect(survives(gap.state)).toBe(true);
    const filled = reduceNativeObservation(gap.state, observation(2, 'tool-start'));
    expect(filled.outcome.reason).toBe('gate_preserved');
    expect(filled.state.continuity).toBe('proven');
    expect(filled.state.lastSeq).toBe(2);
    expect(survives(filled.state)).toBe(true);
    const late = reduceNativeObservation(filled.state, clearOf(1));
    expect(late.state).toBe(filled.state);
    expect(late.outcome.reason).toBe('late_sequence');
    const cleared = reduceNativeObservation(filled.state, clearOf(3));
    expect(cleared.outcome.reason).toBe('gate_cleared');
  });

  test('resynchronizes only as an explicit caller action and does not apply the skipped clear', () => {
    const state = opened();
    const gap = reduceNativeObservation(state, clearOf(4));
    expect(survives(gap.state)).toBe(true);
    const premature = resyncSequence(state, 4);
    expect(premature.state).toBe(state);
    expect(premature.outcome.reason).toBe('unsupported');
    const resynced = resyncSequence(gap.state, 4);
    expect(resynced.outcome.reason).toBe('sequence_resynced');
    expect(resynced.state.lastSeq).toBe(4);
    expect(resynced.state.continuity).toBe('proven');
    expect(survives(resynced.state)).toBe(true);
    const cleared = reduceNativeObservation(resynced.state, clearOf(5));
    expect(cleared.outcome.reason).toBe('gate_cleared');
    expect(cleared.state.lastSeq).toBe(5);
  });

  test('preserves a quiet reading and an open gate across heartbeat and generic advisory input', () => {
    const quiet = reduceNativeObservation(establishContext(initialNativeCandidate(), CONTEXT).state, observation(1, 'quiet'));
    expect(quiet.outcome.reason).toBe('quiet_preserved');
    expect(quiet.state.advisory).toBe('quiet');
    const beat = reduceNativeObservation(quiet.state, observation(2, 'heartbeat'));
    expect(beat.outcome.reason).toBe('heartbeat_preserved');
    expect(beat.state.advisory).toBe('quiet');
    expect(beat.state.gate).toBeNull();
    const timed = reduceNativeObservation(beat.state, { ...observation(3, 'quiet'), observedAt: '2026-01-01T00:00:00Z' });
    expect(timed.state).toBe(beat.state);
    expect(timed.outcome.reason).toBe('malformed');
    const gated = reduceNativeObservation(opened(), observation(2, 'heartbeat', { ownerRequired: false }));
    expect(gated.outcome.reason).toBe('owner_required_preserved');
    expect(gated.state.gate?.ownerRequired).toBe(true);
    const still = reduceNativeObservation(gated.state, observation(3, 'candidate-state', { advisory: 'working' }));
    expect(still.outcome.reason).toBe('advisory_ignored');
    expect(still.state.advisory).toBe('gated');
    const named = reduceNativeObservation(still.state, observation(4, 'quiet'));
    expect(named.outcome.reason).toBe('quiet_preserved');
    expect(survives(named.state)).toBe(true);
  });

  test('session-end asks for process confirmation and never becomes done or idle', () => {
    const quiet = reduceNativeObservation(establishContext(initialNativeCandidate(), CONTEXT).state, observation(1, 'quiet'));
    const ended = reduceNativeObservation(quiet.state, observation(2, 'session-end'));
    expect(ended.outcome.reason).toBe('session_end_unconfirmed');
    expect(ended.state.processConfirmation).toBe('needed');
    expect(ended.state.advisory).toBe('unknown');
    expect(JSON.stringify(ended.state)).not.toContain('done');
    expect(JSON.stringify(ended.state)).not.toContain('idle');
    const gated = reduceNativeObservation(opened(), observation(2, 'session-end', { lane: 'subagent' }));
    expect(gated.outcome.reason).toBe('subagent_ignored');
    expect(survives(gated.state)).toBe(true);
    expect(gated.state.processConfirmation).toBe('not_requested');
    const main = reduceNativeObservation(gated.state, observation(3, 'session-end'));
    expect(main.state.processConfirmation).toBe('needed');
    expect(survives(main.state)).toBe(true);
    expect(main.state.advisory).toBe('gated');
  });

  test('refuses malformed and unsupported shapes without throwing or changing state', () => {
    const state = opened();
    const inputs: unknown[] = [
      null,
      [],
      observation(2, 'heartbeat', { seq: '2' }),
      observation(2, 'candidate-state'),
      observation(2, 'candidate-state', { advisory: 'idle' }),
      observation(2, 'heartbeat', { seatId: '' }),
      observation(2, 'tool-start', { advisory: 'working' }),
      { ...observation(2, 'heartbeat'), source: 'host' },
      { ...observation(2, 'heartbeat'), kind: 'done' },
    ];
    for (const input of inputs) {
      expect(() => reduceNativeObservation(state, input)).not.toThrow();
      const reduced = reduceNativeObservation(state, input);
      expect(reduced.state).toBe(state);
      expect(reduced.outcome.applied).toBe(false);
      expect(['malformed', 'unsupported']).toContain(reduced.outcome.reason);
    }
    const host = reduceNativeObservation(state, { ...observation(2, 'heartbeat'), source: 'host' });
    expect(host.outcome.reason).toBe('unsupported');
    const done = reduceNativeObservation(state, { ...observation(2, 'heartbeat'), kind: 'done' });
    expect(done.outcome.reason).toBe('unsupported');
  });

  test('leaves its inputs unchanged', () => {
    const state = opened();
    const snapshot = structuredClone(state);
    const input = clearOf(2);
    Object.freeze(input);
    Object.freeze(state.context);
    Object.freeze(state.gate);
    const reduced = reduceNativeObservation(state, input);
    expect(state.context).toEqual(snapshot.context);
    expect(state.gate).toEqual(snapshot.gate);
    expect(state.lastSeq).toBe(1);
    expect(reduced.state).not.toBe(state);
    expect(reduced.state.gate).toBeNull();
  });

  test('resets incarnation only when the caller asks, and a foreign token updates nothing', () => {
    const state = opened();
    const foreign = reduceNativeObservation(state, observation(2, 'session-end', { incarnation: 'inc-b' }));
    expect(foreign.state).toBe(state);
    expect(foreign.outcome.reason).toBe('context_mismatch');
    const same = resetIncarnation(state, { ...CONTEXT, mainTurn: 'turn-b' });
    expect(same.state).toBe(state);
    expect(same.outcome.reason).toBe('unsupported');
    const otherSeat = resetIncarnation(state, { ...CONTEXT, seatId: 'id-b', incarnation: 'inc-b' });
    expect(otherSeat.state).toBe(state);
    expect(otherSeat.outcome.reason).toBe('context_mismatch');
    const reset = resetIncarnation(state, { seatId: 'id-a', incarnation: 'inc-b', mainTurn: 'turn-b' });
    expect(reset.outcome.reason).toBe('incarnation_reset');
    expect(reset.state.gate).toBeNull();
    expect(reset.state.lastSeq).toBeNull();
    expect(reset.state.advisory).toBe('unknown');
    expect(reset.state.processConfirmation).toBe('not_requested');
    const stale = reduceNativeObservation(reset.state, observation(1, 'permission-clear', {
      toolId: 'tool-a',
      gateId: 'gate-a',
      binding: 'bind-a',
    }));
    expect(stale.state).toBe(reset.state);
    expect(stale.outcome.reason).toBe('context_mismatch');
  });
});
