import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner } from '../caller.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, TEAM_FILE } from '../file/load.ts';
import { retireTeamFile, type Retired } from '../file/retire.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { importTeamFile, type ImportMode, type ImportOutcome } from '../file/team-import.ts';
import { approvalStanding } from '../store/store.ts';
import { teamIdOf } from '../registry/teams.ts';
import type { Command, Io } from '../io.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';

export const USAGE = `Usage: team migrate [--keep-file] [--dry-run] [--json]

Moves this team's definition from .agents/team.yaml into the registry, once. The team
is imported, read back from the registry and compared with the file by canonical record;
only then is .agents/team.yaml moved to the system Trash (or renamed to
.agents/team.yaml.migrated when no Trash can be reached; it is never deleted). Every
command then reads the team from the registry, and team config edits it. The approval
stays in force: it is signed over the canonical record, not the file.

Run again on a team the registry already holds, it moves a leftover file that says
what the registry says, and refuses one that does not (team import replaces the record).

  --keep-file  import and verify, and leave .agents/team.yaml where it is
  --dry-run    say what would be imported, and write nothing
  --json       the result as one JSON document on stdout

Exits 0 when the team is in the registry (or would be, with --dry-run), 1 when the
caller is not the owner or the team was already moved, 2 when the invocation, team
file, or registry record can't be read.
`;

export const migrate: Command = (argv, io) => runMigrate(argv, io);

/** The command with its home and clock named, for tests that keep the registry in a temp home. */
export async function runMigrate(argv: string[], io: Io, sources: { home?: string; now?: () => Date } = {}): Promise<number> {
  const ended = await runTeamImport('migrate', argv, readArgs(argv, [], ['json', 'dry-run', 'keep-file']), io, sources);
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
  const home = sources.home ?? homedir();
  const dryRun = args.flags.has('dry-run');
  const keepFile = mode === 'import' || args.flags.has('keep-file');
  const root = findRoot(io.cwd) ?? io.cwd;
  const teamFile = join(root, TEAM_FILE);
  // The approval's standing before the move: the move must not change it.
  const before = approvalStanding(root, home).kind;
  let outcome: ImportOutcome = importTeamFile({
    cwd: io.cwd,
    home,
    mode,
    ...(file !== undefined ? { file } : {}),
    dryRun,
    now: (sources.now ?? (() => new Date()))(),
  });
  if (mode === 'migrate' && !outcome.ok && (outcome.reason === 'already-migrated' || (outcome.reason === 'invalid' && !existsSync(teamFile)))) {
    // A team the registry already holds: a leftover file that says what the registry says is
    // retired as a first run would have retired it, and no file at all is nothing to do. A file
    // that says something else is still refused, with team import as the repair.
    const held = readTeamConfig(io.cwd, { home, source: 'registry' });
    if (held.ok && (held.leftover === undefined || held.leftover.matches)) {
      outcome = {
        ok: true,
        action: 'unchanged',
        project: held.team.project,
        id: teamIdOf(held.root),
        root: held.root,
        from: teamFile,
        record: null,
        replaced: false,
        verified: true,
      };
    }
  }
  if (!outcome.ok) {
    const message = outcome.errors.map((p) => (p.line ? `line ${p.line}: ` : '') + p.message).join('; ');
    const where = outcome.reason === 'invalid' && outcome.from ? `${outcome.from}: ` : '';
    refuse(io, json, mode, {
      id: `${mode}.${outcome.reason}`,
      message: `${where}${message}`,
      repair: outcome.reason === 'already-migrated' ? 'team import' : null,
    });
    return outcome.reason;
  }
  // The file is retired only after the read-back verified, never on a dry run, never for
  // `team import` (its file is the owner's copy), and not with --keep-file.
  let retired: Retired | null = null;
  if (!keepFile && !dryRun && outcome.verified && existsSync(teamFile)) retired = retireTeamFile(teamFile);
  const after = approvalStanding(root, home).kind;
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
      ...(mode === 'migrate' ? { file: retired === null ? (existsSync(teamFile) ? 'kept' : 'absent') : retired.how, file_moved_to: retired?.to ?? null, approval: after } : {}),
    });
    return 'done';
  }
  if (outcome.action === 'would-import') {
    io.stdout(`${outcome.project}: would ${outcome.replaced ? 'replace the registry\'s record with' : 'import'} ${outcome.from} (team ${outcome.id}); nothing written\n`);
    if (mode === 'migrate' && !keepFile) io.stdout(`then ${TEAM_FILE} would be moved to the Trash (--keep-file leaves it)\n`);
    return 'done';
  }
  if (outcome.action === 'unchanged') {
    io.stdout(`${outcome.project}: the registry already holds this team; nothing to import\n`);
  } else {
    io.stdout(`${outcome.project}: ${outcome.replaced ? 'replaced the registry\'s record with' : 'imported'} ${outcome.from} (team ${outcome.id}); read back and verified\n`);
  }
  if (mode === 'import') {
    io.stdout('the team is read from the registry; the file is not read\n');
  } else if (retired !== null) {
    io.stdout(`${TEAM_FILE} ${retired.how === 'trash' ? 'was moved to the Trash' : `was renamed to ${retired.to} (no Trash could be reached)`}; edit the team with team config\n`);
  } else if (existsSync(teamFile)) {
    io.stdout(`${TEAM_FILE} was kept (--keep-file); it is no longer read, and team migrate moves it later\n`);
  }
  if (mode === 'migrate' && before === 'verified') {
    io.stdout(after === 'verified' ? 'the approval is still in force: it is signed over the canonical record\n' : `the approval no longer verifies (${after}); approve the team again\n`);
  }
  return 'done';
}
