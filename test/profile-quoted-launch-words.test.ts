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
import { readBackOf } from '../src/commands/restart.ts';
import type { Seat } from '../src/file/types.ts';
import { shellWords } from '../src/launch/shell-words.ts';
import { setsSettings } from '../src/launch/cli-hook.ts';
import { launchModelOf } from '../src/launch/model-guard.ts';
import { profileFor } from '../src/profiles/index.ts';
import {
  cliWordList,
  cliWordsOf,
  launchCommand,
  launchSessionId,
  namedResumeTarget,
  resumeCarry,
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
    // The shell that parses the line expands an unescaped `$` or backtick inside its double
    // quotes, even where inner single quotes make it look literal to the script's own shell.
    { name: 'a variable hidden in inner single quotes', line: '/bin/sh -c "claude --model m \'$TAIL\'"' },
    { name: 'a braced variable hidden in inner single quotes', line: '/bin/sh -c "claude --model m \'${TAIL}\'"' },
    { name: 'a command substitution hidden in inner single quotes', line: '/bin/sh -c "claude --model m \'$(printf x)\'"' },
    { name: 'a backtick hidden in inner single quotes', line: '/bin/sh -c "claude --model m \'`printf x`\'"' },
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

  test("inner single quotes do not shield an outer expansion: the CLI gets only the words before it", () => {
    // Measured on `/bin/sh` here with `SYNTHETIC_TAIL="' # ignored tail"`: the shell that parses
    // the line expands the variable inside its double-quoted command argument before the script's
    // own shell reads it. The value's quote closes an empty word and its `#` starts a comment, so
    // the CLI receives `--model m` and that empty word, and every word after it is lost.
    const line = '/bin/sh -c "claude --model m \'$SYNTHETIC_TAIL\'"';
    const env = { SYNTHETIC_TAIL: "' # ignored tail" };
    expect(cliArgv(line, { env })).toEqual(['--model', 'm']);
    const warnings: string[] = [];
    const command = launchCommand(claude, line, 'Rules.', undefined, undefined, undefined, undefined, undefined, (text) => warnings.push(text));
    expect(command).toBe(baseline(line));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('after the line, where the CLI may not read them');
    expect(cliArgv(command, { env })).toEqual(['--model', 'm']);
    const launch = withLaunchSession('claude-code', command);
    expect(launch.command).toBe(command);
    expect(launch.sessionId).toBeUndefined();
    expect(launch.notice).toContain('cannot take a session id');
  });

  test('a literal $ in inner single quotes is provable when the outer quote keeps it literal: the words still arrive', () => {
    // The inner shell reads a single-quoted `$X` literally, so the script hands the CLI the
    // four characters `$X` whatever `X` holds, and the added words reach it the same way.
    // `\$` is literal to the outer shell, so the inner shell receives `'$X'`: a single-quoted
    // word of the script, not an expansion, and the CLI receives the four characters. This holds
    // because the outer word keeps the `$` literal; an unescaped one in the same place expands
    // at the outer layer, and the scene above measures that.
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

  test('a single-quoted script keeps its inner single quotes literal: the words arrive', () => {
    // The outer word is single-quoted, so the shell that parses the line hands the script's
    // shell exactly the text written: a spliced `'\''` is a literal `'` there, the inner
    // `'$X'` is single-quoted to the script's shell, and the CLI receives `$X` whatever `X`
    // holds. The added words go inside the same script and arrive too.
    const line = "/bin/sh -c 'claude --model '\\''$X'\\'''";
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

describe('an unprovable line proves no word, and every reader reads it as 0.5.10 read it', () => {
  // Builder-3's round-6 probe: the outer shell expands the variable inside its double-quoted
  // command argument into `' # ignored tail`, so the script its shell runs is `claude --model m ''`
  // and every word after the variable — the quoted `--session-id` and its value — is inside a
  // comment. The decoded source still appears to name the declared id, so a reader that decodes
  // without the outer-word proof records an id the CLI never read.
  const HIDDEN_ID = '/bin/sh -c "claude --model m \'$SYNTHETIC_TAIL\' \'--session-id\' \'declared-session\'"';
  const LITERAL_ID = '/bin/sh -c "claude --model m \'\\$SYNTHETIC_TAIL\' \'--session-id\' \'declared-session\'"';
  const TAIL = { SYNTHETIC_TAIL: "' # ignored tail" };

  test('the declared id the shell comments away is not the id the launch records', () => {
    expect(cliArgv(HIDDEN_ID, { env: TAIL })).toEqual(['--model', 'm']);
    expect(cliWordList('claude-code', HIDDEN_ID)).toBeNull();
    expect(cliWordsOf('claude-code', HIDDEN_ID)).toBe('');
    const launch = withLaunchSession('claude-code', HIDDEN_ID);
    expect(launch.command).toBe(HIDDEN_ID);
    expect(launch.sessionId).toBeUndefined();
    expect(launch.notice).toContain('cannot take a session id');
    // The words the launch actually hands its CLI name no id at all.
    expect(cliArgv(launch.command, { env: TAIL })).toEqual(['--model', 'm']);
  });

  test('the escaped outer dollar keeps the same shape provable: the declared id is recorded and arrives', () => {
    expect(cliWordList('claude-code', LITERAL_ID)).toContain('declared-session');
    const launch = withLaunchSession('claude-code', LITERAL_ID);
    expect(launch.notice).toBeUndefined();
    expect(launch.sessionId).toBe('declared-session');
    expect(cliArgv(launch.command, { env: TAIL })).toContain('declared-session');
  });

  test('a resume the unprovable script appears to name is no resume the tool reasons about', () => {
    const line = '/bin/sh -c "claude \'$SYNTHETIC_TAIL\' \'--resume\' \'synthetic-one\'"';
    expect(namedResumeTarget('claude-code', line)).toBeNull();
    expect(withResume('claude-code', line, 'synthetic-two')).toBeNull();
    expect(resumeCarry('claude-code', line, 'synthetic-two')).toEqual({
      kind: 'refuse',
      why: 'its launch line has no measured resume form',
    });
  });

  test('a resume the unprovable script appears to name is not stripped from the line either', () => {
    // Builder-3's round-8 probe: the outer shell expands the variable inside the inner script's
    // single quotes, so the text this reader decodes is not the script the CLI runs. Stripping
    // the resume by a source span would rewrite the line on a reading the shell never hands on.
    const line = '/bin/sh -c "claude --model m \'$SYNTHETIC_TAIL\' --resume synthetic-one"';
    expect(cliWordList('claude-code', line)).toBeNull();
    expect(withResume('claude-code', line, 'synthetic-two')).toBeNull();
    expect(withoutResume('claude-code', line)).toBeNull();
    // The controls: a body whose source the reader decoded exactly strips, single- and
    // double-quoted alike.
    expect(withoutResume('claude-code', "/bin/sh -c 'claude --model m --resume synthetic-one'")).toBe(
      "/bin/sh -c 'claude --model m'",
    );
    expect(withoutResume('claude-code', '/bin/sh -c "claude --model m --resume synthetic-one"')).toBe(
      '/bin/sh -c "claude --model m"',
    );
  });

  test('a quoted settings flag on an unprovable line is not the CLI setting: 0.5.10 did not see it either', () => {
    // The flag name is quoted in the source, so 0.5.10's own `/(^|\s)--settings(=|\s|$)/` never
    // matched it: the reader keeps that answer instead of inventing a setting from the decoded text.
    const line = '/bin/sh -c "claude \'$SYNTHETIC_TAIL\' \'--settings\' \'/synthetic/hook.json\'"';
    expect(setsSettings('claude-code', line)).toBe(false);
    // The same words in a proved line are the setting the reader honours.
    expect(setsSettings('claude-code', '/bin/sh -c "claude \'\\$SYNTHETIC_TAIL\' \'--settings\' \'/synthetic/hook.json\'"')).toBe(true);
  });

  test('a settings flag the line plainly sets is still seen, and the run adds no second one', () => {
    const line = '/bin/sh -c "claude --settings /synthetic/hook.json \'$SYNTHETIC_TAIL\'"';
    expect(cliWordList('claude-code', line)).toBeNull();
    expect(setsSettings('claude-code', line)).toBe(true);
    const command = launchCommand(claude, line, 'Rules for this session', HOOK);
    expect(command.split('--settings')).toHaveLength(2);
    expect(cliArgv(command, { env: TAIL })).toContain('/synthetic/hook.json');
  });

  test('a quoted model flag on an unprovable line is no model this run will judge: 0.5.10 did not see it either', () => {
    const line = '/bin/sh -c "claude \'$SYNTHETIC_TAIL\' \'--model\' \'gpt-5.5\'"';
    expect(launchModelOf({ cli: 'claude-code', launch: line })).toEqual({ kind: 'none' });
    expect(launchModelOf({ cli: 'claude-code', launch: '/bin/sh -c "claude \'\\$SYNTHETIC_TAIL\' \'--model\' \'gpt-5.5\'"' })).toEqual({
      kind: 'lab',
      model: 'gpt-5.5',
      lab: 'openai',
    });
  });

  test('a model the line plainly names before its unprovable tail is still judged, as 0.5.10 judged it', () => {
    // The model rule is never relaxed for a line this version cannot prove: the raw text names
    // the model 0.5.10's own regex found, so the rule still sees it.
    const line = '/bin/sh -c "claude --model gpt-5.5 \'$SYNTHETIC_TAIL\'"';
    expect(cliWordList('claude-code', line)).toBeNull();
    expect(launchModelOf({ cli: 'claude-code', launch: line })).toEqual({ kind: 'lab', model: 'gpt-5.5', lab: 'openai' });
    // The model is really the CLI's: the unprovable tail does not take the flag away.
    expect(cliArgv(line, { env: TAIL })[1]).toBe('gpt-5.5');
  });

  test('the option checks read a plain flag on an unprovable line, and no option is added twice', () => {
    // 0.5.10 asked its raw-line questions of the whole text; the gate keeps that answer for a
    // line it cannot prove, so the run never appends an option the line already carries.
    const named = launchCommand(claude, '/bin/sh -c "claude --name synthetic-seat \'$SYNTHETIC_TAIL\'"', 'Rules.', HOOK, undefined, 'seat-display');
    expect(named.split('--name')).toHaveLength(2);
    const daemon = launchCommand(codex, '/bin/sh -c "codex --no-daemon \'$SYNTHETIC_TAIL\'"', 'Rules.', undefined, undefined, undefined, { codexDaemon: 'off' });
    expect(daemon.split('--no-daemon')).toHaveLength(2);
  });

  test('the restart read-back compares against the model the line plainly names, as 0.5.10 did', () => {
    const seat = {
      name: 'seat',
      vendor: 'anthropic',
      cli: 'claude-code',
      model: 'synthetic-model',
      version: '1.0',
      launch: '/bin/sh -c "claude --model gpt-5.5 \'$SYNTHETIC_TAIL\'"',
    } as Seat;
    // The pane's welcome box, the line the banner reader draws the wrapper's id from: 0.5.11
    // reads a model line only under its one header line.
    const box = ' ▐▛███▛█   Claude Code v2.1.291\n▝▜██████▀  gpt-5.5 · API Usage Billing\n';
    expect(readBackOf(seat, box)).toEqual({ kind: 'match', model: 'gpt-5.5' });
    // A quoted flag name is not an id to 0.5.10 either: the declaration's model is compared.
    const quoted = { ...seat, launch: '/bin/sh -c "claude \'$SYNTHETIC_TAIL\' \'--model\' \'gpt-5.5\'"' } as Seat;
    expect(readBackOf(quoted, box)).toEqual({
      kind: 'mismatch',
      expected: 'synthetic-model',
      shown: 'gpt-5.5',
    });
  });

  // Builder-3's round-7 probes: the outer word is single-quoted, so the shell that parses the
  // line hands the script through unchanged and only the body decides. The script's own shell
  // reads a comment (or a second command) and the CLI never receives the words the decoded
  // source appears to name. The body proof is the one the placement asks, so the reader names
  // no word here either, and no id is recorded.
  const COMMENTED_ID = '/bin/sh -c \'claude --model m # "--session-id" "declared-session"\'';
  const SECOND_COMMAND_ID = '/bin/sh -c \'claude --model m; : "--session-id" "declared-session"\'';

  test('a comment inside the script is no word list: the CLI receives only the words before it', () => {
    expect(cliArgv(COMMENTED_ID)).toEqual(['--model', 'm']);
    expect(cliWordList('claude-code', COMMENTED_ID)).toBeNull();
    expect(cliWordsOf('claude-code', COMMENTED_ID)).toBe('');
    const launch = withLaunchSession('claude-code', COMMENTED_ID);
    expect(launch.command).toBe(COMMENTED_ID);
    expect(launch.sessionId).toBeUndefined();
    expect(launch.notice).toContain('cannot take a session id');
  });

  test('a second command after a semicolon names no word either: the declared id never reaches the CLI', () => {
    expect(cliArgv(SECOND_COMMAND_ID)).toEqual(['--model', 'm']);
    expect(cliWordList('claude-code', SECOND_COMMAND_ID)).toBeNull();
    expect(cliWordsOf('claude-code', SECOND_COMMAND_ID)).toBe('');
    const launch = withLaunchSession('claude-code', SECOND_COMMAND_ID);
    expect(launch.command).toBe(SECOND_COMMAND_ID);
    expect(launch.sessionId).toBeUndefined();
    expect(launch.notice).toContain('cannot take a session id');
  });
});

// A shell nested two levels down: one nesting is followed to the script it runs, and the proof
// stops there for every reader.
const THREE_SHELLS = `/bin/sh -c ${JSON.stringify(`sh -c 'sh -c "claude --resume known"'`)}`;
const THREE_SHELLS_DECLARED = `/bin/sh -c ${JSON.stringify(`sh -c 'sh -c "claude --session-id declared-1"'`)}`;

describe('one proof decides both: a reader is unknown exactly where the placement refuses', () => {
  const baseline = (line: string): string =>
    `AGENT_UNATTENDED=1 ${line} --dangerously-skip-permissions --append-system-prompt Rules.`;

  // The whole unprovable-shape table. The first rows write the construct inside a single-quoted
  // script word — literal to the shell that parses the line, so only the body's own proof can
  // refuse them — and the last rows put the construct where the outer shell reads it, so no
  // proof of the body reaches that shell at all. Each row is asked of both readers: the
  // placement (a warned launchCommand, options after the line) and the word read
  // (cliWordList/cliWordsOf). They must answer the same thing on every row.
  const SHAPES = [
    { name: 'a comment', line: "/bin/sh -c 'claude --model m # note'" },
    { name: 'a semicolon', line: "/bin/sh -c 'claude --model m; :'" },
    { name: 'a pipe', line: "/bin/sh -c 'claude --model m | cat'" },
    { name: 'an ampersand', line: "/bin/sh -c 'claude --model m & true'" },
    { name: 'an output redirection', line: "/bin/sh -c 'claude --model m > out.txt'" },
    { name: 'an input redirection', line: "/bin/sh -c 'claude --model m < in.txt'" },
    { name: 'an opening parenthesis', line: "/bin/sh -c '(claude --model m)'" },
    { name: 'a closing parenthesis', line: "/bin/sh -c 'claude --model m)'" },
    { name: 'a newline', line: "/bin/sh -c 'claude --model m\ntrue'" },
    { name: 'a variable', line: "/bin/sh -c 'claude --model $X'" },
    { name: 'a braced variable', line: "/bin/sh -c 'claude --model ${X}'" },
    { name: 'a command substitution', line: "/bin/sh -c 'claude --model $(printf x)'" },
    { name: 'a backtick substitution', line: "/bin/sh -c 'claude --model `printf x`'" },
    { name: 'a star glob', line: "/bin/sh -c 'claude --model m*'" },
    { name: 'a question-mark glob', line: "/bin/sh -c 'claude --model m?'" },
    { name: 'a bracket glob', line: "/bin/sh -c 'claude --model [m]'" },
    { name: 'an unclosed inner quote', line: '/bin/sh -c \'claude --model "m\'' },
    { name: 'a variable the outer shell expands', line: '/bin/sh -c "claude --model m $TAIL"' },
    { name: 'a backtick the outer shell runs', line: '/bin/sh -c "claude --model m `printf x`"' },
    { name: 'a star the outer shell globs', line: '/bin/sh -c "claude --model *"' },
    // A shell whose syntax this reader does not model: the body may be one simple command in
    // POSIX terms and still mean something else to that shell, so no word is proved.
    { name: 'a shell this reader does not write inside', line: "/usr/bin/fish -c 'claude --model m'" },
    // A shell nested two levels down: beyond the one nested shell the placement follows, so the
    // line is unprovable however literal its body looks.
    { name: 'a shell nested two levels down', line: `/bin/sh -c ${JSON.stringify(`sh -c 'sh -c "claude --model m"'`)}` },
  ];
  const PROVED = "/bin/sh -c 'claude --model m'";

  test('every unprovable shape is refused by the placement and names no word', () => {
    for (const { name, line } of SHAPES) {
      const warnings: string[] = [];
      const command = launchCommand(claude, line, 'Rules.', undefined, undefined, undefined, undefined, undefined, (text) => warnings.push(text));
      const placementRefused = warnings.length === 1 && command === baseline(line);
      const readerUnknown = cliWordList('claude-code', line) === null && cliWordsOf('claude-code', line) === '';
      expect(`${name}: placement refuses — ${placementRefused}`).toBe(`${name}: placement refuses — true`);
      expect(`${name}: reader unknown — ${readerUnknown}`).toBe(`${name}: reader unknown — true`);
      // The agreement itself: neither answer can move without the other.
      expect(`${name}: ${readerUnknown}`).toBe(`${name}: ${placementRefused}`);
    }
  });

  test('the proved control is refused by neither, and its words are read', () => {
    const warnings: string[] = [];
    launchCommand(claude, PROVED, 'Rules.', undefined, undefined, undefined, undefined, undefined, (text) => warnings.push(text));
    expect(warnings).toEqual([]);
    expect(cliWordList('claude-code', PROVED)).toContain('--model');
    expect(cliWordsOf('claude-code', PROVED)).toContain('--model');
  });

  // The plain-line rows: no script word stands between the reader and the shell that runs the
  // line, so the only question left is whether the line swallows a word written after it. A
  // comment, an operator, a redirect, a newline, an unclosed quote and a trailing backslash do;
  // an expansion or a glob changes its own word only, so the words written after it still reach
  // the CLI and the line stays provable — refusing those would lose ids 0.5.10 recorded.
  const PLAIN_SWALLOWED = [
    { name: 'a plain comment', line: 'claude --model m # note' },
    { name: 'a plain semicolon', line: 'claude --model m; :' },
    { name: 'a plain and', line: 'claude --model m && true' },
    { name: 'a plain or', line: 'claude --model m || true' },
    { name: 'a plain pipe', line: 'claude --model m | cat' },
    { name: 'a plain ampersand', line: 'claude --model m & true' },
    { name: 'a plain output redirection', line: 'claude --model m > out.txt' },
    { name: 'a plain input redirection', line: 'claude --model m < in.txt' },
    { name: 'a plain unclosed quote', line: 'claude --model "m' },
    { name: 'a plain newline', line: 'claude --model m\ntrue' },
    { name: 'a plain trailing backslash', line: 'claude --model m \\' },
  ];
  const PLAIN_PROVED = [
    { name: 'a plain variable', line: 'claude --model $X' },
    { name: 'a plain braced variable', line: 'claude --model ${X}' },
    { name: 'a plain command substitution', line: 'claude --model $(printf x)' },
    { name: 'a plain backtick substitution', line: 'claude --model `printf x`' },
    { name: 'a plain star glob', line: 'claude --model m*' },
    { name: 'a plain quoted word', line: 'claude --model "m"' },
    { name: 'a plain single-quoted word', line: "claude --model 'm'" },
  ];

  test('every plain shape that swallows its tail is refused by the placement and names no word', () => {
    for (const { name, line } of PLAIN_SWALLOWED) {
      const warnings: string[] = [];
      const command = launchCommand(claude, line, 'Rules.', undefined, undefined, undefined, undefined, undefined, (text) => warnings.push(text));
      const placementRefused = warnings.length === 1 && command === baseline(line);
      const readerUnknown = cliWordList('claude-code', line) === null && cliWordsOf('claude-code', line) === '';
      expect(`${name}: placement refuses — ${placementRefused}`).toBe(`${name}: placement refuses — true`);
      expect(`${name}: reader unknown — ${readerUnknown}`).toBe(`${name}: reader unknown — true`);
      expect(`${name}: ${readerUnknown}`).toBe(`${name}: ${placementRefused}`);
    }
  });

  test('a plain shape whose tail still reaches the CLI is refused by neither, and its words are read', () => {
    for (const { name, line } of PLAIN_PROVED) {
      const warnings: string[] = [];
      const command = launchCommand(claude, line, 'Rules.', undefined, undefined, undefined, undefined, undefined, (text) => warnings.push(text));
      const placementRefused = warnings.length === 1 && command === baseline(line);
      const readerUnknown = cliWordList('claude-code', line) === null && cliWordsOf('claude-code', line) === '';
      expect(`${name}: placement refuses — ${placementRefused}`).toBe(`${name}: placement refuses — false`);
      expect(`${name}: reader unknown — ${readerUnknown}`).toBe(`${name}: reader unknown — false`);
      expect(`${name}: ${readerUnknown}`).toBe(`${name}: ${placementRefused}`);
    }
  });
});

describe('a shell nested deeper than one level is unprovable for every reader', () => {
  test('the words, the resume and the launch all read nothing, and the launch says so once', () => {
    expect(cliWordList('claude-code', THREE_SHELLS)).toBeNull();
    expect(cliWordsOf('claude-code', THREE_SHELLS)).toBe('');
    expect(namedResumeTarget('claude-code', THREE_SHELLS)).toBeNull();
    expect(withResume('claude-code', THREE_SHELLS, 'abc-1')).toBeNull();
    expect(withoutResume('claude-code', THREE_SHELLS)).toBeNull();
    expect(launchSessionId(THREE_SHELLS)).toBeUndefined();
    expect(launchSessionId(THREE_SHELLS_DECLARED)).toBeUndefined();
    const launch = withLaunchSession('claude-code', THREE_SHELLS);
    expect(launch.command).toBe(THREE_SHELLS);
    expect(launch.sessionId).toBeUndefined();
    expect(launch.notice).toContain('cannot take a session id');
  });
});

describe('a plain line that swallows its tail takes no session id, and one that does not keeps it', () => {
  test('the comment line records no id, and the stub CLI receives only the words before the comment', () => {
    const line = 'claude --model m # note';
    const launch = withLaunchSession('claude-code', line);
    expect(launch.command).toBe(line);
    expect(launch.sessionId).toBeUndefined();
    expect(launch.notice).toContain('cannot take a session id');
    // Were the id recorded, it would land inside the comment. The shell hands the CLI the line
    // without it, so the stub's argv is the measurement.
    expect(cliArgv(`${line} --session-id declared-1`)).toEqual(['--model', 'm']);
  });

  test('a variable on a plain line does not swallow the id, and the CLI receives it', () => {
    const launch = withLaunchSession('claude-code', 'claude --model $X');
    expect(launch.sessionId).toBeDefined();
    expect(cliArgv(launch.command, { env: { X: 'm' } })).toEqual([
      '--model',
      'm',
      '--session-id',
      launch.sessionId!,
    ]);
  });

  test('a glob on a plain line does not swallow the id either', () => {
    const launch = withLaunchSession('claude-code', 'claude --model m*');
    expect(launch.sessionId).toBeDefined();
  });
});

// The read-back side of the same contract: an id the CLI receives is an id the line records. The
// seven proved shapes below are the ones this lane mints on, and the declared flags are the ones
// a line writes itself, plain and quoted. The stub's argv is the measurement: the id is in it.
describe('the session id a launch line carries is the id that reaches its CLI', () => {
  const MINTED_SHAPES = [
    'claude --model m',
    '/bin/sh -c "claude --model m"',
    "/bin/sh -c 'claude --model m'",
    '/bin/sh -lc "claude --model m"',
    '/bin/sh -ec "claude --model m"',
    '/bin/sh -c "exec claude --model m"',
    '/bin/sh -c "command claude --model m"',
    `/bin/sh -c "sh -ec 'exec claude --model m'"`,
  ] as const;

  test('every minted id is the id launchSessionId reads back, on every proved shape', () => {
    for (const line of MINTED_SHAPES) {
      const launched = withLaunchSession('claude-code', line);
      expect(`${line}: ${launched.notice ?? 'none'}`).toBe(`${line}: none`);
      expect(launched.sessionId).toBeDefined();
      expect(`${line}: ${launchSessionId(launched.command) ?? 'none'}`).toBe(`${line}: ${launched.sessionId}`);
      const argv = cliArgv(launched.command);
      expect(argv[argv.indexOf('--session-id') + 1]).toBe(launched.sessionId!);
    }
  });

  test('a declared id is read however its flag and value are written', () => {
    const id = '01234567-89ab-4cde-8fab-0123456789ab';
    const quoteSingle = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
    const shapes = [
      `claude --session-id ${id}`,
      ...['--session-id', '"--session-id"', "'--session-id'"].map(
        (flag) => `/bin/sh -ec ${quoteSingle(`claude ${flag} ${id}`)}`,
      ),
    ];
    for (const line of shapes) {
      expect(`${line}: ${launchSessionId(line) ?? 'none'}`).toBe(`${line}: ${id}`);
      expect(withLaunchSession('claude-code', line)).toEqual({ command: line, sessionId: id });
      expect(cliArgv(line)).toEqual(['--session-id', id]);
    }
  });

  test('a declared id on an unprovable line is not read: the shell never hands it over', () => {
    const line = '/bin/sh -c "claude --session-id declared-1 $TAIL"';
    expect(cliWordList('claude-code', line)).toBeNull();
    expect(launchSessionId(line)).toBeUndefined();
    expect(withLaunchSession('claude-code', line).sessionId).toBeUndefined();
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
