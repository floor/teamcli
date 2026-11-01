// No command or owner-store modules are imported into this parent runner.
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const bases: string[] = [];
afterAll(() => { for (const base of bases) spawnSync('trash', [base]); });
type Result = { code: number; out: string; err: string; records: { team: string; body: string }[]; paneWrites: number; home: string; issued?: boolean; before?: Result; line?: string; repair?: Result; after?: Result; verified?: { name: string }[] };
function scene(name: string): Result {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'independent-cross-grant-')));
  bases.push(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const worker = fileURLToPath(new URL('./adapters/cross-send-independent-worker.ts', import.meta.url));
  const child = spawnSync(process.execPath, [worker, name, home], {
    cwd: base, env: { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, encoding: 'utf8', timeout: 20_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout) as Result;
  expect(result.home).toBe(home);
  return result;
}
function refused(result: Result, id: string) {
  expect(result.code).toBe(1);
  expect(JSON.parse(result.out).error.id).toBe(id);
  expect(result.records).toEqual([]);
  expect(result.paneWrites).toBe(0);
}
test('a signed architect grant reaches another team lead in the same entity', () => {
  const result = scene('allowed');
  expect(result.code).toBe(0);
  expect(result.records).toHaveLength(1);
  expect(result.records[0]?.team).toBe('product');
  expect(result.records[0]?.body).toContain('admitted by: an owner-signed grant naming send (architect-outbound)');
  expect(result.records[0]?.body).toContain('independent synthetic message');
  expect(result.paneWrites).toBe(0);
});
for (const name of ['non-lead', 'other-entity', 'expired']) {
  test(`a signed grant refuses ${name} without delivery effects`, () => {
    const result = scene(name);
    expect(result.code).toBe(1);
    expect(result.records).toEqual([]);
    expect(result.paneWrites).toBe(0);
    expect(result.out + result.err).toContain('no rule admits it');
  });
}
for (const name of ['unsigned', 'bad-signature', 'wrong-key']) {
  test(`a ${name} record is an actionable grant-invalid refusal`, () => {
    const result = scene(name);
    refused(result, 'send.grant-invalid');
    const error = JSON.parse(result.out).error;
    expect(error.message).toContain('architect-outbound');
    expect(error.message).toContain("team grant --send --from 'architect@design' --to 'coordinator@product'");
    expect(error.message).toContain("--name 'architect-outbound'");
  });
}
test('a seat cannot issue an outbound send grant', () => {
  const result = scene('seat-issue');
  expect(result.code).toBe(1);
  expect(result.err).toContain('only the owner runs this');
  expect(result.issued).toBe(false);
});
test('a send dry run shows the same unsigned-grant refusal and writes no record', () => {
  const result = scene('dry-unsigned');
  refused(result, 'send.grant-invalid');
  expect(JSON.parse(result.out).error.message).toContain('Re-issue it signed');
});
test('the exact printed repair arguments recreate a valid record and permit the next send', () => {
  const result = scene('reissue');
  expect(result.before?.code).toBe(1);
  expect(result.line).toStartWith('team grant --send');
  expect(result.repair?.code).toBe(0);
  expect(result.verified?.map((value) => value.name)).toEqual(['architect-outbound']);
  expect(result.after?.code).toBe(0);
  expect(result.records).toHaveLength(1);
  expect(result.records[0]?.body).toContain('admitted by: an owner-signed grant naming send (architect-outbound)');
  expect(result.paneWrites).toBe(0);
});
