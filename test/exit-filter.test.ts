// The filter that lets a local run of test/exit-codes.test.ts cover only the scenes a diff
// touches must never skip silently: unset means every scene runs, and a filter naming an id
// the contract does not list fails the run. Both are proved here — the second against the
// real file, so the wiring itself cannot rot.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { leadPart, outsidePart, scenePart, skipsScene, unknownScenes, wantedScenes } from './exit-filter.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

// One spawn per id set: three of the tests below read the same filtered run.
const runs = new Map<string, { status: number | null; output: string }>();

function runScenes(ids: string): { status: number | null; output: string } {
  const had = runs.get(ids);
  if (had !== undefined) return had;
  const run = spawnSync('bun', ['test', join('test', 'exit-codes.test.ts')], {
    cwd: repo,
    env: { ...process.env, TEAM_EXIT_IDS: ids },
    encoding: 'utf8',
    timeout: 300_000,
  });
  const result = { status: run.status, output: `${run.stdout}${run.stderr}` };
  runs.set(ids, result);
  return result;
}

/** The `N pass` a run reported, or -1 when it never got there. */
function passes(output: string): number {
  return Number(/ (\d+) pass/.exec(output)?.[1] ?? -1);
}

test('no filter means every scene runs', () => {
  expect(wantedScenes(undefined)).toBeNull();
  expect(wantedScenes('')).toBeNull();
  expect(wantedScenes(' , ')).toBeNull();
  expect(skipsScene(null, 'add.invocation')).toBe(false);
  expect(skipsScene(null, 'made.up')).toBe(false);
});

test('a filter skips only the scenes it does not name', () => {
  const wanted = wantedScenes('add.invocation, send.held');
  expect(wanted).toEqual(new Set(['add.invocation', 'send.held']));
  expect(skipsScene(wanted, 'add.invocation')).toBe(false);
  expect(skipsScene(wanted, 'add.seat-name')).toBe(true);
});

test('the ids the contract does not list are named back', () => {
  expect(unknownScenes(wantedScenes('add.invocation, made.up'), ['add.invocation'])).toEqual(['made.up']);
  expect(unknownScenes(null, ['add.invocation'])).toEqual([]);
});

test('the real file refuses a filter naming an id the contract lacks', () => {
  const run = runScenes('made.up-nothing');
  expect(run.output).toContain('made.up-nothing');
  expect(run.status).not.toBe(0);
}, 300_000);

test('the real file runs exactly the one scene a filter names', () => {
  const run = runScenes('add.invocation');
  expect(run.output).toContain('selected 1 of');
  expect(run.status).toBe(0);
}, 300_000);

// What a filter leaves out is counted, not just announced: a second scene costs exactly one more
// test, and the run stays far below the 72 analyzer probes an unfiltered run registers — so the
// probe skip can never become silent, and the checks against this repo cannot have gone with it.
test('a filtered run costs one test per scene', () => {
  const one = runScenes('add.invocation');
  const two = runScenes('add.invocation,send.held');
  expect(one.output).toContain('analyzer probes skipped');
  expect(two.status).toBe(0);
  expect(passes(two.output) - passes(one.output)).toBe(1);
  expect(passes(one.output)).toBeGreaterThanOrEqual(5);
  expect(passes(one.output)).toBeLessThan(20);
}, 300_000);

test('TEAM_EXIT_PART deals every scene to exactly one part, and only part 0 leads', () => {
  expect(scenePart(undefined)).toBeNull();
  expect(scenePart('')).toBeNull();
  expect(scenePart('1/4')).toEqual({ index: 1, count: 4 });
  for (const bad of ['4/4', '1', 'a/b', '-1/4', '0/0']) expect(() => scenePart(bad)).toThrow('TEAM_EXIT_PART');
  const parts = [0, 1, 2, 3].map((index) => ({ index, count: 4 }));
  for (let position = 0; position < 50; position++) {
    expect(parts.filter((part) => !outsidePart(part, position)).length).toBe(1);
  }
  expect(outsidePart(null, 7)).toBe(false);
  expect(parts.map(leadPart)).toEqual([true, false, false, false]);
  expect(leadPart(null)).toBe(true);
});
