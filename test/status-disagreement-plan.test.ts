import { describe, expect, test } from 'bun:test';
import {
  initialDisagreementPlan, resetDisagreementPlan, observeDisagreementPlan,
  type DisagreementWord,
} from '../src/status/disagreement-plan.ts';

const context = { seatId: 'example-agent', incarnation: 'example-inc' };
const winner = { source: 'native', word: 'working', healthy: true, current: true };
const other = { source: 'screen', word: 'blocked', healthy: true, current: true };
function fresh(now = 0) { return resetDisagreementPlan(initialDisagreementPlan(), context, now).state; }
function sample(seq: number, now: number, extra: Record<string, unknown> = {}) {
  return { context, seq, now, winner, other, ...extra };
}
function started(now = 0) { return observeDisagreementPlan(fresh(), sample(1, now)).state; }

describe('sampled disagreement diagnostic plan', () => {
  test('settles below, exactly at, and above two seconds only on fresh eligible observations', () => {
    for (const [time, emitted] of [[1999, false], [2000, true], [2001, true]] as const) {
      const state = started();
      const result = observeDisagreementPlan(state, sample(2, time));
      expect(result.diagnostic !== null).toBe(emitted);
      expect(result.state.active?.since).toBe(0);
      expect(result.reason).toBe(emitted ? 'conflict_reported' : 'conflict_pending');
      if (emitted) expect(result.diagnostic).toEqual({
        context, winner: { source: 'native', word: 'working' },
        other: { source: 'screen', word: 'blocked' }, since: 0, at: time,
      });
    }
    const state = started(100);
    expect(observeDisagreementPlan(state, sample(2, 2099)).diagnostic).toBeNull();
    expect(observeDisagreementPlan(state, sample(2, 2100)).diagnostic?.since).toBe(100);
    expect(observeDisagreementPlan(state, { context, seq: 2, now: 5000, kind: 'tick' }).state).toBe(state);
    expect(state.active?.emitted).toBe(false);
  });

  test('repeated conflict preserves original start and emits once without accumulating history', () => {
    let state = started();
    for (let seq = 2; seq <= 20; seq++) {
      const result = observeDisagreementPlan(state, sample(seq, seq * 90));
      expect(result.state.active?.since).toBe(0);
      expect(result.diagnostic).toBeNull();
      state = result.state;
    }
    let result = observeDisagreementPlan(state, sample(21, 2000));
    expect(result.diagnostic).not.toBeNull();
    state = result.state;
    for (let seq = 22; seq < 1000; seq++) {
      result = observeDisagreementPlan(state, sample(seq, seq * 100));
      expect(result.reason).toBe('conflict_suppressed');
      expect(result.diagnostic).toBeNull();
      expect(Object.keys(result.state)).toHaveLength(4);
      expect(Object.keys(result.state.active!)).toHaveLength(3);
      state = result.state;
    }
    expect(state.active?.since).toBe(0);
    expect(state.active?.emitted).toBe(true);
  });

  test('agreement and explicit missing/unhealthy/noncurrent samples break continuity', () => {
    const breaks = [
      { winner: null }, { other: null }, { winner: null, other: null },
      { winner: { ...winner, healthy: false } }, { winner: { ...winner, current: false } },
      { other: { ...other, healthy: false } }, { other: { ...other, current: false } },
      { other: { ...other, word: winner.word } },
    ];
    for (const extra of breaks) {
      const state = observeDisagreementPlan(started(), sample(2, 2000)).state;
      const broken = observeDisagreementPlan(state, sample(3, 2100, extra));
      expect(broken.accepted).toBe(true);
      expect(broken.state.active).toBeNull();
      expect(broken.diagnostic).toBeNull();
      const restarted = observeDisagreementPlan(broken.state, sample(4, 2200));
      expect(restarted.state.active?.since).toBe(2200);
      expect(restarted.diagnostic).toBeNull();
      expect(observeDisagreementPlan(restarted.state, sample(5, 4199)).diagnostic).toBeNull();
      expect(observeDisagreementPlan(restarted.state, sample(5, 4200)).diagnostic).not.toBeNull();
    }
  });

  test('changed ordered sources, winner role or normalized words start a new interval', () => {
    const changes = [
      { winner: { ...winner, source: 'host' } },
      { other: { ...other, source: 'host' } },
      { winner: other, other: winner },
      { winner: { ...winner, word: 'quiet' } },
      { other: { ...other, word: 'gated' } },
    ];
    for (const extra of changes) {
      const changed = observeDisagreementPlan(started(), sample(2, 1999, extra));
      expect(changed.reason).toBe('conflict_started');
      expect(changed.state.active?.since).toBe(1999);
      expect(observeDisagreementPlan(changed.state, sample(3, 2000, extra)).diagnostic).toBeNull();
      const settled = observeDisagreementPlan(changed.state, sample(3, 3999, extra));
      expect(settled.diagnostic).not.toBeNull();
      const oldReturns = observeDisagreementPlan(settled.state, sample(4, 4000));
      expect(oldReturns.reason).toBe('conflict_started');
      expect(oldReturns.state.active?.since).toBe(4000);
    }
  });

  test('caller-selected winner remains explicit, with no hardcoded source priority or word mapping', () => {
    for (const source of ['native', 'host', 'screen'] as const) {
      for (const second of ['native', 'host', 'screen'] as const) {
        if (source === second) continue;
        const extra = { winner: { ...winner, source }, other: { ...other, source: second } };
        const state = observeDisagreementPlan(fresh(), sample(1, 0, extra)).state;
        expect(observeDisagreementPlan(state, sample(2, 2000, extra)).diagnostic?.winner.source).toBe(source);
      }
    }
    const words: DisagreementWord[] = ['working', 'quiet', 'gated', 'blocked', 'unknown', 'unreachable', 'exited'];
    for (const word of words) {
      const extra = { winner: { ...winner, word }, other: { ...other, word: word === 'quiet' ? 'working' : 'quiet' } };
      const state = observeDisagreementPlan(fresh(), sample(1, 0, extra)).state;
      expect(observeDisagreementPlan(state, sample(2, 2000, extra)).diagnostic?.winner.word).toBe(word);
      expect(observeDisagreementPlan(state, sample(2, 2000, { other: { ...other, word }, winner: { ...winner, word } })).reason).toBe('agreement');
    }
  });

  test('same-source pairs refuse atomically even when unhealthy or agreeing', () => {
    const state = started();
    for (const changedOther of [{ ...other, source: winner.source }, { ...winner }, { ...winner, healthy: false }]) {
      const result = observeDisagreementPlan(state, sample(2, 2000, { other: changedOther }));
      expect(result.reason).toBe('same_source');
      expect(result.state).toBe(state);
      expect(result.diagnostic).toBeNull();
    }
    expect(observeDisagreementPlan(state, sample(2, 2000)).diagnostic).not.toBeNull();
  });

  test('stale, foreign and regressing samples neither clear nor extend the interval', () => {
    const state = observeDisagreementPlan(started(), sample(2, 1000)).state;
    for (const value of [
      sample(1, 9000, { winner: null }), sample(2, 9000, { other: null }),
      sample(3, 999, { other: null }),
      sample(3, 9000, { context: { ...context, incarnation: 'example-old-inc' }, winner: null }),
      sample(3, 9000, { context: { ...context, seatId: 'example-other-agent' }, winner: null }),
    ]) {
      const result = observeDisagreementPlan(state, value);
      expect(result.state).toBe(state);
      expect(result.diagnostic).toBeNull();
    }
    const resumed = observeDisagreementPlan(state, sample(10, 2000));
    expect(resumed.diagnostic?.since).toBe(0);
    expect(resumed.state.lastSeq).toBe(10);
  });

  test('only explicit context reset changes incarnation and clears settling under monotonic time', () => {
    const empty = initialDisagreementPlan();
    expect(observeDisagreementPlan(empty, sample(1, 0)).reason).toBe('missing_context');
    const state = observeDisagreementPlan(started(), sample(2, 2000)).state;
    const same = resetDisagreementPlan(state, context, 2000);
    expect(same.state.active).toBeNull();
    expect(same.state.lastSeq).toBe(2);
    expect(observeDisagreementPlan(same.state, sample(2, 2000)).state).toBe(same.state);
    const nextContext = { ...context, incarnation: 'example-next-inc' };
    const reset = resetDisagreementPlan(state, nextContext, 2000);
    expect(reset.state.active).toBeNull();
    expect(reset.state.lastSeq).toBe(0);
    expect(observeDisagreementPlan(reset.state, sample(3, 3000)).state).toBe(reset.state);
    const current = observeDisagreementPlan(reset.state, sample(1, 3000, { context: nextContext }));
    expect(current.state.active?.since).toBe(3000);
    expect(resetDisagreementPlan(current.state, context, 2999).state).toBe(current.state);
    expect(resetDisagreementPlan(state, { seatId: 'example-agent' }, 2000).state).toBe(state);
  });

  test('safe arithmetic accepts exact deadline limit and refuses overflow without advancing', () => {
    const state = fresh();
    const tooLate = observeDisagreementPlan(state, sample(1, Number.MAX_SAFE_INTEGER - 1999));
    expect(tooLate.reason).toBe('overflow');
    expect(tooLate.state).toBe(state);
    const boundary = observeDisagreementPlan(state, sample(1, Number.MAX_SAFE_INTEGER - 2000));
    expect(boundary.reason).toBe('conflict_started');
    const settled = observeDisagreementPlan(boundary.state, sample(2, Number.MAX_SAFE_INTEGER));
    expect(settled.diagnostic?.at).toBe(Number.MAX_SAFE_INTEGER);
    expect(observeDisagreementPlan(settled.state, sample(3, Number.MAX_SAFE_INTEGER)).diagnostic).toBeNull();
    expect(observeDisagreementPlan(state, sample(1, Number.MAX_SAFE_INTEGER, { winner: null })).reason).toBe('unavailable');
    const changed = sample(2, Number.MAX_SAFE_INTEGER, { other: { ...other, word: 'quiet' } });
    expect(observeDisagreementPlan(boundary.state, changed).state).toBe(boundary.state);
  });

  test('rejects malformed numeric/context/reading input without coercion or continuity changes', () => {
    const state = started();
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2000', null, true, {}, 1n]) {
      expect(observeDisagreementPlan(state, sample(2, 2000, { now: value })).state).toBe(state);
      expect(observeDisagreementPlan(state, sample(2, 2000, { seq: value })).state).toBe(state);
      expect(resetDisagreementPlan(state, context, value).state).toBe(state);
    }
    expect(observeDisagreementPlan(state, sample(0, 2000)).state).toBe(state);
    for (const value of [undefined, {}, { ...winner, word: 'idle' }, { ...winner, source: 'example-provider' },
      { ...winner, healthy: 'true' }, { ...winner, current: undefined },
      { ...winner, prompt: 'permission' }, { ...winner, rawText: 'example-private-text' }]) {
      expect(observeDisagreementPlan(state, sample(2, 2000, { winner: value })).state).toBe(state);
    }
    for (const invalid of [{}, { ...context, seatId: '' }, { ...context, incarnation: 'x'.repeat(65) },
      { ...context, seatId: 'example\n' }, { ...context, extra: 'example-private-text' }]) {
      expect(observeDisagreementPlan(state, sample(2, 2000, { context: invalid })).state).toBe(state);
    }
    const valid = { seatId: 'bad', incarnation: 'x'.repeat(64) };
    expect(resetDisagreementPlan(state, valid, 0).reason).toBe('context_reset');
  });

  test('unknown shapes, accessors and inspection exceptions refuse without raw diagnostics', () => {
    const state = started();
    let reads = 0;
    const accessor = Object.defineProperty(sample(2, 2000), 'winner', { get() { reads++; throw Error('example-private-error'); } });
    const proxy = new Proxy({}, { ownKeys() { throw Error('example-private-error'); } });
    const hidden = Object.defineProperty(sample(2, 2000), 'raw', { value: 'example-private-text' });
    for (const value of [null, [], {}, new Date(0), Object.create(sample(2, 2000)), accessor, proxy, hidden,
      sample(2, 2000, { [Symbol('example')]: 'example-private-text' }),
      sample(2, 2000, { raw: 'example-private-text' }),
      sample(2, 2000, { winner: proxy }), sample(2, 2000, { context: proxy }),
    ]) {
      const result = observeDisagreementPlan(state, value);
      expect(result.reason).toBe('malformed');
      expect(result.state).toBe(state);
      expect(result.diagnostic).toBeNull();
      expect(JSON.stringify(result)).not.toContain('example-private');
    }
    expect(reads).toBe(0);
    expect(resetDisagreementPlan(state, proxy, 2000).reason).toBe('malformed');
    const plain = Object.assign(Object.create(null), sample(2, 2000));
    expect(observeDisagreementPlan(state, plain).reason).toBe('conflict_reported');
  });

  test('deeply freezes bounded state and descriptor while preserving all prior inputs', () => {
    const state = started();
    const observation = Object.freeze({ ...sample(2, 2000),
      context: Object.freeze({ ...context }), winner: Object.freeze({ ...winner }), other: Object.freeze({ ...other }) });
    const before = JSON.stringify({ state, observation });
    const result = observeDisagreementPlan(state, observation);
    expect(JSON.stringify({ state, observation })).toBe(before);
    expect(Object.keys(result)).toEqual(['state', 'diagnostic', 'accepted', 'reason']);
    expect(Object.keys(result.diagnostic!).sort()).toEqual(['at', 'context', 'other', 'since', 'winner']);
    for (const value of [result, result.state, result.state.context, result.state.active,
      result.state.active!.fingerprint, result.state.active!.fingerprint.winner, result.state.active!.fingerprint.other,
      result.diagnostic, result.diagnostic!.context, result.diagnostic!.winner, result.diagnostic!.other]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Reflect.set(result.state, 'lastSeq', 0)).toBe(false);
    expect(Reflect.set(result.diagnostic!.winner, 'word', 'quiet')).toBe(false);
    expect(Object.keys(result.diagnostic!.winner).sort()).toEqual(['source', 'word']);
    expect(JSON.stringify(result.diagnostic)).not.toContain('healthy');
    expect(JSON.stringify(result.diagnostic)).not.toContain('dispatch');
    expect(JSON.stringify(result.diagnostic)).not.toContain('authenticated');
  });
});
