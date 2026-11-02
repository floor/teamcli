import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { discardFixtures } from './fixture-cleanup.ts';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const bases: string[] = [];
afterAll(() => { if (bases.length > 0) discardFixtures(bases, { quiet: true }); }, 30_000);
type Result = { home: string; scan?: { hits: { line: number; origin: string; ordinal: number }[]; problem?: string }; locations?: string[]; commit?: string; corpusHasNul?: boolean; rawHasNul?: boolean; rawHasNeedle?: boolean; code?: number; out?: string; err?: string; leaks?: boolean };
function scene(name: string): Result {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'nul-private-independent-')));
  bases.push(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const worker = fileURLToPath(new URL('./adapters/nul-private-independent-worker.ts', import.meta.url));
  const child = spawnSync(process.execPath, [worker, name, home], { cwd: base, env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, encoding: 'utf8', timeout: 20_000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout) as Result;
  expect(result.home).toBe(home);
  return result;
}
for (const [name, lines] of [['adjacent', [2]], ['split', [2]], ['multiple', [2, 4]], ['positions', [3, 6]]] as [string, number[]][]) {
  test(`${name} corpus reports synthetic hits at their original line numbers`, () => {
    const result = scene(name);
    expect(result.scan?.problem).toBeUndefined();
    expect(result.scan?.hits.map((hit) => hit.line)).toEqual(lines);
    expect(result.scan?.hits.every((hit) => hit.origin === 'synthetic' && hit.ordinal === 1)).toBe(true);
  });
}
for (const name of ['range', 'range-split']) {
  test(`${name} remains a nonzero private-diff result beside a NUL-bearing commit`, () => {
    const result = scene(name);
    expect(result.rawHasNul).toBe(true);
    expect(result.corpusHasNul).toBe(true);
    expect(result.locations).toContain('notes.txt:2');
    expect(result.code, (result.out ?? '') + (result.err ?? '')).toBe(1);
    expect(result.err).toContain('notes.txt:2');
    expect(result.leaks).toBe(false);
  });
}
test('a synthetic message hit before its NUL remains visible in the range', () => {
  const result = scene('commit-before');
  expect(result.rawHasNul).toBe(true);
  expect(result.rawHasNeedle).toBe(true);
  expect(result.locations).toContain(`commit:${result.commit}:3`);
  expect(result.code).toBe(1);
  expect(result.leaks).toBe(false);
});
test('a synthetic message hit after its NUL remains visible in the range', () => {
  const result = scene('commit-tail');
  expect(result.rawHasNul).toBe(true);
  expect(result.rawHasNeedle).toBe(true);
  expect(result.locations).toContain(`commit:${result.commit}:3`);
  expect(result.code).toBe(1);
  expect(result.leaks).toBe(false);
});
