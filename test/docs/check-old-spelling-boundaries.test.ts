// The check page's own paragraph on the old spelling, held to the dispatch that lives it. The
// page says the ref, `--pr` and `--since` make the call the older reading; that `--file` is read
// by both readings and `--session` is the team check's alone, met by the older one with one
// fixed sentence and exit 2; and that the older reading says once on stderr which command now
// holds it. Each claim is pinned twice: the sentence as written on the page, and the bytes or
// the branch that carry it in the command — the option lists both spellings parse, the
// unknown-option refusal, and the two notice lines.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, USAGE as CHECK_USAGE, type LoadConfig } from '../../src/commands/check.ts';
import type { CheckSources } from '../../src/check/team.ts';
import type { Io } from '../../src/io.ts';
import { config, SIGNATURE } from '../check/fixtures.ts';
import { createRepository, type Repository } from '../check/repository.ts';

const PAGE = '../../docs/commands/check.md';
const SRC = '../../src/commands/check.ts';

/** The notice the older reading prints once; the tail of the usage a refusal keeps byte for byte. */
const NOTICE = 'team check: `team check` is now `team commits check`, and is still read through 0.3.3\n';
const OLD_USAGE = CHECK_USAGE.slice(CHECK_USAGE.indexOf('Usage: team check <ref>'));

// Whitespace runs collapse before the match, so a sentence survives line wrapping but not
// rewording: every other character is compared as written.
function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** A one-seat team, the seat named by the caller: the report names the seat the file carried. */
function teamFor(seat: string, project: string): string {
  return [
    'format: 1',
    `project: ${project}`,
    `coordinator: ${seat}`,
    `operator: ${seat}`,
    'workspace:',
    '  mode: shared',
    'seats:',
    '  - role: implementer',
    `    name: ${seat}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    '',
  ].join('\n');
}

let repo: Repository;
let clean: string;

beforeAll(() => {
  repo = createRepository();
  clean = repo.commit(`feat: a clean one\n\n${SIGNATURE}`);
});

afterAll(() => repo.remove());

/** The loader the commits run is handed: a public project that passes the clean commit. */
const plainLoad: LoadConfig = () => ({ ok: true, config: config(), warnings: [] });

/** The older spelling, run the way a caller types it: no caller walk, the repository for a cwd. */
async function runOld(argv: string[], load: LoadConfig = plainLoad) {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: (text: string) => void (stdout += text),
    stderr: (text: string) => void (stderr += text),
    cwd: repo.path,
    env: {},
    stdinIsTTY: false,
  };
  const code = await check(argv, io, load);
  return { code, stdout, stderr };
}

/** The team check, run by the owner in a folder with the world handed in. */
function ownerIo(cwd: string) {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: (text: string) => void (stdout += text),
    stderr: (text: string) => void (stderr += text),
    cwd,
    env: {},
    stdinIsTTY: false,
    caller: { kind: 'owner' },
  };
  return { io, out: () => stdout, err: () => stderr };
}

const sources = (home: string): CheckSources => ({
  live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
  branch: () => 'main',
  standing: () => ({ kind: 'none' }),
  now: () => new Date(0),
  home,
});

describe('the old spelling\'s own line, its ref, --pr and --since — the page held to the binary', () => {
  test('the page\'s paragraph is pinned as written', () => {
    const page = prose(PAGE);
    expect(
      page.includes(
        'A `<ref>` (a range when it holds `..`, passed to git as given, otherwise that one commit) runs that older reading, ' +
          'as do `--pr <file>` (check a pull request\'s body as well; `-` reads standard input) and `--since <ref>` ' +
          '(skip that commit and everything reachable from it).',
      ),
      'check.md lost the sentence naming the ref, --pr and --since',
    ).toBe(true);
    expect(
      page.includes(
        '`--file` is read by both readings; `--session` is this one\'s alone, and the older one meets it with ' +
          '`team check: unknown option --session` and exit 2.',
      ),
      'check.md lost the --file and --session sentence',
    ).toBe(true);
    expect(
      page.includes('A run of the older reading says once on stderr which command now holds it, and `--pr` adds its own line.'),
      'check.md lost the notice sentence',
    ).toBe(true);
  });

  test('the page\'s words are the command\'s words: the spellings, the refusal and the notices', () => {
    const src = raw(SRC);
    expect(
      src.includes("const OLD_OPTIONS: readonly Option[] = ['pr', 'since', 'file'];"),
      'the older spelling no longer reads --file, or now reads another option',
    ).toBe(true);
    expect(
      src.includes("const NEW_OPTIONS: readonly Option[] = ['session', 'file'];"),
      'the team check no longer reads --file, or now reads another option',
    ).toBe(true);
    expect(
      src.includes('if (!option) return `unknown option ${argument}`;'),
      'the unknown-option refusal changed its bytes',
    ).toBe(true);
    expect(
      prose(SRC).includes(
        'The old spelling, still read through 0.3.3 — a <ref>, --pr or --since anywhere in the line makes the call this one:',
      ),
      'the usage lost its anywhere-in-the-line rule',
    ).toBe(true);
    expect(
      src.includes('team check: `team check` is now `team commits check`, and is still read through 0.3.3'),
      'the notice the page says appears once changed its bytes',
    ).toBe(true);
    expect(
      src.includes('team check: `team check --pr` is now `team pr check`, and is still read through 0.3.3'),
      'the --pr line the page says is added changed its bytes',
    ).toBe(true);
  });

  test('the older reading meets --session with the named bytes, and exit 2', async () => {
    const refused = await runOld([clean, '--session', 'acme']);
    expect(refused.code).toBe(2);
    expect(refused.stderr.split('\n')[0]).toBe('team check: unknown option --session');
    expect(refused.stderr).toEndWith(OLD_USAGE);
    expect(refused.stderr).not.toContain('is now');
    expect(refused.stdout).toBe('');
  });

  test('a line of options alone, one of them --pr, is still the older reading', async () => {
    const mixed = await runOld(['--pr', 'body.md', '--session', 'acme']);
    expect(mixed.code).toBe(2);
    expect(mixed.stderr.split('\n')[0]).toBe('team check: unknown option --session');
  });

  test('--file is read by the older reading: it reaches the commits run', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const recording: LoadConfig = (cwd: string, file?: string) => {
      seen.push([cwd, file]);
      return { ok: true, config: config(), warnings: [] };
    };
    const ran = await runOld([clean, '--file', 'other.yaml'], recording);
    expect(
      seen.some((entry) => entry[1] === 'other.yaml'),
      'the older reading never handed --file to the commits run',
    ).toBe(true);
    expect(ran.code).toBe(0);
    expect(ran.stderr).toBe(NOTICE);
  });

  test('--file and --session are read by this reading: the team check answers from the file they name', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'team-check-old-file-'));
    const home = mkdtempSync(join(tmpdir(), 'team-check-old-home-'));
    try {
      mkdirSync(join(folder, '.agents'), { recursive: true });
      writeFileSync(join(folder, '.agents', 'team.yaml'), teamFor('lead', 'acme-web'));
      writeFileSync(join(folder, 'other.yaml'), teamFor('pilot', 'beacon-web'));
      const world = sources(home);

      const named = ownerIo(folder);
      const aimed = await check(['--file', 'other.yaml'], named.io, plainLoad, world);
      expect(aimed).toBe(1);
      expect(named.out(), 'the report names the seat of the file --file named').toContain('pilot is in the file and is not running');
      expect(named.out()).not.toContain('lead is in the file');
      expect(named.err()).toBe('');

      const plain = ownerIo(folder);
      const bare = await check([], plain.io, plainLoad, world);
      expect(bare).toBe(1);
      expect(plain.out(), 'with no --file the report names the folder\'s own file').toContain('lead is in the file and is not running');

      const sessioned = ownerIo(folder);
      const withSession = await check(['--session', 'acme'], sessioned.io, plainLoad, world);
      expect(withSession).toBe(1);
      expect(sessioned.err(), '--session is read by this reading, not refused as unknown').toBe('');
      expect(sessioned.out()).toBe(plain.out().replace('session "acme-web"', 'session "acme"'));
    } finally {
      rmSync(folder, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
