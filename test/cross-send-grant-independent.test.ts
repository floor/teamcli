// No command or owner-store modules are imported into this parent runner.
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const fixtureRoot = fileURLToPath(new URL('../../cross-send-independent-fixtures/', import.meta.url));
mkdirSync(fixtureRoot, { recursive: true });
const bases: string[] = [];
afterAll(() => { if (bases.length > 0) spawnSync('trash', bases, { timeout: 20_000 }); }, 30_000);
type Result = { code: number; out: string; err: string; records: { team: string; body: string }[]; paneWrites: number; home: string; issued?: boolean; before?: Result; line?: string; repair?: Result; after?: Result; verified?: { name: string; from: string; to: string }[]; expectedPair?: { from: string; to: string }; grantFiles?: string[] };
type PairInput = { words: string[]; entities: string[]; expectedPair: { from: string; to: string } };
function scene(name: string, pair?: PairInput): Result {
  const base = realpathSync(mkdtempSync(join(fixtureRoot, 'scene-')));
  bases.push(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const worker = fileURLToPath(new URL('./adapters/cross-send-independent-worker.ts', import.meta.url));
  const child = spawnSync(process.execPath, [worker, name, home, JSON.stringify(pair ?? null)], {
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

// A wildcard principal can issue any pair. These scenes pin argument parsing and the
// exact signed pair; listed-entity admission stays on the separate scoped branch.
function checkedPair(input: PairInput) {
  const result = scene('general-pair', input);
  expect(result.code, result.out + result.err).toBe(0);
  expect(result.records).toEqual([]);
  expect(result.paneWrites).toBe(0);
  expect(result.verified).toEqual([{ name: 'independent-pair', ...result.expectedPair, expires: expect.any(String) }]);
  expect(result.grantFiles).toHaveLength(1);
}
const inside = { from: 'architect@design', to: 'coordinator@product' };
const outside = { from: 'orchestrator@foreign', to: 'orchestrator@foreign' };
for (const side of ['from', 'to'] as const) {
  const other = side === 'from' ? 'to' : 'from';
  for (const style of ['space', 'equals', 'space-equals', 'equals-space']) {
    for (const disposition of ['foreign-side-final', 'foreign-pair-final', 'local-side-final']) {
      const covered = disposition === 'foreign-pair-final';
      const lastInside = disposition === 'local-side-final';
      const ordered = lastInside ? [outside[side], inside[side]] : [inside[side], outside[side]];
      const words = [`--${other}`, covered ? outside[other] : inside[other]];
      for (let index = 0; index < ordered.length; index++) {
        const equals = style === 'equals' || (style === 'space-equals' && index === 1) || (style === 'equals-space' && index === 0);
        words.push(...(equals ? [`--${side}=${ordered[index]}`] : [`--${side}`, ordered[index]!]));
      }
      test(`repeated --${side} ${style} ${disposition} signs only the final pair`, () => {
        checkedPair({ words, entities: ['*'], expectedPair: { ...inside, [side]: ordered[1]!, [other]: covered ? outside[other] : inside[other] } });
      });
    }
  }
  for (const padding of ['leading', 'trailing']) {
    for (const disposition of ['foreign-side', 'foreign-pair', 'local-side']) {
      const local = disposition === 'local-side';
      const covered = disposition === 'foreign-pair';
      const target = local ? (side === 'from' ? '$INSIDE_FROM' : '$INSIDE_TO') : '$OUTSIDE';
      const padded = padding === 'leading' ? `  ${target}` : `${target}  `;
      const fixed = covered ? outside[other] : inside[other];
      test(`padded --${side} agent id ${padding} ${disposition} signs a trimmed pair`, () => {
        checkedPair({ words: [`--${side}`, padded, `--${other}`, fixed], entities: ['*'], expectedPair: { ...inside, [side]: target, [other]: fixed } });
      });
    }
  }
}

test('a listed-entity general grant is refused before issuing any send grant', () => {
  const result = scene('general-pair', {
    words: ['--from', inside.from, '--to', inside.to], entities: ['studio'], expectedPair: inside,
  });
  refused(result, 'team.general-target');
  expect(JSON.parse(result.out).error.message).toContain('scoped general grants arrive in 0.5.11');
  expect(result.verified).toEqual([]);
  expect(result.grantFiles).toEqual([]);
});
