import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkContract, renderContract } from '../../scripts/contract.ts';

const root = join(import.meta.dir, '..', '..');

test('the checked-in contract matches the command definitions', () => {
  const result = checkContract(root);
  expect(result.ok).toBe(true);
  expect(result.message).toBe('contract:check: contract/cli.json and docs/reference/cli.md are current');
});

test('rendering twice is the same text', () => {
  expect(renderContract(root)).toEqual(renderContract(root));
});

test('hidden commands and undocumented short flags are marked', () => {
  const contract = JSON.parse(readFileSync(join(root, 'contract/cli.json'), 'utf8')) as {
    program: { flags: { name: string; hidden: boolean; repeatable: boolean }[] };
    commands: {
      name: string;
      hidden: boolean;
      flags: { name: string; hidden: boolean }[];
      positionals: { name: string; optional: boolean; repeatable: boolean }[];
      subcommands: { name: string }[];
    }[];
  };
  const byName = (name: string) => contract.commands.find((command) => command.name === name);
  expect(byName('conformance-adapter')?.hidden).toBe(true);
  expect(byName('help')?.hidden).toBe(true);
  expect(byName('init')?.flags.find((flag) => flag.name === '--restore')?.hidden).toBe(false);
  expect(byName('init')?.flags.find((flag) => flag.name === '--help')?.hidden).toBe(false);
  expect(byName('init')?.flags.find((flag) => flag.name === '-h')?.hidden).toBe(true);
  expect(contract.program.flags.find((flag) => flag.name === '-V')?.hidden).toBe(true);
  expect(contract.program.flags.every((flag) => flag.repeatable === false)).toBe(true);
  expect(byName('worktree')?.subcommands.map((sub) => sub.name)).toEqual(['list', 'new', 'remove']);
  expect(byName('add')?.positionals).toEqual([{ name: 'name', optional: true, repeatable: false }]);
  const json = readFileSync(join(root, 'contract/cli.json'), 'utf8');
  expect(json.includes('/Users/')).toBe(false);
  expect(json.includes('/home/')).toBe(false);
  expect(json.includes('\\')).toBe(false);
  expect(json.endsWith('\n')).toBe(true);
});

test('contract:check fails when a command option list is broken by hand', () => {
  const rel = 'src/commands/init.ts';
  const source = readFileSync(join(root, rel), 'utf8');
  const needle = "readArgs(argv, ['from-archive'], ['restore'])";
  expect(source).toContain(needle);
  const broken = source.replace(needle, "readArgs(argv, ['from-archive', 'force'], ['restore'])");
  const result = checkContract(root, new Map([[rel, broken]]));
  expect(result.ok).toBe(false);
  expect(result.message).toContain('--force');
  expect(result.message).toContain('contract/cli.json');
  expect(result.message).toContain('docs/reference/cli.md');
  expect(result.message).toContain('contract:check: failed');
});

test('the check script exits 0 on this tree', () => {
  const result = spawnSync('bun', ['scripts/contract.ts', '--check'], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('contract:check: contract/cli.json and docs/reference/cli.md are current');
});
