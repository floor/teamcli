import { expect, test } from 'bun:test';
import {
  UNTIMED_MS,
  appendUnits,
  assignmentOf,
  assignmentProblems,
  assignmentWeights,
  plan,
  shardUnits,
  timingsFromLog,
  unitTimesFromJunit,
  units,
  weights,
} from '../scripts/ci-shard-tests.ts';

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

test('an untimed unit weighs the measured average when the assignment is made, not its size', () => {
  const sizes: Record<string, number> = { 'test/new.test.ts': 100, 'test/old.test.ts': 100 };
  const w = assignmentWeights(['test/new.test.ts', 'test/old.test.ts'], { 'test/old.test.ts': 1200 }, (f) => sizes[f] ?? 0);
  expect(w.get('test/new.test.ts')).toBe(UNTIMED_MS);
  expect(w.get('test/old.test.ts')).toBe(1200);
  const part = assignmentWeights(['test/exit-codes.test.ts#1/4'], {}, () => 0);
  expect(part.get('test/exit-codes.test.ts#1/4')).toBe(Math.round(UNTIMED_MS / 4));
});

test('the packed plan is checked in as a sorted unit-to-shard map', () => {
  const bins = plan(['t/c', 't/a', 't/b'], 2, new Map([['t/a', 5], ['t/b', 3], ['t/c', 2]]));
  const assignment = assignmentOf(bins);
  expect(assignment.shards).toBe(2);
  expect(Object.keys(assignment.units)).toEqual(['t/a', 't/b', 't/c']);
  expect(shardUnits(assignment, 0)).toEqual([...bins[0]!.files].sort());
  expect(shardUnits(assignment, 1)).toEqual([...bins[1]!.files].sort());
});

test('--write keeps every placed unit and appends newcomers heaviest first to the lightest', () => {
  const base = { shards: 3, units: { 't/a': 0 } };
  const w = new Map([['t/a', 100], ['t/b', 90], ['t/c', 80], ['t/d', 70]]);
  const next = appendUnits(base, ['t/a', 't/b', 't/c', 't/d'], w);
  expect(next.units).toEqual({ 't/a': 0, 't/b': 1, 't/c': 2, 't/d': 2 });
  expect(next.shards).toBe(3);
  // A unit whose file is gone is dropped, and the base is not changed.
  expect(appendUnits(base, ['t/a'], w).units).toEqual({ 't/a': 0 });
  expect(base.units).toEqual({ 't/a': 0 });
});

const TRACKED = ['test/a.test.ts', 'test/exit-codes.test.ts'];
const CLEAN = {
  shards: 2,
  units: {
    'test/a.test.ts': 0,
    'test/exit-codes.test.ts#0/4': 1,
    'test/exit-codes.test.ts#1/4': 1,
    'test/exit-codes.test.ts#2/4': 0,
    'test/exit-codes.test.ts#3/4': 0,
  },
};

test('a complete assignment has no problems', () => {
  expect(assignmentProblems(CLEAN, TRACKED)).toEqual([]);
});

test('--check names a test file with no shard, a stray unit and an empty shard', () => {
  const missing = { ...CLEAN, units: { ...CLEAN.units } };
  delete (missing.units as Record<string, number>)['test/a.test.ts'];
  expect(assignmentProblems(missing, TRACKED).join('\n')).toContain('not assigned to any shard');

  const stray = { ...CLEAN, units: { ...CLEAN.units, 'test/gone.test.ts': 1 } };
  expect(assignmentProblems(stray, TRACKED).join('\n')).toContain('not a tracked test');

  const oneShard = { shards: 2, units: { 'test/a.test.ts': 0, 'test/exit-codes.test.ts#0/4': 0, 'test/exit-codes.test.ts#1/4': 0, 'test/exit-codes.test.ts#2/4': 0, 'test/exit-codes.test.ts#3/4': 0 } };
  expect(assignmentProblems(oneShard, TRACKED).join('\n')).toContain('shard 1: no units');
});

test('--check refuses a split file assigned whole, split into the wrong parts or outside its shard', () => {
  const whole = { ...CLEAN, units: { ...CLEAN.units, 'test/exit-codes.test.ts': 0 } };
  expect(assignmentProblems(whole, TRACKED).join('\n')).toContain('cannot be assigned whole');

  const wrong = { ...CLEAN, units: { ...CLEAN.units, 'test/exit-codes.test.ts#0/3': 0 } };
  expect(assignmentProblems(wrong, TRACKED).join('\n')).toContain('not 3');

  const notSplit = { ...CLEAN, units: { ...CLEAN.units, 'test/a.test.ts#0/4': 0 } };
  expect(assignmentProblems(notSplit, TRACKED).join('\n')).toContain('not split');

  const outside = { ...CLEAN, units: { ...CLEAN.units, 'test/a.test.ts': 5 } };
  expect(assignmentProblems(outside, TRACKED).join('\n')).toContain('shard 5 is outside 0..1');
});

test('--check refuses a unit named twice in the file', () => {
  const raw = '{"shards":2,"units":{"test/a.test.ts":0,"test/a.test.ts":1}}';
  expect(assignmentProblems(CLEAN, TRACKED, raw).join('\n')).toContain('named 2 times');
});

test('--record reads the unit lines a shard log prints from its JUnit report', () => {
  const times = timingsFromLog([
    '2026-11-02T12:00:00.1234567Z ##[unit]test/a.test.ts 42',
    '2026-11-02T12:00:01.0000000Z ##[unit]test/b.test.ts 7',
    '2026-11-02T12:00:02.0000000Z ##[unit]test/b.test.ts 3',
  ].join('\n'));
  expect(times['test/a.test.ts']).toBe(42);
  expect(times['test/b.test.ts']).toBe(10);
});

test('--record still reads the older group form and attributes a part to its unit', () => {
  const groups = timingsFromLog([
    '2026-11-02T12:00:00.0000000Z ##[group]test/a.test.ts:',
    '2026-11-02T12:00:01.0000000Z ##[group]test/b.test.ts:',
    '2026-11-02T12:00:04.0000000Z Ran 2 tests across 2 files. [4.00s]',
  ].join('\n'));
  expect(groups['test/a.test.ts']).toBe(1000);
  expect(groups['test/b.test.ts']).toBe(3000);

  const part = timingsFromLog([
    '2026-11-02T12:00:00.0000000Z Part 1/4 of test/exit-codes.test.ts',
    '2026-11-02T12:00:00.1000000Z ##[group]test/exit-codes.test.ts:',
    '2026-11-02T12:00:05.0000000Z Ran 3 tests across 1 file. [4.90s]',
  ].join('\n'));
  expect(part['test/exit-codes.test.ts#1/4']).toBe(4900);
});

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" assertions="0" failures="0" skipped="0" time="2.0">
  <testsuite name="test/a.test.ts" file="test/a.test.ts" tests="1" assertions="0" failures="0" skipped="0" time="1.234" hostname="host">
    <testcase name="a" classname="" time="0.1" file="test/a.test.ts" line="2" assertions="0" />
  </testsuite>
  <testsuite name="test/b.test.ts" file="test/b.test.ts" tests="1" assertions="0" failures="0" skipped="0" time="0.5" hostname="host">
    <testcase name="b" classname="" time="0.1" file="test/b.test.ts" line="2" assertions="0" />
  </testsuite>
</testsuites>`;

test('a JUnit report gives each file its suite time, and a label the sum for a split part', () => {
  expect(unitTimesFromJunit(JUNIT)).toEqual({ 'test/a.test.ts': 1234, 'test/b.test.ts': 500 });
  expect(unitTimesFromJunit(JUNIT, 'test/exit-codes.test.ts#0/4')).toEqual({ 'test/exit-codes.test.ts#0/4': 1734 });
});

const NESTED_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" time="1.5">
  <testsuite name="test/live-delivery-rebind-independent.test.ts" file="test/live-delivery-rebind-independent.test.ts" tests="1" time="1.5">
    <testcase name="a scene" time="1.5" file="test/live-delivery-rebind-independent.test.ts" />
  </testsuite>
  <testsuite name="live-delivery-rebind independent scenes" file="test/live-delivery-rebind-independent.test.ts" tests="1" time="1.5" />
</testsuites>`;

test('a nested describe suite is not a second unit and does not add its time again', () => {
  expect(unitTimesFromJunit(NESTED_JUNIT)).toEqual({ 'test/live-delivery-rebind-independent.test.ts': 1500 });
  expect(unitTimesFromJunit(NESTED_JUNIT, 'test/live-delivery-rebind-independent.test.ts#0/1')).toEqual({
    'test/live-delivery-rebind-independent.test.ts#0/1': 1500,
  });
  const unnamed = `<testsuite name="not a unit path" time="1.0"></testsuite>`;
  expect(unitTimesFromJunit(unnamed)).toEqual({ 'not a unit path': 1000 });
});
