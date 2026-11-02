import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A launch line is decoded in one place and proved by one function. `provenScriptWord` is that
// proof: the shell that parses a script word hands it on exactly as this reader decoded it
// (`outerWordKeepsText` on the raw source), and the body it runs is one simple command for that
// shell. Round 8 of the quoted-launch review found `cliBodyOn` checking the raw source text and
// the simple command itself, never asking the proof: `withoutResume` then rewrote a line whose
// outer shell expands a variable inside the inner script's single quotes. These tests are the
// mechanical guard against that recurrence. They read the source, never a launch line, so they
// cannot drift into testing one.
//
// What they hold:
//
//   - every function in the launch readers (`src/profiles/profile.ts` and the line machinery it
//     asks, `src/launch/cli-scope.ts`) that decodes a launch line with a tokenizer reaches
//     `provenScriptWord`, or is named here with what it does instead;
//   - every name on the exported reader set reaches it too, so a reader added later cannot skip
//     it without failing here;
//   - `shell-words.ts` is the one tokenizer, and the two reader modules are the ones that ask it
//     for the words of a launch line;
//   - the four files that split a launch line on whitespace are named with what each split is
//     for, so a fifth one cannot appear unnoticed.

const SOURCE_FILES = ['../src/profiles/profile.ts', '../src/launch/cli-scope.ts'];
const SOURCES = SOURCE_FILES.map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));

/** The source without comments: a doc comment names functions too, and this scan reads code. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

type Decl = { name: string; exported: boolean; body: string };

/** Every top-level function declaration, from its `function` line to the `}` at column zero. */
function declarationsIn(source: string): Decl[] {
  const lines = codeOf(source).split('\n');
  const out: Decl[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const head = /^(export )?function ([A-Za-z0-9_]+)\(/.exec(lines[at]!);
    if (head === null) continue;
    let end = at;
    while (end < lines.length && lines[end] !== '}') end += 1;
    out.push({ name: head[2]!, exported: head[1] !== undefined, body: lines.slice(at, end + 1).join('\n') });
    at = end;
  }
  return out;
}

/** Every name called in a function body. A declaration's own name is harmless: reaching itself
 *  is not reaching the proof. */
function calledIn(body: string): Set<string> {
  return new Set([...body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]!));
}

// The functions that decode a launch line's source themselves: the shell tokenizer and the
// readers that turn its words into quote spans. They are the bottom layer — a caller that asks
// them a question is the one that must ask the proof.
const TOKENIZERS = new Set([
  'shellWords',
  'readShellWords',
  'shellScriptWordOf',
  'closingQuoteOf',
  'openingOf',
  'programWordAt',
  'quotedWordOf',
  'outerWordKeepsText',
  'isSimpleCommand',
]);

// Functions that decode a launch line without reaching the proof, and why that is safe: none of
// them returns or rewrites a word or a span of the CLI's.
const NOT_A_READER = new Map<string, string>([
  ['shellProgramOf', 'names the shell that parses the line: one program word, never a word or span of the CLI'],
  ['startsWithCli', "compares the first decoded word with the CLI's binary and returns a boolean, never a word or span"],
  ['launchWordScopes', "0.5.10's raw-line question: it may see more words than the CLI reads, and its answer only suppresses an addition"],
  ['splitAtDelimiter', 'splits a line at its delimiter word so a rewrite keeps the tail verbatim: source spans, never a word or span of the CLI'],
  ['lineDelimiterRisk', 'answers whether an unread line may hide the delimiter: a boolean, never a word or span'],
]);

// The plain proof: a line with no script word names the CLI's own words only when a word written
// after it still reaches the CLI ({@link takesAppendedWord}). A reader or rewriter that tokenizes
// the whole line asks this too — the words a comment or a later command holds are not the CLI's.
const PLAIN_PROOF = 'takesAppendedWord';

// Functions that decode a launch line without reaching the plain proof, and why that is safe:
// each works only inside a script word, or answers a boolean about the line's first word.
const NOT_A_PLAIN_READER = new Map<string, string>([
  ['shellProgramOf', 'names the shell that runs the line: one program word, never a word or span of the CLI'],
  ['startsWithCli', "compares the first decoded word with the CLI's binary and returns a boolean, never a word or span"],
  ['provenScriptWord', 'is the script proof itself; the plain proof guards a line with no script word'],
  ['nestedPlacement', 'follows the one nested shell word; a plain line has none'],
  ['cliBodyOn', 'returns a span inside a script word only; its callers ask the plain proof on a plain line'],
  ['cliTextOf', 'follows script words only; its caller cliWordListOf asks the plain proof on a plain line'],
  ['launchWordScopes', "0.5.10's raw-line question: its answer only suppresses an addition"],
  ['splitAtDelimiter', 'splits a line at its delimiter word for a rewrite: source spans only, never a word or span of the CLI'],
  ['lineDelimiterRisk', 'answers whether an unread line may hide the delimiter: a boolean, never a word or span'],
]);

// Every exported function that returns CLI words, an id read from them, a launch line, or a
// span into one. Each must reach the proof through the functions it calls.
const READERS = [
  'launchCommand',
  'withLaunchSession',
  'withResume',
  'withoutResume',
  'withLaunchOverrides',
  'namedResumeTarget',
  'resumeCarry',
  'cliWordList',
  'cliWordsOf',
  'launchSessionId',
];

const DECLS = SOURCES.flatMap((source) => declarationsIn(source));
const BY_NAME = new Map(DECLS.map((decl) => [decl.name, decl]));

/** Whether `name` reaches `root` through the file's own functions. */
function reaches(root: string, name: string, seen = new Set<string>()): boolean {
  if (name === root) return true;
  if (seen.has(name)) return false;
  seen.add(name);
  const decl = BY_NAME.get(name);
  if (decl === undefined) return false;
  for (const call of calledIn(decl.body)) {
    if (BY_NAME.has(call) && reaches(root, call, seen)) return true;
  }
  return false;
}

/** Whether `name` reaches `provenScriptWord` through the file's own functions. */
function reachesProof(name: string): boolean {
  return reaches('provenScriptWord', name);
}

/** Whether `name` reaches the plain proof, {@link PLAIN_PROOF}. */
function reachesPlainProof(name: string): boolean {
  return reaches(PLAIN_PROOF, name);
}

/** The source files under a folder, relative to the repository root, `/`-separated. */
function sourceFiles(folder: string): string[] {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const out: string[] = [];
  const visit = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = `${at}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(path.slice(root.length));
    }
  };
  visit(`${root}${folder}`);
  return out;
}

const SCANNED = ['src/profiles', 'src/launch', 'src/commands'].flatMap(sourceFiles);
const TOKENIZER_FILE = 'src/launch/shell-words.ts';
const READER_FILES = ['src/launch/cli-scope.ts', 'src/profiles/profile.ts'];

// A launch line split on whitespace, and what that split is for. `profile.ts` asks 0.5.10's
// raw-line question so an option the line plainly sets is not added twice, and `line.ts` reads
// the program word and relative-path arguments the way `team` always has so a line that cannot
// run is refused; both can only suppress or report, never record. `command-guard.ts` splits the
// Bash tool's own command (and `env -S`'s string), never a seat's launch line, and `doctor.ts`
// takes a diagnostic's first word after `launchBinary` names none.
const WHITESPACE_SPLITS = new Map<string, string>([
  ['src/profiles/profile.ts', "0.5.10's raw-line option question and the generous fallback of launchWordScopes"],
  ['src/launch/line.ts', "team's historical split: the program word and relative-path arguments, for diagnostics"],
  ['src/launch/command-guard.ts', "the Bash tool's own command line, never a seat's launch line"],
  ['src/commands/doctor.ts', "a diagnostic's first word of a launch line"],
]);

describe('every reader of a launch line asks the one proof', () => {
  test('the one proof is still where this guard looks for it', () => {
    expect(BY_NAME.has('provenScriptWord'), 'provenScriptWord is gone or renamed: update this guard').toBe(true);
  });

  test('every function that decodes a launch line reaches provenScriptWord', () => {
    const unproved: string[] = [];
    for (const decl of DECLS) {
      if (TOKENIZERS.has(decl.name)) continue;
      const asksTokenizer = [...calledIn(decl.body)].some((call) => TOKENIZERS.has(call));
      if (!asksTokenizer) continue;
      if (reachesProof(decl.name)) continue;
      if (NOT_A_READER.has(decl.name)) continue;
      unproved.push(decl.name);
    }
    expect(
      unproved,
      'these decode a launch line without asking the one proof: call provenScriptWord, or name what they do instead in NOT_A_READER',
    ).toEqual([]);
  });

  test('every exemption still decodes a launch line, so none goes stale', () => {
    for (const name of NOT_A_READER.keys()) {
      const decl = BY_NAME.get(name);
      expect(decl, `${name} is gone: remove or update its exemption`).toBeDefined();
      if (decl === undefined) continue;
      const asksTokenizer = [...calledIn(decl.body)].some((call) => TOKENIZERS.has(call));
      expect(asksTokenizer, `${name} no longer decodes a launch line: remove its exemption`).toBe(true);
    }
  });

  test('every exported reader of the CLI words, ids, lines or spans reaches the one proof', () => {
    for (const name of READERS) {
      const decl = BY_NAME.get(name);
      expect(decl, `${name} is gone: update the reader set`).toBeDefined();
      expect(reachesProof(name), `${name} returns CLI words or spans without asking the one proof`).toBe(true);
    }
  });

  test('the plain proof is still where this guard looks for it', () => {
    expect(BY_NAME.has(PLAIN_PROOF), 'takesAppendedWord is gone or renamed: update this guard').toBe(true);
  });

  test('every function that decodes a launch line reaches the plain proof too', () => {
    const unproved: string[] = [];
    for (const decl of DECLS) {
      if (TOKENIZERS.has(decl.name)) continue;
      const asksTokenizer = [...calledIn(decl.body)].some((call) => TOKENIZERS.has(call));
      if (!asksTokenizer) continue;
      if (reachesPlainProof(decl.name)) continue;
      if (NOT_A_PLAIN_READER.has(decl.name)) continue;
      unproved.push(decl.name);
    }
    expect(
      unproved,
      "these decode a whole launch line without asking the plain proof: call takesAppendedWord, or name what they do instead in NOT_A_PLAIN_READER",
    ).toEqual([]);
  });

  test('every plain exemption still decodes a launch line, so none goes stale', () => {
    for (const name of NOT_A_PLAIN_READER.keys()) {
      const decl = BY_NAME.get(name);
      expect(decl, `${name} is gone: remove or update its exemption`).toBeDefined();
      if (decl === undefined) continue;
      const asksTokenizer = [...calledIn(decl.body)].some((call) => TOKENIZERS.has(call));
      expect(asksTokenizer, `${name} no longer decodes a launch line: remove its exemption`).toBe(true);
    }
  });

  test('every exported reader of the CLI words, ids, lines or spans reaches the plain proof', () => {
    for (const name of READERS) {
      expect(
        reachesPlainProof(name),
        `${name} returns CLI words or spans without asking the line's plain proof`,
      ).toBe(true);
    }
  });

  test('the whole-line body is built in one place, and that builder asks the plain proof', () => {
    const builders = DECLS.filter((decl) => /start:\s*0\b/.test(decl.body)).map((decl) => decl.name).sort();
    expect(
      builders,
      'a reader or rewriter built its own whole-line body: ask plainBodyOf instead, which asks the plain proof',
    ).toEqual(['plainBodyOf']);
    expect(reachesPlainProof('plainBodyOf'), 'plainBodyOf builds the whole-line body without asking takesAppendedWord').toBe(true);
  });
});

describe('a launch line is decoded in one place', () => {
  test('the shell tokenizer is asked for launch words only by the reader modules', () => {
    const askers = SCANNED.filter((file) => /\bshellWords\(/.test(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')))
      .filter((file) => file !== TOKENIZER_FILE)
      .sort();
    expect(askers, 'a module outside the launch readers decodes launch words: route it through a reader there').toEqual([...READER_FILES].sort());
  });

  test('a launch line is split on whitespace only in the named files, each with its reason', () => {
    const splitters = SCANNED.filter((file) =>
      /\.split\(\/\\s\+\//.test(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')),
    ).sort();
    expect(splitters, 'a new module splits launch lines itself: name it and its reason, or read the words through the launch readers').toEqual(
      [...WHITESPACE_SPLITS.keys()].sort(),
    );
  });
});
