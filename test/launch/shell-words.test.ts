// The launch line is read the way a POSIX shell splits it into words: single quotes literal,
// double quotes honouring `\`, `"`, `$` and a backtick, a backslash outside quotes taking the
// next character, a backslash-newline removed as a line continuation outside single quotes, and
// the standard `'\''` splice reading as one word. `$'…'` is decoded where bash and zsh decode it
// alike; an escape they read differently leaves the whole line unreadable. A line whose quoting
// never closes has no knowable words either, and reads as null, never as a guess.
import { expect, test } from 'bun:test';
import { shellWords } from '../../src/launch/shell-words.ts';

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

test(`ANSI-C quoting ($'…') decodes to the words the shell hands its program`, () => {
  // Measured here in bash 3.2.57 and zsh 5.9: both read `\n` as a newline, `\'` as a quote,
  // `\\` as a backslash, `\101` and `\x41` as `A`, a four-digit `\u` code as its letter, and the
  // control escapes alike.
  expect(texts("/bin/bash -c $'claude --model m'")).toEqual(['/bin/bash', '-c', 'claude --model m']);
  expect(texts("$'a\\nb'")).toEqual(['a\nb']);
  expect(texts("$'it\\'s'")).toEqual(["it's"]);
  expect(texts("$'a\\\\b'")).toEqual(['a\\b']);
  expect(texts("$'\\101\\x41'")).toEqual(['AA']);
  expect(texts("$'x\\x4y'")).toEqual(['x\x04y']);
  expect(texts("$'\\u00e9'")).toEqual(['é']);
  expect(texts("pre$'post'")).toEqual(['prepost']);
});

test('an ANSI-C escape the two shells read differently leaves the line unreadable, never guessed', () => {
  // Measured with the same probe: bash keeps the backslash on `\q`, `\$` and `` \` `` where zsh
  // drops it; `\cA` is a control byte in bash and `cA` in zsh; `\0` is dropped by bash and kept
  // by zsh; a short `\u00` is literal in bash and `\0` in zsh. None of these is knowable from
  // the line alone, so the line is null and keeps 0.5.10's placement.
  for (const line of ["$'a\\qb'", "$'a\\$b'", "$'a\\`b'", "$'\\cA'", "$'x\\0y'", "$'x\\u00y'", "$'x\\8y'", "$'never closes"]) {
    expect(shellWords(line)).toBeNull();
  }
});
