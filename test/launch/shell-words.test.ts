// The launch line is read the way a POSIX shell splits it into words: single quotes literal,
// double quotes honouring `\`, `"`, `$` and a backtick, a backslash outside quotes taking the
// next character, and the standard `'\''` splice reading as one word. A line whose quoting never
// closes has no knowable words and reads as null, never as a guess.
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
