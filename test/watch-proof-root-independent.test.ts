import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { discardFixtures } from './fixture-cleanup.ts';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const fixtureRoot = fileURLToPath(new URL('../../watch-proof-root-independent-fixtures/', import.meta.url));
mkdirSync(fixtureRoot, { recursive: true });
const roots: string[] = [];
afterAll(() => { if (roots.length > 0) discardFixtures(roots, { quiet: true, roots: [fixtureRoot] }); }, 30_000);
type Input = { words?: string[]; cwd?: string; session?: string; alive?: boolean; startOffset?: number; noStart?: boolean; pane?: boolean; epoch?: boolean; noExpectedFile?: boolean; otherEntry?: boolean };
const cases: [string, Input, string][] = [
  ['absolute own file', { words: ['--session', 'shared', '--file', '$A_FILE'] }, 'proven'],
  ['absolute foreign file', { words: ['--session', 'shared', '--file', '$B_FILE'] }, 'unproven'],
  ['equals own file', { words: ['--session=shared', '--file=$A_FILE'] }, 'proven'],
  ['equals foreign file', { words: ['--session=shared', '--file=$B_FILE'] }, 'unproven'],
  ['own file through alias', { words: ['--session=shared', '--file=$ALIAS_FILE'] }, 'proven'],
  ['relative file from own root', { words: ['--session=shared', '--file=.agents/team.yaml'], cwd: '$A_ROOT' }, 'proven'],
  ['relative file from other root', { words: ['--session=shared', '--file=.agents/team.yaml'], cwd: '$B_ROOT' }, 'unproven'],
  ['relative file without working folder', { words: ['--session=shared', '--file=.agents/team.yaml'], cwd: 'missing' }, 'unproven'],
  ['absolute own file without working folder', { words: ['--session=shared', '--file=$A_FILE'], cwd: 'missing' }, 'proven'],
  ['flagless file from own root', { cwd: '$A_ROOT' }, 'proven'],
  ['flagless file from own team directory', { cwd: '$A_DIR' }, 'proven'],
  ['flagless file through root alias', { cwd: '$ALIAS_ROOT' }, 'proven'],
  ['flagless file from another root', { cwd: '$B_ROOT' }, 'unproven'],
  ['flagless file without working folder', { cwd: 'missing' }, 'unproven'],
  ['repeated own then foreign file', { words: ['--session=shared', '--file', '$A_FILE', '--file=$B_FILE'] }, 'unproven'],
  ['repeated foreign then own file', { words: ['--session=shared', '--file=$B_FILE', '--file', '$A_FILE'] }, 'proven'],
  ['explicit file without expected canonical file', { words: ['--session=shared', '--file=$A_FILE'], noExpectedFile: true }, 'unproven'],
  ['registry launch without explicit file', { noExpectedFile: true }, 'proven'],
  ['another session', { words: ['--session=elsewhere'] }, 'unproven'],
  ['another entry', { otherEntry: true }, 'unproven'],
  ['start outside identity window', { startOffset: 180_000 }, 'unproven'],
  ['recorded start absent', { noStart: true }, 'unproven'],
  ['dead process', { alive: false }, 'nothing'],
  ['recorded pane', { pane: true }, 'nothing'],
  ['session epoch', { epoch: true }, 'nothing'],
  ['default session implicit selector', { words: [], session: 'default' }, 'proven'],
];
for (const [name, input, expected] of cases) {
  test(`${name} has the expected ownership proof`, () => {
    const root = realpathSync(mkdtempSync(join(fixtureRoot, 'scene-')));
    roots.push(root);
    const home = join(root, 'home');
    mkdirSync(home);
    const worker = fileURLToPath(new URL('./adapters/watch-proof-root-independent-worker.ts', import.meta.url));
    const child = spawnSync(process.execPath, [worker, home, JSON.stringify(input)], { cwd: root, env: { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, encoding: 'utf8', timeout: 20_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.home).toBe(home);
    expect(result.result.kind).toBe(expected);
    if (expected !== 'nothing') expect(result.result.pid).toBe(424242);
    if (name.startsWith('flagless file') && !['proven'].includes(expected)) expect(result.reads).toContain('working-folder-adapter');
  });
}
