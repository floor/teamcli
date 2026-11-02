// The launch line is read the way a POSIX shell splits it into words: single quotes literal,
// double quotes honouring `\`, `"`, `$` and a backtick, a backslash outside quotes taking the
// next character, a backslash-newline removed as a line continuation outside single quotes, and
// the standard `'\''` splice reading as one word. An ANSI-C (`$'…'`) word with no backslash is
// its literal text, the same in every shell that reads it; one holding a backslash is not
// decoded, because the two shells read its escapes differently, so a line holding one is
// unreadable at the `ansi` reason. A NUL byte is unreadable at `nul`, and a line whose quoting
// never closes at `unclosed`. A line with no knowable words reads as null, never as a guess.
import { expect, test } from 'bun:test';
import { shellWords, shellWordsReason } from '../../src/launch/shell-words.ts';

const texts = (line: string): string[] | null => shellWords(line)?.map((word) => word.text) ?? null;

test('quotes and escapes are resolved the way a shell resolves them', () => {
  expect(texts(`/bin/sh -c 'claude --model m'`)).toEqual(['/bin/sh', '-c', 'claude --model m']);
  // Inside double quotes a backslash is special only before `$`, a backtick, `"`, a backslash
  // or a newline; anywhere else it stands for itself.
  expect(texts(`zsh -lc "claude --model m \\"quoted\\""`)).toEqual(['zsh', '-lc', 'claude --model m "quoted"']);
  expect(texts(`sh -c "claude --model m \\\\"`)).toEqual(['sh', '-c', 'claude --model m \\']);
  // Outside quotes a backslash takes the next character.
  expect(texts(`sh -c claude\\ --model`)).toEqual(['sh', '-c', 'claude --model']);
});

test('the standard quote splice is one word, as a shell reads it', () => {
  expect(texts(`sh -c 'claude '\\''s --resume abc'`)).toEqual(['sh', '-c', "claude 's --resume abc"]);
});

test('a line whose quoting never closes, or that ends in a backslash, has no knowable words', () => {
  expect(shellWords(`/bin/sh -c "claude --model m`)).toBeNull();
  expect(shellWords(`sh -c 'claude --model m`)).toBeNull();
  expect(shellWords('claude \\')).toBeNull();
});

test('a backslash-newline is a line continuation everywhere but inside single quotes', () => {
  // Outside quotes both characters vanish and the word goes on either side of them: this is how
  // a long launch line in a team file is written across two lines.
  expect(texts('pre\\\npost')).toEqual(['prepost']);
  expect(texts('a \\\nb')).toEqual(['a', 'b']);
  // Inside double quotes the shell removes it too.
  expect(texts('"pre\\\npost"')).toEqual(['prepost']);
  expect(texts(`sh -c "claude --mod\\\nel m"`)).toEqual(['sh', '-c', 'claude --model m']);
  // Inside single quotes the backslash is literal: no continuation there.
  expect(texts("'pre\\\npost'")).toEqual(['pre\\\npost']);
});

test(`an ANSI-C ($'…') word with no backslash is its literal text`, () => {
  // With no escape there is nothing for the shells to read differently: each hands the text
  // between the quotes to the program unchanged, whichever shell runs the line.
  expect(texts("$'claude --model m'")).toEqual(['claude --model m']);
  expect(texts("/bin/bash -c $'claude --model m'")).toEqual(['/bin/bash', '-c', 'claude --model m']);
  expect(texts("x$'y'z $''")).toEqual(['xyz', '']);
});

test(`an ANSI-C ($'…') word holding a backslash is unreadable, never decoded`, () => {
  // Measured here with the same `printf %s $'…'` probe on bash 3.2.57 and zsh 5.9: the word
  // `x\u00e9y` is the literal text in bash (78 5c 75 30 30 65 39) and `xéy` in zsh (78 c3 a9 79);
  // `x\x00y` is `x` in bash (78) and `x`, a NUL, `y` in zsh (78 00 79); a short `\u00` is literal
  // in bash (78 5c 75 30 30 79) and a NUL in zsh (78 00 79); `\8` is literal in bash (78 5c 38 79)
  // and `8` in zsh (78 38 79). Every such word is unreadable, including the escapes the two
  // shells read alike: one rule, no subset.
  for (const line of [
    "$'a\\nb'",
    "$'it\\'s'",
    "$'a\\\\b'",
    "$'\\101\\x41'",
    "$'\\u00e9'",
    "$'x\\u00e9y'",
    "$'x\\x00y'",
    "$'x\\0y'",
    "$'x\\u00y'",
    "$'x\\8y'",
    "$'a\\qb'",
    "$'a\\$b'",
    "$'a\\`b'",
    "$'\\cA'",
  ]) {
    expect(shellWords(line)).toBeNull();
    expect(shellWordsReason(line)).toBe('ansi');
  }
  // A `$'…'` that never closes is a line no shell can run, like any other unclosed quote.
  expect(shellWords("$'never closes")).toBeNull();
  expect(shellWordsReason("$'never closes")).toBe('unclosed');
});

test('a NUL byte and an unclosed line each have their own reason', () => {
  expect(shellWords('claude --model m\u0000')).toBeNull();
  expect(shellWordsReason('claude --model m\u0000')).toBe('nul');
  expect(shellWordsReason('/bin/sh -c "claude --model m')).toBe('unclosed');
  expect(shellWordsReason('claude \\')).toBe('unclosed');
  expect(shellWordsReason('claude --model m')).toBeNull();
  // Inside double quotes `$'` is not ANSI-C quoting: it is two literal characters, as both
  // shells read it.
  expect(texts(`sh -c "claude $'x'"`)).toEqual(['sh', '-c', "claude $'x'"]);
});

test('a command substitution is one word, kept as written', () => {
  // The shell runs the substitution to produce the word, which this reader does not run; its
  // source text is what a reader can know, and the span is one word for every boundary served
  // here. A launch line's credential lookup is exactly this shape: spaces inside `$(…)` are the
  // substitution's, not the line's.
  expect(texts('claude $(which claude) --model m')).toEqual(['claude', '$(which claude)', '--model', 'm']);
  expect(
    texts('ANTHROPIC_AUTH_TOKEN=$(/usr/bin/security find-generic-password -s item -a "$USER" -w) claude'),
  ).toEqual(['ANTHROPIC_AUTH_TOKEN=$(/usr/bin/security find-generic-password -s item -a "$USER" -w)', 'claude']);
  expect(texts('claude "x $(date) y"')).toEqual(['claude', 'x $(date) y']);
  expect(texts('claude `date` --model m')).toEqual(['claude', '`date`', '--model', 'm']);
  expect(texts('claude ${HOME}/x')).toEqual(['claude', '${HOME}/x']);
  expect(texts('claude $(echo $(date))')).toEqual(['claude', '$(echo $(date))']);
  expect(texts('claude $(echo ")")')).toEqual(['claude', '$(echo ")")']);
  expect(texts('claude $(echo `date`)')).toEqual(['claude', '$(echo `date`)']);
  // A backslash still takes the next character: an escaped `$` opens nothing.
  expect(texts('claude \\$(date)')).toEqual(['claude', '$(date)']);
});

test('an unclosed substitution is a line no shell can run', () => {
  expect(shellWords('claude $(date')).toBeNull();
  expect(shellWordsReason('claude $(date')).toBe('unclosed');
  expect(shellWords('claude `date')).toBeNull();
  expect(shellWordsReason('claude `date')).toBe('unclosed');
  expect(shellWords('claude ${HOME')).toBeNull();
  expect(shellWordsReason('claude ${HOME')).toBe('unclosed');
  expect(shellWords('claude "x $(date"')).toBeNull();
  expect(shellWordsReason('claude "x $(date"')).toBe('unclosed');
});
