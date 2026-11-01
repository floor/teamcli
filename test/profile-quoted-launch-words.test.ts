// A launch line whose last word is a quoted script (`/bin/sh -c 'claude …'`) hands its words to
// the CLI through that script. The profile's options, the rules and a minted id go inside the
// quotes, where the CLI reads them, and every "does the line already set this" reads the CLI's
// words there too: a line that sets its own sandbox or approval keeps it. These scenes run the
// built line against a stub CLI and read the argv the CLI was handed, so the words are measured,
// not matched in the line's text.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { profileFor } from '../src/profiles/index.ts';
import { launchCommand, withoutResume, withLaunchSession, withResume } from '../src/profiles/profile.ts';

const claude = profileFor('claude-code')!;
const codex = profileFor('codex')!;
const HOOK = '/synthetic/hook.json';

/** Runs a built launch line with a stub CLI on the PATH and returns the argv that CLI saw. */
function cliArgv(command: string, binary: 'claude' | 'codex' = 'claude'): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'quoted-launch-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const out = join(dir, 'argv');
    writeFileSync(join(bin, binary), `#!/bin/sh\nprintf '%s\\0' "$@" > "$ARGV_OUT"\n`, { mode: 0o755 });
    execFileSync('/bin/sh', ['-c', command], {
      cwd: dir,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ARGV_OUT: out },
    });
    return readFileSync(out, 'utf8').split('\0').filter((word) => word !== '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the profile words a quoted script takes, read from the CLI the script runs', () => {
  const QUOTES = [
    { kind: 'single', quote: "'" },
    { kind: 'double', quote: '"' },
  ] as const;
  const TEXTS = [
    'Rules for this session: use team send',
    "Don't stop.",
    'Follow the "session rules".',
    'Costs $5 and `printf synthetic` runs',
    'A backslash \\ and a path stay',
  ];

  for (const { kind, quote } of QUOTES) {
    for (const rules of TEXTS) {
      test(`a ${kind}-quoted script hands ${JSON.stringify(rules)} to its CLI as one word`, () => {
        const command = launchCommand(claude, `/bin/sh -c ${quote}claude --model m${quote}`, rules, HOOK);
        const argv = cliArgv(command);
        // Every profile word is inside the script and arrives exactly as written: the rules are
        // one argument, byte for byte, and the line keeps no word after the closing quote where
        // the CLI would never read it.
        expect(argv).toEqual([
          '--model',
          'm',
          '--dangerously-skip-permissions',
          '--append-system-prompt',
          rules,
          '--settings',
          HOOK,
        ]);
        expect(command.trimEnd().endsWith(quote)).toBe(true);
      });
    }
  }
});

describe('a minted session id is placed inside the script, where the CLI receives it', () => {
  test('rules containing double quotes do not stop a fresh quoted launch from getting its session id', () => {
    const command = launchCommand(claude, '/bin/sh -c "claude --model m"', 'Follow the "session rules".');
    const launch = withLaunchSession('claude-code', command);
    expect(launch.notice).toBeUndefined();
    expect(launch.sessionId).toBeDefined();
    const argv = cliArgv(launch.command);
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(launch.sessionId!);
    expect(launch.command.trimEnd().endsWith('"')).toBe(true);
  });

  test('a shell option joined as -ec does not hide the script from the id', () => {
    // The escaped rules quotes once made the reader take an inner quote as the script's opening
    // boundary; the id was recorded but written after the outer script, where the CLI never saw
    // it. The tokenizer reads the whole quoted word, so the id lands inside it.
    const command = launchCommand(claude, '/bin/sh -ec "claude --model m"', 'Follow the "session rules".');
    const launch = withLaunchSession('claude-code', command);
    expect(launch.notice).toBeUndefined();
    expect(launch.sessionId).toBeDefined();
    const argv = cliArgv(launch.command);
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(launch.sessionId!);
  });
});

describe('a wrapped CLI line that sets its own safety flags is never widened', () => {
  test('a quoted Codex script with its own sandbox and approval gets no conflicting defaults', () => {
    const command = launchCommand(codex, '/bin/sh -c "codex --sandbox read-only --ask-for-approval on-request"', 'Rules');
    const argv = cliArgv(command, 'codex');
    expect(argv).not.toContain('danger-full-access');
    expect(argv).not.toContain('never');
    expect(argv).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'on-request', '--no-alt-screen']);
  });

  test('the short attached forms inside the script suppress the defaults just the same', () => {
    const command = launchCommand(codex, "/bin/sh -c 'codex -s read-only -aon-request'", 'Rules');
    const argv = cliArgv(command, 'codex');
    expect(argv).not.toContain('danger-full-access');
    expect(argv).not.toContain('never');
    expect(argv).toEqual(['-s', 'read-only', '-aon-request', '--no-alt-screen']);
  });
});

describe('a line that cannot take its words is refused in plain words, never launched with them outside', () => {
  test('a line whose quoting never closes is refused before anything is added to it', () => {
    expect(() => launchCommand(claude, '/bin/sh -c "claude --model m', 'Rules.')).toThrow(/cannot take its profile options/);
    const launch = withLaunchSession('claude-code', '/bin/sh -c "claude --model m');
    expect(launch.command).toBe('/bin/sh -c "claude --model m');
    expect(launch.sessionId).toBeUndefined();
    expect(launch.notice).toContain('cannot take a session id');
  });

  test('a trailing quoted script that runs another program is refused rather than handed words it never reads', () => {
    expect(() => launchCommand(claude, '/bin/sh -c "python3 tool.py"', 'Rules.')).toThrow(/does not run this CLI/);
    const launch = withLaunchSession('claude-code', '/bin/sh -c "python3 tool.py"');
    expect(launch.command).toBe('/bin/sh -c "python3 tool.py"');
    expect(launch.sessionId).toBeUndefined();
    expect(launch.notice).toContain('cannot take a session id');
  });
});

describe('a resume inside a quoted script goes in and comes back out exactly', () => {
  test('the id is appended inside the quotes, and stripping it restores the line', () => {
    const double = '/bin/sh -c "claude --model m"';
    const resumedDouble = withResume('claude-code', double, 'abc-1');
    expect(resumedDouble).toBe('/bin/sh -c "claude --model m --resume abc-1"');
    expect(withoutResume('claude-code', resumedDouble!)).toBe(double);
    const single = "/bin/sh -c 'claude --model m'";
    expect(withResume('claude-code', single, 'abc-1')).toBe("/bin/sh -c 'claude --model m --resume abc-1'");
    expect(withoutResume('claude-code', "/bin/sh -c 'claude --model m --resume abc-1'")).toBe(single);
  });

  test('a line whose quoting never closes has no knowable words: nothing is stripped from it', () => {
    expect(withoutResume('claude-code', '/bin/sh -c "claude --resume abc-1')).toBeNull();
  });
});
