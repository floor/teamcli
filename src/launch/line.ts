import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Seat, TeamFile } from '../file/types.ts';
import { profileFor } from '../profiles/index.ts';
import { lobbyPath } from '../worktree/place.ts';
import { shellWordsReason, shellWordSources } from './shell-words.ts';

// A launch line is not shell-parsed: `team` splits it the way it always has, on whitespace, and
// examines the program — its first word that is not a variable assignment — and the arguments
// written `./…`, `../…` or `~/…`. A relative path in a launch line means one thing: a command line
// run in the folder the seat starts in, which `team` does not rewrite. A seat that works in
// worktrees starts in the lobby, beside the worktrees, not in the project root, so `../tools/x.sh`
// that a hand run in the root finds may resolve nowhere from the lobby. The check refuses only
// what it has proved can't run: a first word a shell would act on — `$`, backticks, a backslash,
// a glob, `~user`, an unmatched or partly quoted word — leaves the line unread, and a relative
// argument is a note: its meaning is not knowable in general and the command may create the path
// it names. The one refusable relative argument is a shell's own script path, where the shell
// exits 127 without starting anything. `~/…` stands for the pane
// shell's own home, so it is looked for there: captured on herdr 0.7.1, typing
// `if [ ~ = "$HOME" ]; then echo "tilde-equals-home probe=tilde-expanded-ok"; fi` into a pane
// printed `tilde-equals-home probe=tilde-expanded-ok`, and `ls -d ~` ran.

/** The command a launch line starts, or null when it names none. The line is read as a shell
 *  reads it, so a word holding a substitution stays one word; a line whose words cannot be read
 *  is split as it always was, and the caller's own finding says so. */
export function launchBinary(launch: string): string | null {
  return wordsOf(launch).find((word) => word !== '' && !ASSIGNMENT.test(word)) ?? null;
}

/** A launch line's words: the shell's reading when it is knowable, the whitespace split when the
 *  line holds an ANSI-C word or a NUL byte and this version cannot decode it. The spelling is the
 *  line's — a quoted word keeps its quotes, as the messages this reader feeds show the caller
 *  what they wrote. */
function wordsOf(launch: string): string[] {
  const read = shellWordSources(launch);
  if (read !== null) return read;
  return launch.trim().split(/\s+/).filter((word) => word !== '');
}

/** The CLI binary a launch line ends up running. A line that runs a wrapper script with a shell
 *  (`zsh ~/tools/as-floor.sh codex resume …`) passes its remaining words to the command the
 *  script execs, so the CLI is the first word after the script. A wrapper that names no further
 *  word is its own program, and the script is returned. */
export function launchedCliBinary(launch: string): string | null {
  const words = wordsOf(launch).filter((word) => word !== '' && !ASSIGNMENT.test(word));
  let at = 0;
  while (at + 2 < words.length && /^(?:\S*\/)?(?:zsh|bash|sh)$/.test(words[at]!) && /\.(?:z|ba)?sh$/.test(words[at + 1]!)) {
    at += 2;
  }
  return words[at] ?? null;
}

/** Whether the launch line starts something other than the CLI's own binary, or the file
 *  says the launcher chooses the model. A restored process is then the CLI without that program. */
export function usesLauncher(seat: Pick<Seat, 'cli' | 'launch' | 'modelFrom'>): boolean {
  if (seat.modelFrom === 'launcher') return true;
  const binary = profileFor(seat.cli)?.binary;
  const first = launchBinary(seat.launch);
  if (!binary || first === null) return false;
  return first !== binary;
}

/** The folder a seat's launch line runs in, as the file writes it: the lobby for a seat that
 *  works in worktrees and names no folder of its own, the seat's own folder otherwise. */
export function startFolder(team: TeamFile, seat: Seat): string {
  if (seat.mode !== 'shared' && seat.cwd === '.') return lobbyPath(team) ?? '.';
  return seat.cwd;
}

/** `why` is the finding in full, for a terminal (`doctor`, a note, a dry run); `record`, on the
 *  findings that carry a folder this machine resolved, is the same finding in words — what the
 *  seat's record and the log may hold, with the folder left to the stderr detail. */
export type LineFinding = { level: 'miss' | 'note'; why: string; record?: string };

/** What `team doctor` and the launch are told about this machine. */
export type LineSources = {
  /** Whether a command is an executable on the PATH the session's server gets. For an absolute
   *  path this is also the executability test main's launcher check used: `accessSync(…, X_OK)`. */
  onPath(binary: string): boolean;
  home: string;
};

function miss(why: string, record?: string): LineFinding {
  return record === undefined ? { level: 'miss', why } : { level: 'miss', why, record };
}

function note(why: string): LineFinding {
  return { level: 'note', why };
}

// Every character a shell would act on, so the word as written is not the word the shell reads:
// quotes, `$`, backticks, a backslash, redirections, pipes, separators, groups, globs, brackets.
const SHELL_TEXT = /['"`$\\<>|&;()*?[\]{}]/;

// The characters that keep a quoted word from being a literal a shell would run as it is written:
// `$` and backticks substitute, a backslash escapes, and a glob makes the shell look.
const QUOTED_TEXT = /[$`\\*?[\]]/;

/** Whether a launch-line word is a plain word: no shell syntax, and no `~user` or `~+` expansion.
 *  `~` alone and `~/…` are the pane shell's home, which the check reads as a path. */
function plainWord(word: string): boolean {
  if (SHELL_TEXT.test(word)) return false;
  return !word.startsWith('~') || word === '~' || word.startsWith('~/');
}

/** The word a shell would run for a launch-line word, when the check can read it with certainty:
 *  a plain word, or one fully quoted literal — `"…"` or `'…'` around text no shell would touch —
 *  with only the quotes removed. A shell changes nothing else about such a word, so the literal
 *  inside is the word it runs: `"definitely-missing" --flag` exits 127 with
 *  `/bin/sh: definitely-missing: command not found`, exactly as `definitely-missing` does.
 *  Quoting does suppress tilde expansion, though: `"~/x"` is a pathname with a literal `~`
 *  folder, not the home, and the check reads it that way. A word a shell would substitute or
 *  expand — `$`, a backtick, a backslash, a glob — stays unread. */
function nakedWord(word: string): string | null {
  if (plainWord(word)) return word;
  const quote = word[0];
  if ((quote !== '"' && quote !== "'") || word.length < 2 || word[word.length - 1] !== quote) return null;
  const inner = word.slice(1, -1);
  if (inner.includes(quote) || QUOTED_TEXT.test(inner)) return null;
  return inner;
}

const notRead = 'its launch line was not checked: it quotes or substitutes text this version does not read';

function programFinding(
  naked: string | null,
  show: string,
  own: string | null,
  cwd: string,
  folder: string,
  sources: LineSources,
): LineFinding | null {
  // The profile's own binary is looked for with its install, whose finding refuses the whole
  // command; this check is the seat's own line, and only that seat's launch is stopped by it.
  if (show === own) return null;
  // The first word is checked before anything else is read, and a word the check cannot read
  // (a substitution, a glob, a backslash) leaves the whole line unread.
  if (naked === null) return note(notRead);
  const quoted = naked !== show;
  // A program given as a path is looked for where it would run, and must run: main's launcher
  // check was `onPath`'s `X_OK`, not existence.
  const pathProgram = (absolute: string, missing: string, record?: string): LineFinding | null => {
    if (!existsSync(absolute)) return miss(missing, record);
    return sources.onPath(absolute) ? null : miss(`its launch line starts \`${show}\`, which is not executable`);
  };
  // An empty literal (`""`) runs nothing: `/bin/sh: : command not found`, exit 127.
  if (naked === '') return miss(`its launch line starts \`${show}\`, which is not on the PATH`);
  // A quoted literal is not home-expanded; only a bare `~/…` word is the pane shell's home.
  if (!quoted && naked.startsWith('~/')) {
    return pathProgram(join(sources.home, naked.slice(2)), `its launch line starts \`${show}\`, not found from \`~\``);
  }
  if (naked.startsWith('/')) {
    return pathProgram(naked, `its launch line starts \`${show}\`, which does not exist`);
  }
  if (quoted ? naked.includes('/') : naked.startsWith('./') || naked.startsWith('../')) {
    return pathProgram(
      resolve(cwd, naked),
      `its launch line starts \`${show}\`, not found from its start folder ${folder}`,
      `its launch line starts \`${show}\`, not found from its start folder`,
    );
  }
  return sources.onPath(naked) ? null : miss(`its launch line starts \`${show}\`, which is not on the PATH`);
}

// The shells whose first argument, when it is a relative path and not an option, is the script
// they read. Given one that is missing where the line runs, each exits 127 without starting
// anything — run from one empty scratch folder: `sh no-such-script.sh` (also `bash`) prints
// `sh: no-such-script.sh: No such file or directory`, `zsh no-such-script.sh` prints
// `zsh: can't open input file: no-such-script.sh`, each exit 127.
const SHELLS = new Set(['sh', 'bash', 'zsh']);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A launch-line word as a shell would run it, when this reader can read it with certainty: a
 *  plain word, or one fully quoted literal with only the quotes removed. A word the shell would
 *  substitute, escape or glob stays unread. */
function commandWord(word: string): string | null {
  const quote = word[0];
  if (quote !== '"' && quote !== "'") return /[$`\\*?[\]{}]/.test(word) ? null : word;
  if (word.length < 2 || word[word.length - 1] !== quote) return null;
  const inner = word.slice(1, -1);
  if (inner.includes(quote) || /[$`\\*?[\]{}]/.test(inner)) return null;
  return inner;
}

/**
 * The program a launch line really starts, as last path segment, or null when the line's own
 * plumbing keeps this reader from saying. The plumbing read off first: leading variable
 * assignments; an `env` prefix with the assignments and options around the program it runs; a
 * shell that only reads a script (the script is the program the line starts); and the quotes
 * around a fully quoted literal. `/usr/local/bin/claude`, `env claude`, `VAR=1 claude` and
 * `"claude"` are all the CLI itself — never a wrapper, whatever directory a path names — while a
 * word this reader cannot follow names no program at all.
 */
export function launchProgram(launch: string): string | null {
  const words = launch.trim().split(/\s+/).filter((word) => word !== '');
  let at = 0;
  while (at < words.length && ASSIGNMENT.test(words[at]!)) at += 1;
  if (at < words.length && (words[at]!.split('/').pop() ?? words[at]!) === 'env') {
    at += 1;
    for (;;) {
      const word = words[at];
      if (word === undefined) return null;
      if (ASSIGNMENT.test(word)) {
        at += 1;
        continue;
      }
      if (word === '--') {
        at += 1;
        break;
      }
      if (/^(?:-u|--unset|-C|--chdir)$/.test(word)) {
        if (words[at + 1] === undefined) return null;
        at += 2;
        continue;
      }
      if (/^(?:--unset|--chdir)=/.test(word)) {
        at += 1;
        continue;
      }
      if (word.startsWith('-')) {
        // An option this reader does not know — `-S`, which splits a command line of its own —
        // names no program this reader can follow.
        if (!/^(?:-i|--ignore-environment|-0|--null|-v|--debug)$/.test(word)) return null;
        at += 1;
        continue;
      }
      break;
    }
  }
  const word = words[at];
  if (word === undefined) return null;
  const program = commandWord(word);
  if (program === null || program === '') return null;
  const base = program.split('/').pop() ?? program;
  if (SHELLS.has(base)) {
    const scriptWord = words[at + 1];
    if (scriptWord === undefined || scriptWord.startsWith('-')) return null;
    const script = commandWord(scriptWord);
    if (script === null || script === '') return null;
    return script.split('/').pop() ?? script;
  }
  return base;
}

/** The one relative argument that can be refused. An argument's meaning is not knowable in
 *  general, but a shell's first argument is the script it reads: when that is a relative path —
 *  not an option (`zsh -c …`, `bash -l x` read no script), not absolute, not `~/…` — and it
 *  resolves from the project root and not from the folder the line runs in, the shell cannot
 *  start at all, and the finding names the folder and the absolute path to write instead. */
function shellScriptFinding(
  naked: string,
  words: readonly string[],
  at: number,
  root: string,
  cwd: string,
  folder: string,
): LineFinding | null {
  if (!SHELLS.has(naked.split('/').pop() ?? naked)) return null;
  const script = words[at + 1];
  if (script === undefined || script.startsWith('-') || script.startsWith('/') || script.startsWith('~')) return null;
  if (existsSync(resolve(cwd, script))) return null;
  const fromRoot = resolve(root, script);
  if (!existsSync(fromRoot)) return null;
  return miss(
    `its launch line runs \`${script}\`, not found from its start folder ${folder}; ` +
      `the same file is at \`${fromRoot}\` from the project root — write that path`,
    `its launch line runs \`${script}\`, not found from its start folder`,
  );
}

function argumentFinding(word: string, cwd: string, folder: string, sources: LineSources): LineFinding | null {
  if (word.startsWith('~/')) {
    return existsSync(join(sources.home, word.slice(2)))
      ? null
      : note(`its launch line runs \`${word}\`, not found from \`~\`; not checked: the command may create it`);
  }
  if (!word.startsWith('./') && !word.startsWith('../')) return null;
  if (existsSync(resolve(cwd, word))) return null;
  // Everything else a relative argument might be — option text, an output path, a path the
  // command creates, one a launcher changes directory for — is only said to be unchecked: the
  // check cannot know what the argument means, and refusing it refused lines that ran.
  return note(
    `its launch line runs \`${word}\`, not found from its start folder ${folder}; ` +
      'not checked: the command may create it',
  );
}

/** The first thing about this seat's launch line that keeps it from running where the seat
 *  starts, or null: a `miss` stops that seat's launch, a `note` is only said. `start` is where
 *  the line will run when that is not the folder the file's seat would launch in — a resumed
 *  seat, whose pane keeps the folder it was started in. */
export function launchLineFinding(
  team: TeamFile,
  seat: Seat,
  root: string,
  sources: LineSources,
  start?: { cwd: string; folder: string },
): LineFinding | null {
  const launch = seat.launch;
  // A line whose quoting never closes is not a command any shell can read: it is refused in
  // plain words, before any of the readings below guess at its words. A line a shell can run
  // whose words this version cannot decode (an ANSI-C word, a NUL byte) is not refused here:
  // 0.5.10 launched it, and the reads below treat its words as unchecked.
  if (shellWordsReason(launch) === 'unclosed') {
    return miss('its launch line has an unclosed quote or a trailing backslash: close it before the line can run');
  }
  const words = launch.trim().split(/\s+/).filter((word) => word !== '');
  const program = launchBinary(launch);
  if (program === null) return note('its launch line names no command');
  const folder = start?.folder ?? startFolder(team, seat);
  const cwd = start?.cwd ?? resolve(root, folder);
  const naked = nakedWord(program);
  const missing = programFinding(naked, program, profileFor(seat.cli)?.binary ?? null, cwd, folder, sources);
  if (missing) return missing;
  const at = words.indexOf(program);
  // With any shell syntax after the first word, the split may not be what a shell would read:
  // the arguments are not checked at all, and the line is only said to be unchecked. The first
  // word's own syntax is not this — it was read above, one fully quoted literal included.
  if (words.some((word, index) => index !== at && !plainWord(word))) return note(notRead);
  // One relative argument can still be refused: a shell's own script path (see the function).
  const script = naked === null ? null : shellScriptFinding(naked, words, at, root, cwd, folder);
  if (script) return script;
  for (const word of words) {
    const hit = argumentFinding(word, cwd, folder, sources);
    if (hit) return hit;
  }
  return null;
}

/** One finding per seat the file would start, named for the report's list. */
export function launchLineFindings(team: TeamFile, root: string, sources: LineSources): { level: 'miss' | 'note'; text: string }[] {
  const findings: { level: 'miss' | 'note'; text: string }[] = [];
  for (const seat of team.seats) {
    if (seat.stopped) continue;
    const one = launchLineFinding(team, seat, root, sources);
    if (one) findings.push({ level: one.level, text: `${seat.name}: ${one.why}` });
  }
  return findings;
}
