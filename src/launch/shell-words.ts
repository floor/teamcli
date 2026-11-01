// A launch line read the way a POSIX shell splits it into words. Quoting is followed, never
// guessed from the last character: single quotes are literal, double quotes honour `\`, `"`,
// `$` and a backtick, and a backslash outside quotes takes the next character. A backslash-newline
// pair is removed outside single quotes — a line continuation, inside double quotes too, as a
// shell removes it; inside single quotes the backslash is literal. `$'…'` is read as bash and zsh
// write it (ANSI-C quoting), but only where both decode it the same way: measured here in bash
// 3.2.57 and zsh 5.9, `\n` is a newline, `\'` a quote, `\\` a backslash, `\101` and `\x41` both
// read `A`, a four-digit `\u` code reads its letter (`é` for the code the probe used), and the
// control escapes `\a \b \e \E \f \r \t \v` agree. They do
// not agree on an escape they do not know (`\q`: bash keeps `\q`, zsh reads `q`), on `\$` or
// `` \` `` (bash keeps the backslash), on `\cA` (bash reads a control byte, zsh reads `cA`), on
// `\0` (bash drops it, zsh keeps `\0`) or on a short `\u00` (bash keeps it, zsh reads `\0`). A
// word using one of those is not knowable from the line alone: the line is null, and nothing
// built on it may guess. The standard `'\''` splice — close the single quotes, an escaped quote,
// reopen — reads as one word, as a shell reads it. A line with an unclosed quote or a trailing
// backslash is null too.

export type ShellWord = {
  /** The word as the shell hands it to the program, quotes removed and escapes resolved. */
  text: string;
  /** Where the word starts on the line. */
  start: number;
  /** Where the word ends on the line: just past its last source character. */
  end: number;
};

/** The escapes both bash and zsh decode identically, measured escape by escape. `$'…'` text
 *  with any other escape decodes differently in the two shells, so the word is not knowable and
 *  the caller treats the line as unreadable. */
const ANSI_SIMPLE: Record<string, string> = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  '\\': '\\', "'": "'", '"': '"', '?': '?',
};

/** The text of one `$'…'` escape whose backslash is at `at`, and where the escape ends. Null for
 *  an escape the two shells do not decode alike: unknown escapes, `\$`, `` \` ``, `\cA`, `\0`
 *  and a short `\u`. */
function ansiEscape(command: string, at: number): { text: string; end: number } | null {
  const next = command[at];
  if (next === undefined) return null;
  const simple = ANSI_SIMPLE[next];
  if (simple !== undefined) return { text: simple, end: at + 1 };
  if (next === 'x') {
    const digits = /^[0-9A-Fa-f]{1,2}/.exec(command.slice(at + 1, at + 3))?.[0] ?? '';
    if (digits === '') return null;
    return { text: String.fromCharCode(Number.parseInt(digits, 16)), end: at + 1 + digits.length };
  }
  if (next === 'u') {
    const digits = /^[0-9A-Fa-f]{4}$/.exec(command.slice(at + 1, at + 5))?.[0];
    if (digits === undefined) return null;
    return { text: String.fromCodePoint(Number.parseInt(digits, 16)), end: at + 5 };
  }
  if (next >= '1' && next <= '7') {
    const digits = /^[0-7]{1,3}/.exec(command.slice(at))![0];
    const code = Number.parseInt(digits, 8);
    if (code > 0xff) return null;
    return { text: String.fromCharCode(code), end: at + digits.length };
  }
  return null;
}

/** The decoded text of a `$'…'` word whose `$` is at `at`, and where its closing quote ends.
 *  Null when the quote never closes, or when it holds an escape the two shells read differently. */
function ansiWord(command: string, at: number): { text: string; end: number } | null {
  let text = '';
  let index = at + 2;
  while (index < command.length) {
    const char = command[index]!;
    if (char === "'") return { text, end: index + 1 };
    if (char !== '\\') {
      text += char;
      index += 1;
      continue;
    }
    const decoded = ansiEscape(command, index + 1);
    if (decoded === null) return null;
    text += decoded.text;
    index = decoded.end;
  }
  return null;
}

/** The words of a command line, or null when its quoting never closes or cannot be decoded the
 *  same way by every shell it may run under. */
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
      if (next === undefined) return null;
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
    if (char === '$' && command[at + 1] === "'") {
      const ansi = ansiWord(command, at);
      if (ansi === null) return null;
      text += ansi.text;
      at = ansi.end;
      continue;
    }
    text += char;
    at += 1;
  }
  if (start >= 0) words.push({ text, start, end: length });
  return words;
}
