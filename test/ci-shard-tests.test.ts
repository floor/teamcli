import { expect, test } from 'bun:test';
import { plan, units, weights } from '../scripts/ci-shard-tests.ts';

test('a split file becomes its parts, each a fraction of its time', () => {
  const all = units(['test/a.test.ts', 'test/exit-codes.test.ts', 'test/a.test.ts']);
  expect(all).toEqual(['test/a.test.ts', 'test/exit-codes.test.ts#0/4', 'test/exit-codes.test.ts#1/4', 'test/exit-codes.test.ts#2/4', 'test/exit-codes.test.ts#3/4']);
  const w = weights(all, { 'test/a.test.ts': 10, 'test/exit-codes.test.ts': 400 }, () => 100);
  expect(w.get('test/exit-codes.test.ts#2/4')).toBe(100);
});

test('every unit lands in exactly one shard, longest first to the lightest', () => {
  const files = ['t/a', 't/b', 't/c', 't/d', 't/e'];
  const w = new Map([['t/a', 50], ['t/b', 40], ['t/c', 30], ['t/d', 20], ['t/e', 10]]);
  const bins = plan(files, 2, w);
  expect(bins.flatMap((b) => b.files).sort()).toEqual(files);
  expect(bins.map((b) => b.ms)).toEqual([80, 70]);
  expect(plan([...files].reverse(), 2, w)).toEqual(bins);
});

test('a file with no recorded time weighs its size at the median rate', () => {
  const sizes: Record<string, number> = { 'x': 100, 'y': 200, 'z': 300, 'new': 1000 };
  const w = weights(['new'], { x: 100, y: 400, z: 900 }, (f) => sizes[f] ?? 0);
  expect(w.get('new')).toBe(2000);
});
