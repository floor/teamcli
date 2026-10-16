#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Command, Io } from './io.ts';
import { writeJson } from './output/index.ts';
import { NOT_PRETENDED, NOT_PRETENDED_ENTRIES } from './permissions/must-not-pretend.ts';
import { description, homepage, license, version } from './version.ts';

// Each command is loaded only when it is called. A slice adds its line here. The table is exported
// so a test can walk it: every command, `--help`, `-h` and a usage line.
export const commands: Record<string, () => Promise<{ default: Command; USAGE: string }>> = {
  brief: () => import('./commands/brief.ts'),
  check: () => import('./commands/check.ts'),
  client: () => import('./commands/client.ts'),
  commits: () => import('./commands/commits.ts'),
  doctor: () => import('./commands/doctor.ts'),
  archive: () => import('./commands/archive.ts'),
  down: () => import('./commands/down.ts'),
  drops: () => import('./commands/drops.ts'),
  init: () => import('./commands/init.ts'),
  import: () => import('./commands/import.ts'),
  migrate: () => import('./commands/migrate.ts'),
  grant: () => import('./commands/grant.ts'),
  delegate: () => import('./commands/delegate.ts'),
  'development-mode': () => import('./commands/development-mode.ts'),
  'owner-seat': () => import('./commands/owner-seat.ts'),
  revoke: () => import('./commands/revoke.ts'),
  status: () => import('./commands/status.ts'),
  seats: () => import('./commands/seats.ts'),
  seat: () => import('./commands/seat.ts'),
  list: () => import('./commands/list.ts'),
  up: () => import('./commands/up.ts'),
  watch: () => import('./commands/watch.ts'),
  messages: () => import('./commands/messages.ts'),
  issues: () => import('./commands/issues.ts'),
  sessions: () => import('./commands/sessions.ts'),
  next: () => import('./commands/next.ts'),
  plan: () => import('./commands/plan.ts'),
  queue: () => import('./commands/queue.ts'),
  worktree: () => import('./commands/worktree.ts'),
  add: () => import('./commands/add.ts'),
  answer: () => import('./commands/answer.ts'),
  'ask-show': () => import('./commands/ask-show.ts'),
  pr: () => import('./commands/pr.ts'),
  register: () => import('./commands/register.ts'),
  reload: () => import('./commands/reload.ts'),
  remove: () => import('./commands/remove.ts'),
  restart: () => import('./commands/restart.ts'),
  send: () => import('./commands/send.ts'),
  reply: () => import('./commands/reply.ts'),
  ack: () => import('./commands/ack.ts'),
  route: () => import('./commands/route.ts'),
  feed: () => import('./commands/feed.ts'),
  release: () => import('./commands/release.ts'),
  usage: () => import('./commands/usage.ts'),
  lock: () => import('./commands/lock.ts'),
  tempo: () => import('./commands/tempo.ts'),
  unlock: () => import('./commands/unlock.ts'),
  hold: () => import('./commands/hold.ts'),
  pause: () => import('./commands/pause.ts'),
  resume: () => import('./commands/resume.ts'),
  raise: () => import('./commands/raise.ts'),
  broker: () => import('./commands/broker.ts'),
  bus: () => import('./commands/bus.ts'),
  daemon: () => import('./commands/daemon.ts'),
  mcp: () => import('./commands/mcp.ts'),
  proc: () => import('./commands/proc.ts'),
  projects: () => import('./commands/projects.ts'),
  policy: () => import('./commands/policy.ts'),
  rename: () => import('./commands/rename.ts'),
  config: () => import('./commands/config.ts'),
  settings: () => import('./commands/settings.ts'),
  swap: () => import('./commands/swap.ts'),
  workflow: () => import('./commands/workflow.ts'),
};

/** Commands an earlier line carried and this one does not, each with the one line a typed one
 *  gets. A record rather than a `name ===` comparison on purpose: the command contract reads
 *  those comparisons as command definitions, and a removed command is not one. */
const REMOVED: Record<string, string> = {
  approve: 'team approve was removed in 0.5.0: the live team file is the record, and nothing needs approving; see UPGRADE-0.5.md',
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
  --about     print what this release is and what 0.5.0 must not pretend
  --help      print this text

The team is declared in <project>/.agents/team.yaml.

Exits 0 on --help, --version, or --about, 1 when a command throws an uncaught error, 2 when no command or an unknown command is given.
`;

// The hidden presence hook is written into a seat's settings file at install time, so no person
// types it. `--help` is the one way to read its words, and it ends through the help site every
// command uses.
const PRESENCE_HOOK_USAGE = `Usage: team presence-hook --dir <path> --session <name> --seat <name> --binding <binding> --event <event> [--notification permission_prompt]
`;

export { version };

/** `team --about`'s text: version, licence, docs link, and the `what 0.5.0 must not pretend` block. */
export function aboutText(): string {
  return [
    `team ${version()} — ${description()}`,
    `licence: ${license()}`,
    `docs: ${homepage()}`,
    '',
    ...NOT_PRETENDED,
    '',
  ].join('\n');
}

/** `team --help`'s text, exactly as printed: the owner's opening sentence (package.json's
 *  description), a blank line, then the usage. */
export function helpText(): string {
  const names = Object.keys(commands);
  const usage = USAGE.replace('{commands}', names.length ? names.map((n) => `  ${n}`).join('\n') : '  (none in this build)');
  return `${description()}\n\n${usage}`;
}

/** The one help end: print a command's usage and stop. A table command and the hidden presence
 *  hook both reach it, so the help exit stays one site with one row. */
function printHelp(io: Io, usage: string): number {
  io.stdout(usage);
  return 0; // exit: team.command-help
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
  // `--about` and `--json` are read as the line's first two words only: neither is a flag a
  // command takes after its name, so the contract must not read it from `rest.includes`.
  if (name === '--version' || name === '-V' || name === '--about' || (name === '--json' && rest[0] === '--about')) {
    const isAbout = name === '--about' || (name === '--json' && rest[0] === '--about');
    const isJson = isAbout && (name === '--json' || rest[0] === '--json');
    if (isJson) {
      writeJson(io, 'team.about', {
        format: 1,
        version: version(),
        description: description(),
        licence: license(),
        docs: homepage(),
        must_not_pretend: NOT_PRETENDED_ENTRIES.map((entry) => ({
          text: entry.text,
          ref: entry.ref,
        })),
      });
    } else {
      io.stdout(isAbout ? aboutText() : `${version()}\n`);
    }
    return 0; // exit: team.version
  }
  // Hidden: a port speaks this protocol. It is not a command in the help text.
  if (name === 'conformance-adapter') {
    const { default: run } = await import('./conformance/adapter.ts');
    return run(rest, io);
  }
  // Hidden: a seat's settings-file hook stages one presence event. Turn words are in argv and the
  // command reads no stdin; the notification command also exact-filters the CLI's payload. It
  // prints nothing. It is not a command in the help text.
  if (name === 'presence-hook') {
    if (rest.includes('--help') || rest.includes('-h')) return printHelp(io, PRESENCE_HOOK_USAGE);
    const { default: run } = await import('./daemon/presence/hook.ts');
    return run(rest);
  }
  const load = commands[name];
  if (!load) {
    // 0.3.5's last setup step was `team approve`. A user typing it out of habit is told the
    // command was removed, in one line, rather than given the generic help. A record and not a
    // `name ===` comparison: the command contract reads those comparisons as command
    // definitions, and this one is not a command any more.
    const removed = REMOVED[name];
    if (removed !== undefined) {
      io.stderr(`${removed}\n`);
      return 2; // exit: team.approve-removed
    }
    io.stderr(`team: unknown command "${name}"\n\n${helpText()}`);
    return 2; // exit: team.unknown
  }
  const command = await load();
  // The one path for every command's `--help`/`-h`: it prints the command's usage and stops,
  // before any option parsing, file reading, caller check or herdr call in the command itself.
  if (rest.includes('--help') || rest.includes('-h')) return printHelp(io, command.USAGE);
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
    stderrIsTTY: Boolean(process.stderr.isTTY),
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
