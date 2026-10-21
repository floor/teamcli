// The command guard a claude-code seat carries: a PreToolUse hook its own per-launch settings
// file installs (`cli-hook.ts`), run by this install's interpreter before every Bash tool call.
//
// It is a best-effort net that keeps an unattended seat out of the owner's user-wide permission
// prompt for the common forms of a dangerous command. It is not a sandbox: a shell can always
// reach a command another way. Deliberate evasions — `exec -a`, `eval`, a command hidden inside a
// `sh -c` string, functions, aliases — are out of scope; the prompt escalation, which climbs an
// unanswered prompt to the lead and the owner, is the backstop.
//
// The owner's guard asks — a Yes/No permission prompt — and a seat at an unattended pane cannot
// answer it, so the seat freezes. A deny wins over an ask (`test/command-guard-live`'s scene was
// measured on Claude Code 2.1.302), and this hook never asks: it allows a command or denies it
// with one line of guidance back to the model. `command -v <name>` asks where a name is and runs
// nothing, so it passes; `command <name>` runs it and is judged.
//
// The hook names the command class, never the command: a command line may hold a secret, and a
// refusal is raised as `security.refused` with the class as its rule and the seat as its object.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from '../profiles/profile.ts';

/** The command classes the guard denies. One rule name and one line of guidance each. */
export type GuardRule =
  | 'chmod'
  | 'chown'
  | 'sudo'
  | 'rm-recursive'
  | 'kill'
  | 'kill-hard'
  | 'disk-write'
  | 'system-power'
  | 'persistent-job'
  | 'pipe-to-shell'
  | 'git-push-force'
  | 'git-reset-hard'
  | 'git-clean'
  | 'git-branch-force-delete'
  | 'npm-publish';

/** What a denied command is and what the model is told instead. */
export type GuardMatch = { rule: GuardRule; guidance: string };

const GUIDANCE: Record<GuardRule, string> = {
  chmod: 'refused in team seats: run the script with `bash file.sh`',
  chown: 'refused in team seats: ownership changes wait for the owner',
  sudo: 'refused in team seats: a seat runs as its own user',
  'rm-recursive': 'refused in team seats: delete with `trash <path>`, never a recursive rm',
  kill: 'refused in team seats: stop a seat with `team stop <seat>`',
  'kill-hard': 'refused in team seats: stop a seat with `team stop <seat>`, never a hard kill',
  'disk-write': 'refused in team seats: a raw disk write can lose the machine — ask the owner',
  'system-power': 'refused in team seats: the owner restarts the machine',
  'persistent-job': 'refused in team seats: a job that outlives the seat waits for the owner',
  'pipe-to-shell': 'refused in team seats: save the download, read it, then run it',
  'git-push-force': 'refused in team seats: push a branch and open a pull request',
  'git-reset-hard': 'refused in team seats: use `git stash` or `git checkout -- <path>`',
  'git-clean': 'refused in team seats: delete only the paths you created, never the untracked tree',
  'git-branch-force-delete': 'refused in team seats: delete a merged branch with `git branch -d`',
  'npm-publish': 'refused in team seats: the release moves only by the orchestrator',
};

/** One segment of a shell command line: its words, and whether a `|` put it after another. */
type Segment = { words: string[]; piped: boolean };

/**
 * Splits a command line on unquoted `;`, a lone `&` and newlines (and `|`, remembering the pipe).
 * Quotes and backslash escapes are honoured, so `git commit -m "do not chmod"` is one word
 * sequence the guard never reads as a chmod. Redirects stay inside their command: `2>&1`, `>&2`
 * and `&>` are not segment breaks, and `|&` is one pipe. This is not a shell parser: it only
 * needs to find where a command word stands.
 */
function segments(line: string): Segment[] {
  const out: Segment[] = [];
  let words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let piped = false;
  let justPiped = false;
  const endWord = (): void => {
    if (word !== '') {
      words.push(word);
      word = '';
    }
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0) out.push({ words, piped });
    words = [];
  };
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at]!;
    if (escaped) {
      word += char;
      escaped = false;
      justPiped = false;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      justPiped = false;
      continue;
    }
    if (char === '&') {
      // `|&` is the pipe already taken; `>&`, `<&` and `&>` are redirects, not breaks.
      if (justPiped) {
        justPiped = false;
        continue;
      }
      if (word.endsWith('>') || word.endsWith('<') || line[at + 1] === '>') {
        word += char;
        justPiped = false;
        continue;
      }
      endSegment();
      piped = false;
      justPiped = false;
      continue;
    }
    if (char === ';' || char === '\n' || char === '|') {
      endSegment();
      // Every separator ends the segment; only `|` makes the next one a pipe's right side.
      piped = char === '|';
      justPiped = char === '|';
      continue;
    }
    if (char === ' ' || char === '\t') {
      endWord();
      justPiped = false;
      continue;
    }
    word += char;
    justPiped = false;
  }
  endSegment();
  return out;
}

/** A leading assignment, the kind a command line puts before the command word. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The words of an `env -S` string: the shell-like split that flag's argument asks for. */
function splitString(words: readonly string[]): string[] {
  return words.join(' ').split(/\s+/).filter((word) => word !== '');
}

/**
 * The command word and arguments of a segment, after the prefixes that run another command:
 * `VAR=value`, `env`, `command`, `exec`, `nohup`, `nice`, `time`, `timeout` and `stdbuf` — each
 * recognised by its base name, so `/usr/bin/env` is a prefix too. `env`'s own options are read
 * properly: `-u NAME` and `-C DIR`
 * take a value, `-S STRING` is split and judged as the command it holds, `--` ends the options,
 * and anything else starting with `-` is a flag.
 */
function commandOf(words: readonly string[]): string[] {
  let at = 0;
  while (at < words.length) {
    const word = words[at]!;
    if (ASSIGNMENT.test(word)) {
      at += 1;
      continue;
    }
    const name = base(word);
    if (name === 'env') {
      at += 1;
      while (at < words.length) {
        const arg = words[at]!;
        if (arg === '--') {
          at += 1;
          break;
        }
        if (ASSIGNMENT.test(arg)) {
          at += 1;
          continue;
        }
        if (arg === '-u' || arg === '--unset' || arg === '-C' || arg === '--chdir') {
          at += 2;
          continue;
        }
        if (arg === '-S' || arg === '--split-string') {
          // The string is a command line of its own: parse it the same way, prefixes included.
          return commandOf(splitString(words.slice(at + 1)));
        }
        if (arg.startsWith('--split-string=')) {
          return commandOf(splitString([arg.slice('--split-string='.length), ...words.slice(at + 1)]));
        }
        if (arg.startsWith('-')) {
          at += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (name === 'command') {
      // `command -v <name>` asks where a name is and runs nothing; `command [-p] <name>` runs it.
      let scan = at + 1;
      let lookup = false;
      while (scan < words.length && words[scan]!.startsWith('-')) {
        if (/^-[pVv]+$/.test(words[scan]!) && /[Vv]/.test(words[scan]!)) lookup = true;
        scan += 1;
      }
      if (lookup) return [];
      at = scan;
      continue;
    }
    if (name === 'nice') {
      at += 1;
      while (at < words.length) {
        const arg = words[at]!;
        if (arg === '-n' || arg === '--adjustment') {
          at += 2;
          continue;
        }
        if (arg.startsWith('-')) {
          at += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (name === 'timeout') {
      at += 1;
      while (at < words.length) {
        const arg = words[at]!;
        if (arg === '-s' || arg === '--signal' || arg === '-k' || arg === '--kill-after') {
          at += 2;
          continue;
        }
        if (arg.startsWith('-')) {
          at += 1;
          continue;
        }
        at += 1; // the duration
        break;
      }
      continue;
    }
    if (name === 'stdbuf') {
      // `-i`, `-o` and `-e` take a mode, attached (`-oL`) or as the next word.
      at += 1;
      while (at < words.length) {
        const arg = words[at]!;
        if (arg === '-i' || arg === '-o' || arg === '-e') {
          at += 2;
          continue;
        }
        if (arg.startsWith('-') || ASSIGNMENT.test(arg)) {
          at += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (name === 'exec' || name === 'nohup' || name === 'time') {
      at += 1;
      while (at < words.length && (words[at]!.startsWith('-') || ASSIGNMENT.test(words[at]!))) at += 1;
      continue;
    }
    break;
  }
  return words.slice(at);
}

/** The word a path names, without the directories that lead to it (`/bin/chmod` is `chmod`). */
function base(word: string): string {
  const slash = word.lastIndexOf('/');
  return slash === -1 ? word : word.slice(slash + 1);
}

/** A short option bundle or a long one holding the recursive flag of `rm`. */
function recursiveRm(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--') break;
    if (arg === '--recursive') return true;
    if (/^-[A-Za-z]+$/.test(arg) && /[rR]/.test(arg)) return true;
  }
  return false;
}

/** A heredoc a line opens: the word that ends its body, and whether `<<-` lets tabs precede it. */
type Heredoc = { delimiter: string; tabs: boolean };

/** The heredocs one command line opens, found outside quotes (`<<<` is a here-string, not one). */
function heredocDelimiters(text: string): Heredoc[] {
  const out: Heredoc[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== '<' || text[at + 1] !== '<' || text[at + 2] === '<') continue;
    let cursor = at + 2;
    const tabs = text[cursor] === '-';
    if (tabs) cursor += 1;
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
    let delimiter = '';
    const delimiterQuote = text[cursor] === '"' || text[cursor] === "'" ? text[cursor] : null;
    if (delimiterQuote !== null) {
      cursor += 1;
      while (cursor < text.length && text[cursor] !== delimiterQuote) {
        delimiter += text[cursor]!;
        cursor += 1;
      }
      cursor += 1;
    } else {
      while (cursor < text.length && !/[\s;&|<>()]/.test(text[cursor]!)) {
        delimiter += text[cursor]!;
        cursor += 1;
      }
    }
    if (delimiter !== '') out.push({ delimiter, tabs });
    at = cursor - 1;
  }
  return out;
}

/**
 * A command line with heredoc bodies removed: a body is data the shell feeds a command, never a
 * command of its own, so a sentence inside it that names `rm -rf` must not be judged. A body runs
 * to the line that repeats its delimiter (leading tabs ignored under `<<-`); an unterminated one
 * runs to the end of the input.
 */
function withoutHeredocBodies(line: string): string {
  const lines = line.split('\n');
  const kept: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const text = lines[at]!;
    kept.push(text);
    for (const { delimiter, tabs } of heredocDelimiters(text)) {
      let end = at + 1;
      while (end < lines.length) {
        const body = tabs ? lines[end]!.replace(/^\t+/, '') : lines[end]!;
        end += 1;
        if (body === delimiter) break;
      }
      at = end - 1;
    }
  }
  return kept.join('\n');
}

/** A signal word normalised the way `kill` reads it: `SIG` stripped, upper-cased. */
function signalName(value: string): string {
  return value.replace(/^SIG/i, '').toUpperCase();
}

/** True when a signal value asks for SIGKILL: `9` (leading zeros included) or `KILL`, in any
 *  spelling `kill` accepts. */
function hardSignal(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  if (/^[0-9]+$/.test(value)) return Number(value) === 9;
  return signalName(value) === 'KILL';
}

/**
 * True when a `kill` asks for SIGKILL: `-9`, `-KILL`, `-SIGKILL`, `-s 9`, `-s SIGKILL`,
 * `--signal=KILL` or `--signal KILL`.
 */
function hardKill(args: readonly string[]): boolean {
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === '--') break;
    if (arg === '-s' || arg === '--signal') {
      if (hardSignal(args[at + 1])) return true;
      continue;
    }
    if (arg.startsWith('--signal=')) {
      if (hardSignal(arg.slice('--signal='.length))) return true;
      continue;
    }
    if (arg.startsWith('-s') && arg.length > 2) {
      if (hardSignal(arg.slice(2))) return true;
      continue;
    }
    if (/^-(?:[0-9]+|[A-Za-z][A-Za-z0-9]*)$/.test(arg) && hardSignal(arg.slice(1))) return true;
  }
  return false;
}

/** The short-option letters of `git clean`, `--force` counted as `-f`. */
function cleanFlags(args: readonly string[]): Set<string> {
  const flags = new Set<string>();
  for (const arg of args) {
    if (arg === '--') break;
    if (arg === '--force') flags.add('f');
    else if (/^-[A-Za-z]+$/.test(arg)) for (const letter of arg.slice(1)) flags.add(letter);
  }
  return flags;
}

/** True when `git branch` both deletes and forces in any spelling: `-d -f`, `-df`,
 *  `--delete --force`; `-D` carries both on its own. */
function branchForceDelete(args: readonly string[]): boolean {
  const shorts = new Set<string>();
  const longs = new Set<string>();
  for (const arg of args) {
    if (arg === '--') break;
    if (arg.startsWith('--')) longs.add(arg);
    else if (/^-[A-Za-z]+$/.test(arg)) for (const letter of arg.slice(1)) shorts.add(letter);
  }
  const deletes = shorts.has('d') || shorts.has('D') || longs.has('--delete');
  const forces = shorts.has('f') || shorts.has('D') || longs.has('--force');
  return deletes && forces;
}

/**
 * True when any bare argument of `npm` is `publish`: no table of options that take a value, so
 * `npm --depth 0 publish` and `npm --umask 0022 publish` both deny. A value that happens to
 * spell `publish` denies too — the guard errs towards refusing.
 */
function npmPublishes(args: readonly string[]): boolean {
  return args.includes('publish');
}

/** `git -C <dir> push --force`: the subcommand, after the global options that take a value. */
function gitSubcommand(args: readonly string[]): { sub: string | null; rest: string[] } {
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree') {
      at += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return { sub: arg, rest: args.slice(at + 1) };
  }
  return { sub: null, rest: [] };
}

function matchSegment(words: readonly string[]): GuardMatch | null {
  const command = commandOf(words);
  if (command.length === 0) return null;
  const word = base(command[0]!);
  const args = command.slice(1);
  if (word === 'chmod') return { rule: 'chmod', guidance: GUIDANCE.chmod };
  if (word === 'chown') return { rule: 'chown', guidance: GUIDANCE.chown };
  if (word === 'sudo') return { rule: 'sudo', guidance: GUIDANCE.sudo };
  if (word === 'pkill' || word === 'killall') return { rule: 'kill', guidance: GUIDANCE.kill };
  if (word === 'kill' && hardKill(args)) return { rule: 'kill-hard', guidance: GUIDANCE['kill-hard'] };
  if (word === 'dd' || /^mkfs(\..+)?$/.test(word)) {
    return { rule: 'disk-write', guidance: GUIDANCE['disk-write'] };
  }
  if (word === 'shutdown' || word === 'reboot') {
    return { rule: 'system-power', guidance: GUIDANCE['system-power'] };
  }
  if (word === 'launchctl' || word === 'crontab') {
    return { rule: 'persistent-job', guidance: GUIDANCE['persistent-job'] };
  }
  if (word === 'rm' && recursiveRm(args)) return { rule: 'rm-recursive', guidance: GUIDANCE['rm-recursive'] };
  if (word === 'git') {
    const { sub, rest } = gitSubcommand(args);
    if (sub === 'push' && rest.some((arg) =>
      arg === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg) || arg.startsWith('+'))) {
      return { rule: 'git-push-force', guidance: GUIDANCE['git-push-force'] };
    }
    if (sub === 'reset' && rest.includes('--hard')) {
      return { rule: 'git-reset-hard', guidance: GUIDANCE['git-reset-hard'] };
    }
    if (sub === 'clean') {
      const flags = cleanFlags(rest);
      if (flags.has('f') && (flags.has('x') || flags.has('d'))) {
        return { rule: 'git-clean', guidance: GUIDANCE['git-clean'] };
      }
    }
    if (sub === 'branch' && branchForceDelete(rest)) {
      return { rule: 'git-branch-force-delete', guidance: GUIDANCE['git-branch-force-delete'] };
    }
  }
  if (word === 'npm' && npmPublishes(args)) {
    return { rule: 'npm-publish', guidance: GUIDANCE['npm-publish'] };
  }
  if (word === 'xargs') {
    // `find … | xargs chmod +x`: the command xargs runs is the first word that is not its option.
    const at = args.findIndex((arg) => !arg.startsWith('-'));
    if (at !== -1) return matchSegment(args.slice(at));
  }
  if (word === 'find') {
    // Every `-exec`, `-execdir`, `-ok` and `-okdir` runs the words that follow it, up to the
    // action's `;` or `+`.
    const actions = new Set(['-exec', '-execdir', '-ok', '-okdir']);
    let scan = 0;
    while (scan < args.length) {
      const action = args.findIndex((arg, index) => index >= scan && actions.has(arg));
      if (action === -1) break;
      const command = args.slice(action + 1);
      const end = command.findIndex((arg) => arg === ';' || arg === '+');
      const match = matchSegment(end === -1 ? command : command.slice(0, end));
      if (match !== null) return match;
      scan = end === -1 ? args.length : action + end + 2;
    }
  }
  return null;
}

/**
 * What the guard says about one shell command line: null when it is allowed, or the class it
 * belongs to and the one line the model is told instead. A conservative set — chmod, chown,
 * sudo, a recursive rm, pkill and killall, a hard `kill`, dd and mkfs, shutdown and reboot,
 * launchctl and crontab, a download piped into a shell, `git push --force` (and `-f`),
 * `git reset --hard`, a destructive `git clean`, `git branch -D` and `npm publish`.
 *
 * It matches commands, never words: a sentence in a quote, a heredoc body or a `team send` body
 * only ever sits in the arguments of the command that carries it.
 */
export function refusedByGuard(line: string): GuardMatch | null {
  const parsed = segments(withoutHeredocBodies(line));
  for (let at = 0; at < parsed.length; at++) {
    const segment = parsed[at]!;
    const match = matchSegment(segment.words);
    if (match !== null) return match;
    if (segment.piped && at > 0) {
      const left = commandOf(parsed[at - 1]!.words);
      const right = commandOf(segment.words);
      const download = left.length > 0 ? base(left[0]!) : '';
      const shell = right.length > 0 ? base(right[0]!) : '';
      if ((download === 'curl' || download === 'wget') && /^(sh|bash|zsh|dash|ksh)$/.test(shell)) {
        return { rule: 'pipe-to-shell', guidance: GUIDANCE['pipe-to-shell'] };
      }
    }
  }
  return null;
}

/** Where the hook script lives beside this module: the source file under this install's
 *  interpreter, the compiled one in a built package. */
export function commandGuardScriptPath(): string {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), here.endsWith('.ts') ? 'command-guard-hook.ts' : 'command-guard-hook.js');
}

/** The context a refusal is raised with: the team file's project, the project root and the
 *  owner's home, all baked into the hook's command line at install time. */
export type CommandGuardContext = { project: string; root: string; home: string };

/**
 * The shell command a seat's settings file runs before a Bash call: this install's own
 * interpreter, the hook script, and the context the refusal event is raised with. The seat and
 * session are the launch's, written with the settings file.
 */
export function commandGuardHookCommand(context: CommandGuardContext, session: string, seat: string): string {
  return [
    shellQuote(process.execPath),
    shellQuote(commandGuardScriptPath()),
    '--project', shellQuote(context.project),
    '--root', shellQuote(context.root),
    '--home', shellQuote(context.home),
    '--session', shellQuote(session),
    '--seat', shellQuote(seat),
  ].join(' ');
}

/** True when the hook script this build would name is there: a settings file that names a
 *  missing script would make every Bash call report a broken hook. */
export function commandGuardAvailable(): boolean {
  return existsSync(commandGuardScriptPath());
}

/** The one PreToolUse entry the settings file adds: a Bash matcher and the hook command. */
export function commandGuardEntry(run: string): unknown {
  return { matcher: 'Bash', hooks: [{ type: 'command', command: run }] };
}
