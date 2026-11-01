// Command execution is instrumented inside child processes; all stores and keys are synthetic.
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const fixtureRoot = fileURLToPath(new URL('../../general-door-narrow-independent-fixtures/', import.meta.url));
mkdirSync(fixtureRoot, { recursive: true });
const bases: string[] = [];
afterAll(() => { if (bases.length > 0) spawnSync('trash', bases, { timeout: 20_000 }); }, 30_000);
type Input = { command: string; words: string[]; entities?: string[]; ops?: string[]; mode?: 'daemon' | 'config' | 'up' };
type Result = { storeChanges: string[]; home: string; code: number; out: string; err: string; calls: number; calledAs?: { kind: string }; received: string[]; marker: boolean; servicePlans: number; serviceInstalls: number; upReads: number; storedModel?: string; originalFile: string };
function scene(input: Input): Result {
  const base = realpathSync(mkdtempSync(join(fixtureRoot, 'scene-')));
  bases.push(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const worker = fileURLToPath(new URL('./adapters/general-door-narrow-independent-worker.ts', import.meta.url));
  const child = spawnSync(process.execPath, [worker, home, JSON.stringify({ entities: ['*'], ops: ['*'], ...input })], {
    cwd: base, env: { ...process.env, HOME: home, TEAM_CONFIG_SOURCE: 'registry', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, encoding: 'utf8', timeout: 20_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout) as Result;
  expect(result.home).toBe(home);
  return result;
}
function stopped(result: Result) {
  expect(result.code, result.out + result.err).toBe(1);
  expect(result.calls).toBe(0);
  expect(result.marker).toBe(false);
  expect(result.servicePlans).toBe(0);
  expect(result.serviceInstalls).toBe(0);
  expect(result.upReads).toBe(0);
}
function admitted(result: Result) {
  expect(result.code, result.out + result.err).toBe(0);
  expect(result.calls).toBe(1);
  expect(result.marker).toBe(true);
  expect(result.calledAs?.kind).toBe('owner');
  expect(result.received).not.toContain('--general');
  expect(result.received).not.toContain('--key');
}
const scopedMessage = 'scoped general grants arrive in 0.5.11; use a wildcard grant or the owner path';
const scopedLines: [string, string[]][] = [
  ['down', []], ['down', ['--file', '$A_FILE']], ['down', ['--file=$B_FILE']],
  ['down', ['--file', '$MISSING_FILE']], ['down', ['--session', 'beta']],
  ['down', ['--file', '$A_FILE', '--file=$B_FILE']], ['down', ['--file=$B_FILE', '--file', '$A_FILE']],
  ['down', ['--session', 'alpha', '--session=beta']], ['down', ['--session=beta', '--session', 'alpha']],
  ['send', ['worker', 'synthetic message']],
  ['send', ['--record', 'worker@beta', '--channel', 'native', '--ms', '1', 'synthetic message']],
  ['send', ['--record=$B_AGENT', '--channel=native', '--ms=1', 'synthetic message']],
  ['send', ['  $B_AGENT', 'synthetic message']], ['send', ['$B_AGENT  ', 'synthetic message']],
  ['send', [' \t$B_AGENT\t ', 'synthetic message']],
  ['send', ['--record', ' \t$B_AGENT\t ', '--channel', 'native', '--ms', '1', 'synthetic message']],
  ['status', ['--synthetic-future-selector=worker@beta']], ['seat', ['add', 'new-worker', '--like', 'worker']],
];
for (const [command, words] of scopedLines) {
  test(`alpha-only ${command} ${words.join(' ')} refuses before dispatch`, () => {
    const result = scene({ command, words, entities: ['alpha'] });
    stopped(result);
    expect(result.out + result.err).toContain(scopedMessage);
  });
}
for (const entities of [['alpha', 'beta'], ['*', 'alpha'], ['*', '*']]) {
  test(`entities ${JSON.stringify(entities)} are not exactly the wildcard list`, () => {
    const result = scene({ command: 'down', words: [], entities });
    stopped(result);
    expect(result.out + result.err).toContain(scopedMessage);
  });
}
const configWords = ['set', 'seats.worker.model', 'Revised Synthetic Model'];
for (const mode of ['config', 'up'] as const) {
  test(`alpha-only ${mode} refuses its own general admission`, () => {
    const result = scene({ command: mode, words: mode === 'config' ? configWords : ['--dry-run'], entities: ['alpha'], mode });
    stopped(result);
    expect(result.out + result.err).toContain(scopedMessage);
    if (mode === 'config') expect(result.storedModel).not.toContain('Revised Synthetic Model');
  });
}
const listedOps = ['config', 'restart', 'up', 'down', 'abandon', 'send', 'messages', 'reply'];
for (const [command, words] of [
  ['restart', ['worker']], ['down', []], ['down', ['--abandon']],
  ['send', ['worker', 'synthetic message']], ['messages', []], ['reply', ['r_synthetic', 'synthetic reply']],
] as [string, string[]][]) {
  test(`listed operations admit ${command} ${words.join(' ')}`, () => admitted(scene({ command, words, ops: listedOps })));
}
for (const [command, words] of [
  ['seat', ['add', 'new-worker', '--like', 'worker']], ['add', ['new-worker', '--like', 'worker']],
  ['status', []], ['daemon', ['install', '--dry-run']], ['grant', []], ['lock', []],
] as [string, string[]][]) {
  test(`listed operations refuse ${command} ${words.join(' ')}`, () => stopped(scene({ command, words, ops: listedOps })));
}
for (const [words, ops, allowed] of [
  [[], ['down'], true], [['--abandon'], ['abandon'], true],
  [['--abandon'], ['down'], false], [[], ['abandon'], false],
] as [string[], string[], boolean][]) {
  test(`down ${words.join(' ')} needs its operation ${ops.join(',')}`, () => {
    const result = scene({ command: 'down', words, ops });
    if (allowed) admitted(result); else stopped(result);
  });
}
for (const words of [
  ['--abandon', '--abandon'], ['--abandon', '--file', '$A_FILE', '--abandon'],
  ['--abandon=true'], ['--abandon=false'], ['--abandon='],
]) {
  test(`ambiguous operation flag ${words.join(' ')} refuses even full wildcard`, () => stopped(scene({ command: 'down', words })));
}
for (const ops of [listedOps, ['*']]) {
  test(`config actual seat edit works with operations ${ops.join(',')}`, () => {
    const result = scene({ command: 'config', words: configWords, ops, mode: 'config' });
    expect(result.code, result.out + result.err).toBe(0);
    expect(result.storedModel).toContain('Revised Synthetic Model');
    expect(result.originalFile).not.toContain('Revised Synthetic Model');
    expect(result.err).toContain('admitted by general grant');
  });
  test(`up actual dry run works with operations ${ops.join(',')}`, () => {
    const result = scene({ command: 'up', words: ['--dry-run'], ops, mode: 'up' });
    expect(result.code, result.out + result.err).toBe(0);
    expect(result.out + result.err).toContain('admitted by general grant');
    expect(result.upReads).toBeGreaterThan(0);
  });
}
for (const mode of ['config', 'up'] as const) {
  test(`${mode} own admission refuses an unlisted operation`, () => {
    const result = scene({ command: mode, words: mode === 'config' ? configWords : ['--dry-run'], ops: ['send'], mode });
    stopped(result);
    expect(result.out + result.err).toContain(`does not cover ${mode}`);
  });
}
test('full wildcard daemon install dry run plans once and never installs', () => {
  const result = scene({ command: 'daemon', words: ['install', '--dry-run', '--root', '$B_ROOT'], mode: 'daemon' });
  expect(result.code, result.out + result.err).toBe(0);
  expect(result.calledAs?.kind).toBe('owner');
  expect(result.servicePlans).toBe(1);
  expect(result.serviceInstalls).toBe(0);
  expect(result.out).toContain('would install');
});
test('full wildcard admits down abandon', () => admitted(scene({ command: 'down', words: ['--abandon'] })));

for (const [command, words] of [
  ['init', ['--request']], ['init', ['--approvals']],
  ['config', [...configWords, '--request']], ['config', ['keys']],
] as [string, string[]][]) {
  test(`alpha-only own admission ${command} ${words.join(' ')} stops before command loading`, () => {
    const result = scene({ command, words, entities: ['alpha'] });
    stopped(result);
    expect(result.out + result.err).toContain(scopedMessage);
    expect(result.storeChanges).toEqual([]);
  });
}
for (const [command, words] of [
  ['init', ['--request']], ['init', ['--approvals']],
  ['config', [...configWords, '--request']], ['up', ['--request']],
] as [string, string[]][]) {
  test(`wildcard own admission ${command} ${words.join(' ')} is a usage refusal`, () => {
    const result = scene({ command, words });
    expect(result.code, result.out + result.err).toBe(2);
    expect(result.calls).toBe(0);
    expect(result.marker).toBe(false);
    expect(result.out + result.err).toContain('--general is its own door');
    expect(result.storeChanges).toEqual([]);
  });
}
