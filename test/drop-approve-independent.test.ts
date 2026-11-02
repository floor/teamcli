// Output contracts checked in child processes with synthetic homes and approval snapshots.
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { discardFixtures } from './fixture-cleanup.ts';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const bases: string[] = [];
afterAll(() => { if (bases.length > 0) discardFixtures(bases, { quiet: true }); }, 30_000);
type Result = { home: string; code: number; out: string; err: string; label?: string; before?: string; after?: string; snapshotUnchanged?: boolean; text?: string };
function scene(name: string): Result {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'drop-approve-independent-')));
  bases.push(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const worker = fileURLToPath(new URL('./adapters/drop-approve-independent-worker.ts', import.meta.url));
  const child = spawnSync(process.execPath, [worker, name, home], { cwd: base, env: { ...process.env, HOME: home, TEAM_CONFIG_SOURCE: 'registry', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, encoding: 'utf8', timeout: 20_000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout) as Result;
  expect(result.home).toBe(home);
  return result;
}
const obsoleteStep = /the approval no longer covers|for the owner to approve|approve with the owner seat|the approval record was not changed|needing approval again|approve the (?:team|file) again/i;
for (const shape of ['label', 'whole']) {
  for (const format of ['plain', 'json']) {
    test(`config set ${shape} reports the validated change (${format})`, () => {
      const result = scene(`${shape}-${format}`);
      expect(result.code, result.out + result.err).toBe(0);
      expect(result.before).toBe('verified');
      expect(result.label).toBe('Revised Worker');
      expect(result.snapshotUnchanged).toBe(true);
      expect((result.out + result.err).replace(/\s+/g, ' ')).not.toMatch(obsoleteStep);
      if (format === 'json') {
        const body = JSON.parse(result.out) as Record<string, unknown>;
        expect(body.changed).toBe(true);
        expect(Object.hasOwn(body, 'approval_differences')).toBe(false);
      }
    });
  }
}
test('an unchanged config set has the same JSON field contract', () => {
  const result = scene('unchanged-json');
  expect(result.code).toBe(0);
  const body = JSON.parse(result.out) as Record<string, unknown>;
  expect(body.changed).toBe(false);
  expect(Object.hasOwn(body, 'approval_differences')).toBe(false);
});
for (const bundle of ['manager', 'developer']) {
  for (const op of ['add', 'remove']) {
    test(`${bundle} client roster ${op} text names the roster result`, () => {
      const result = scene(`roster-${op}-${bundle}`);
      expect(result.text).toContain(`${op === 'add' ? 'added' : 'removed'} worker-two`);
      expect(result.text?.replace(/\s+/g, ' ')).not.toMatch(obsoleteStep);
      if (op === 'add') {
        expect(result.text).toContain('up --client');
        expect(result.text).toContain(`fresh ${bundle} grant`);
      }
    });
  }
}
test('migration keeps the historical snapshot report and leaves its bytes intact', () => {
  const result = scene('migrate');
  expect(result.code, result.out + result.err).toBe(0);
  expect(result.before).toBe('verified');
  expect(result.after).toBe('refused');
  expect(result.snapshotUnchanged).toBe(true);
  expect(result.out).toContain('migration completed; the stored approval describes an earlier team record and no longer verifies');
  expect(result.out).toContain('this version has no command to refresh that snapshot');
});
test('config help describes editing without the obsolete follow-up step', () => {
  const result = scene('help');
  expect(result.code).toBe(0);
  expect(result.out).toContain('team config set');
  expect(result.out.replace(/\s+/g, ' ')).not.toMatch(obsoleteStep);
});
