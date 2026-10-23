import { describe, expect, test } from 'bun:test';
import { isSignalName, SIGNAL_RECORD_TYPES, SIGNALS } from '../../src/workflow/signals.ts';
import { isEventKind } from '../../src/bus/kinds.ts';

describe('the transition-signal set', () => {
  test('is exactly the twenty-three, in the pinned order', () => {
    expect(SIGNALS).toEqual([
      'pr-opened',
      'pr-merged',
      'sha-verified',
      'gate-passed',
      'approved',
      'tag-outcome',
      'publish-outcome',
      'deploy-outcome',
      'time-reached',
      'goals-set',
      'diverged',
      'accepted',
      'task-ready',
      'acknowledged',
      'step-done',
      'step-blocked',
      'seat-down',
      'merge-observed',
      'install-recorded',
      'redispatch',
      'lead-word',
      'step-failed',
      'lead-stop',
    ]);
  });

  test('a bus kind is never a signal', () => {
    expect(isSignalName('release.ready')).toBe(false);
    expect(isEventKind('release.ready')).toBe(true);
    for (const signal of SIGNALS) expect(isEventKind(signal)).toBe(false);
  });

  test('isSignalName accepts members only', () => {
    expect(isSignalName('approved')).toBe(true);
    expect(isSignalName('Approved')).toBe(false);
    expect(isSignalName('')).toBe(false);
    expect(isSignalName(1)).toBe(false);
  });
});

describe('the signal → record table', () => {
  test('covers every signal exactly once', () => {
    expect(Object.keys(SIGNAL_RECORD_TYPES).sort()).toEqual([...SIGNALS].sort());
  });

  test('outcome signals require the done result and name their operation', () => {
    expect(SIGNAL_RECORD_TYPES['tag-outcome']).toEqual({ type: 'outcome', operation: 'release-tag', result: 'done' });
    expect(SIGNAL_RECORD_TYPES['publish-outcome']).toEqual({
      type: 'outcome',
      operation: 'release-publish',
      result: 'done',
    });
    expect(SIGNAL_RECORD_TYPES['deploy-outcome']).toEqual({ type: 'outcome', operation: 'site-deploy', result: 'done' });
    expect(SIGNAL_RECORD_TYPES['goals-set']).toEqual({ type: 'outcome', operation: 'goals-session', result: 'done' });
    expect(SIGNAL_RECORD_TYPES['merge-observed']).toEqual({ type: 'outcome', operation: 'merge', result: 'done' });
    expect(SIGNAL_RECORD_TYPES['install-recorded']).toEqual({ type: 'outcome', operation: 'install', result: 'done' });
  });

  test('the workflow MVP selectors are the seam table rows', () => {
    expect(SIGNAL_RECORD_TYPES['task-ready']).toEqual({ type: 'task' });
    expect(SIGNAL_RECORD_TYPES.acknowledged).toEqual({ type: 'message' });
    expect(SIGNAL_RECORD_TYPES['step-done']).toEqual({ type: 'step' });
    expect(SIGNAL_RECORD_TYPES['step-blocked']).toEqual({ type: 'step' });
    expect(SIGNAL_RECORD_TYPES['seat-down']).toEqual({ type: 'seat-state' });
    expect(SIGNAL_RECORD_TYPES.redispatch).toEqual({ type: 'dispatch' });
    expect(SIGNAL_RECORD_TYPES['lead-word']).toEqual({ type: 'message' });
    expect(SIGNAL_RECORD_TYPES['step-failed']).toEqual({ type: 'refusal' });
    expect(SIGNAL_RECORD_TYPES['lead-stop']).toEqual({ type: 'message' });
  });

  test('approved names the approval record provisionally, with no signature claim', () => {
    expect(SIGNAL_RECORD_TYPES.approved).toEqual({ type: 'approval' });
  });
});
