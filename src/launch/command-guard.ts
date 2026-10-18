// The command guard a claude-code seat carries: a PreToolUse hook its own per-launch settings
// file installs (`cli-hook.ts`), run by this install's interpreter before every Bash tool call.
//
// The owner's guard asks — a Yes/No permission prompt — and a seat at an unattended pane cannot
// answer it, so the seat freezes. A deny wins over an ask (`test/command-guard-live`'s scene was
// measured on Claude Code 2.1.302), and this hook never asks: it allows a command or denies it
// with one line of guidance back to the model. The set is deliberately small and conservative;
// a shell can always find another way to run a command, and the guard is a stop against the
// freeze, not a sandbox.
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
  | 'pipe-to-shell'
  | 'git-push-force'
  | 'git-reset-hard';

/** What a denied command is and what the model is told instead. */
export type GuardMatch = { rule: GuardRule; guidance: string };

const GUIDANCE: Record<GuardRule, string> = {
  chmod: 'refused in team seats: run the script with `bash file.sh`',
  chown: 'refused in team seats: ownership changes wait for the owner',
  sudo: 'refused in team seats: a seat runs as its own user',
  'rm-recursive': 'refused in team seats: delete with `trash <path>`, never a recursive rm',
  kill: 'refused in team seats: stop a seat with `team stop <seat>`',
  'pipe-to-shell': 'refused in team seats: save the download, read it, then run it',
  'git-push-force': 'refused in team seats: push a branch and open a pull request',
  'git-reset-hard': 'refused in team seats: use `git stash` or `git checkout -- <path>`',
};

/** One segment of a shell command line: its words, and whether a `|` put it after another. */
type Segment = { words: string[]; piped: boolean };

/**
 * Splits a command line on unquoted `;`, `&` and newlines (and `|`, remembering the pipe). Quotes
 * and backslash escapes are honoured, so `git commit -m "do not chmod"` is one word sequence the
 * guard never reads as a chmod. This is not a shell parser: it only needs to find where a command
 * word stands.
 */
function segments(line: string): Segment[] {
  const out: Segment[] = [];
  let words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let piped = false;
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
  for (const char of line) {
    if (escaped) {
      word += char;
      escaped = false;
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
      continue;
    }
    if (char === ';' || char === '\n' || char === '&' || char === '|') {
      endSegment();
      // Every separator ends the segment; only `|` makes the next one a pipe's right side.
      piped = char === '|';
      continue;
    }
    if (char === ' ' || char === '\t') {
      endWord();
      continue;
    }
    word += char;
  }
  endSegment();
  return out;
}

/** The command word and arguments of a segment, after the prefixes that run another command:
 *  `VAR=value`, `env`, `command`, `exec` and `nohup`. */
function commandOf(words: readonly string[]): string[] {
  let at = 0;
  while (at < words.length) {
    const word = words[at]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      at += 1;
      continue;
    }
    if (word === 'env' || word === 'command' || word === 'exec' || word === 'nohup') {
      at += 1;
      while (at < words.length && (words[at]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!))) at += 1;
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
  if (word === 'rm' && recursiveRm(args)) return { rule: 'rm-recursive', guidance: GUIDANCE['rm-recursive'] };
  if (word === 'git') {
    const { sub, rest } = gitSubcommand(args);
    if (sub === 'push' && rest.some((arg) => arg === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg))) {
      return { rule: 'git-push-force', guidance: GUIDANCE['git-push-force'] };
    }
    if (sub === 'reset' && rest.includes('--hard')) {
      return { rule: 'git-reset-hard', guidance: GUIDANCE['git-reset-hard'] };
    }
  }
  if (word === 'xargs') {
    // `find … | xargs chmod +x`: the command xargs runs is the first word that is not its option.
    const at = args.findIndex((arg) => !arg.startsWith('-'));
    if (at !== -1) return matchSegment(args.slice(at));
  }
  return null;
}

/**
 * What the guard says about one shell command line: null when it is allowed, or the class it
 * belongs to and the one line the model is told instead. A conservative set — chmod, chown,
 * sudo, a recursive rm, pkill and killall, a download piped into a shell, `git push --force`
 * (and `-f`) and `git reset --hard`.
 */
export function refusedByGuard(line: string): GuardMatch | null {
  const parsed = segments(line);
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
