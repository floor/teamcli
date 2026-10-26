// `team doctor --jules`: the two reads that answer whether the Jules CLI, the owner's Google
// login, the GitHub link and this project's repository are in place — and which step is missing
// when they are not. Every answer here is a fixture: no test runs `jules`, runs `git`, or touches
// a network, and the sources a mode does not need are functions that throw if they are read.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubOrigin, runDoctor, type CommandRead, type DoctorSources } from '../src/commands/doctor.ts';
import { testIo } from './helpers.ts';

const EXAMPLE = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-04T09:00:00Z');

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-jdf-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const untouched = (): never => {
  throw new Error('a source this mode does not need was read');
};

type Answers = (binary: string, args: string[]) => CommandRead | null;

/** The sources `--jules` is allowed to read, and a record of every command it ran. `version`,
 *  `loggedIn` and herdr's three reads throw: the flag must never touch them. The approval store's
 *  one read is the shared preamble of every doctor mode (the file's own read shape) and is stubbed
 *  here so the test never opens the real store. */
function sources(options: { onPath?: boolean; answers?: Answers } = {}): { doctor: DoctorSources; calls: string[] } {
  const calls: string[] = [];
  const doctor: DoctorSources = {
    version: untouched,
    onPath: () => options.onPath ?? true,
    loggedIn: untouched,
    herdrVersion: untouched,
    sessionRunning: untouched,
    now: () => NOW,
    home,
    standing: () => ({ kind: 'none' }),
    command(binary, args) {
      calls.push(`${binary} ${args.join(' ')}`);
      return options.answers ? options.answers(binary, args) : null;
    },
  };
  return { doctor, calls };
}

async function run(doctor: DoctorSources): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root);
  const code = await runDoctor(['--jules'], io, doctor);
  return { code, out: io.out, err: io.err };
}

describe('the missing steps, one at a time', () => {
  test('the CLI is not on the PATH: the install step is named, and nothing is run', async () => {
    const { doctor, calls } = sources({ onPath: false });
    const { code, out, err } = await run(doctor);
    expect(code).toBe(1);
    expect(out).toBe(
      "MISS  install the Jules CLI: `npm install -g @google/jules` — the owner's step\n"
      + 'team doctor: 1 missing, 0 warnings\n',
    );
    expect(err).toBe('');
    expect(calls).toEqual([]);
  });

  test('the call fails: the login and the GitHub link are one step, with the line the CLI printed', async () => {
    const { doctor, calls } = sources({
      answers: () => ({ status: 1, stdout: '', stderr: 'Error: 401 Unauthorized: sign in first\nmore detail\n' }),
    });
    const { code, out } = await run(doctor);
    expect(code).toBe(1);
    expect(out).toBe(
      "MISS  log in to Jules and link it to GitHub: `jules login` — the owner's step\n"
      + 'note  jules said: Error: 401 Unauthorized: sign in first\n'
      + 'team doctor: 1 missing, 0 warnings\n',
    );
    // One call: the repository is not asked about until the login answers.
    expect(calls).toEqual(['jules remote list --repo']);
  });

  test('the call cannot be run at all: the same step, and no line to repeat', async () => {
    const { doctor, calls } = sources();
    const { code, out } = await run(doctor);
    expect(code).toBe(1);
    expect(out).toBe(
      "MISS  log in to Jules and link it to GitHub: `jules login` — the owner's step\n"
      + 'team doctor: 1 missing, 0 warnings\n',
    );
    expect(calls).toEqual(['jules remote list --repo']);
  });

  test('a line the CLI printed on standard output is repeated when standard error is empty', async () => {
    const { doctor } = sources({ answers: () => ({ status: 2, stdout: '\njules: the token expired\n', stderr: '' }) });
    const { out } = await run(doctor);
    expect(out).toContain('note  jules said: jules: the token expired\n');
  });
});

describe('the project repository', () => {
  const LISTED: CommandRead = { status: 0, stdout: 'floor/agents\nfloor/teamcli\nfloor/welcome\n', stderr: '' };
  const ORIGIN: CommandRead = { status: 0, stdout: 'git@github.com:floor/teamcli.git\n', stderr: '' };

  test('logged in, linked, and listed: two ok lines, exit 0, and the origin remote read once', async () => {
    const { doctor, calls } = sources({ answers: (binary) => (binary === 'jules' ? LISTED : ORIGIN) });
    const { code, out, err } = await run(doctor);
    expect(code).toBe(0);
    expect(out).toBe(
      'ok    jules: logged in, with GitHub linked\n'
      + 'ok    jules: floor/teamcli is connected\n'
      + 'team doctor: nothing missing, 0 warnings\n',
    );
    expect(err).toBe('');
    expect(calls).toEqual(['jules remote list --repo', `git -C ${root} remote get-url origin`]);
  });

  test('the repository is not in the list: the connect step is named, exit 1', async () => {
    const listed: CommandRead = { status: 0, stdout: 'floor/agents\nfloor/welcome\n', stderr: '' };
    const { doctor } = sources({ answers: (binary) => (binary === 'jules' ? listed : ORIGIN) });
    const { code, out } = await run(doctor);
    expect(code).toBe(1);
    expect(out).toBe(
      'ok    jules: logged in, with GitHub linked\n'
      + "MISS  connect floor/teamcli to Jules: https://jules.google.com — the owner's step\n"
      + 'team doctor: 1 missing, 0 warnings\n',
    );
  });

  test('an https origin with a .git suffix is the same repository', async () => {
    const { doctor } = sources({
      answers: (binary) => (binary === 'jules' ? LISTED : { status: 0, stdout: 'https://github.com/floor/teamcli.git\n', stderr: '' }),
    });
    expect((await run(doctor)).out).toContain('ok    jules: floor/teamcli is connected\n');
  });

  test('a repository the origin remote cannot name: a note, never a guess', async () => {
    for (const origin of [
      { status: 0, stdout: 'https://gitlab.com/floor/teamcli.git\n', stderr: '' },
      { status: 128, stdout: '', stderr: 'error: No such remote origin\n' },
      { status: 0, stdout: '', stderr: '' },
      { status: 0, stdout: 'git@github.com:floor\n', stderr: '' },
    ]) {
      const { doctor } = sources({ answers: (binary) => (binary === 'jules' ? LISTED : origin) });
      const { code, out } = await run(doctor);
      expect(code).toBe(0);
      expect(out).toBe(
        'ok    jules: logged in, with GitHub linked\n'
        + "note  the project's github repository was not read from the origin remote\n"
        + 'team doctor: nothing missing, 0 warnings\n',
      );
    }
  });
});

describe('the flag itself', () => {
  test('--login with --jules is refused before the file or any source is read', async () => {
    const io = testIo(root);
    const doctor: DoctorSources = {
      version: untouched,
      onPath: untouched,
      loggedIn: untouched,
      herdrVersion: untouched,
      sessionRunning: untouched,
      now: untouched,
      get home(): string {
        throw new Error('the file was read');
      },
      command: untouched,
    };
    const code = await runDoctor(['--login', '--jules'], io, doctor);
    expect(code).toBe(2);
    expect(io.err).toBe(
      'team doctor: --login and --jules answer different questions; ask one at a time\n'
      + 'Usage: team doctor [--session <name>] [--file <path>] [--login] [--jules] [--json]\nExits 0 when nothing is missing, 1 when something is missing, 2 when the invocation or team file can\'t be read.\n',
    );
    expect(io.out).toBe('');
  });

  test('the full report says nothing about jules and never runs a command', async () => {
    const io = testIo(root);
    const doctor: DoctorSources = {
      version: () => null,
      onPath: () => false,
      loggedIn: () => null,
      herdrVersion: () => null,
      sessionRunning: () => null,
      now: () => NOW,
      home,
      standing: () => ({ kind: 'none' }),
      command: untouched,
    };
    const code = await runDoctor([], io, doctor);
    expect(code).toBe(1);
    expect(io.out).not.toContain('jules');
  });
});

describe('githubOrigin', () => {
  const cases: [string, string | null][] = [
    ['git@github.com:floor/teamcli.git\n', 'floor/teamcli'],
    ['https://github.com/floor/teamcli.git\n', 'floor/teamcli'],
    ['https://github.com/floor/teamcli', 'floor/teamcli'],
    ['https://github.com/floor/teamcli/\n', 'floor/teamcli'],
    ['  https://github.com/floor/teamcli.git  ', 'floor/teamcli'],
    ['https://gitlab.com/floor/teamcli.git', null],
    ['git@gitlab.com:floor/teamcli.git', null],
    ['git@github.com:floor', null],
    ['https://github.com/floor/teamcli/tree/main', null],
    ['', null],
    ['\n', null],
  ];
  for (const [text, expected] of cases) {
    test(`${JSON.stringify(text.trim())} reads as ${expected ?? 'nothing'}`, () => expect(githubOrigin(text)).toBe(expected));
  }
});
