import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { discardFixtures } from './fixture-cleanup.ts';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// A client key cannot be placed under the system temporary directory. This fixture root is
// outside the checked-out trees and every synthetic registered team root/lobby.
const fixtureRoot = fileURLToPath(new URL('../../team-name-resolve-fixtures/', import.meta.url));
mkdirSync(fixtureRoot, { recursive: true });
const bases: string[] = [];
afterAll(() => { if (bases.length > 0) discardFixtures(bases, { quiet: true, roots: [fixtureRoot] }); }, 30_000);
type Result = { code: number; out: string; err: string; ids: Record<string, string>; agentIds: Record<string, string>; records: { team: string; body: string; toId: string }[]; paneWrites: number; home: string; grantResult?: { ok: boolean; why?: string }; grantTarget?: string };
function scene(name: string): Result {
  const base = realpathSync(mkdtempSync(join(fixtureRoot, 'scene-')));
  bases.push(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const worker = fileURLToPath(new URL('./adapters/team-name-independent-worker.ts', import.meta.url));
  const child = spawnSync(process.execPath, [worker, name, home], { cwd: base, env: { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, encoding: 'utf8', timeout: 20_000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout) as Result;
  expect(result.home).toBe(home);
  return result;
}
function reachedFirst(result: Result) {
  expect(result.code, result.out + result.err).toBe(0);
  expect(result.records).toHaveLength(1);
  expect(result.records[0]?.team).toBe('first');
  expect(result.records[0]?.toId).toBe(result.agentIds.first);
  expect(result.paneWrites).toBe(0);
}
for (const name of ['by-name', 'by-session', 'by-team-id', 'by-agent-id']) {
  test(`plain send resolves ${name} within two teams sharing a project and entity`, () => reachedFirst(scene(name)));
}
for (const name of ['ambiguous-name', 'ambiguous-session']) {
  test(`${name} refuses and names both candidates`, () => {
    const result = scene(name);
    expect(result.code).toBe(1);
    expect(result.out + result.err).toContain(result.ids.first!);
    expect(result.out + result.err).toContain(result.ids.second!);
    expect(result.out + result.err).toContain('say which by its id');
    expect(result.records).toEqual([]);
    expect(result.paneWrites).toBe(0);
  });
}
test('a project-only name is clearly refused as a missing team', () => {
  const result = scene('project-only');
  expect(result.code).toBe(1);
  expect(result.out + result.err).toContain('no team registry record matches "portfolio"');
  expect(result.records).toEqual([]);
});
for (const name of ['client-name', 'client-session', 'client-pinned']) {
  test(`${name} sends only to the team selected by the owner grant`, () => {
    const result = scene(name);
    expect(result.grantResult, result.out + result.err).toEqual({ ok: true });
    expect(result.grantTarget).toBe(result.ids.first);
    reachedFirst(result);
    expect(result.records[0]?.body).toContain('independent client routing probe');
  });
}
test('issuing a client grant to an ambiguous team name names both candidates', () => {
  const result = scene('client-ambiguous');
  expect(result.grantResult?.ok).toBe(false);
  expect(result.err).toContain(result.ids.first!);
  expect(result.err).toContain(result.ids.second!);
  expect(result.records).toEqual([]);
});
test('a client grant cannot be issued using only the project name', () => {
  const result = scene('client-project-only');
  expect(result.grantResult?.ok).toBe(false);
  expect(result.err).toContain('no team "portfolio"');
  expect(result.records).toEqual([]);
});
