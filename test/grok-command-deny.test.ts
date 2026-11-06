// Generated settings and recorded launch words only. No agent CLI is started.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildSchema } from '../scripts/schema.ts';
import { grokCommandDenyNotes } from '../src/launch/grok-command-deny.ts';
import { resolvePolicy } from '../src/policy/resolve.ts';
import { getPolicySpec, normalizePolicyName, type Policy } from '../src/policy/types.ts';
import { shellQuote } from '../src/profiles/profile.ts';
import { cursorCommandDenyConfig, grokCommandDenyArgs, parseGrokCommandDeny } from '../src/settings/grok-command-deny.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';
import { validateAgainstJsonSchema } from './helpers/output.ts';

const NAME = 'grok-command-deny';
const NOW = new Date('2026-11-06T21:00:00Z');
const CURSOR = { name: 'worker', cli: 'cursor', model: 'Grok' };
const NATIVE = { name: 'native', cli: 'grok', model: 'Grok' };
const roots: string[] = [];
afterEach(() => {
  const held = roots.splice(0);
  discardFixtures(held, { roots: held.map(dirname) });
});

test('the team-only policy is off by default and accepts only its three words', () => {
  const spec = getPolicySpec(NAME);
  expect(spec).not.toBeNull();
  expect(spec?.levels).toEqual(['team']);
  expect(spec?.defaultValue).toBe('off');
  expect(normalizePolicyName('grok_command_deny')).toBe(NAME);
  for (const word of ['off', 'git', 'git-and-tests'] as const) expect(parseGrokCommandDeny(word)).toBe(word);
  for (const word of ['on', 'tests', true, {}, ['git']]) expect(parseGrokCommandDeny(word)).toBeNull();
  expect(resolvePolicy(NAME, [], { now: NOW })).toMatchObject({ ok: true, effective: { value: 'off' } });
});

test('team declarations resolve and expired or wrong-level declarations do not govern a seat', () => {
  const declared: Policy = { name: NAME, value: 'git', level: 'team', setter: 'owner', date: NOW.toISOString(), kind: 'enforced' };
  expect(resolvePolicy(NAME, [declared], { now: NOW })).toMatchObject({ ok: true, effective: { value: 'git', level: 'team' } });
  expect(resolvePolicy(NAME, [{ ...declared, expiry: NOW.toISOString() }], { now: NOW })).toMatchObject({ ok: true, effective: { value: 'off' } });
  for (const level of ['entity', 'project', 'seat'] as const) {
    expect(resolvePolicy(NAME, [{ ...declared, level }], { now: NOW }).ok).toBe(false);
  }
});

test('the team schema bounds the new signed value and still requires a signature', () => {
  const fragment = (buildSchema().properties as Record<string, any>).policies;
  const entry = { value: 'git', setter: 'owner', date: NOW.toISOString(), kind: 'enforced', generation: 1, signature: 'fixture' };
  expect(fragment.properties?.[NAME]?.properties?.value?.enum).toEqual(['off', 'git', 'git-and-tests']);
  expect(validateAgainstJsonSchema({ [NAME]: entry }, fragment)).toEqual([]);
  expect(validateAgainstJsonSchema({ [NAME]: { ...entry, value: 'tests' } }, fragment).length).toBeGreaterThan(0);
  const { signature: _signature, ...unsigned } = entry;
  expect(validateAgainstJsonSchema({ [NAME]: unsigned }, fragment).length).toBeGreaterThan(0);
});

test('Cursor generation preserves other settings, adds deny tokens once and leaves input unchanged', () => {
  const original = { version: 1, permissions: { allow: ['Shell(git)'], deny: ['Read(.env*)'] }, editor: { vimMode: true } };
  const before = JSON.stringify(original);
  const git = cursorCommandDenyConfig('git', original);
  expect(git).toEqual({ ...original, permissions: { allow: ['Shell(git)'], deny: ['Read(.env*)', 'Shell(git)'] } });
  const both = cursorCommandDenyConfig('git-and-tests', git);
  expect(both).toEqual({ ...original, permissions: { allow: ['Shell(git)'], deny: ['Read(.env*)', 'Shell(git)', 'Shell(bun test)'] } });
  expect(cursorCommandDenyConfig('git-and-tests', both)).toEqual(both);
  expect(cursorCommandDenyConfig('off', original)).toEqual(original);
  expect(cursorCommandDenyConfig('off')).toEqual({});
  expect(JSON.stringify(original)).toBe(before);
});

test('generation refuses malformed Cursor settings instead of dropping a prior rule', () => {
  for (const value of [null, [], { permissions: 'deny' }, { permissions: { deny: 'Shell(git)' } }, { permissions: { deny: [7] } }]) {
    expect(() => cursorCommandDenyConfig('git', value)).toThrow();
  }
});

test('native Grok generation denies the bare commands and their argument forms', () => {
  expect(grokCommandDenyArgs('off')).toEqual([]);
  expect(grokCommandDenyArgs('git')).toEqual(['--deny', 'Bash(git)', '--deny', 'Bash(git *)']);
  expect(grokCommandDenyArgs('git-and-tests')).toEqual(['--deny', 'Bash(git)', '--deny', 'Bash(git *)', '--deny', 'Bash(bun test)', '--deny', 'Bash(bun test *)']);
});

test('off and other models read no config, and an unknown folder is named without a shared-folder fallback', () => {
  let reads = 0;
  const read = () => { reads++; return {}; };
  expect(grokCommandDenyNotes('off', [CURSOR, NATIVE], {}, read)).toEqual([]);
  expect(grokCommandDenyNotes('git', [{ ...CURSOR, model: 'GPT Sol' }, { ...CURSOR, name: 'human', human: true }], {}, read)).toEqual([]);
  const gaps = grokCommandDenyNotes('git', [CURSOR], {}, read);
  expect(gaps.join('\n')).toContain('worker');
  expect(gaps.join('\n')).toContain('no recorded launch folder');
  expect(grokCommandDenyNotes('git', [CURSOR], { worker: { start_cwd: 'relative' } }, read).join('\n')).toContain('no recorded launch folder');
  expect(reads).toBe(0);
});

test('Cursor checks require the requested deny entries, never entries in allow', () => {
  const records = { worker: { start_cwd: '/synthetic/worker' } };
  const missing = grokCommandDenyNotes('git', [CURSOR], records, () => ({ permissions: { allow: ['Shell(git)'] } }));
  expect(missing.join('\n')).toContain('worker');
  expect(missing.join('\n')).toContain('Shell(git)');
  expect(grokCommandDenyNotes('git', [CURSOR], records, () => cursorCommandDenyConfig('git'))).toEqual([]);
  expect(grokCommandDenyNotes('git-and-tests', [CURSOR], records, () => cursorCommandDenyConfig('git')).join('\n')).toContain('Shell(bun test)');
  expect(grokCommandDenyNotes('git-and-tests', [CURSOR], records, () => cursorCommandDenyConfig('git-and-tests'))).toEqual([]);
  expect(grokCommandDenyNotes('git', [CURSOR], records, () => ({ permissions: { deny: ['Shell(git)', 7] } })).join('\n')).toContain('worker');
});

test('native checks decode real deny arguments and ignore prompt text and words after the delimiter', () => {
  const line = `grok ${grokCommandDenyArgs('git-and-tests').map(shellQuote).join(' ')}`;
  expect(grokCommandDenyNotes('git-and-tests', [NATIVE], { native: { launch_line: line } })).toEqual([]);
  for (const bad of ['grok', `grok --rules ${shellQuote(line)}`, `grok -- ${line}`]) {
    const gaps = grokCommandDenyNotes('git', [NATIVE], { native: { launch_line: bad } });
    expect(gaps.join('\n')).toContain('native');
    expect(gaps.join('\n')).toContain('--deny');
  }
});

test('the config reader stays read-only and refuses missing, malformed or linked Cursor files', () => {
  const base = fixtureBase('grok-command-deny-'); roots.push(base);
  const folder = join(base, 'worker'); const cursor = join(folder, '.cursor'); const file = join(cursor, 'cli.json');
  mkdirSync(cursor, { recursive: true });
  const records = { worker: { start_cwd: folder } };
  expect(grokCommandDenyNotes('git', [CURSOR], records).join('\n')).toContain('worker');
  const bytes = `${JSON.stringify(cursorCommandDenyConfig('git'))}\n`;
  writeFileSync(file, bytes);
  expect(grokCommandDenyNotes('git', [CURSOR], records)).toEqual([]);
  expect(readFileSync(file, 'utf8')).toBe(bytes);
  writeFileSync(file, '{broken');
  expect(grokCommandDenyNotes('git', [CURSOR], records).join('\n')).toContain('worker');
  writeFileSync(file, JSON.stringify({ ...cursorCommandDenyConfig('git'), padding: 'x'.repeat(64 * 1024) }));
  expect(grokCommandDenyNotes('git', [CURSOR], records).join('\n')).toContain('worker');
  writeFileSync(file, bytes);
  const linked = join(base, 'linked'); mkdirSync(join(linked, '.cursor'), { recursive: true });
  const target = join(base, 'target.json'); writeFileSync(target, bytes); symlinkSync(target, join(linked, '.cursor', 'cli.json'));
  expect(grokCommandDenyNotes('git', [CURSOR], { worker: { start_cwd: linked } }).join('\n')).toContain('worker');
  const linkedFolder = join(base, 'linked-folder'); mkdirSync(linkedFolder);
  symlinkSync(cursor, join(linkedFolder, '.cursor'));
  expect(grokCommandDenyNotes('git', [CURSOR], { worker: { start_cwd: linkedFolder } }).join('\n')).toContain('worker');
  expect(readFileSync(target, 'utf8')).toBe(bytes);
});
