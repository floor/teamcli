// Independent scenes for `team launchers migrate` loader errors and usage on a direct child of
// the launchers withoutFileOffer fix. All homes, repositories, sessions and seats are synthetic
// under disjoint fixture roots; no real home, credential store or environment is read.
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { runLaunchers, USAGE } from '../src/commands/launchers.ts';
import { NOT_A_REPO_NO_FILE } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

let scratchParent: string | undefined;
const made: string[] = [];

afterEach(() => {
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

function openScratch(): { base: string; home: string; outside: string; repo: string } {
  const base = fixtureBase('launchers-no-file-');
  scratchParent ??= dirname(base);
  made.push(base);
  const home = join(base, 'home');
  const outside = join(base, 'outside');
  const repo = join(base, 'repo');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(lobbyDir(home), { mode: 0o700 });
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(repo, '.agents'), { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { stdio: 'ignore', env: gitEnv() });
  return { base, home, outside, repo };
}

function useFileSource(home: string): void {
  writeFileSync(join(home, '.config', 'team', 'settings.yaml'), 'team-config.source: file\n');
}

describe('team launchers migrate loader errors and subcommand handling', () => {
  test('outside a checkout, team launchers migrate exits 2 with no --file in its sentence (plain and --json)', async () => {
    const { home, outside } = openScratch();
    useFileSource(home);

    for (const argv of [['migrate'], ['migrate', '--dry-run']]) {
      const io = testIo(outside, { kind: 'owner' });
      const code = await runLaunchers(argv, io, home);
      expect(code).toBe(2);
      expect(io.out).toBe('');
      expect(io.err).toBe(`team launchers: ${NOT_A_REPO_NO_FILE}\n`);
      expect(io.err).not.toContain('--file');
    }

    for (const argv of [['migrate', '--json'], ['migrate', '--dry-run', '--json']]) {
      const io = testIo(outside, { kind: 'owner' });
      const code = await runLaunchers(argv, io, home);
      expect(code).toBe(2);
      expect(io.err).toBe('');
      expect(io.out).not.toContain('--file');
      expect(JSON.parse(io.out)).toEqual({
        schema: {
          name: 'team.error',
          version: 1,
        },
        error: {
          id: 'launchers.migrate',
          message: NOT_A_REPO_NO_FILE,
          repair: null,
        },
      });
    }
  });

  test('outside a checkout with a symlinked .agents/team.yaml, the link refusal omits --file and keeps the link detail', async () => {
    const { base, home, outside } = openScratch();
    useFileSource(home);
    mkdirSync(join(outside, '.agents'), { recursive: true });
    const target = join(base, 'linked-team.yaml');
    writeFileSync(target, 'format: 1\n');
    symlinkSync(target, join(outside, '.agents', 'team.yaml'));

    const expected = `${NOT_A_REPO_NO_FILE}: a link was found and not followed`;

    const plainIo = testIo(outside, { kind: 'owner' });
    expect(await runLaunchers(['migrate'], plainIo, home)).toBe(2);
    expect(plainIo.out).toBe('');
    expect(plainIo.err).toBe(`team launchers: ${expected}\n`);
    expect(plainIo.err).not.toContain('--file');

    const jsonIo = testIo(outside, { kind: 'owner' });
    expect(await runLaunchers(['migrate', '--json'], jsonIo, home)).toBe(2);
    expect(jsonIo.err).toBe('');
    expect(JSON.parse(jsonIo.out)).toEqual({
      schema: {
        name: 'team.error',
        version: 1,
      },
      error: {
        id: 'launchers.migrate',
        message: expected,
        repair: null,
      },
    });
  });

  test('a loader error inside a checkout keeps the shape it had before', async () => {
    const { home, repo } = openScratch();
    useFileSource(home);

    const missingIo = testIo(repo, { kind: 'owner' });
    expect(await runLaunchers(['migrate'], missingIo, home)).toBe(2);
    const missingMessage =
      'no team file here; it is private to each clone: run `team init`, or `team init --restore` to bring back the copy this machine stored';
    expect(missingIo.out).toBe('');
    expect(missingIo.err).toBe(`team launchers: ${missingMessage}\n`);

    const missingJsonIo = testIo(repo, { kind: 'owner' });
    expect(await runLaunchers(['migrate', '--json'], missingJsonIo, home)).toBe(2);
    expect(missingJsonIo.err).toBe('');
    expect(JSON.parse(missingJsonIo.out)).toEqual({
      schema: {
        name: 'team.error',
        version: 1,
      },
      error: {
        id: 'launchers.migrate',
        message: missingMessage,
        repair: null,
      },
    });

    writeFileSync(
      join(repo, '.agents', 'team.yaml'),
      'format: 99\nproject: ""\nsession: acme\nseats: []\n',
    );

    const invalidIo = testIo(repo, { kind: 'owner' });
    expect(await runLaunchers(['migrate', '--dry-run'], invalidIo, home)).toBe(2);
    expect(invalidIo.out).toBe('');
    expect(invalidIo.err.startsWith('team launchers: ')).toBe(true);
    expect(invalidIo.err.endsWith('\n')).toBe(true);
    const joinedMessage = invalidIo.err.slice('team launchers: '.length, -1);
    expect(joinedMessage).toContain('; ');
    expect(joinedMessage).not.toContain('--file');

    const invalidJsonIo = testIo(repo, { kind: 'owner' });
    expect(await runLaunchers(['migrate', '--dry-run', '--json'], invalidJsonIo, home)).toBe(2);
    expect(invalidJsonIo.err).toBe('');
    expect(JSON.parse(invalidJsonIo.out)).toEqual({
      schema: {
        name: 'team.error',
        version: 1,
      },
      error: {
        id: 'launchers.migrate',
        message: joinedMessage,
        repair: null,
      },
    });
  });

  test('team launchers without a subcommand and parser rejections are unchanged', async () => {
    const { home, outside } = openScratch();

    const barePlain = testIo(outside, { kind: 'owner' });
    expect(await runLaunchers([], barePlain, home)).toBe(2);
    expect(barePlain.out).toBe('');
    expect(barePlain.err).toBe(`team launchers: team launchers migrate [--dry-run] [--json]\n${USAGE}`);

    const bareJson = testIo(outside, { kind: 'owner' });
    expect(await runLaunchers(['--json'], bareJson, home)).toBe(2);
    expect(bareJson.err).toBe('');
    expect(JSON.parse(bareJson.out)).toEqual({
      schema: {
        name: 'team.error',
        version: 1,
      },
      error: {
        id: 'launchers.usage',
        message: 'team launchers migrate [--dry-run] [--json]',
        repair: 'team launchers migrate [--dry-run] [--json]',
      },
    });

    const wrongSub = testIo(outside, { kind: 'owner' });
    expect(await runLaunchers(['list'], wrongSub, home)).toBe(2);
    expect(wrongSub.err).toBe(`team launchers: team launchers migrate [--dry-run] [--json]\n${USAGE}`);

    const extraArg = testIo(outside, { kind: 'owner' });
    expect(await runLaunchers(['migrate', 'extra'], extraArg, home)).toBe(2);
    expect(extraArg.err).toBe(`team launchers: unexpected "extra"\n${USAGE}`);

    const fileFlag = testIo(outside, { kind: 'owner' });
    expect(await runLaunchers(['migrate', '--file', 'team.yaml'], fileFlag, home)).toBe(2);
    expect(fileFlag.err).toBe(`team launchers: unknown option --file\n${USAGE}`);
  });

  test('admission order is unchanged: a non-lead seat inside a valid checkout is refused with exit 1 after the loader succeeds', async () => {
    const { home, repo } = openScratch();
    useFileSource(home);
    const yaml = `format: 1
project: acme
session: session-acme
coordinator: lead-seat
operator: lead-seat
workspace:
  mode: shared
trust:
  - ${repo}
  - ${lobbyDir(home)}
seats:
  - role: coordinator
    name: lead-seat
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    display: "Claude Opus 5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
  - role: implementer
    name: worker-seat
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    display: "Claude Opus 5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
`;
    writeFileSync(join(repo, '.agents', 'team.yaml'), yaml);

    const workerIo = testIo(repo, {
      kind: 'seat',
      name: 'worker-seat',
      pane: 'pane-worker',
      session: 'session-acme',
    });
    expect(await runLaunchers(['migrate', '--dry-run'], workerIo, home)).toBe(1);
    expect(workerIo.err).toContain('only the owner, or a lead of this team, migrates its launchers');
  });
});
