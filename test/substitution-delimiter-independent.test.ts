// Independent scenes: a launch line whose CLI argument depends on what the shell computes is
// refused, never placed around. The tokenizer keeps a substitution, a backtick or a parameter
// expansion as its source text, because the shell runs it: the word that reaches the CLI may be
// `--`, and an option written after it would be prompt text. Measured here on GNU bash
// 3.2.57(1)-release and zsh 5.9, `printf '<%s>\n' codex $(printf %s $'\055\055') --flag` hands
// the program `codex`, `--`, `--flag`; `DELIM=--; printf '<%s>\n' codex $DELIM --flag` hands it
// the same three words. The probe only runs printf and a FAKE codex — a plain script that logs
// its argv; no real agent CLI, credential or owner file is touched. A literal spelling — a
// single-quoted `'$X'`, an escaped `\$X`, a decodable `$'--'` — is a word this reader knows, and
// a leading assignment word is exempt because no shell splits its expansion: measured on bash,
// zsh and sh, `A=$(printf '%s' 'x y') /usr/bin/env` prints `A=x y`, one value, while the same
// word after `env` is split (`env A=$(printf '%s' 'x y')` tries to run `y`). The vendor's
// credential lookup is exactly that leading-assignment shape, so it keeps launching.
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendOnLaunchLine, cliWordListOf, lineDelimiterRisk } from '../src/launch/cli-scope.ts';
import { profileFor } from '../src/profiles/index.ts';
import { launchCommandOrRefusal } from '../src/profiles/profile.ts';

const PROFILE = profileFor('codex')!;
const RULES = 'Read the rules file before your first answer (pair 3b7c1d42).';
/** The words the profile adds to a line that sets none of them itself. */
const ADDED = ['-a', 'never', '-s', 'danger-full-access', '--no-alt-screen', '-c', 'features.mcp_oauth_refresh_coordination=false'];

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A folder holding a fake codex that logs its argv, one argument per line. The script is
 *  created with its mode, never chmod'ed afterwards. */
function fakeCodex(): { bin: string; log: string; home: string } {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'codex-subst-')));
  roots.push(root);
  const bin = join(root, 'bin');
  const log = join(root, 'argv.log');
  const home = join(root, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(
    join(bin, 'codex'),
    `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> '${log}'; done\n`,
    { mode: 0o755 },
  );
  return { bin, log, home };
}

/** The launcher's command, run as a pane would run it; the fake codex's argv. */
function argvOf(launch: string): string[] {
  const { bin, log, home } = fakeCodex();
  const built = launchCommandOrRefusal(PROFILE, launch, 'Rules.', undefined, undefined, undefined, undefined, RULES);
  expect(built.refusal, launch).toBeUndefined();
  const out = spawnSync('/bin/sh', ['-c', built.command], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, encoding: 'utf8' });
  expect(out.status, `${launch}: ${out.stderr}`).toBe(0);
  expect(existsSync(log), `${launch}: the fake codex never ran`).toBe(true);
  return readFileSync(log, 'utf8').replace(/\n$/, '').split('\n');
}

/** Every added option stands before the CLI's own delimiter, and the rules line is last. */
function addedBeforeDelimiter(argv: string[]): void {
  const delimiter = argv.indexOf('--');
  expect(delimiter).toBeGreaterThan(0);
  expect(argv.slice(delimiter - ADDED.length, delimiter)).toEqual(ADDED);
  expect(argv[argv.length - 1]).toBe(RULES);
}

// Each line hands its CLI a word whose value the shell computes: the word may be the CLI's `--`
// when the line runs, so any word this tool wrote after it would be prompt text.
const COMPUTED = [
  "codex $(printf %s $'\\055\\055')", // the probe: a substitution whose body hides an escaped ANSI-C word
  'codex $(printf %s --)', // a substitution whose value is the delimiter
  'codex `printf %s --`', // the same, as a backtick
  'codex --model $DELIM', // an unquoted parameter expansion
  'codex --model ${DELIM}', // the braced spelling
  'codex --model "$DELIM"', // the same inside double quotes: one word, and still the shell's
  "codex --model $'\\x2d\\x2d'", // an escaped ANSI-C word: refused before this fix too
  'env TOKEN=$(printf %s tok) codex --model m', // after `env` the word is split: not an assignment
];

test('a computed word at the CLI argument scope is refused, never launched', () => {
  for (const line of COMPUTED) {
    const built = launchCommandOrRefusal(PROFILE, line, 'Rules.', undefined, undefined, undefined, undefined, RULES);
    expect(built.refusal, line).toContain('delimiter');
    expect(built.command, line).toBe('');
    expect(lineDelimiterRisk(line), line).toBe(true);
    expect(cliWordListOf('codex', line), line).toBeNull();
  }
});

test('a computed word is never placed around: the plain-line placement gives way', () => {
  for (const line of COMPUTED) {
    const placed = appendOnLaunchLine(line, '--model fast', 'codex');
    expect(placed.uncertain, line).toBe(true);
    // The fallback keeps 0.5.10's placement after the line — but the caller refuses the launch
    // above, so no command built from it is ever run. What must never happen is a placement
    // that writes a word before a delimiter this reader did not see literally.
    expect(cliWordListOf('codex', placed.line), line).toBeNull();
  }
});

test('a literal spelling is a word this reader knows, and the launch stands', () => {
  const literal = argvOf(`codex --model '$X' -- ask`);
  expect(literal.slice(0, 2)).toEqual(['--model', '$X']);
  addedBeforeDelimiter(literal);

  const substitutionText = argvOf(`codex '$(printf %s --)' -- ask`);
  expect(substitutionText).toEqual(['$(printf %s --)', ...ADDED, '--', 'ask', RULES]);

  const escaped = argvOf('codex --model \\$X -- ask');
  expect(escaped[0]).toBe('--model');
  expect(escaped[1]).toBe('$X');
  addedBeforeDelimiter(escaped);
});

// Known for 0.5.12.1: running $'--' under /bin/sh -c assumes a shell that decodes ANSI-C quoting;
// Ubuntu /bin/sh is dash.
test.skipIf(process.platform !== 'darwin')('a decodable ANSI-C delimiter is still a known delimiter: options stand before it', () => {
  const line = "codex exec $'--' plain task";
  expect(lineDelimiterRisk(line)).toBe(false);
  expect(cliWordListOf('codex', line)).toEqual(['codex', 'exec', '--', 'plain', 'task']);
  expect(appendOnLaunchLine(line, '--model fast', 'codex')).toEqual({
    line: "codex exec --model fast $'--' plain task",
    uncertain: false,
  });
  expect(argvOf(line)).toEqual(['exec', ...ADDED, '--', 'plain', 'task', RULES]);
});

test('a leading assignment keeps the vendor lookup launching, with options before the delimiter', () => {
  const argv = argvOf('ANTHROPIC_AUTH_TOKEN=$(printf %s tok) codex --model m -- task');
  expect(argv.slice(0, 2)).toEqual(['--model', 'm']);
  addedBeforeDelimiter(argv);
  const delimiter = argv.indexOf('--');
  expect(argv.slice(delimiter + 1)).toEqual(['task', RULES]);
});
