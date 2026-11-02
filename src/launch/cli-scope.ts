// The shell scope of a launch line: which words the shell hands the CLI, and where a word
// written for the CLI is read by it. A line's last word may be a quoted script (`sh -c 'claude
// …'`) that runs the CLI, and one nested shell is followed to the script it runs. Every reader
// and every placement asks the same proof before it trusts a word (provenScriptWord), so they
// refuse the same lines by construction. Nothing here refuses to launch: a line this reader
// cannot prove keeps 0.5.10's placement and the caller says so.
import { readShellWords, shellWords, type ShellWord } from './shell-words.ts';

/** A launch line split at its first positional delimiter, as the shell will parse it: `head`
 *  ends before the `--` word, `tail` begins at it and is empty when the line names none. The
 *  delimiter is the argv word, so `--`, `'--'`, `"--"` and an ANSI-C `$'--'` all split the line.
 *  A line this reader cannot read names no split; every caller asks only about a line it has
 *  already read (`placementOf` refuses an unreadable one first). */
export function splitAtDelimiter(line: string): { head: string; tail: string } {
  const words = shellWords(line);
  if (words === null) return { head: line, tail: '' };
  const delimiter = words.find((word) => word.text === '--');
  if (delimiter === undefined) return { head: line, tail: '' };
  return { head: line.slice(0, delimiter.start), tail: line.slice(delimiter.start) };
}

/** The shells that take a command string. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh']);

/** Whether a program name is a shell: one that takes a command string of its own. */
export function isShellName(name: string): boolean {
  return SHELLS.has(name);
}

/** The shells whose quoting this tool writes inside: the POSIX shells, whose single quote
 *  splices as `'\''` and whose words split as the tokenizer reads them. A fish or csh command
 *  string is read for its flags but never written into: a line that runs one keeps 0.5.10's
 *  placement after the line, with the warning that says so. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash']);

/** The program word of a line, past its variable assignments and an `env` prefix. */
function programWordAt(words: readonly ShellWord[]): number {
  let at = 0;
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!.text)) at += 1;
  if (at < words.length && (words[at]!.text.split('/').pop() ?? words[at]!.text) === 'env') {
    at += 1;
    while (at < words.length) {
      const text = words[at]!.text;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text) || text.startsWith('-')) {
        at += 1;
        continue;
      }
      break;
    }
  }
  return at;
}

/** The program word of a line, when that word is a shell. */
function shellProgramOf(command: string): string | null {
  const words = shellWords(command.trimEnd());
  if (words === null) return null;
  const program = words[programWordAt(words)];
  if (program === undefined) return null;
  const name = program.text.split('/').pop() ?? program.text;
  return SHELLS.has(name) ? name : null;
}

/** A shell's command-string flag: `-c`, or a cluster that ends in one — `-lc`, `-ec`, `-euc`.
 *  A cluster carrying `o` or `O` is not one: those take the rest of the cluster as their own
 *  name, so `-oc` names that option `c`, never the command-string flag. */
function isCommandStringFlag(text: string): boolean {
  return /^-[A-Za-z]*c$/.test(text) && !/[oO]/.test(text.slice(1));
}

/** The word a shell on this line runs as its command string, with the words after it. Null when
 *  the line's program is not a shell, when the shell's options name no command string (a script
 *  file, stdin), and when a command-string flag has no word after it. Only a word right after a
 *  command-string flag is a script: `bash -l ../tools/y.sh` runs a file, and a script file is
 *  never read as a `-c` script. The words after that script are its positional words. */
export type ShellScript = { word: ShellWord; trailing: readonly ShellWord[] };
export function shellScriptWordOf(command: string): ShellScript | null {
  const trimmed = command.trimEnd();
  const words = shellWords(trimmed);
  if (words === null || words.length === 0) return null;
  const programAt = programWordAt(words);
  const program = words[programAt];
  if (program === undefined) return null;
  if (!SHELLS.has(program.text.split('/').pop() ?? program.text)) return null;
  for (let at = programAt + 1; at < words.length; at += 1) {
    const word = words[at]!;
    if (isCommandStringFlag(word.text)) {
      const script = words[at + 1];
      return script === undefined ? null : { word: script, trailing: words.slice(at + 2) };
    }
    // `--` ends the options and `-` names stdin: neither is a command string.
    if (word.text === '--' || word.text === '-') return null;
    if (word.text === '-o') {
      // `-o` takes its option name as the next word: `sh -o errexit -c 'claude'`.
      at += 1;
      continue;
    }
    if (word.text.startsWith('-')) continue;
    // A script file operand: the words after it are that script's own.
    return null;
  }
  return null;
}

/** The quoting a script word's text can be written into. */
type ScriptQuote = 'double' | 'single';

/** The quote that opens a word's last source character, when that character closes it: the
 *  quote context open just before the word ends. Null when the word ends outside quotes
 *  (`claude`, `"claude"x`), where nothing can be placed inside its text. A `$'…'` word never
 *  reaches this reader: the tokenizer does not read ANSI-C quoting, so its line is unreadable. */
function closingQuoteOf(command: string, word: ShellWord): ScriptQuote | null {
  let quote: ScriptQuote | null = null;
  let at = word.start;
  const last = word.end - 1;
  while (at < last) {
    const char = command[at]!;
    if (quote === null) {
      if (char === '\\') {
        at += 2;
        continue;
      }
      if (char === "'") {
        quote = 'single';
        at += 1;
        continue;
      }
      if (char === '"') {
        quote = 'double';
        at += 1;
        continue;
      }
      at += 1;
      continue;
    }
    if (quote === 'single') {
      if (char === "'") quote = null;
      at += 1;
      continue;
    }
    if (char === '\\') {
      at += 2;
      continue;
    }
    if (char === '"') quote = null;
    at += 1;
  }
  if (quote === null) return null;
  const close = command[last];
  if (quote === 'double') return close === '"' ? quote : null;
  return close === "'" ? quote : null;
}

/** The source length of the delimiter a quoted word opens with, when its first source
 *  characters are that delimiter. Null when the word starts with something else (`x"…"`),
 *  whose source this reader cannot rebuild. */
function openingOf(command: string, word: ShellWord, quote: ScriptQuote): number | null {
  return command[word.start] === (quote === 'double' ? '"' : "'") ? 1 : null;
}

type QuotedWord = { quote: ScriptQuote; openLen: number };

/** A word this reader can write inside: one quoted string in source, whose opening delimiter is
 *  the quote that closes its last character. */
function quotedWordOf(command: string, word: ShellWord): QuotedWord | null {
  const quote = closingQuoteOf(command, word);
  if (quote === null) return null;
  const openLen = openingOf(command, word, quote);
  return openLen === null ? null : { quote, openLen };
}

/** Whether a script body runs the CLI as its command: its program word is `<binary>`, by name or
 *  path, given directly or after `exec` or `command` whose own options are none. */
function startsWithCli(binary: string, command: string): boolean {
  const words = shellWords(command);
  if (words === null) return false;
  let at = programWordAt(words);
  let program = words[at];
  if (program !== undefined && (program.text === 'exec' || program.text === 'command')) {
    at += 1;
    program = words[at];
    if (program === undefined || program.text.startsWith('-')) return false;
  }
  return program !== undefined && (program.text.split('/').pop() ?? program.text) === binary;
}

/** Whether a script word's raw source reaches the shell that runs it unchanged. The shell that
 *  parses the command line reads a double-quoted word before any inner shell sees it: inside
 *  those quotes an unescaped `$` or backtick is expanded at that outer layer, whatever quotes
 *  appear inside it, and an unquoted stretch of the word is read there too. So a word whose raw
 *  text holds either hands the inner shell something other than the text this reader decoded.
 *  A single-quoted word is taken literally, and a backslash makes the next character literal.
 *  A word that closes and reopens quotes is followed as the outer shell reads it. */
function outerWordKeepsText(body: string, quote: ScriptQuote): boolean {
  let state: ScriptQuote | null = quote;
  let at = 0;
  while (at < body.length) {
    const char = body[at]!;
    if (state === 'single') {
      if (char === "'") state = null;
      at += 1;
      continue;
    }
    if (char === '\\') {
      at += 2;
      continue;
    }
    if (state === 'double') {
      if (char === '"') {
        state = null;
        at += 1;
        continue;
      }
      if (char === '$' || char === '`') return false;
      at += 1;
      continue;
    }
    if (char === "'") {
      state = 'single';
      at += 1;
      continue;
    }
    if (char === '"') {
      state = 'double';
      at += 1;
      continue;
    }
    if ('$`*?['.includes(char)) return false;
    at += 1;
  }
  return true;
}

/** Whether a script body is one simple command whose words the shell hands on exactly as
 *  written. A lexical reader cannot see what the shell does at run time, so a body holding a
 *  construct the shell changes is not proved: not a top-level operator (`;`, `&`, `|`, `<`, `>`,
 *  `(`, `)`), a newline or a comment, and not an expansion or a substitution (`$` in any form, a
 *  backtick) or a glob (`*`, `?`, `[`), which the shell reads unquoted and inside double quotes
 *  alike. Only single quotes make such characters literal, and a backslash makes the next
 *  character literal. A body with any other such construct is unprovable, and its line keeps the
 *  0.5.10 placement with its notice. */
function isSimpleCommand(text: string): boolean {
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (char === "'") {
      const close = text.indexOf("'", at + 1);
      if (close < 0) return false;
      at = close + 1;
      continue;
    }
    if (char === '"') {
      at += 1;
      let closed = false;
      while (at < text.length) {
        const inner = text[at]!;
        if (inner === '\\') {
          at += 2;
          continue;
        }
        if (inner === '"') {
          at += 1;
          closed = true;
          break;
        }
        if (inner === '$' || inner === '`') return false;
        at += 1;
      }
      if (!closed) return false;
      continue;
    }
    if (char === '\\') {
      at += 2;
      continue;
    }
    if (char === '$' || char === '`' || char === '*' || char === '?' || char === '[') return false;
    if (char === '#' && (at === 0 || /\s/.test(text[at - 1]!))) return false;
    if (';|&<>()\n'.includes(char)) return false;
    at += 1;
  }
  return true;
}

/** The one proof a script word carries, asked by every reader: the shell that parses it hands
 *  it on exactly as this reader decoded it — one quoted source word whose raw text keeps every
 *  character that shell reads inside it ({@link outerWordKeepsText}) — and the body it runs is
 *  one simple command for that shell ({@link isSimpleCommand}). A placement never writes inside
 *  a script that fails either proof, and a word read reports no word from one. Both ask this
 *  same function, so they refuse the same lines by construction. Returns the body and the quote
 *  the shell reads inside it, or null when the word proves neither. */
export function provenScriptWord(text: string, word: ShellWord): { body: string; layer: QuotedWord } | null {
  const layer = quotedWordOf(text, word);
  if (layer === null) return null;
  if (!outerWordKeepsText(text.slice(word.start + layer.openLen, word.end - 1), layer.quote)) return null;
  if (!isSimpleCommand(word.text)) return null;
  return { body: word.text, layer };
}

/** `text` written so one shell quoting layer hands it on exactly as written: a double-quoted
 *  script's shell reads `\`, `"`, `$` and a backtick back to themselves; a single-quoted one
 *  takes everything literally, with quotes spliced as `'\''`. */
function encodeForQuote(quote: ScriptQuote, text: string): string {
  if (quote === 'double') {
    return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`');
  }
  return text.replaceAll("'", "'\\''");
}

/** Where an addition belongs on a launch line. `script` is inside the innermost quoted script
 *  that runs the CLI, `at` the source position just before that script's closing quote, and
 *  `layers` the quotes the text passes through, outermost first. `uncertain` is a line whose
 *  shape this version cannot prove: it keeps 0.5.10's placement after the line. */
type Placement =
  | { kind: 'line' }
  | { kind: 'script'; at: number; layers: readonly ScriptQuote[] }
  | { kind: 'uncertain' };

/** Whether a word written after a plain line reaches the command the line runs. A plain line has
 *  no shell command string, so the shell that runs it reads the appended word too — unless the
 *  line swallows the rest of its own text: an unquoted `#` that starts a word is a comment, an
 *  unquoted top-level operator (`;`, `|`, `&`, `<`, `>`) or a newline ends the command, an
 *  unclosed quote takes every later character into the quoted word, and a trailing backslash
 *  escapes the space before the appended word. A `$` expansion or a glob changes its own word
 *  only, so the words written after it still reach the command and it does not count here. */
export function takesAppendedWord(text: string): boolean {
  let quote: ScriptQuote | null = null;
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (quote === 'single') {
      if (char === "'") quote = null;
      at += 1;
      continue;
    }
    if (char === '\\') {
      if (at + 1 >= text.length) return false;
      at += 2;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      at += 1;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      at += 1;
      continue;
    }
    if (char === '"') {
      quote = 'double';
      at += 1;
      continue;
    }
    if (char === '#' && (at === 0 || /\s/.test(text[at - 1]!))) return false;
    if (';|&<>\n'.includes(char)) return false;
    at += 1;
  }
  return quote === null;
}

/** Where words written for the CLI are read on a launch line. A plain line and a wrapper that
 *  forwards its arguments take them after the line, when the line does not swallow the rest of
 *  its text ({@link takesAppendedWord}). A line ending in a quoted script that runs the CLI takes
 *  them inside that script, and one nested shell is followed to the script it runs. Everything
 *  else — an unreadable line, a script word after positional words, a script file, a bare command
 *  word, a shell whose quoting this tool does not write, a body that is more than one simple
 *  command, a nesting deeper than one shell, or a plain line that swallows an appended word — is
 *  uncertain, and keeps 0.5.10's placement after the line. */
function placementOf(binary: string, command: string): Placement {
  const trimmed = command.trimEnd();
  if (trimmed === '') return { kind: 'line' };
  if (shellWords(trimmed) === null) return { kind: 'uncertain' };
  const found = shellScriptWordOf(trimmed);
  if (found === null) return takesAppendedWord(trimmed) ? { kind: 'line' } : { kind: 'uncertain' };
  if (found.trailing.length > 0) return { kind: 'uncertain' };
  const shell = shellProgramOf(trimmed);
  if (shell === null || !POSIX_SHELLS.has(shell)) return { kind: 'uncertain' };
  const proof = provenScriptWord(trimmed, found.word);
  if (proof === null) return { kind: 'uncertain' };
  if (startsWithCli(binary, proof.body)) {
    return { kind: 'script', at: found.word.end - 1, layers: [proof.layer.quote] };
  }
  return nestedPlacement(binary, trimmed, found.word, proof.layer) ?? { kind: 'uncertain' };
}

/**
 * Whether a launch line that cannot be read whole may hand its CLI a `--` this tool cannot place
 * words before. Words appended to such a line stand after it, where a plain line's program reads
 * them; if the line names the delimiter before the part this reader cannot see, or the
 * unreadable part could name one, the added options would be prompt text instead. The caller
 * refuses such a launch.
 *
 * The test on the unread suffix is deliberately conservative and does not parse it: a `--`
 * anywhere in the raw text (in any quoting, not only as a bare word), a backslash, or an ANSI-C
 * opening all refuse, because each can spell a delimiter under some shell. Only a suffix that
 * plainly cannot — an unclosed quote takes the rest of the line into one word — keeps 0.5.10's
 * placement with its notice.
 */
export function lineDelimiterRisk(command: string): boolean {
  const line = command.trimEnd();
  const read = readShellWords(line);
  if (!('unreadable' in read)) return false;
  if (read.words.some((word) => word.text === '--')) return true;
  const rest = line.slice(read.at);
  return rest.includes('--') || rest.includes('\\') || rest.includes("$'");
}

/** The script one nested shell runs, when that script runs the CLI: the outer body's source is
 *  normally exactly the text this reader decoded, so a position in the body is a position on the
 *  line. A line this tool has already written into no longer matches character for character —
 *  an addition is spliced as `'\''` when a single quote carries it and escaped when a double
 *  quote does — but the inner script is the body's last word, so its closing quote is still the
 *  body's last character that is not whitespace. That character is readable in the source when
 *  the outer quote is a single quote (literal, and a splice never changes a quote inside it) and
 *  when the outer quote is a double quote it is readable unless escaped (an odd backslash run
 *  before it). Deeper nesting, any other shell dialect, an outer double quote around an inner
 *  double-quoted script, and a body that is not one simple command are left to 0.5.10's
 *  placement. */
function nestedPlacement(
  binary: string,
  command: string,
  outer: ShellWord,
  layer: QuotedWord,
): Placement | null {
  const body = outer.text;
  const inner = shellScriptWordOf(body);
  if (inner === null || inner.trailing.length > 0) return null;
  const shell = shellProgramOf(body);
  if (shell === null || !POSIX_SHELLS.has(shell)) return null;
  const proof = provenScriptWord(body, inner.word);
  if (proof === null) return null;
  if (!startsWithCli(binary, proof.body)) return null;
  const source = command.slice(outer.start + layer.openLen, outer.end - 1);
  if (source === body) {
    return {
      kind: 'script',
      at: outer.start + layer.openLen + inner.word.end - 1,
      layers: [layer.quote, proof.layer.quote],
    };
  }
  const tail = source.replace(/\s+$/, '');
  if (layer.quote === 'double') {
    // The inner script is a single-quoted word inside the double quotes: its closing quote is
    // readable in the source when it is not escaped there.
    if (proof.layer.quote === 'double' || !tail.endsWith("'")) return null;
    let backslashes = 0;
    for (let index = tail.length - 2; index >= 0 && tail[index] === '\\'; index -= 1) backslashes += 1;
    if (backslashes % 2 === 1) return null;
  } else if (proof.layer.quote !== 'double' || !tail.endsWith('"')) {
    // The outer quote is single, so the source is literal: the inner script must be the
    // double-quoted word whose closing quote is the source's last one.
    return null;
  }
  return {
    kind: 'script',
    at: outer.start + layer.openLen + tail.length - 1,
    layers: [layer.quote, proof.layer.quote],
  };
}

/** `text` written so every quoting layer between the line and the CLI reads it back exactly. */
function encodeThrough(layers: readonly ScriptQuote[], text: string): string {
  let encoded = text;
  for (let at = layers.length - 1; at >= 0; at -= 1) encoded = encodeForQuote(layers[at]!, encoded);
  return encoded;
}

/** Whether the new line's CLI words are the old line's with `added` inserted at `at`, in order. */
function insertionKept(
  binary: string,
  line: string,
  before: readonly string[],
  at: number,
  added: readonly string[],
): boolean {
  const after = cliWordListOf(binary, line);
  if (after === null || after.length !== before.length + added.length) return false;
  const want = [...before.slice(0, at), ...added, ...before.slice(at)];
  return after.every((word, index) => word === want[index]);
}

/**
 * Option words written for the CLI on a launch line, where the CLI reads them. A wrapper that
 * execs `"$@"` (`zsh …/as-floor.sh <binary> …`) takes them at the end of the line. A quoted
 * script that itself runs `<binary>` (`zsh -lc "grok --model …"`) would drop words written
 * after the quotes: those words go inside that script, and a shell nested one level deep is
 * followed to the script it runs. The words are written so every quoting layer between the
 * line and the CLI reads them back exactly: a double-quoted script still has its text read by
 * the wrapping shell, so `\`, `"`, `$` and a backtick are escaped for it; a single-quoted
 * script takes them through the standard `'\''` splice.
 *
 * A line's own `--` is the CLI's delimiter, and inside a quoted script the outer shell never
 * sees it. The delimiter is found among the CLI's decoded words instead, and the addition
 * stands before it, so no launch flag, pin or inbox word is read as prompt text. The separator
 * is always a literal space — a raw newline after a continuation backslash and an escaped
 * space are not separators to the inner shell, a space always is.
 *
 * Every insertion is proved after the fact: the CLI's decoded words on the new line must be its
 * words on the old line with exactly the added words inserted at the delimiter, in order. If
 * the line or the addition cannot be read, or the words do not come back that way, the addition
 * keeps 0.5.10's placement after the line and `uncertain` reports it. This never refuses a
 * line.
 */
export function appendOnLaunchLine(
  command: string,
  addition: string,
  binary: string,
): { line: string; uncertain: boolean } {
  const trimmed = command.trimEnd();
  const placement = placementOf(binary, trimmed);
  const after = (): string => (trimmed === '' ? addition : `${trimmed} ${addition}`);
  if (placement.kind === 'uncertain') return { line: after(), uncertain: true };
  const addedWords = shellWords(addition);
  if (addedWords === null) return { line: after(), uncertain: true };
  const added = addedWords.map((word) => word.text);
  const beforeWords = cliWordListOf(binary, trimmed);
  if (beforeWords === null) return { line: after(), uncertain: true };
  if (placement.kind === 'line') {
    const { head, tail } = splitAtDelimiter(trimmed);
    if (tail === '') return { line: after(), uncertain: false };
    const headWords = shellWords(head.trimEnd());
    if (headWords === null) return { line: after(), uncertain: true };
    const line = `${head.trimEnd()} ${addition} ${tail}`;
    return insertionKept(binary, line, beforeWords, headWords.length, added)
      ? { line, uncertain: false }
      : { line: after(), uncertain: true };
  }
  // The CLI's body is read through the decoded words, so a line this tool already wrote into —
  // its inner quotes spliced and escaped for the layer that carries them — is read exactly as
  // the CLI receives it. Only a body that names a delimiter needs a source position inside it;
  // without one, the closing quote is the end of the CLI's words on the raw line too.
  const bodyText = cliTextOf(binary, trimmed);
  if (bodyText === null) return { line: after(), uncertain: true };
  const { head: bodyHead, tail: bodyTail } = splitAtDelimiter(bodyText);
  let line: string;
  let at: number;
  if (bodyTail === '') {
    at = beforeWords.length;
    line = `${trimmed.slice(0, placement.at)} ${encodeThrough(placement.layers, addition)}${trimmed.slice(placement.at)}`;
  } else {
    const body = cliBodyOn(binary, trimmed);
    if (body === null) return { line: after(), uncertain: true };
    const headWords = shellWords(bodyHead);
    if (headWords === null) return { line: after(), uncertain: true };
    at = headWords.length;
    const position = body.start + bodyHead.trimEnd().length;
    line = `${trimmed.slice(0, position)} ${encodeThrough(placement.layers, addition)}${trimmed.slice(position)}`;
  }
  return insertionKept(binary, line, beforeWords, at, added)
    ? { line, uncertain: false }
    : { line: after(), uncertain: true };
}

/**
 * Positional words written for the CLI on a launch line — a message-mode CLI's initial prompt.
 * They go at the end of the CLI's own words: after the line's `--` when it names one, inside a
 * quoted script that runs the CLI, and after a wrapper or a plain line where the shell hands
 * them on. A line this version cannot read keeps 0.5.10's placement after the line, with
 * `uncertain` reporting it; this never refuses a line.
 */
export function appendPositionalOnLaunchLine(
  command: string,
  addition: string,
  binary: string,
): { line: string; uncertain: boolean } {
  const trimmed = command.trimEnd();
  const placement = placementOf(binary, trimmed);
  const after = (): string => (trimmed === '' ? addition : `${trimmed} ${addition}`);
  if (placement.kind === 'uncertain') return { line: after(), uncertain: true };
  const addedWords = shellWords(addition);
  if (addedWords === null) return { line: after(), uncertain: true };
  const added = addedWords.map((word) => word.text);
  const beforeWords = cliWordListOf(binary, trimmed);
  if (beforeWords === null) return { line: after(), uncertain: true };
  if (placement.kind === 'line') {
    // After the line is after its delimiter, so the word is the CLI's last positional word.
    return { line: after(), uncertain: false };
  }
  const line = `${trimmed.slice(0, placement.at)} ${encodeThrough(placement.layers, addition)}${trimmed.slice(placement.at)}`;
  return insertionKept(binary, line, beforeWords, beforeWords.length, added)
    ? { line, uncertain: false }
    : { line: after(), uncertain: true };
}

/** The line an addition this version can place, or null when it cannot prove the placement: a
 *  reader that records what it writes (a session id, a resume) never records one the CLI may
 *  not read. */
export function placedOnLaunchLine(command: string, addition: string, binary: string): string | null {
  const placed = appendOnLaunchLine(command, addition, binary);
  return placed.uncertain ? null : placed.line;
}

/** The whole line as the CLI's own body, when a word written after the line still reaches the
 *  CLI ({@link takesAppendedWord}): the one place a reader or rewriter takes the whole line as
 *  the CLI's text. Null when the line swallows its tail — a comment, an operator, a redirect, a
 *  newline or an unclosed quote after the program word — because the words a tokenizer reads
 *  there are not the words the CLI receives. */
export function plainBodyOf(command: string): CliBody | null {
  const trimmed = command.trimEnd();
  return takesAppendedWord(trimmed) ? { text: trimmed, start: 0, end: trimmed.length } : null;
}

/** Where a line's CLI words sit in the line's source: the innermost shell script that runs the
 *  CLI, with the span of its body text. Every layer's source must be exactly the text this
 *  reader decoded, so a position in the body is a position in the line, and every layer's body
 *  must be one simple command ({@link provenScriptWord}) — a reader that rewrites words inside a
 *  script asks the same proof a placement and a word read ask. One nested shell is followed,
 *  exactly as a placement follows it ({@link placementOf}); a line nested deeper has no body.
 *  Null when the line has no shell command string, or one this reader cannot read through. */
export type CliBody = { text: string; start: number; end: number };
export function cliBodyOn(binary: string, command: string): CliBody | null {
  let text = command;
  let offset = 0;
  for (let depth = 0; depth < 2; depth += 1) {
    const found = shellScriptWordOf(text);
    if (found === null) return null;
    const shell = shellProgramOf(text);
    if (shell === null || !POSIX_SHELLS.has(shell)) return null;
    // The proof every reader and every placement asks, before any span is trusted.
    const proof = provenScriptWord(text, found.word);
    if (proof === null) return null;
    // The position guard this reader needs on top: the raw source between the quotes must be
    // exactly the text this reader decoded, so a position in the body is a position in the line.
    const openAt = found.word.start + proof.layer.openLen;
    if (text.slice(openAt, found.word.end - 1) !== proof.body) return null;
    const start = offset + openAt;
    if (startsWithCli(binary, proof.body)) {
      return { text: proof.body, start, end: start + proof.body.length };
    }
    offset = start;
    text = proof.body;
  }
  return null;
}

/** The text of the innermost shell script that runs the CLI, read through the decoded words of
 *  every layer. Null when the line has no shell command string, or none this reader can follow to
 *  the CLI, and null when a script word is not proved on the line ({@link provenScriptWord}): a
 *  word the shell that parses it may rewrite, a body that is more than one simple command, or a
 *  shell whose syntax this reader does not model, names no word of this CLI, whatever its
 *  decoded words appear to say. The proof is the one the placement asks, so a reader is unknown
 *  exactly where a placement refuses: one nested shell is followed, and a line nested deeper
 *  names no word either. Reading needs no
 *  source positions, so a line this tool has already written into — one whose inner quotes are
 *  spliced as `'\''` — still reads exactly as the CLI receives it. */
function cliTextOf(binary: string, command: string): string | null {
  let text = command.trimEnd();
  for (let depth = 0; depth < 2; depth += 1) {
    const found = shellScriptWordOf(text);
    if (found === null) return null;
    const shell = shellProgramOf(text);
    if (shell === null || !POSIX_SHELLS.has(shell)) return null;
    const proof = provenScriptWord(text, found.word);
    if (proof === null) return null;
    if (startsWithCli(binary, proof.body)) return proof.body;
    if (found.trailing.length > 0) return null;
    text = proof.body;
  }
  return null;
}

/** The CLI's own words on a launch line, decoded by the shell at every layer: the words inside
 *  the innermost shell script that runs it, or the line's own words when there is no shell
 *  command string and the line does not swallow the rest of its text ({@link takesAppendedWord}).
 *  A shell's own options — `-c`, `-lc`, `-ec`, `-l` — are the shell's, never the
 *  CLI's, and a word after the closing quote is a positional word of the script, not the CLI's
 *  either. A shell script that runs some other program, or one this reader cannot read through,
 *  names no word of this CLI at all. A script word the shell that parses the line may rewrite —
 *  an unescaped `$` or backtick inside the double quotes the word opens with — proves no word
 *  either, and a body that is more than one simple command — a comment, an operator, a
 *  substitution, a glob — names none: the words after such a construct are not the argv the
 *  script hands its CLI. Null when the line, or the script that runs the CLI, cannot be proved
 *  ({@link provenScriptWord}, the proof a placement asks too): no caller may treat an unproved
 *  line as a word list. */
export function cliWordListOf(binary: string, command: string): string[] | null {
  const trimmed = command.trimEnd();
  const lineWords = shellWords(trimmed);
  if (lineWords === null) return null;
  if (shellScriptWordOf(trimmed) === null) {
    return takesAppendedWord(trimmed) ? lineWords.map((word) => word.text) : null;
  }
  const text = cliTextOf(binary, trimmed);
  if (text === null) return null;
  const words = shellWords(text);
  return words === null ? null : words.map((word) => word.text);
}

/** The words the innermost shell command string on a line hands its program, when every word
 *  proves. This is the same reader as {@link cliWordListOf} without a binary to look for: a
 *  recorded recipe names its CLI by the recipe's own program word, so a reader of feature pins
 *  does not need to know the CLI in advance. A line with no shell command string is read as its
 *  own words, exactly as the shell will hand them to the program. Null when the line, or the
 *  script that runs its program, cannot be proved. */
export function decodedWordsOf(command: string): string[] | null {
  const trimmed = command.trimEnd();
  const lineWords = shellWords(trimmed);
  if (lineWords === null) return null;
  if (shellScriptWordOf(trimmed) === null) {
    return takesAppendedWord(trimmed) ? lineWords.map((word) => word.text) : null;
  }
  let text = trimmed;
  for (let depth = 0; depth < 2; depth += 1) {
    const found = shellScriptWordOf(text);
    if (found === null || found.trailing.length > 0) return null;
    const shell = shellProgramOf(text);
    if (shell === null || !POSIX_SHELLS.has(shell)) return null;
    const proof = provenScriptWord(text, found.word);
    if (proof === null) return null;
    const inner = shellScriptWordOf(proof.body);
    if (inner === null) {
      const words = shellWords(proof.body);
      return words === null ? null : words.map((word) => word.text);
    }
    text = proof.body;
  }
  return null;
}
