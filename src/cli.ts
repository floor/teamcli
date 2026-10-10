#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Command, Io } from './io.ts';
import { description, version } from './version.ts';

// Each command is loaded only when it is called. A slice adds its line here. The table is exported
// so a test can walk it: every command, `--help`, `-h` and a usage line.
export const commands: Record<string, () => Promise<{ default: Command; USAGE: string }>> = {
  approve: () => import('./commands/approve.ts'),
  check: () => import('./commands/check.ts'),
  commits: () => import('./commands/commits.ts'),
  doctor: () => import('./commands/doctor.ts'),
  down: () => import('./commands/down.ts'),
  init: () => import('./commands/init.ts'),
  status: () => import('./commands/status.ts'),
  up: () => import('./commands/up.ts'),
  watch: () => import('./commands/watch.ts'),
  messages: () => import('./commands/messages.ts'),
  issues: () => import('./commands/issues.ts'),
  next: () => import('./commands/next.ts'),
  plan: () => import('./commands/plan.ts'),
  worktree: () => import('./commands/worktree.ts'),
  add: () => import('./commands/add.ts'),
  answer: () => import('./commands/answer.ts'),
  pr: () => import('./commands/pr.ts'),
  remove: () => import('./commands/remove.ts'),
  send: () => import('./commands/send.ts'),
  release: () => import('./commands/release.ts'),
  usage: () => import('./commands/usage.ts'),
  broker: () => import('./commands/broker.ts'),
  mcp: () => import('./commands/mcp.ts'),
};

// The usage below the opening sentence: `team --help`'s first line is package.json's
// description, read at print time by helpText, so it is the same sentence the READMEs carry.
// This const stays a plain string, with no interpolation: scripts/contract.ts reads it from
// the source for contract/cli.json and docs/reference/cli.md.
const USAGE = `Usage: team <command> [options]

Commands:
{commands}

Options:
  --version   print the version
  --help      print this text

The team is declared in <project>/.agents/team.yaml.
`;

export { version };

/** `team --help`'s text, exactly as printed: the owner's opening sentence (package.json's
 *  description), a blank line, then the usage. */
export function helpText(): string {
  const names = Object.keys(commands);
  const usage = USAGE.replace('{commands}', names.length ? names.map((n) => `  ${n}`).join('\n') : '  (none in this build)');
  return `${description()}\n\n${usage}`;
}

/** What the process entry point does when a command throws: one line on stderr, exit code 1. */
export function reportFailure(error: unknown, stderr: (text: string) => void): number {
  stderr(`team: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1; // exit: team.command-threw
}

export async function main(argv: string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    io.stdout(helpText());
    // exit: team.help
    // exit: team.no-command
    return name ? 0 : 2;
  }
  if (name === '--version' || name === '-V') {
    io.stdout(`${version()}\n`);
    return 0; // exit: team.version
  }
  // Hidden: a port speaks this protocol. It is not a command in the help text.
  if (name === 'conformance-adapter') {
    const { default: run } = await import('./conformance/adapter.ts');
    return run(rest, io);
  }
  const load = commands[name];
  if (!load) {
    io.stderr(`team: unknown command "${name}"\n\n${helpText()}`);
    return 2; // exit: team.unknown
  }
  const command = await load();
  // The one path for every command's `--help`/`-h`: it prints the command's usage and stops,
  // before any option parsing, file reading, caller check or herdr call in the command itself.
  if (rest.includes('--help') || rest.includes('-h')) {
    io.stdout(command.USAGE);
    return 0; // exit: team.command-help
  }
  return command.default(rest, io);
}

export function processIo(): Io {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    cwd: process.cwd(),
    env: process.env,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), processIo()).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.exitCode = reportFailure(error, (text) => {
        process.stderr.write(text);
      });
    },
  );
}
