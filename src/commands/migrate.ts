import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner } from '../caller.ts';
import { importTeamFile, type ImportMode } from '../file/team-import.ts';
import type { Command, Io } from '../io.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';

export const USAGE = `Usage: team migrate [--dry-run] [--json]

Moves this team's definition from .agents/team.yaml into the registry, once. Every
command then reads the team from the registry (team-config.source, default registry);
the file is left in place and is no longer read. team check and team status name it
if it ever says something the registry does not.

  --dry-run  say what would be imported, and write nothing
  --json     the result as one JSON document on stdout

Exits 0 when the team is in the registry (or would be, with --dry-run), 1 when the
caller is not the owner or the team was already moved, 2 when the invocation, team
file, or registry record can't be read.
`;

export const migrate: Command = (argv, io) => runMigrate(argv, io);

/** The command with its home and clock named, for tests that keep the registry in a temp home. */
export async function runMigrate(argv: string[], io: Io, sources: { home?: string; now?: () => Date } = {}): Promise<number> {
  const ended = await runTeamImport('migrate', argv, readArgs(argv, [], ['json', 'dry-run']), io, sources);
  switch (ended) {
    case 'done':
      // exit: migrate.done
      return 0;
    case 'detached':
      // exit: migrate.detached
      return 1;
    case 'not-owner':
      // exit: migrate.not-owner
      return 1;
    case 'already-migrated':
      // exit: migrate.already-migrated
      return 1;
    case 'invocation':
      // exit: migrate.invocation
      return 2;
    case 'invalid':
      // exit: migrate.invalid
      return 2;
    case 'registry':
      // exit: migrate.registry
      return 2;
    default:
      // exit: migrate.round-trip
      return 2;
  }
}
export default migrate;

/** How a run ended: each command turns it into its own exit code. */
export type ImportEnd = 'done' | 'detached' | 'not-owner' | 'already-migrated' | 'invocation' | 'invalid' | 'registry' | 'round-trip';

/** The one runner for `team migrate` and `team import` (src/commands/import.ts). It prints and
 *  says how the run ended; the exit code is each command's own. */
export async function runTeamImport(
  mode: ImportMode,
  argv: string[],
  args: ReturnType<typeof readArgs>,
  io: Io,
  sources: { home?: string; now?: () => Date } = {},
): Promise<ImportEnd> {
  const usage = mode === 'migrate' ? USAGE : (await import('./import.ts')).USAGE;
  const json = hasJsonFlag(argv);
  const extra = mode === 'import' ? args.rest.slice(1) : args.rest;
  if (args.error || extra.length > 0) {
    refuse(io, json, mode, { id: `${mode}.invocation`, message: args.error ?? `unexpected "${extra[0]}"`, repair: null, usage });
    return 'invocation';
  }
  const file = mode === 'import' ? args.rest[0] : undefined;
  const caller = callerOf(io);
  const detached = detachedRefusal(caller);
  if (detached !== undefined) {
    refuse(io, json, mode, { id: `${mode}.detached`, message: detached, repair: null });
    return 'detached';
  }
  if (!isOwner(caller)) {
    // The team's configuration is the owner's: moving it is the owner's act, as writing it is.
    refuse(io, json, mode, {
      id: `${mode}.not-owner`,
      message: `only the owner runs ${mode}, from a terminal outside herdr; this call is ${describeCaller(caller)}`,
      repair: null,
      rule: 'owner-only',
    });
    return 'not-owner';
  }
  const outcome = importTeamFile({
    cwd: io.cwd,
    home: sources.home ?? homedir(),
    mode,
    ...(file !== undefined ? { file } : {}),
    dryRun: args.flags.has('dry-run'),
    now: (sources.now ?? (() => new Date()))(),
  });
  if (!outcome.ok) {
    const message = outcome.errors.map((p) => (p.line ? `line ${p.line}: ${p.message}` : p.message)).join('; ');
    const where = outcome.reason === 'invalid' && outcome.from ? `${outcome.from}: ` : '';
    refuse(io, json, mode, {
      id: `${mode}.${outcome.reason}`,
      message: `${where}${message}`,
      repair: outcome.reason === 'already-migrated' ? 'team import' : null,
    });
    return outcome.reason;
  }
  if (json) {
    writeJson(io, `team.${mode}`, {
      format: 1,
      project: outcome.project,
      team_id: outcome.id,
      root: outcome.root,
      from: outcome.from,
      action: outcome.action,
      replaced: outcome.replaced,
      verified: outcome.verified,
      record_sha256: outcome.record,
    });
  } else if (outcome.action === 'would-import') {
    io.stdout(`${outcome.project}: would ${outcome.replaced ? 'replace the registry\'s record with' : 'import'} ${outcome.from} (team ${outcome.id}); nothing written\n`);
  } else if (outcome.action === 'unchanged') {
    io.stdout(`${outcome.project}: the registry already holds ${outcome.from}; nothing to do\n`);
  } else {
    io.stdout(`${outcome.project}: ${outcome.replaced ? 'replaced the registry\'s record with' : 'imported'} ${outcome.from} (team ${outcome.id}); read back and verified\n`);
    io.stdout('the team is now read from the registry; the file is no longer read, and you may delete it\n');
  }
  return 'done';
}
