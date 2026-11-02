import { afterAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { discardFixtures } from './fixture-cleanup.ts';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const fixtureRoot = fileURLToPath(new URL('../../names-unique-independent-fixtures/', import.meta.url));
mkdirSync(fixtureRoot, { recursive: true });
const bases: string[] = [];
afterAll(() => { if (bases.length > 0) discardFixtures(bases, { quiet: true, roots: [fixtureRoot] }); }, 30_000);
type Run = { code: number; out: string; err: string; bodies?: string[] };
type Input = { action: string; scope?: string; relation?: string; map?: boolean; word?: string; actor?: string; json?: boolean };
type Result = Run & { home: string; before: string | Run; after: string | Run; get?: Run; created?: string; fileWritten?: boolean; plan?: Run; edit?: Run; paneWrites?: number; oldId?: string; id?: string; beforeAgent?: { id: string; reach: unknown }; afterAgent?: { id: string; reach: unknown }; roster?: { seat: string; nickname?: string }[] };
function scene(input: Input): Result {
  const base = realpathSync(mkdtempSync(join(fixtureRoot, 'scene-')));
  bases.push(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const worker = fileURLToPath(new URL('./adapters/names-unique-independent-worker.ts', import.meta.url));
  const child = spawnSync(process.execPath, [worker, home, JSON.stringify(input)], { cwd: base, env: { ...process.env, HOME: home, TEAM_CONFIG_SOURCE: 'registry', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', timeout: 20_000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout) as Result;
  expect(result.home).toBe(home);
  return result;
}
for (const scope of [undefined, 'entity', 'project', 'team', 'off']) {
  for (const relation of ['same-project', 'other-project', 'other-entity']) {
    const conflict = relation !== 'other-entity' && (scope === undefined || scope === 'entity' || (scope === 'project' && relation === 'same-project'));
    test(`label set under ${scope ?? 'default'} against ${relation} follows the uniqueness scope`, () => {
      const result = scene({ action: 'config', scope, relation });
      expect(result.code, result.out + result.err).toBe(conflict ? 1 : 0);
      if (conflict) {
        expect(JSON.parse(result.out).error.id).toBe('config.name-taken');
        expect(result.after).toBe(result.before);
        expect(result.out).toContain(relation === 'other-project' ? 'api' : 'producer');
        expect(result.out).toContain('reviewer');
        expect(result.out).toContain('names.unique');
      } else expect(result.after).not.toBe(result.before);
    });
  }
}
for (const scope of ['entity', 'project', 'team', 'off']) {
  test(`whole seat map under ${scope} uses the same name check`, () => {
    const result = scene({ action: 'config', scope, relation: 'same-project', map: true });
    expect(result.code, result.out + result.err).toBe(scope === 'entity' || scope === 'project' ? 1 : 0);
    if (scope === 'entity' || scope === 'project') {
      expect(JSON.parse(result.out).error.id).toBe('config.name-taken');
      expect(result.after).toBe(result.before);
    }
  });
  test(`init restore under ${scope} checks newly introduced personas before writing`, () => {
    const result = scene({ action: 'init', scope });
    const conflict = scope === 'entity' || scope === 'project';
    expect(result.code, result.out + result.err).toBe(conflict ? 1 : 0);
    if (conflict) {
      expect(JSON.parse(result.out).error.id).toBe('init.name-taken');
      expect(result.created).toBe('');
      expect(result.fileWritten).toBe(false);
    } else expect(result.created).toContain('cObAlT');
  });
}
for (const scope of ['entity', 'project', 'team', 'off']) {
  test(`existing duplicate under ${scope} is a check note and retains exit zero`, () => {
    const result = scene({ action: 'check', scope });
    expect(result.code, result.out + result.err).toBe(0);
    if (scope === 'entity' || scope === 'project') {
      expect(result.out).toContain('nickname "Cobalt"');
      expect(result.out).toContain('producer');
      expect(result.out).toContain('reviewer');
      expect(result.out).toContain('existing duplicates keep running');
    } else expect(result.out).not.toContain('existing duplicates keep running');
    expect(result.out).not.toContain('difference:');
  });
}
for (const actor of ['owner', 'wildcard']) {
  for (const word of ['entity', 'project', 'team', 'off']) {
    test(`${actor} sets entity word ${word} and a seat reads it back`, () => {
      const result = scene({ action: 'entity', actor, word, scope: 'entity', json: true });
      expect(result.code, result.out + result.err).toBe(0);
      expect(result.get?.code).toBe(0);
      expect(JSON.parse(result.get!.out).value).toBe(word);
      expect(result.after).toContain('# independent entity words');
      expect(result.after).toContain('other:');
    });
  }
}
for (const actor of ['seat', 'scoped']) {
  test(`${actor} cannot change the entity word and writes nothing`, () => {
    const result = scene({ action: 'entity', actor, word: 'off', scope: 'entity', json: true });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).error.id).toBe(actor === 'seat' ? 'config.entity.not-owner' : 'config.entity.general-refused');
    expect(result.after).toBe(result.before);
    if (actor === 'scoped') expect(result.out).toContain('scoped general grants arrive in 0.5.11');
  });
}
for (const actor of ['owner', 'wildcard']) {
  test(`${actor} bad entity word refuses before writing`, () => {
    const result = scene({ action: 'entity', actor, word: 'sometimes', scope: 'entity', json: true });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).error.id).toBe('config.entity.names-value');
    expect(result.after).toBe(result.before);
  });
}
for (const action of ['launch', 'retired']) {
  test(`${action} uses the label persona in its launch plan, roster and actual message header`, () => {
    const result = scene({ action });
    expect(result.plan?.code, result.plan?.out).toBe(0);
    expect(result.plan?.out).toContain('Lyra');
    expect(result.plan?.out).not.toContain('OldEcho');
    expect(result.roster?.find((line) => line.seat === 'reviewer')?.nickname).toBe('Lyra');
    const before = result.before as Run;
    expect(before.code, before.out + before.err).toBe(0);
    expect(before.bodies?.some((body) => body.startsWith('from Lyra'))).toBe(true);
    expect(before.bodies?.some((body) => body.startsWith('from OldEcho'))).toBe(false);
    expect(result.paneWrites).toBe(0);
    if (action === 'retired') expect(result.id).not.toBe(result.oldId);
  });
}
test('a label change appears in the next actual header without a relaunch', () => {
  const result = scene({ action: 'rename' });
  const before = result.before as Run;
  const after = result.after as Run;
  expect(before.code).toBe(0);
  expect(before.bodies?.some((body) => body.startsWith('from Lyra'))).toBe(true);
  assert.ok(result.edit, 'the rename scene must return its edit result');
  expect(result.edit.code, result.edit.out + result.edit.err).toBe(0);
  expect(after.code, after.out + after.err).toBe(0);
  expect(after.bodies?.some((body) => body.startsWith('from Kestrel'))).toBe(true);
  expect(result.beforeAgent?.id).toBe(result.afterAgent?.id);
  expect(result.beforeAgent?.reach).toEqual(result.afterAgent?.reach);
  expect(result.paneWrites).toBe(0);
});
