import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMAND_GATES } from '../../src/permissions/map.ts';
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
  const needle = "readArgs(argv, [], ['restore', 'json'])";
  expect(source).toContain(needle);
  const broken = source.replace(needle, "readArgs(argv, [], ['restore', 'json', 'force'])");
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

test('every command carries who may run it, and the map rows are copied as they stand', () => {
  const contract = JSON.parse(readFileSync(join(root, 'contract/cli.json'), 'utf8')) as {
    commands: { name: string; who?: { gate: string; why: string } }[];
  };
  const byName = (name: string) => contract.commands.find((command) => command.name === name);
  // Every word of the CLI, hidden ones and the help words included, states its row: the adapter
  // that generates access rules reads this field and must never meet a command without one.
  for (const command of contract.commands) {
    expect(command.who, `${command.name} has no who row`).toBeDefined();
    expect(command.who?.gate, `${command.name} names no gate`).not.toBe('');
    expect(command.who?.why, `${command.name} gives no reason`).not.toBe('');
  }
  // The two sides agree in both directions: a map row the contract lacks hidden as a stale copy,
  // and a contract row the map dropped would be a rule that no longer exists in the code.
  for (const command of contract.commands) {
    const gate = COMMAND_GATES[command.name];
    if (command.who?.gate === 'unlisted') {
      expect(gate, `${command.name} is unlisted, but the map now holds a row for it`).toBeUndefined();
      continue;
    }
    if (gate === undefined) {
      expect(gate, `${command.name} claims a gate the map does not hold`).toBeDefined();
      continue;
    }
    expect(command.who, `${command.name} is in the map but the contract does not repeat its row`).toEqual({
      gate: gate.kind,
      why: gate.why,
    });
  }
  expect(byName('up')?.who?.gate).toBe('owner-or-leads');
  expect(byName('add')?.who?.gate).toBe('owner-only');
  expect(byName('status')?.who?.gate).toBe('seat-record');
  expect(byName('send')?.who?.gate).toBe('admission');
  expect(byName('answer')?.who?.gate).toBe('pane-authority');
  // A word the map does not name is `unlisted`, never open: the map's silence admits no one.
  expect(byName('broker')?.who?.gate).toBe('unlisted');
  expect(byName('help')?.who?.gate).toBe('unlisted');
});

test('the reference page states the same who row the contract carries', () => {
  const contract = JSON.parse(readFileSync(join(root, 'contract/cli.json'), 'utf8')) as {
    commands: { name: string; who: { gate: string; why: string } }[];
  };
  const page = readFileSync(join(root, 'docs/reference/cli.md'), 'utf8');
  expect(page.split('\n').filter((line) => line === '### Who may run it').length).toBe(contract.commands.length);
  expect(page).toContain(`\`${contract.commands.find((command) => command.name === 'up')?.who.gate}\` — ${contract.commands.find((command) => command.name === 'up')?.who.why}`);
});
