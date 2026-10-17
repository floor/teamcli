import { expect, test } from 'bun:test';
import { commands, main, version } from '../src/cli.ts';
import type { Io } from '../src/io.ts';

function io(): Io & { out: string; err: string } {
  const state = {
    out: '',
    err: '',
    stdout(text: string) { state.out += text; },
    stderr(text: string) { state.err += text; },
    cwd: process.cwd(),
    env: {},
    stdinIsTTY: false,
  };
  return state;
}

test('--version prints the package version and --about prints version, licence, docs link, and NOT_PRETENDED', async () => {
  const run = io();
  expect(await main(['--version'], run)).toBe(0);
  expect(run.out.trim()).toBe(version());
  expect(version()).toMatch(/^\d+\.\d+\.\d+/);

  const about = io();
  expect(await main(['--about'], about)).toBe(0);
  expect(about.err).toBe('');
  expect(about.out).toContain(`team ${version()}`);
  expect(about.out).toContain('licence: MIT');
  expect(about.out).toContain('what 0.5.0 must not pretend:');
  expect(about.out).toContain('The checks in 0.5.0 stop mistakes, not an agent on this machine that runs as you and sets out to get around those checks.');

  const aboutJson = io();
  expect(await main(['--about', '--json'], aboutJson)).toBe(0);
  expect(aboutJson.err).toBe('');
  const parsed = JSON.parse(aboutJson.out) as {
    schema: { name: string; version: number };
    version: string;
    licence: string;
    must_not_pretend: Array<{ text: string; ref: string }>;
  };
  expect(parsed.schema).toEqual({ name: 'team.about', version: 1 });
  expect(parsed.version).toBe(version());
  expect(parsed.licence).toBe('MIT');
  expect(parsed.must_not_pretend).toHaveLength(5);
  expect(parsed.must_not_pretend[0]).toEqual({
    text: 'The checks in 0.5.0 stop mistakes, not an agent on this machine that runs as you and sets out to get around those checks.',
    ref: 'Kernel §11, §12, §14',
  });
});

test('--help prints the usage and exits 0; no command exits 2', async () => {
  const help = io();
  expect(await main(['--help'], help)).toBe(0);
  expect(help.out).toContain('Usage: team <command>');
  expect(await main([], io())).toBe(2);
});

test('an unknown command is an error', async () => {
  const run = io();
  expect(await main(['frobnicate'], run)).toBe(2);
  expect(run.err).toContain('unknown command "frobnicate"');
});

test('check is a command of this build', async () => {
  const run = io();
  expect(await main(['check', '--help'], run)).toBe(0);
  expect(run.out).toStartWith('Usage: team check [--session <name>] [--file <path>]');
  const help = io();
  await main(['--help'], help);
  expect(help.out).toContain('\n  check\n');
});

test('every command of the table takes --help and -h, and prints its usage', async () => {
  const table = Object.entries(commands);
  expect(table.length).toBeGreaterThan(0);
  for (const [name, load] of table) {
    const usage = (await load()).USAGE;
    for (const flag of ['--help', '-h']) {
      const run = io();
      expect(await main([name, flag], run)).toBe(0);
      expect(run.out).toBe(usage);
      const first = run.out.split('\n')[0] ?? '';
      expect(first).toMatch(new RegExp(`^Usage: team ${name}\\b`));
    }
  }
});

