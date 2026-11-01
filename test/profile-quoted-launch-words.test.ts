// A launch line whose last word is a quoted script (`/bin/sh -c 'claude …'`) hands its words to
// the CLI through that script. The profile's options, the rules and a minted id go inside the
// quotes, where the CLI reads them, and every "does the line already set this" reads the CLI's
// decoded words there too: a line that sets its own sandbox or approval keeps it, and a quoted
// `--session-id` is the flag. One invariant closes the class: after any insertion the CLI's
// decoded words are its words before, exactly, followed by exactly the inserted words in order.
// A line whose shape this version cannot prove — unclosed quoting, a script file, a bare command
// word, a nested shell deeper than one, an ANSI-C (`$'…'`) word — keeps exactly its 0.5.10
// placement, the options after the line, with one plain warning, and is never refused. These
// scenes run the built line against a stub CLI and read the argv the CLI was handed, so the words
// are measured, not matched in the line's text.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { shellWords } from '../src/launch/shell-words.ts';
import { profileFor } from '../src/profiles/index.ts';
import {
  cliWordList,
  launchCommand,
  namedResumeTarget,
  withoutResume,
  withLaunchOverrides,
  withLaunchSession,
  withResume,
} from '../src/profiles/profile.ts';

const claude = profileFor('claude-code')!;
const codex = profileFor('codex')!;
const antigravity = profileFor('antigravity')!;
const HOOK = '/synthetic/hook.json';
const RULES = 'Rules for this session';

/** Whether a program this test runs as an outer shell exists here. A row needing one is skipped
 *  rather than failed where it does not: the shapes are the same words either way. */
function hasProgram(path: string): boolean {
  try {
    execFileSync(path, ['-c', 'exit 0']);
    return true;
  } catch {
    return false;
  }
}

const ZSH = hasProgram('/bin/zsh');
const BASH = hasProgram('/bin/bash');

type CliRun = {
  /** The stub CLI's name, placed first on the PATH. */
  binary?: string;
  /** The outer shell the built line runs under: the default is the POSIX shell, and a line
   *  whose script is ANSI-C quoted (`$'…'`) needs a shell that reads that quoting. */
  runner?: string;
  /** A wrapper script written beside the run, when the launch line names one. */
  wrapper?: string;
  /** Variables the outer shell sees, for a line that expands one at run time. */
  env?: Record<string, string>;
};

/** Runs a built launch line with a stub CLI on the PATH and returns the argv that CLI saw. */
function cliArgv(command: string, run: CliRun = {}): string[] {
  const binary = run.binary ?? 'claude';
  const dir = mkdtempSync(join(tmpdir(), 'quoted-launch-'));
  try {
    if (run.wrapper !== undefined) writeFileSync(join(dir, 'wrapper.sh'), run.wrapper);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const out = join(dir, 'argv');
    writeFileSync(join(bin, binary), `#!/bin/sh\nprintf '%s\\0' "$@" > "$ARGV_OUT"\n`, { mode: 0o755 });
    execFileSync(run.runner ?? '/bin/sh', ['-c', command], {
      cwd: dir,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ARGV_OUT: out, ...run.env },
    });
    return readFileSync(out, 'utf8').split('\0').filter((word) => word !== '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether every word of `part` appears in `whole` in the same order: the CLI of 0.5.10 received
 *  these words, and a later line may add words but never lose one. */
function isOrderedSubsequence(part: readonly string[], whole: readonly string[]): boolean {
  let at = 0;
  for (const word of whole) {
    if (part[at] === word) at += 1;
  }
  return at === part.length;
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
    const argv = cliArgv(command, { binary: 'codex' });
    expect(argv).not.toContain('danger-full-access');
    expect(argv).not.toContain('never');
    expect(argv).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'on-request', '--no-alt-screen']);
  });

  test('the short attached forms inside the script suppress the defaults just the same', () => {
    const command = launchCommand(codex, "/bin/sh -c 'codex -s read-only -aon-request'", 'Rules');
    const argv = cliArgv(command, { binary: 'codex' });
    expect(argv).not.toContain('danger-full-access');
    expect(argv).not.toContain('never');
    expect(argv).toEqual(['-s', 'read-only', '-aon-request', '--no-alt-screen']);
  });
});

describe('a line whose shape this version cannot prove keeps 0.5.10 placement, with one warning', () => {
  // 0.5.10 (`5dc4d0a5b`) wrote the options after the line and the shell ran it. This version
  // does exactly the same for a line it cannot read to its end, adds one plain warning through
  // `warn`, and never throws: a line 0.5.10 launched still launches.
  const baseline = (line: string): string =>
    `AGENT_UNATTENDED=1 ${line} --dangerously-skip-permissions --append-system-prompt Rules.`;

  test('a line whose quoting never closes launches with its options after the line, and says so', () => {
    const warnings: string[] = [];
    const command = launchCommand(claude, '/bin/sh -c "claude --model m', 'Rules.', undefined, undefined, undefined, undefined, undefined, (text) => warnings.push(text));
    expect(command).toBe(baseline('/bin/sh -c "claude --model m'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('after the line, where the CLI may not read them');
    // The id is still never recorded on a line it cannot be placed on; the seat says so.
    const launch = withLaunchSession('claude-code', '/bin/sh -c "claude --model m');
    expect(launch.command).toBe('/bin/sh -c "claude --model m');
    expect(launch.sessionId).toBeUndefined();
    expect(launch.notice).toContain('cannot take a session id');
  });

  test('a trailing quoted script that runs another program keeps the options after it, and says so', () => {
    const warnings: string[] = [];
    const command = launchCommand(claude, '/bin/sh -c "python3 tool.py"', 'Rules.', undefined, undefined, undefined, undefined, undefined, (text) => warnings.push(text));
    expect(command).toBe(baseline('/bin/sh -c "python3 tool.py"'));
    expect(warnings).toHaveLength(1);
    const launch = withLaunchSession('claude-code', '/bin/sh -c "python3 tool.py"');
    expect(launch.command).toBe('/bin/sh -c "python3 tool.py"');
    expect(launch.sessionId).toBeUndefined();
    expect(launch.notice).toContain('cannot take a session id');
  });

  test('a positional word after the script, a bare command word and a script file keep it too', () => {
    for (const line of ['/bin/sh -c "claude --model m" extra', 'zsh -c claude', '/bin/sh wrapper.sh']) {
      const warnings: string[] = [];
      const command = launchCommand(claude, line, 'Rules.', undefined, undefined, undefined, undefined, undefined, (text) => warnings.push(text));
      // A script file forwards words after the line like 0.5.10 did, so it needs no warning; the
      // other two are positional words the CLI never reads there, and both are marked.
      const expected = line === '/bin/sh wrapper.sh' ? [] : [expect.stringContaining('after the line')];
      expect(command).toBe(baseline(line));
      expect(warnings).toEqual(expected);
    }
  });
});

describe('a script whose words a shell changes at run time is unprovable, and keeps 0.5.10 placement', () => {
  const baseline = (line: string): string =>
    `AGENT_UNATTENDED=1 ${line} --dangerously-skip-permissions --append-system-prompt Rules.`;

  // A lexical reader cannot see what the outer shell does at run time, so a script word holding
  // any of these constructs is not proved: it keeps 0.5.10's placement, reports one plain
  // notice, and records no session id. One scene per character class, plus a nested form and a
  // comment, each measured against the placement, never run: several would not run as text.
  const UNPROVABLE = [
    { name: 'a variable', line: '/bin/sh -c "claude --model m $TAIL"' },
    { name: 'a command substitution', line: '/bin/sh -c "claude --model m $(printf x)"' },
    { name: 'a braced variable', line: '/bin/sh -c "claude --model m ${TAIL}"' },
    { name: 'a backtick substitution', line: "/bin/sh -c 'claude --model m `printf x`'" },
    { name: 'a star glob', line: '/bin/sh -c "claude --model *"' },
    { name: 'a question-mark glob', line: '/bin/sh -c "claude --model m?"' },
    { name: 'a bracket glob', line: '/bin/sh -c "claude --model [m]"' },
    { name: 'a word-initial comment', line: '/bin/sh -c "claude --model m # note"' },
    { name: 'a semicolon', line: '/bin/sh -c "claude --model m; true"' },
    { name: 'a pipe', line: '/bin/sh -c "claude --model m | cat"' },
    { name: 'an ampersand', line: '/bin/sh -c "claude --model m & true"' },
    { name: 'an output redirection', line: '/bin/sh -c "claude --model m > out.txt"' },
    { name: 'an input redirection', line: '/bin/sh -c "claude --model m < in.txt"' },
    { name: 'an opening parenthesis', line: '/bin/sh -c "(claude --model m)"' },
    { name: 'a closing parenthesis', line: '/bin/sh -c "true) claude --model m"' },
    { name: 'a newline', line: '/bin/sh -c "claude --model m\ntrue"' },
  ];

  for (const { name, line } of UNPROVABLE) {
    test(`${name} in the script word keeps the options after the line, with one notice and no id`, () => {
      const warnings: string[] = [];
      const command = launchCommand(claude, line, 'Rules.', undefined, undefined, undefined, undefined, undefined, (text) => warnings.push(text));
      expect(command).toBe(baseline(line));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('after the line, where the CLI may not read them');
      // The line on its own cannot take an id either: it would go after the closing quote, where
      // this script never reads it, so none is recorded.
      const launch = withLaunchSession('claude-code', line);
      expect(launch.command).toBe(line);
      expect(launch.sessionId).toBeUndefined();
      expect(launch.notice).toContain('cannot take a session id');
      // The fallback line itself says the same: its added words come after the script.
      const onFallback = withLaunchSession('claude-code', command);
      expect(onFallback.command).toBe(command);
      expect(onFallback.sessionId).toBeUndefined();
      expect(onFallback.notice).toContain('cannot take a session id');
    });
  }

  test("the outer shell expands a variable into a comment, so no id is minted for the line", () => {
    // Measured on `/bin/sh` here: the outer shell writes `# ignored tail` into the command
    // string, the inner shell reads it as a comment, and the CLI receives only `--model m`. A
    // lexical insertion after the variable would be swallowed by that comment while a minted id
    // was recorded; the line is unprovable instead, so no id is recorded.
    const line = '/bin/sh -c "claude --model m $SYNTHETIC_TAIL"';
    const env = { SYNTHETIC_TAIL: '# ignored tail' };
    expect(cliArgv(line, { env })).toEqual(['--model', 'm']);
    const warnings: string[] = [];
    const command = launchCommand(claude, line, 'Rules.', undefined, undefined, undefined, undefined, undefined, (text) => warnings.push(text));
    expect(command).toBe(baseline(line));
    expect(warnings).toHaveLength(1);
    expect(cliArgv(command, { env })).toEqual(['--model', 'm']);
    const launch = withLaunchSession('claude-code', command);
    expect(launch.command).toBe(command);
    expect(launch.sessionId).toBeUndefined();
    expect(launch.notice).toContain('cannot take a session id');
  });

  test('a literal $ in inner single quotes is provable: the words still go inside the script and arrive', () => {
    // The inner shell reads a single-quoted `$X` literally, so the script hands the CLI the
    // four characters `$X` whatever `X` holds, and the added words reach it the same way.
    // `\$` is literal to the outer shell, so the inner shell receives `'$X'`: a single-quoted
    // word of the script, not an expansion, and the CLI receives the four characters.
    const line = '/bin/sh -c "claude --model \'\\$X\'"';
    const env = { X: 'expanded' };
    expect(cliArgv(line, { env })).toEqual(['--model', '$X']);
    const command = launchCommand(claude, line, 'Rules.', HOOK);
    expect(cliArgv(command, { env })).toEqual([
      '--model',
      '$X',
      '--dangerously-skip-permissions',
      '--append-system-prompt',
      'Rules.',
      '--settings',
      HOOK,
    ]);
    const launch = withLaunchSession('claude-code', command);
    expect(launch.notice).toBeUndefined();
    const sessionId = launch.sessionId ?? '';
    expect(sessionId).not.toBe('');
    expect(cliArgv(launch.command, { env })).toContain(sessionId);
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

// The shapes the repo's 0.5.10 tests write, and the argv the stub CLI received from 0.5.10's
// launchCommand (`5dc4d0a5b`, profile.ts blob 101148e8d9905890723b552750de293ee6020792), measured
// by running each baseline line under this same stub. A shape launches here iff 0.5.10 launched
// it, the CLI receives every baseline word in the same order (more is allowed, fewer never), and
// launchCommand returns a line instead of throwing.
type ParityRow = {
  name: string;
  line: string;
  cli: 'claude-code' | 'codex' | 'antigravity';
  binary: string;
  runner?: string;
  wrapper?: string;
  baseline: readonly string[];
};

const PARITY: readonly ParityRow[] = [
  {
    name: 'a plain line',
    line: 'claude --model m',
    cli: 'claude-code',
    binary: 'claude',
    baseline: ['--model', 'm', '--dangerously-skip-permissions', '--append-system-prompt', RULES],
  },
  ...(['double', 'single'] as const).map((kind): ParityRow => ({
    name: `a ${kind}-quoted script that runs the CLI`,
    line: kind === 'double' ? '/bin/sh -c "claude --model m"' : "/bin/sh -c 'claude --model m'",
    cli: 'claude-code',
    binary: 'claude',
    baseline: ['--model', 'm'],
  })),
  {
    name: 'a cluster flag -ec before the script',
    line: '/bin/sh -ec "claude --model m"',
    cli: 'claude-code',
    binary: 'claude',
    baseline: ['--model', 'm'],
  },
  {
    name: 'a zsh command string',
    line: 'zsh -c "claude --model claude-opus-5-5"',
    cli: 'claude-code',
    binary: 'claude',
    runner: '/bin/zsh',
    baseline: ['--model', 'claude-opus-5-5'],
  },
  {
    name: 'the zsh -lc launch shape',
    line: 'zsh -lc "claude --model claude-opus-5-5"',
    cli: 'claude-code',
    binary: 'claude',
    runner: '/bin/zsh',
    baseline: ['--model', 'claude-opus-5-5'],
  },
  {
    name: 'a bare agy',
    line: 'zsh -lc "agy"',
    cli: 'antigravity',
    binary: 'agy',
    runner: '/bin/zsh',
    baseline: [],
  },
  {
    name: 'an agy model',
    line: 'zsh -lc "agy --model claude-sonnet-5-5-high"',
    cli: 'antigravity',
    binary: 'agy',
    runner: '/bin/zsh',
    baseline: ['--model', 'claude-sonnet-5-5-high'],
  },
  {
    name: 'a script-file wrapper that forwards its words',
    line: '/bin/sh wrapper.sh',
    cli: 'claude-code',
    binary: 'claude',
    wrapper: 'exec claude "$@"\n',
    baseline: ['--dangerously-skip-permissions', '--append-system-prompt', RULES],
  },
  {
    name: 'a nested shell one level deep',
    line: `/bin/sh -c "sh -c 'exec claude --model m'"`,
    cli: 'claude-code',
    binary: 'claude',
    baseline: ['--model', 'm'],
  },
  {
    name: 'an ANSI-C quoted script',
    line: "/bin/bash -c $'claude --model m'",
    cli: 'claude-code',
    binary: 'claude',
    runner: '/bin/bash',
    baseline: ['--model', 'm'],
  },
  {
    name: 'codex with its own sandbox and approval',
    line: '/bin/sh -c "codex --sandbox read-only --ask-for-approval on-request"',
    cli: 'codex',
    binary: 'codex',
    baseline: ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'],
  },
  {
    name: 'codex short attached options',
    line: "/bin/sh -c 'codex -s read-only -aon-request'",
    cli: 'codex',
    binary: 'codex',
    baseline: ['-s', 'read-only', '-aon-request'],
  },
  {
    name: 'codex with an escaped newline inside its sandbox flag',
    line: '/bin/sh -c "codex --sand\\\nbox read-only --ask-for-approval on-request"',
    cli: 'codex',
    binary: 'codex',
    baseline: ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'],
  },
  {
    name: 'codex with quoted flag names',
    line: `/bin/sh -c 'codex "--sandbox" read-only "--ask-for-approval" on-request'`,
    cli: 'codex',
    binary: 'codex',
    baseline: ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'],
  },
  {
    name: 'a plain codex line with a -c config value',
    line: `codex -c 'probe_note="use -a on-request --sandbox workspace-write"'`,
    cli: 'codex',
    binary: 'codex',
    baseline: [
      '-c',
      'probe_note="use -a on-request --sandbox workspace-write"',
      '-a',
      'never',
      '-s',
      'danger-full-access',
      '--no-alt-screen',
    ],
  },
];

describe('every 0.5.10 launch-line shape launches with the same words or more, never a throw', () => {
  for (const row of PARITY) {
    const runner = row.runner ?? '/bin/sh';
    const available = runner === '/bin/zsh' ? ZSH : runner === '/bin/bash' ? BASH : true;
    test.skipIf(!available)(row.name, () => {
      const profile = profileFor(row.cli)!;
      const warnings: string[] = [];
      let command: string;
      expect(() => {
        command = launchCommand(profile, row.line, RULES, undefined, undefined, undefined, undefined, undefined, (text) => warnings.push(text));
      }).not.toThrow();
      const argv = cliArgv(command!, { binary: row.binary, runner, wrapper: row.wrapper });
      expect(argv.length).toBeGreaterThanOrEqual(row.baseline.length);
      expect(isOrderedSubsequence(row.baseline, argv)).toBe(true);
    });
  }
});

// One invariant closes the class: after any insertion into a script, re-tokenizing the result
// must give the CLI's original decoded words, exactly, followed by exactly the inserted words,
// in order. Every readable parity shape proves both halves at the CLI it actually runs; a shape
// this version cannot read proves the fallback: the line untouched, one notice, the same argv.
describe('the insertion invariant holds over every parity shape', () => {
  for (const row of PARITY) {
    const runner = row.runner ?? '/bin/sh';
    const available = runner === '/bin/zsh' ? ZSH : runner === '/bin/bash' ? BASH : true;
    test.skipIf(!available)(row.name, () => {
      const profile = profileFor(row.cli)!;
      const warnings: string[] = [];
      const command = launchCommand(profile, row.line, RULES, undefined, undefined, undefined, undefined, undefined, (text) => warnings.push(text));
      const argv = cliArgv(command, { binary: row.binary, runner, wrapper: row.wrapper });
      if (warnings.length > 0) {
        expect(command.startsWith(`AGENT_UNATTENDED=1 ${row.line.trimEnd()} `)).toBe(true);
        expect(isOrderedSubsequence(row.baseline, argv)).toBe(true);
        return;
      }
      const before = cliWordList(profile.cli, row.line);
      const after = cliWordList(profile.cli, command);
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      // The environment word belongs to the line, not to the CLI.
      const words = after![0] === 'AGENT_UNATTENDED=1' ? after!.slice(1) : after!;
      expect(words.slice(0, before!.length)).toEqual(before!);
      const inserted = words.slice(before!.length);
      expect(inserted.length).toBeGreaterThan(0);
      // The inserted words are whole CLI words at the end of its argv — never glued onto an
      // original word, never split, never reordered.
      expect(argv.slice(argv.length - inserted.length)).toEqual(inserted);
      // Every word the CLI received before, it still receives first.
      expect(argv.slice(0, row.baseline.length)).toEqual([...row.baseline]);
    });
  }
});

// The words builder-3's round-3 probes broke: each now keeps the line's own word whole and adds
// exactly the profile's words after it. The ANSI-C NUL is unreadable, so it takes the fallback,
// and the quoted `--session-id` is the flag, so no second id is minted.
describe('the round-3 probe shapes satisfy the same invariant', () => {
  const SHAPES = [
    { name: 'an escaped space at the end of the script', line: String.raw`/bin/sh -c 'claude --model m\ '` },
    { name: 'a line continuation at the end of the script', line: '/bin/sh -c "claude --model m\\\n"' },
  ];
  for (const shape of SHAPES) {
    test(shape.name, () => {
      const base = cliArgv(shape.line);
      const warnings: string[] = [];
      const command = launchCommand(claude, shape.line, RULES, undefined, undefined, undefined, undefined, undefined, (text) => warnings.push(text));
      expect(warnings).toEqual([]);
      const before = cliWordList('claude-code', shape.line)!;
      const afterRaw = cliWordList('claude-code', command)!;
      const after = afterRaw[0] === 'AGENT_UNATTENDED=1' ? afterRaw.slice(1) : afterRaw;
      expect(after.slice(0, before.length)).toEqual(before);
      const inserted = after.slice(before.length);
      const argv = cliArgv(command);
      expect(argv.slice(0, base.length)).toEqual(base);
      expect(argv.slice(argv.length - inserted.length)).toEqual(inserted);
      expect(inserted).toEqual(['--dangerously-skip-permissions', '--append-system-prompt', RULES]);
    });
  }

  test('a quoted --session-id is the flag: the declared id is recorded, and none is minted', () => {
    const id = '01234567-89ab-4cde-8fab-0123456789ab';
    const line = `/bin/sh -c 'claude "--session-id" ${id}'`;
    const launch = withLaunchSession('claude-code', line);
    expect(launch).toEqual({ command: line, sessionId: id });
    expect(cliArgv(launch.command)).toEqual(['--session-id', id]);
  });

  test('an ANSI-C NUL cannot certify a minted id: none is recorded, and the notice says so', () => {
    if (!BASH) return;
    const line = String.raw`/bin/bash -c $'claude --model m\x00'`;
    const launch = withLaunchSession('claude-code', line);
    expect(launch.command).toBe(line);
    expect(launch.sessionId).toBeUndefined();
    expect(launch.notice).toContain('cannot take a session id');
    expect(cliArgv(launch.command, { runner: '/bin/bash' })).toEqual(['--model', 'm']);
  });
});

describe('the words a launch line hides from a plain text scan are read as the CLI reads them', () => {
  test("an escaped newline inside the script does not hide the line's own sandbox and approval", () => {
    const line = '/bin/sh -c "codex --sand\\\nbox read-only --ask-for-approval on-request"';
    const argv = cliArgv(launchCommand(codex, line, RULES), { binary: 'codex' });
    expect(argv).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'on-request', '--no-alt-screen']);
  });

  test('a quoted flag name is still the flag the CLI reads', () => {
    const line = `/bin/sh -c 'codex "--sandbox" read-only "--ask-for-approval" on-request'`;
    const argv = cliArgv(launchCommand(codex, line, RULES), { binary: 'codex' });
    expect(argv).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'on-request', '--no-alt-screen']);
  });
});

describe("a script-file wrapper, an $'…' script and a nested shell all reach the CLI", () => {
  test("the shell's own -c is not a CLI flag, so a script file keeps its words", () => {
    // The word after `sh` is a file, not a command string: nothing here is written inside it,
    // and the words go after the line where a forwarding wrapper reads them, as 0.5.10 did.
    const command = launchCommand(claude, '/bin/sh wrapper.sh', RULES);
    expect(command).toBe(`AGENT_UNATTENDED=1 /bin/sh wrapper.sh --dangerously-skip-permissions --append-system-prompt '${RULES}'`);
    const argv = cliArgv(command, { wrapper: 'exec claude "$@"\n' });
    expect(argv).toEqual(['--dangerously-skip-permissions', '--append-system-prompt', RULES]);
  });

  test("an ANSI-C quoted script keeps 0.5.10's placement, for every escape class", () => {
    // The two shells read the same `$'…'` word differently (the measured bytes are in
    // src/launch/shell-words.ts), so no such word is decoded: the options stay after the line,
    // where 0.5.10 wrote them, and the seat says so. One line per escape class — the escapes
    // both shells read alike, and the ones they do not.
    const LINES = [
      String.raw`/bin/bash -c $'claude --model m'`,
      String.raw`/bin/bash -c $'claude --model m\n'`,
      String.raw`/bin/bash -c $'claude --model m\x41'`,
      String.raw`/bin/bash -c $'claude --model m\u00e9'`,
      String.raw`/bin/bash -c $'claude --model m\u00'`,
      String.raw`/bin/bash -c $'claude --model m\x00'`,
      String.raw`/bin/bash -c $'claude --model m\0'`,
      String.raw`/bin/bash -c $'claude --model m\8'`,
      String.raw`/bin/bash -c $'claude --model m\q'`,
      String.raw`/bin/bash -c $'claude --model m\$'`,
    ];
    if (!BASH) return;
    for (const line of LINES) {
      const warnings: string[] = [];
      const command = launchCommand(claude, line, RULES, undefined, undefined, undefined, undefined, undefined, (text) => warnings.push(text));
      const before = cliArgv(line, { runner: '/bin/bash' });
      expect(command).toBe(`AGENT_UNATTENDED=1 ${line} --dangerously-skip-permissions --append-system-prompt '${RULES}'`);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('after the line, where the CLI may not read them');
      // The fallback changes no word the CLI receives: the options are the script's positional
      // words, never the CLI's.
      expect(cliArgv(command, { runner: '/bin/bash' })).toEqual(before);
    }
  });

  test('a nested shell one level deep takes the rules, the id and a resume in its CLI script', () => {
    const line = `/bin/sh -c "sh -c 'exec claude --model m'"`;
    const launched = withLaunchSession('claude-code', launchCommand(claude, line, RULES));
    expect(launched.notice).toBeUndefined();
    expect(launched.sessionId).toBeDefined();
    const argv = cliArgv(launched.command);
    expect(argv).toEqual([
      '--model',
      'm',
      '--dangerously-skip-permissions',
      '--append-system-prompt',
      RULES,
      '--session-id',
      launched.sessionId!,
    ]);
    // The inner shell's `-c` is the shell's, never the CLI's resume or continue.
    expect(namedResumeTarget('claude-code', line)).toBeNull();
    const resumed = withResume('claude-code', line, 'abc-1');
    expect(resumed).not.toBeNull();
    expect(cliArgv(resumed!)).toEqual(['--model', 'm', '--resume', 'abc-1']);
  });

  test('a model override inside a quoted script keeps the closing quote', () => {
    const before = '/bin/sh -c "claude --model old"';
    const after = withLaunchOverrides(claude, before, { modelId: 'new' });
    expect(shellWords(after)).not.toBeNull();
    expect(after).toBe('/bin/sh -c "claude --model new"');
    expect(cliArgv(after)).toEqual(['--model', 'new']);
  });
});
