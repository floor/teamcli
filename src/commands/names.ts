// `team names fill`: names every seat of the team that goes by no name — no `nickname:`, and no
// persona in its written label but its seat name — with the first free name of the entity's
// `names.pool`, in file order, the way `team add` and `team up` name a seat at its launch
// (src/registry/names.ts:autoNamePlan). `--entity <name>` does it for every registered team of
// that entity, one after the other, so no two of them take one name. The write is
// `team config edit`'s own (src/config/edit.ts): the same door, the same validation, the same
// `names.unique` check and the same roster refresh, so a handed-out name is a manual one. A
// dry run reads the record and plans, and writes nothing. It runs whatever `names.auto` says: the
// word decides only whether a launch names a seat, and asking for a fill is asking for names.

import { existsSync, readFileSync } from 'node:fs';
import { writeFileSync } from '../host/guarded-fs.ts';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { recordNamedSeatDigestsOf } from '../approve/approval.ts';
import { approvalStanding } from '../store/store.ts';
import { runTeamRecordEdit } from '../config/edit.ts';
import { findRoot, TEAM_FILE } from '../file/load.ts';
import { readTeamText } from '../file/team-text.ts';
import { validateTeamFile } from '../file/validate.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { addressedTeam } from '../registry/binding.ts';
import { autoNamePlan, withAutoNames, type NameAssignment } from '../registry/names.ts';
import { readTeams, TeamsError } from '../registry/teams.ts';
import type { ConfigSources } from './config.ts';

export const USAGE = `Usage: team names fill [--dry-run] [--json]
       team names fill --entity <name> [--dry-run] [--json]

fill names every seat of this team that has no nickname: each takes the first name of the
entity's names.pool (greek-myth unless the entity names another pool or lists its own names) that
no seat of the team carries, passing over a name another registered team already carries while the
pool has another, and never one the entity's names.unique word refuses. The seat's nickname is
written, and its label becomes "<Nickname> · <role>": the part after a written label's middle
dot, or a label with no dot whole ("Gemini tester" becomes "<Nickname> · Gemini tester"). A seat
is named when it has a nickname or a label "<Name> · <role>", and keeps it; a label with no dot is
a description, not a name. A human seat and a counted entry get none. A registered team whose
folder is gone is "<team>: its record is gone; skipped". One line per seat: "<team>: <seat> → <Nickname>". --dry-run prints the
same lines under "dry run: nothing was written" and writes nothing. --entity <name> fills every
registered team of that entity, in order, so no two take one name.

The write is team config edit's: the owner's at a terminal outside herdr (or a charter's, or dev
mode's), validated whole, the roster's names refreshed at once. A dry run reads and is any caller's.

Exits 0 when the names are written or planned, or every seat already has one; 1 when the write is
refused, the pool has no free name or the entity has no team; 2 when the invocation is invalid or
the team's record can't be read.
`;

type TeamFill = {
  team: string;
  root: string;
  assignments: NameAssignment[];
  written: boolean;
  problem: string | null;
  /** The team's folder is gone: nothing was read or written. */
  skipped?: true;
};

export const names: Command = (argv, io) => runNames(argv, io);
export default names;

export async function runNames(argv: string[], rawIo: Io, sources: ConfigSources = {}): Promise<number> {
  const io = cleanedIo(rawIo);
  const json = hasJsonFlag(argv, ['entity']);
  const args = readArgs(argv, ['entity'], ['dry-run', 'json']);
  const sub = args.rest[0];
  const why = args.error
    ?? (sub !== 'fill' ? (sub === undefined ? 'a subcommand is required: fill' : `unknown subcommand "${sub}"`)
      : args.rest.length > 1 ? `unexpected "${args.rest[1]}"` : null);
  if (why !== null) {
    refuse(io, json, 'names', { id: 'names.usage', message: why, repair: null, usage: USAGE });
    // exit: names.usage
    return 2;
  }
  const dry = args.flags.has('dry-run');
  const home = sources.home ?? homedir();
  const env = sources.env ?? process.env;
  let roots: Array<{ root: string; team: string | null }>;
  const entity = args.values.entity;
  if (entity !== undefined) {
    let teams: ReturnType<typeof readTeams>;
    try {
      teams = readTeams(home);
    } catch (error) {
      if (!(error instanceof TeamsError)) throw error;
      refuse(io, json, 'names', { id: 'names.unreadable', message: `the registry cannot be read: ${error.message}`, repair: null });
      // exit: names.unreadable
      return 2;
    }
    roots = Object.values(teams)
      .filter((record) => record.entity === entity && record.lifecycle !== 'archived')
      .map((record) => ({ root: record.root, team: record.project }))
      .sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
    if (roots.length === 0) {
      refuse(io, json, 'names', { id: 'names.no-team', message: `entity "${entity}" has no registered team`, repair: null });
      // exit: names.no-team
      return 1;
    }
  } else {
    const binding = addressedTeam(home, io.cwd, undefined, rawIo);
    if (binding.kind === 'ambiguous' || binding.kind === 'unreadable') {
      refuse(io, json, 'names', { id: 'names.unreadable', message: binding.message, repair: null });
      return 2; // exit: names.unreadable
    }
    roots = [binding.kind === 'bound'
      ? { root: binding.team.root, team: binding.team.project }
      : { root: findRoot(io.cwd) ?? resolve(io.cwd), team: null }];
  }

  const taken = new Set<string>();
  const fills: TeamFill[] = [];
  let failed = false;
  for (const { root, team } of roots) {
    // A registered team whose folder is gone has no record to name: said, and skipped.
    if (!existsSync(root)) {
      const name = team ?? root;
      fills.push({ team: name, root, assignments: [], written: false, problem: null, skipped: true });
      if (!json) {
        if (dry && fills.length === 1) io.stdout('dry run: nothing was written\n');
        io.stdout(`${name}: its record is gone; skipped\n`);
      }
      continue;
    }
    const fill = dry ? planFill(root, home, env, taken) : await writeFill(root, rawIo, io, sources, taken);
    for (const assignment of fill.assignments) taken.add(assignment.nickname.toLowerCase());
    fills.push(fill);
    if (fill.problem !== null) failed = true;
    if (!json) {
      if (dry && fills.length === 1) io.stdout('dry run: nothing was written\n');
      for (const assignment of fill.assignments) io.stdout(`${fill.team}: ${assignment.seat} → ${assignment.nickname}\n`);
      if (fill.problem !== null) io.stderr(`team names: ${fill.team}: ${fill.problem}\n`);
      else if (fill.assignments.length === 0) io.stdout(`${fill.team}: every seat has a name\n`);
    }
  }
  if (json) {
    writeJson(io, 'team.names-fill', {
      format: 1,
      dry_run: dry,
      teams: fills.map((fill) => ({
        team: fill.team,
        written: fill.written,
        assignments: fill.assignments.map((assignment) => ({ seat: assignment.seat, nickname: assignment.nickname, label: assignment.label })),
        problem: fill.problem,
        ...(fill.skipped ? { skipped: true } : {}),
      })),
    });
  }
  if (failed) {
    // exit: names.refused
    return 1;
  }
  // exit: names.filled
  return 0;
}

/** The plan for one team's record, read as it stands: nothing is written. */
function planFill(root: string, home: string, env: Record<string, string | undefined>, taken: ReadonlySet<string>): TeamFill {
  let text: string;
  try {
    text = readTeamText(join(root, TEAM_FILE), { home, env });
  } catch (error) {
    return { team: root, root, assignments: [], written: false, problem: `the team's record cannot be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  return planOf(text, root, home, taken);
}

function planOf(text: string, root: string, home: string, taken: ReadonlySet<string>): TeamFill {
  const parsed = validateTeamFile(text, { home, root });
  if (!parsed.ok) {
    return { team: root, root, assignments: [], written: false, problem: `the team's record does not validate: ${parsed.errors.map((problem) => problem.message).join('; ')}` };
  }
  const plan = autoNamePlan({ home, root, team: parsed.team, taken });
  return { team: parsed.team.project, root, assignments: plan.assignments, written: false, problem: plan.problem };
}

/**
 * One team's names, written through `team config edit` with the planned text as the edit: the
 * plan is made from the very text the edit reads, under its door, and the edit's own refusal is
 * this team's problem. Its report lines are this command's to print, so its stdout is dropped.
 */
async function writeFill(root: string, rawIo: Io, io: Io, sources: ConfigSources, taken: ReadonlySet<string>): Promise<TeamFill> {
  const home = sources.home ?? homedir();
  const read = planFill(root, home, sources.env ?? process.env, taken);
  if (read.problem !== null && read.assignments.length === 0 && read.team === root) return read;
  let fill: TeamFill = { ...read, assignments: [], problem: null };
  const said: string[] = [];
  let edited: { before: string; after: string } | null = null;
  const code = await runTeamRecordEdit(['edit'], {
    ...rawIo,
    cwd: root,
    stdout: () => {},
    stderr: (text) => {
      said.push(text);
    },
  }, {
    ...sources,
    editor: (draft) => {
      const text = readFileSync(draft, 'utf8');
      fill = planOf(text, root, home, taken);
      if (fill.assignments.length > 0) {
        edited = { before: text, after: withAutoNames(text, fill.assignments) };
        writeFileSync(draft, edited.after, { mode: 0o600 });
      }
      return 0;
    },
  });
  if (code !== 0) {
    const reason = said.join('').trim().replace(/^team config: /, '').split('\n')[0] ?? '';
    return { ...fill, assignments: [], written: false, problem: reason === '' ? 'the write was refused' : reason };
  }
  // The approval follows the names and nothing else (src/approve/approval.ts).
  const pair = edited as { before: string; after: string } | null;
  if (pair !== null) {
    const before = validateTeamFile(pair.before, { home, root });
    const after = validateTeamFile(pair.after, { home, root });
    if (before.ok && after.ok) recordNamedSeatDigestsOf(approvalStanding(root, home), before.team, after.team, root, fill.assignments.map((one) => one.seat), home);
  }
  // Warnings the edit printed (a dev-mode admission, comments rewritten) are said as they came.
  for (const text of said) io.stderr(text);
  return { ...fill, written: fill.assignments.length > 0 };
}
