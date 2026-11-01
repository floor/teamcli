// A launch line read the way a POSIX shell splits it into words. Quoting is followed, never
// guessed from the last character: single quotes are literal, double quotes honour `\`, `"`,
// `$` and a backtick, and a backslash outside quotes takes the next character. The standard
// `'\''` splice — close the single quotes, an escaped quote, reopen — reads as one word, as a
// shell reads it. A line with an unclosed quote or a trailing backslash is null: the words are
// not knowable, and nothing built on them may guess.

export type ShellWord = {
  /** The word as the shell hands it to the program, quotes removed and escapes resolved. */
  text: string;
  /** Where the word starts on the line. */
  start: number;
  /** Where the word ends on the line: just past its last source character. */
  end: number;
};

/** The words of a command line, or null when its quoting never closes. */
export function shellWords(command: string): ShellWord[] | null {
  const words: ShellWord[] = [];
  const length = command.length;
  let at = 0;
  let text = '';
  let start = -1;
  while (at < length) {
    const char = command[at]!;
    if (/\s/.test(char)) {
      if (start >= 0) {
        words.push({ text, start, end: at });
        text = '';
        start = -1;
      }
      at += 1;
      continue;
    }
    if (start < 0) start = at;
    if (char === "'") {
      const close = command.indexOf("'", at + 1);
      if (close < 0) return null;
      text += command.slice(at + 1, close);
      at = close + 1;
      continue;
    }
    if (char === '"') {
      at += 1;
      for (;;) {
        if (at >= length) return null;
        const inner = command[at]!;
        if (inner === '"') {
          at += 1;
          break;
        }
        if (inner === '\\') {
          const next = command[at + 1];
          if (next === undefined) return null;
          // Inside double quotes a backslash is special only before `$`, a backtick, `"`, a
          // backslash or a newline; anywhere else it stands for itself.
          if (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n') {
            text += next;
            at += 2;
            continue;
          }
          text += inner;
          at += 1;
          continue;
        }
        text += inner;
        at += 1;
      }
      continue;
    }
    if (char === '\\') {
      const next = command[at + 1];
      if (next === undefined) return null;
      text += next;
      at += 2;
      continue;
    }
    text += char;
    at += 1;
  }
  if (start >= 0) words.push({ text, start, end: length });
  return words;
}
