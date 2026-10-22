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
  const needle = "['restore', 'json', 'request', 'approvals'])";
  expect(source).toContain(needle);
  const broken = source.replace(needle, "['restore', 'json', 'request', 'approvals', 'force'])");
  const result = checkContract(root, new Map([[rel, broken]]));
  expect(result.ok).toBe(false);
  expect(result.message).toContain('--force');
  expect(result.message).toContain('contract/cli.json');
  expect(result.message).toContain('docs/reference/cli.md');
  expect(result.message).toContain('contract:check: failed');
});

test('a command with two parser forms carries both usage lines and the union of their flags', () => {
  const contract = JSON.parse(readFileSync(join(root, 'contract/cli.json'), 'utf8')) as {
    commands: {
      name: string;
      usage: string[];
      flags: { name: string; takesValue: boolean; hidden: boolean }[];
    }[];
  };
  const messages = contract.commands.find((command) => command.name === 'messages');
  expect(messages?.usage).toEqual([
    'team messages [--json]',
    'team messages --client <grant-file> --key <key-file> [--since <id>] [--ack <id>] [--limit <n>] [--request-id <id>] [--json]',
  ]);
  // The flags are the union of the two readArgs calls, never a whitelist: the client form's six
  // valued options and the --json switch both forms share.
  expect((messages?.flags ?? []).filter((flag) => !flag.hidden).map((flag) => [flag.name, flag.takesValue])).toEqual([
    ['--ack', true],
    ['--client', true],
    ['--help', false],
    ['--json', false],
    ['--key', true],
    ['--limit', true],
    ['--request-id', true],
    ['--since', true],
  ]);
  expect((messages?.flags ?? []).filter((flag) => flag.hidden).map((flag) => flag.name)).toEqual(['-h']);
});

test('a parser form the usage lines do not declare is refused', () => {
  const rel = 'src/commands/messages.ts';
  const source = readFileSync(join(root, rel), 'utf8');
  const needle = ' [--request-id <id>]';
  expect(source).toContain(needle);
  const broken = source.replace(needle, '');
  let message = '';
  try {
    renderContract(root, new Map([[rel, broken]]));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('--request-id');
  expect(message).toContain('has no usage line declaring that form');
});

test('an option that is a value in one parser form and a switch in another is refused', () => {
  const rel = 'src/commands/messages.ts';
  const source = readFileSync(join(root, rel), 'utf8');
  const needle = "readArgs(argv, [], ['json'])";
  expect(source).toContain(needle);
  const broken = source.replace(needle, "readArgs(argv, [], ['json', 'request-id'])");
  expect(() => renderContract(root, new Map([[rel, broken]]))).toThrow(/--request-id is both a value and a boolean/);
});

test('two parser forms of the same shape are refused as ambiguous', () => {
  const rel = 'src/commands/messages.ts';
  const source = readFileSync(join(root, rel), 'utf8');
  const needle = "readArgs(argv, [], ['json'])";
  expect(source).toContain(needle);
  const broken = source.replace(
    needle,
    "readArgs(argv, ['client', 'key', 'since', 'ack', 'limit', 'request-id'], ['json'])",
  );
  expect(() => renderContract(root, new Map([[rel, broken]]))).toThrow(/two readArgs calls declare the same form/);
});

test('the check script exits 0 on this tree', () => {
  const result = spawnSync('bun', ['scripts/contract.ts', '--check'], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('contract:check: contract/cli.json and docs/reference/cli.md are current');
});

test('every command and subcommand carries who may run it, and the map rows are copied as they stand', () => {
  const contract = JSON.parse(readFileSync(join(root, 'contract/cli.json'), 'utf8')) as {
    commands: {
      name: string;
      who?: { gate: string; why: string; terminal?: { who: string; where: string } };
      subcommands: { name: string; who?: { gate: string; why: string; terminal?: { who: string; where: string } } }[];
    }[];
  };
  const byName = (name: string) => contract.commands.find((command) => command.name === name);
  const nodes = contract.commands.flatMap((command) => [
    { key: command.name, node: command },
    ...command.subcommands.map((sub) => ({ key: `${command.name}:${sub.name}`, node: sub })),
  ]);
  // Every word of the CLI, hidden ones, the help words and every verb included, states its row:
  // the adapter that generates access rules reads this field and must never meet a word without
  // one. A word the map does not name is a failure, never a silent "unlisted".
  for (const { key, node } of nodes) {
    expect(node.who, `${key} has no who row`).toBeDefined();
    expect(node.who?.gate, `${key} names no gate`).not.toBe('');
    expect(node.who?.why, `${key} gives no reason`).not.toBe('');
    expect(node.who?.gate, `${key} is unlisted: the map must hold a row for every word`).not.toBe('unlisted');
  }
  // Both sides agree: a dropped map row is caught as a contract row without a rule, and a
  // reworded map row is caught as a copy that no longer matches the code's own sentence.
  for (const { key, node } of nodes) {
    const gate = COMMAND_GATES[key];
    if (gate === undefined) {
      expect(gate, `${key} is in the contract but the map holds no row for it`).toBeDefined();
      continue;
    }
    expect(node.who, `${key} is in the map but the contract does not repeat its row`).toEqual({
      gate: gate.kind,
      why: gate.why,
      ...(gate.terminal !== undefined ? { terminal: gate.terminal } : {}),
    });
  }
  expect(byName('up')?.who?.gate).toBe('owner-or-leads');
  expect(byName('add')?.who?.gate).toBe('owner-only');
  expect(byName('status')?.who?.gate).toBe('seat-record');
  expect(byName('send')?.who?.gate).toBe('admission');
  expect(byName('answer')?.who?.gate).toBe('pane-authority');
  // The map now names every word, including those whose modules refuse non-owners outright.
  expect(byName('broker')?.who?.gate).toBe('owner-only');
  expect(byName('bus')?.who?.gate).toBe('owner-only');
  expect(byName('tempo')?.who?.gate).toBe('owner-only');
  expect(byName('help')?.who?.gate).toBe('any-caller');
  expect(byName('drops')?.who?.gate).toBe('seat-only');
  expect(byName('raise')?.who?.gate).toBe('leads-only');
  // A verb whose gate differs from its command's carries its own row.
  const sub = (command: string, verb: string) => byName(command)?.subcommands.find((word) => word.name === verb);
  expect(sub('policy', 'set')?.who?.gate).toBe('owner-only');
  expect(byName('policy')?.who?.gate).toBe('team-read');
  expect(sub('mcp', 'serve')?.who?.gate).toBe('any-caller');
  expect(sub('proc', 'list')?.who?.gate).toBe('team-read');
  expect(sub('worktree', 'remove')?.who?.gate).toBe('team-change');
  // `pause` and `resume` are the orchestrator's lever on the team: the owner or the
  // orchestrator's seat, never the operator, with the route their modules' `detachedRefusal`
  // prints. `sessions` reads the machine-wide session registry and asks for no caller.
  for (const word of ['pause', 'resume']) {
    expect(byName(word)?.who?.gate).toBe('team-pause');
    expect(byName(word)?.who?.terminal).toEqual({
      who: 'the owner or the orchestrator',
      where: 'a terminal outside herdr or its own seat',
    });
  }
  expect(byName('sessions')?.who?.gate).toBe('any-caller');
  expect(byName('sessions')?.who?.terminal).toBeUndefined();
  // A row whose module refuses a run with no terminal carries the route that refusal prints,
  // beside a kind that reads wider: `watch` is any caller, and only a caller with a terminal or
  // its own pane starts it.
  expect(byName('watch')?.who?.gate).toBe('any-caller');
  expect(byName('watch')?.who?.terminal).toEqual({
    who: 'the owner or a placed seat',
    where: 'a terminal outside herdr or its own pane',
  });
  expect(sub('proc', 'list')?.who?.terminal).toBeUndefined();
  expect(byName('proc')?.who?.terminal).toEqual({
    who: 'the owner or a seat of this team',
    where: 'a terminal outside herdr or its own pane',
  });
});

test('the reference page states the same who row the contract carries', () => {
  const contract = JSON.parse(readFileSync(join(root, 'contract/cli.json'), 'utf8')) as {
    commands: {
      name: string;
      who: { gate: string; why: string; terminal?: { who: string; where: string } };
      subcommands: { name: string; who: { gate: string; why: string; terminal?: { who: string; where: string } } }[];
    }[];
  };
  const page = readFileSync(join(root, 'docs/reference/cli.md'), 'utf8');
  const words = contract.commands.flatMap((command) => [command, ...command.subcommands]);
  expect(page.split('\n').filter((line) => /^#{3,4} Who may run it$/.test(line)).length).toBe(words.length);
  const up = contract.commands.find((command) => command.name === 'up');
  expect(page).toContain(`\`${up?.who.gate}\` — ${up?.who.why}`);
  // A subcommand states its own row, never the command's standing in for it.
  const policy = contract.commands.find((command) => command.name === 'policy');
  const set = policy?.subcommands.find((word) => word.name === 'set');
  expect(page).toContain(`\`${set?.who.gate}\` — ${set?.who.why}`);
  // A terminal requirement is stated beside the kind, in the sentence `detachedRefusal` prints.
  const watch = contract.commands.find((command) => command.name === 'watch');
  expect(watch?.who.terminal).toBeDefined();
  expect(page).toContain(
    `A run with no terminal is refused: only ${watch?.who.terminal?.who} runs this, from ${watch?.who.terminal?.where}`,
  );
});
