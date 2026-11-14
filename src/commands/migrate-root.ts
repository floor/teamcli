// `team migrate --root`: rewrites the full paths a team's record writes inside its entity's
// projects root on this machine as `{root}/…` (src/file/root-word.ts), so the same record reads on
// every machine. `--dry-run` lists every line it would change and writes nothing; without it the
// same lines are written, and every changed line is printed — the rewrite is never silent. The
// rewrite keeps every comment and every other line byte for byte, and is refused unless it reads
// back as the same team with only those paths changed. Writing is the owner's, from a terminal
// outside herdr, as every other edit of the team's record is.
import { join } from 'node:path';
import { callerOf, describeCaller, detachedRefusal, isOwner } from '../caller.ts';
import { syncAgentLaunches } from '../config/edit.ts';
import { findRoot, TEAM_FILE } from '../file/load.ts';
import { planRootRewrite, ROOT_WORD } from '../file/root-word.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { readTeamText, writeTeamText } from '../file/team-text.ts';
import type { Io } from '../io.ts';
import { refuse, writeJson } from '../output/index.ts';
import { teamIdOf } from '../registry/teams.ts';

/** The options the root form takes; any other migrate option is refused with it. */
export type RootMigrateArgs = { dryRun: boolean; json: boolean; others: string[] };

/** One refusal of the root form, under its id; each site returns its own exit. */
function refused(io: Io, json: boolean, id: string, message: string): void {
  refuse(io, json, 'migrate', { id, message, repair: null });
}

export function runRootMigrate(args: RootMigrateArgs, io: Io, home: string): number {
  const { dryRun, json } = args;
  if (args.others.length > 0) {
    refused(io, json, 'migrate.root-invocation', `--root takes only --dry-run and --json, not ${args.others.join(', ')}`);
    // exit: migrate.root-invocation
    return 2;
  }
  // The team the other commands read here (a seat's own folder is its team's); a team that does
  // not load is looked for at the checkout's root, so a record whose {root} cannot be read is
  // still found and its words named.
  const loaded = readTeamConfig(io.cwd, { home });
  const root = loaded.ok ? loaded.root : findRoot(io.cwd) ?? io.cwd;
  const file = join(root, TEAM_FILE);
  let text: string;
  try {
    text = readTeamText(file, { home });
  } catch (error) {
    refused(io, json, 'migrate.root-unreadable', `the team's record cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    // exit: migrate.root-unreadable
    return 2;
  }
  const plan = planRootRewrite(text, home);
  if (!plan.ok) {
    refused(io, json, 'migrate.root-refused', `${plan.why}; nothing was written`);
    // exit: migrate.root-refused
    return 1;
  }
  const lines = plan.changes.map((change) => ({ line: change.line, before: change.before, after: change.after }));
  const say = (written: boolean) => {
    if (json) {
      writeJson(io, 'team.migrate-root', { format: 1, dry_run: dryRun, written, entity: plan.entity, root: plan.root, changes: lines });
      return;
    }
    if (lines.length === 0) {
      io.stdout(`nothing to rewrite: the team's record writes no full path inside ${plan.root}\n`);
      return;
    }
    const verb = dryRun ? 'would rewrite' : 'rewrote';
    io.stdout(`${verb} ${String(lines.length)} line${lines.length === 1 ? '' : 's'} to ${ROOT_WORD} (entity "${plan.entity}", ${plan.root} on this machine):\n`);
    for (const change of lines) io.stdout(`  line ${String(change.line)}:\n  - ${change.before.trim()}\n  + ${change.after.trim()}\n`);
  };
  if (dryRun || lines.length === 0) {
    say(false);
    // exit: migrate.root-listed
    return 0;
  }
  // The write: the owner, from a terminal outside herdr, as every edit of the team's record.
  const caller = callerOf(io);
  const detached = detachedRefusal(caller);
  if (detached !== undefined) {
    refused(io, json, 'migrate.root-detached', detached);
    // exit: migrate.root-detached
    return 1;
  }
  if (!isOwner(caller)) {
    refused(io, json, 'migrate.root-not-owner', `only the owner rewrites the team's record, from a terminal outside herdr; this call is ${describeCaller(caller)}; \`team migrate --root --dry-run\` lists the rewrite`);
    // exit: migrate.root-not-owner
    return 1;
  }
  const wrote = writeTeamText(file, plan.text, {
    home,
    command: 'migrate --root',
    audit: { caller, rule: 'owner-only' },
  });
  if (!wrote.ok) {
    const said = wrote.errors.map((problem) => (problem.line ? `line ${String(problem.line)}: ` : '') + problem.message).join('; ');
    refused(io, json, 'migrate.root-invalid', `the rewrite does not validate, and nothing was written: ${said}`);
    // exit: migrate.root-invalid
    return 1;
  }
  // A seat whose launch line changed: its agent record's launch recipe follows the record.
  const checked = readTeamConfig(root, { home });
  const synced = checked.ok ? syncAgentLaunches(home, teamIdOf(root), text, checked.team.seats, root) : [];
  say(true);
  if (!json) for (const name of synced) io.stdout(`agent record of ${name}: launch line updated to match\n`);
  // exit: migrate.root-written
  return 0;
}
