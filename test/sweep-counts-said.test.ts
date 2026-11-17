import { beforeEach, describe, expect, test } from 'bun:test';
import { resetSweepCountsSaid, sweepCountsAreNews, sweepCountsKey } from '../src/daemon/sweep-said.ts';

const refused = (id: string, reason = 'the recipient is not in the team') => ({ messageId: id, reason });
const counts = (over: Partial<{ escalated: unknown[]; refused: { messageId: string; reason: string }[]; unreadable: string[] }> = {}) => ({
  escalated: [], refused: [], unreadable: [], ...over,
});

describe('the fallback sweep says the same counts once', () => {
  beforeEach(() => resetSweepCountsSaid());

  test('the same refused marker on every pass is said once', () => {
    const report = counts({ refused: [refused('m1')] });
    expect(sweepCountsAreNews('chores', '/r', report)).toBe(true);
    for (let i = 0; i < 5; i++) expect(sweepCountsAreNews('chores', '/r', report)).toBe(false);
  });

  test('a pass that escalates is always said', () => {
    const report = counts({ escalated: [{}], refused: [refused('m1')] });
    expect(sweepCountsAreNews('chores', '/r', report)).toBe(true);
    expect(sweepCountsAreNews('chores', '/r', report)).toBe(true);
  });

  test('a different refusal is news; a clean pass forgets the root', () => {
    expect(sweepCountsAreNews('chores', '/r', counts({ refused: [refused('m1')] }))).toBe(true);
    expect(sweepCountsAreNews('chores', '/r', counts({ refused: [refused('m2')] }))).toBe(true);
    expect(sweepCountsAreNews('chores', '/r', counts({ refused: [refused('m2'), refused('m1')] }))).toBe(true);
    expect(sweepCountsAreNews('chores', '/r', counts())).toBe(false);
    expect(sweepCountsAreNews('chores', '/r', counts({ refused: [refused('m2'), refused('m1')] }))).toBe(true);
  });

  test('roots and scopes are apart', () => {
    const report = counts({ unreadable: ['x'] });
    expect(sweepCountsAreNews('chores', '/a', report)).toBe(true);
    expect(sweepCountsAreNews('chores', '/b', report)).toBe(true);
    expect(sweepCountsAreNews('beat', '/a', report)).toBe(true);
    expect(sweepCountsAreNews('chores', '/a', report)).toBe(false);
  });

  test('the key ignores order', () => {
    expect(sweepCountsKey({ refused: [refused('a'), refused('b')], unreadable: ['y', 'x'] }))
      .toBe(sweepCountsKey({ refused: [refused('b'), refused('a')], unreadable: ['x', 'y'] }));
  });
});
