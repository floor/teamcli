import { describe, expect, test } from 'bun:test';
import {
  initialProbePlan, resetProbePlan, reduceProbePlan, type ProbePlanState,
} from '../src/status/probe-plan.ts';

const context = { seatId: 'example-agent', incarnation: 'example-inc', mainTurn: 'example-turn', step: 'example-step' };
const eligibility = { human: false, protected: false, stopped: false, supportsCapture: true };
function input(seq: number, now: number, kind: string, extra: Record<string, unknown> = {}) {
  return { context, seq, now, kind, lane: 'main', eligibility, ...extra };
}
function fresh(now = 0): ProbePlanState {
  return resetProbePlan(initialProbePlan(), context, now).state;
}
function armed(now = 0): ProbePlanState {
  return reduceProbePlan(fresh(now), input(1, now, 'tool-start', { partialCoverage: true })).state;
}
function output(seq: number, now: number, outputSeq: number, extra: Record<string, unknown> = {}) {
  return input(seq, now, 'output', { outputSeq, mode: 'quiet', since: 0, partialCoverage: true, ...extra });
}

describe('pure delayed observation plan', () => {
  test('requires explicit complete context and caller transition for another step', () => {
    const empty = initialProbePlan();
    expect(reduceProbePlan(empty, input(1, 0, 'heartbeat')).reason).toBe('missing_context');
    for (const field of ['seatId', 'incarnation', 'mainTurn', 'step']) {
      const missing: Record<string, unknown> = { ...context };
      delete missing[field];
      expect(resetProbePlan(empty, missing, 0).state).toBe(empty);
      const state = armed();
      expect(reduceProbePlan(state, input(2, 1, 'completion', { context: { ...context, [field]: 'example-other' } })).state).toBe(state);
    }
    const state = armed();
    const nextContext = { ...context, step: 'example-next' };
    const reset = resetProbePlan(state, nextContext, 10);
    expect(reset.state.pending).toEqual([]);
    expect(reset.state.staggered).toBe(false);
    const next = reduceProbePlan(reset.state, input(1, 10, 'turn-stop', { context: nextContext, partialCoverage: true }));
    expect(next.state.pending.map((p) => p.dueAt)).toEqual([260, 1010, 3010]);
    expect(reduceProbePlan(next.state, input(2, 20, 'completion')).state).toBe(next.state);
  });

  test('consumes exact staggered boundaries once and preserves remaining deadlines', () => {
    let state = armed();
    expect(state.pending.map((p) => p.dueAt)).toEqual([250, 1000, 3000]);
    const early = reduceProbePlan(state, input(2, 249, 'consume'));
    expect(early.due).toEqual([]);
    state = early.state;
    let seq = 3;
    for (const time of [250, 1000, 3000]) {
      const due = reduceProbePlan(state, input(seq++, time, 'consume'));
      expect(due.due).toEqual([{ context, dueAt: time, causes: ['step'] }]);
      const repeated = reduceProbePlan(due.state, input(seq++, time, 'consume'));
      expect(repeated.due).toEqual([]);
      state = repeated.state;
    }
    expect(state.pending).toEqual([]);
    const duplicate = reduceProbePlan(state, input(seq++, 4000, 'tool-start', { partialCoverage: true }));
    expect(duplicate.state.pending).toEqual([]);
    expect(reduceProbePlan(duplicate.state, input(seq++, 4000, 'turn-stop', { partialCoverage: true })).state.pending).toEqual([]);
    expect(reduceProbePlan(duplicate.state, input(1, 0, 'tool-start', { partialCoverage: true })).state).toBe(duplicate.state);
  });

  test('late output after all staggered probes requests a debounced plan without live timers', () => {
    const step = reduceProbePlan(fresh(20000), input(1, 20000, 'turn-stop', { partialCoverage: true }));
    const consumed = reduceProbePlan(step.state, input(2, 23000, 'consume'));
    expect(consumed.due.map((p) => p.dueAt)).toEqual([20250, 21000, 23000]);
    expect(consumed.state.pending).toEqual([]);
    const later = reduceProbePlan(consumed.state, output(3, 28000, 1, { since: 20000 }));
    expect(later.state.pending).toEqual([{ dueAt: 28300, cause: 'output' }]);
    expect(reduceProbePlan(later.state, input(4, 28299, 'consume')).due).toEqual([]);
    expect(reduceProbePlan(later.state, input(4, 28300, 'consume')).due).toEqual([
      { context, dueAt: 28300, causes: ['output'] },
    ]);
  });

  test('exact quiet and partial-working thresholds depend on explicit current facts', () => {
    for (const [mode, partialCoverage, time, expected] of [
      ['quiet', false, 499, false], ['quiet', false, 500, true],
      ['working', true, 2999, false], ['working', true, 3000, true],
      ['working', false, 3000, false], ['unknown', true, 5000, false],
    ] as const) {
      const result = reduceProbePlan(fresh(), output(1, time, 1, { mode, partialCoverage }));
      expect(result.state.pending).toEqual(expected ? [{ dueAt: time + 300, cause: 'output' }] : []);
    }
    expect(reduceProbePlan(fresh(), output(1, 500, 0)).state.pending).toEqual([]);
    const under = reduceProbePlan(fresh(), output(1, 499, 1));
    expect(reduceProbePlan(under.state, output(2, 500, 1)).state.pending).toEqual([]);
  });

  test('repeated output coalesces without starvation and only an advance requests another probe', () => {
    let state = reduceProbePlan(fresh(), output(1, 500, 1)).state;
    for (let seq = 2; seq <= 100; seq++) {
      state = reduceProbePlan(state, output(seq, 500 + seq, seq)).state;
      expect(state.pending).toEqual([{ dueAt: 800, cause: 'output' }]);
    }
    const consumed = reduceProbePlan(state, input(101, 800, 'consume'));
    expect(consumed.due.map((p) => p.dueAt)).toEqual([800]);
    expect(reduceProbePlan(consumed.state, output(102, 900, 100)).state.pending).toEqual([]);
    expect(reduceProbePlan(consumed.state, output(102, 900, 101)).state.pending).toEqual([{ dueAt: 1200, cause: 'output' }]);
    expect(reduceProbePlan(consumed.state, output(102, 900, 99)).state).toBe(consumed.state);
  });

  test('coalesces coincident causes and keeps future deadlines', () => {
    let state = reduceProbePlan(armed(), input(2, 250, 'consume')).state;
    state = reduceProbePlan(state, output(3, 700, 1)).state;
    state = reduceProbePlan(state, input(4, 1000, 'classify')).state;
    const due = reduceProbePlan(state, input(5, 1000, 'consume'));
    expect(due.due).toEqual([{ context, dueAt: 1000, causes: ['classification', 'output', 'step'] }]);
    expect(due.state.pending).toEqual([{ dueAt: 3000, cause: 'step' }]);
    expect(reduceProbePlan(due.state, input(6, 1000, 'consume')).due).toEqual([]);
  });

  test('immediate classification requests retain the earliest outstanding deadline', () => {
    const first = reduceProbePlan(fresh(), input(1, 10, 'classify'));
    expect(first.due).toEqual([]);
    expect(first.state.pending).toEqual([{ dueAt: 10, cause: 'classification' }]);
    const repeated = reduceProbePlan(first.state, input(2, 20, 'classify'));
    expect(repeated.state.pending).toEqual(first.state.pending);
    expect(reduceProbePlan(repeated.state, input(3, 20, 'consume')).due).toEqual([
      { context, dueAt: 10, causes: ['classification'] },
    ]);
  });

  test('only correlated completion or permission-clear retires and cancels a step', () => {
    for (const kind of ['completion', 'permission-clear']) {
      const result = reduceProbePlan(armed(), input(2, 50, kind));
      expect(result.state.pending).toEqual([]);
      expect(result.state.completed).toBe(true);
      expect(reduceProbePlan(result.state, input(3, 60, 'tool-start', { partialCoverage: true })).state.pending).toEqual([]);
      expect(reduceProbePlan(result.state, output(3, 5000, 1)).state.pending).toEqual([]);
      expect(reduceProbePlan(result.state, input(3, 60, 'classify')).state.pending).toEqual([]);
    }
    let state = armed();
    for (const kind of ['heartbeat', 'other']) {
      const next = reduceProbePlan(state, input(state.lastSeq + 1, 100, kind));
      expect(next.state.pending).toEqual(state.pending);
      state = next.state;
    }
    const subagent = reduceProbePlan(state, input(100, 5000, 'completion', { lane: 'subagent', eligibility: undefined }));
    expect(subagent.state.pending).toEqual(state.pending);
    expect(subagent.state.completed).toBe(false);
    const foreign = reduceProbePlan(state, input(100, 5000, 'completion', { context: { ...context, step: 'example-unrelated' } }));
    expect(foreign.state).toBe(state);
    expect(reduceProbePlan(fresh(), input(1, 0, 'tool-start', { partialCoverage: false })).state.pending).toEqual([]);
  });

  test('a correlated subagent preserves probes but fences older main sequence/time input', () => {
    const state = armed();
    const subagent = reduceProbePlan(state, input(3, 200, 'other', { lane: 'subagent', eligibility: undefined }));
    expect(subagent.state.pending).toEqual(state.pending);
    expect(subagent.state.lastSeq).toBe(3);
    expect(subagent.state.now).toBe(200);
    expect(reduceProbePlan(subagent.state, input(2, 250, 'completion')).state).toBe(subagent.state);
    expect(reduceProbePlan(subagent.state, input(4, 199, 'completion')).state).toBe(subagent.state);
    expect(reduceProbePlan(subagent.state, input(4, 250, 'consume')).due).toEqual([
      { context, dueAt: 250, causes: ['step'] },
    ]);
  });

  test('human, protected, stopped, unsupported or missing eligibility cancels and never emits', () => {
    const denied = [undefined, {}, { ...eligibility, human: true }, { ...eligibility, protected: true },
      { ...eligibility, stopped: true }, { ...eligibility, supportsCapture: false }];
    for (const value of denied) {
      for (const kind of ['classify', 'consume', 'heartbeat', 'tool-start']) {
        const extra = { eligibility: value, ...(kind === 'tool-start' ? { partialCoverage: true } : {}) };
        const result = reduceProbePlan(armed(), input(2, 4000, kind, extra));
        expect(result.reason).toBe('ineligible');
        expect(result.state.pending).toEqual([]);
        expect(result.due).toEqual([]);
        expect(reduceProbePlan(result.state, input(3, 5000, 'tool-start', { partialCoverage: true })).state.pending).toEqual([]);
      }
    }
    expect(reduceProbePlan(fresh(), input(1, 0, 'classify', { eligibility: undefined })).state.pending).toEqual([]);
  });

  test('explicit context reset cancels without same-step rearming or stale-incarnation work', () => {
    const state = armed();
    const same = resetProbePlan(state, context, 100);
    expect(same.state.pending).toEqual([]);
    expect(same.state.lastSeq).toBe(state.lastSeq);
    expect(reduceProbePlan(same.state, input(2, 100, 'tool-start', { partialCoverage: true })).state.pending).toEqual([]);
    const nextContext = { ...context, incarnation: 'example-next-inc' };
    const reset = resetProbePlan(state, nextContext, 100);
    expect(reset.state.pending).toEqual([]);
    expect(reset.state.lastSeq).toBe(0);
    expect(reduceProbePlan(reset.state, input(2, 200, 'classify')).state).toBe(reset.state);
    expect(resetProbePlan(reset.state, context, 99).state).toBe(reset.state);
  });

  test('rejects invalid, regressing and unsafe times/sequences without changing the plan', () => {
    const state = armed(100);
    const invalid: unknown[] = [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '200', null, true, {}];
    for (const value of invalid) {
      expect(reduceProbePlan(state, input(2, 200, 'heartbeat', { now: value })).state).toBe(state);
      expect(reduceProbePlan(state, input(2, 200, 'heartbeat', { seq: value })).state).toBe(state);
      expect(resetProbePlan(state, context, value).state).toBe(state);
      expect(reduceProbePlan(state, output(2, 5000, 1, { since: value })).state).toBe(state);
      expect(reduceProbePlan(state, output(2, 5000, 1, { outputSeq: value })).state).toBe(state);
    }
    for (const value of [0, 1]) expect(reduceProbePlan(state, input(value, 100, 'classify')).state).toBe(state);
    expect(reduceProbePlan(state, input(2, 99, 'classify')).state).toBe(state);
    expect(reduceProbePlan(state, output(2, 200, 1, { since: 201 })).state).toBe(state);
    expect(reduceProbePlan(state, output(2, 200, 1, { since: 0 })).state).toBe(state);
    const fact = reduceProbePlan(state, output(2, 200, 1, { since: 150 }));
    expect(reduceProbePlan(fact.state, output(3, 1000, 2, { since: 149 })).state).toBe(fact.state);
  });

  test('safe deadline arithmetic refuses atomically and allows the exact upper boundary', () => {
    const state = fresh();
    expect(reduceProbePlan(state, input(1, Number.MAX_SAFE_INTEGER - 2999, 'tool-start', { partialCoverage: true })).state).toBe(state);
    const limit = reduceProbePlan(state, input(1, Number.MAX_SAFE_INTEGER - 3000, 'tool-start', { partialCoverage: true }));
    expect(limit.state.pending.at(-1)?.dueAt).toBe(Number.MAX_SAFE_INTEGER);
    expect(reduceProbePlan(state, output(1, Number.MAX_SAFE_INTEGER - 299, 1)).state).toBe(state);
    const outputLimit = reduceProbePlan(state, output(1, Number.MAX_SAFE_INTEGER - 300, 1));
    expect(outputLimit.state.pending[0]?.dueAt).toBe(Number.MAX_SAFE_INTEGER);
    const early = reduceProbePlan(state, output(1, 500, 1));
    expect(reduceProbePlan(early.state, output(2, Number.MAX_SAFE_INTEGER, 2)).state.pending).toEqual(early.state.pending);
    const immediate = reduceProbePlan(state, input(1, Number.MAX_SAFE_INTEGER, 'classify'));
    expect(reduceProbePlan(immediate.state, input(2, Number.MAX_SAFE_INTEGER, 'consume')).due[0]?.dueAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('strict closed shapes refuse accessors, raw payload and thrown inspection messages', () => {
    const state = armed();
    let reads = 0;
    const accessor = Object.defineProperty(input(2, 1, 'heartbeat'), 'now', { get() { reads++; throw Error('example-private-error'); } });
    const proxy = new Proxy({}, { ownKeys() { throw Error('example-private-error'); } });
    const hidden = Object.defineProperty(input(2, 1, 'heartbeat'), 'raw', { value: 'example-private-text' });
    for (const value of [null, [], {}, accessor, proxy, hidden,
      input(2, 1, 'heartbeat', { raw: 'example-private-text' }),
      input(2, 1, 'heartbeat', { [Symbol('example')]: 'example-private-text' }),
      input(2, 1, 'heartbeat', { partialCoverage: true }),
      input(2, 1, 'unknown-provider-event'),
      input(2, 1, 'classify', { eligibility: { ...eligibility, human: 'false' } }),
      input(2, 1, 'classify', { context: { ...context, step: 'example\n' } }),
    ]) {
      const result = reduceProbePlan(state, value);
      expect(result.state).toBe(state);
      expect(result.due).toEqual([]);
      expect(result.reason).toBe('malformed');
      expect(JSON.stringify({ reason: result.reason, accepted: result.accepted })).not.toContain('example-private');
    }
    expect(reads).toBe(0);
    expect(resetProbePlan(state, proxy, 10).reason).toBe('malformed');
  });

  test('bounds pending work/output and deeply freezes results without mutating input', () => {
    let state = armed();
    const event = Object.freeze(output(2, 500, 1));
    const before = JSON.stringify({ state, event });
    const planned = reduceProbePlan(state, event);
    expect(JSON.stringify({ state, event })).toBe(before);
    state = reduceProbePlan(planned.state, input(3, 600, 'classify')).state;
    expect(state.pending).toHaveLength(5);
    for (let seq = 4; seq < 100; seq++) {
      state = reduceProbePlan(state, input(seq, 600, 'classify')).state;
      expect(state.pending).toHaveLength(5);
    }
    const due = reduceProbePlan(state, input(100, 3000, 'consume'));
    expect(due.due).toHaveLength(5);
    expect(due.state.pending).toEqual([]);
    for (const value of [due, due.state, due.state.context, due.state.pending, due.due,
      state, state.context, state.pending, ...state.pending,
      ...due.due, ...due.due.map((probe) => probe.context), ...due.due.map((probe) => probe.causes)]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Reflect.set(due.state, 'now', 0)).toBe(false);
    expect(Reflect.set(due.due[0]!, 'dueAt', 0)).toBe(false);
    expect(Object.keys(due.due[0]!).sort()).toEqual(['causes', 'context', 'dueAt']);
    expect(reduceProbePlan(due.state, input(101, 3000, 'consume')).due).toEqual([]);
  });
});
