// A launch line read the way a POSIX shell splits it into words. Quoting is followed, never
// guessed from the last character: single quotes are literal, double quotes honour `\`, `"`,
// `$` and a backtick, and a backslash outside quotes takes the next character. A backslash-newline
// pair is removed outside single quotes — a line continuation, inside double quotes too, as a
// shell removes it; inside single quotes the backslash is literal. The standard `'\''` splice —
// close the single quotes, an escaped quote, reopen — reads as one word, as a shell reads it.
//
// `$'…'` (ANSI-C quoting) is read when it holds no backslash: every shell that reads such a
// word then hands on the literal text between its quotes, so there is nothing to guess. A word
// holding a backslash is not read at all. What its escapes mean depends on the shell that runs
// the line, and the shells disagree: measured here on GNU bash 3.2.57(1)-release and zsh 5.9 with the
// same `printf %s $'…'` probe, `x\u00e9y` is the literal text `x\u00e9y` in bash
// (78 5c 75 30 30 65 39) and `xéy` in zsh (78 c3 a9 79); `x\x00y` is `x` in bash (78) and `x`,
// a NUL, `y` in zsh (78 00 79); and `\0`, a short `\u00` and `\8` differ the same way. Even the
// escapes the two shells read alike are not read here: one rule covers every such word, so a
// line holding one is unreadable at the `ansi` reason, and nothing built on it may guess — a
// launch refuses it (`lineDelimiterRisk` in `cli-scope.ts`), as it refuses any unread suffix
// holding a `--`, a backslash or an ANSI-C opening; only a suffix that plainly cannot spell the
// CLI's delimiter keeps 0.5.10's placement. A NUL byte is unreadable at
// the `nul` reason: no shell can hand one to a program in a word. A line with an unclosed quote
// or a trailing backslash is unreadable at the `unclosed` reason: no shell can run it.

export type ShellWord = {
  /** The word as the shell hands it to the program, quotes removed and escapes resolved. */
  text: string;
  /** Where the word starts on the line. */
  start: number;
  /** Where the word ends on the line: just past its last source character. */
  end: number;
};

/** Why a line has no knowable words. `unclosed` is a line no shell can run; `ansi` and `nul`
 *  are a line some shell may run, whose words this reader cannot know without guessing. */
export type ShellWordsUnreadable = 'unclosed' | 'ansi' | 'nul';

/** A line's words, or the reason they stop: the words read before the stop come with the reason,
 *  so a caller can see whether they named the CLI's delimiter, and `at` is where the word being
 *  read when it stopped begins, so a caller can see what it did not read. */
export type ShellWordsRead =
  | { words: ShellWord[] }
  | { words: ShellWord[]; unreadable: ShellWordsUnreadable; at: number };

/** Read a line to its words. Exported for the one caller that must decide about a line it could
 *  not read (`lineDelimiterRisk`), which needs the words read before the unreadable part. */
export function readShellWords(command: string): ShellWordsRead {
  if (command.includes('\u0000')) return { words: [], unreadable: 'nul', at: 0 };
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
      if (close < 0) return { words, unreadable: 'unclosed', at: start };
      text += command.slice(at + 1, close);
      at = close + 1;
      continue;
    }
    if (char === '"') {
      at += 1;
      for (;;) {
        if (at >= length) return { words, unreadable: 'unclosed', at: start };
        const inner = command[at]!;
        if (inner === '"') {
          at += 1;
          break;
        }
        if (inner === '\\') {
          const next = command[at + 1];
          if (next === undefined) return { words, unreadable: 'unclosed', at: start };
          // Inside double quotes a backslash is special only before `$`, a backtick, `"`, a
          // backslash or a newline; a backslash-newline is removed as a continuation, and
          // anywhere else the backslash stands for itself.
          if (next === '\n') {
            at += 2;
            continue;
          }
          if (next === '$' || next === '`' || next === '"' || next === '\\') {
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
      if (next === undefined) return { words, unreadable: 'unclosed', at: start };
      // A backslash-newline outside quotes is a line continuation: both characters vanish, and
      // the word goes on either side of them.
      if (next === '\n') {
        at += 2;
        continue;
      }
      text += next;
      at += 2;
      continue;
    }
    // An unquoted `$'` opens ANSI-C quoting. Inside double quotes it is not quoting at all (the
    // `$` is literal there), so this check is here, outside the double-quote branch above. A
    // word with no backslash is the literal text between its quotes in every shell that reads
    // it; one with a backslash is unreadable, because the shells disagree on its escapes.
    if (char === '$' && command[at + 1] === "'") {
      const close = command.indexOf("'", at + 2);
      if (close < 0) return { words, unreadable: 'unclosed', at: start };
      const body = command.slice(at + 2, close);
      if (body.includes('\\')) return { words, unreadable: 'ansi', at: start };
      text += body;
      at = close + 1;
      continue;
    }
    text += char;
    at += 1;
  }
  if (start >= 0) words.push({ text, start, end: length });
  return { words };
}

/** The words of a command line, or null when its quoting never closes or cannot be decoded the
 *  same way by every shell it may run under. */
export function shellWords(command: string): ShellWord[] | null {
  const read = readShellWords(command);
  return 'unreadable' in read ? null : read.words;
}

/** Why a line has no knowable words, or null when it has them. A caller that must tell a line no
 *  shell can run (`unclosed`) from one a shell may run but this reader cannot prove (`ansi`,
 *  `nul`) reads the reason here. */
export function shellWordsReason(command: string): ShellWordsUnreadable | null {
  const read = readShellWords(command);
  return 'unreadable' in read ? read.unreadable : null;
}
