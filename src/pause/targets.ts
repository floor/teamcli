// Which team, or teams, a pause or a resume acts on. The same resolution serves both commands:
// no name is the team file of this folder, `<team>` is a registered team by its name,
// project or id, and `--all` is every registered team whose file still loads. Nothing here
// judges the caller or writes a state; the commands do both, each under its own exit ids.
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { currentTeam } from '../file/current.ts';
import { withoutFileOffer } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import type { Io } from '../io.ts';
import { plainText } from '../launch/plain.ts';
import { findTeams, readTeams } from '../registry/teams.ts';
import type { PauseStop, SeatState, SessionState, WorktreeState } from '../state.ts';

export type PauseTarget = {
  team: TeamFile;
  /** The project folder that holds `.agents`. */
  root: string;
  /** The team file's folder: where the state, the lock and the log live. */
  dir: string;
  /** The line `currentTeam` carries about the last valid file, printed by the plain run. */
  notice?: string;
};

export type TargetFailure = {
  ok: false;
  /** `file` and `team` are exit 2, `io` is exit 1; the command maps the kind to its own row. */
  kind: 'file' | 'team' | 'io';
  message: string;
};

export type TargetResult = { ok: true; targets: PauseTarget[]; skipped: string[] } | TargetFailure;

/**
 * The teams one run acts on. `key` is the positional the caller typed, if any; `all` asks for
 * every registered team. A team whose file does not load is named in `skipped` when `--all` was
 * asked for, and the run goes on with the ones that do; asking for that team by name is a
 * refusal instead, because then it is the only thing the run was for.
 */
export function resolveTargets(options: {
  key: string | undefined;
  all: boolean;
  io: Pick<Io, 'cwd'>;
  home?: string;
  now: () => Date;
  owner: boolean;
}): TargetResult {
  const home = options.home ?? homedir();
  if (options.key !== undefined) {
    let found: ReturnType<typeof findTeams>;
    try {
      found = findTeams(home, options.key);
    } catch (error) {
      return { ok: false, kind: 'io', message: plainText(error instanceof Error ? error.message : String(error)) };
    }
    if (found.length === 0) {
      return { ok: false, kind: 'team', message: `no team named "${plainText(options.key)}" is registered on this machine` };
    }
    if (found.length > 1) {
      return { ok: false, kind: 'team', message: `"${plainText(options.key)}" names more than one team on this machine; name one by its id` };
    }
    const record = found[0] as (typeof found)[number];
    const loaded = readTeamConfig(record.root, { home });
    if (!loaded.ok) {
      return { ok: false, kind: 'file', message: `${record.project}: ${problemsOf(loaded)}` };
    }
    return { ok: true, targets: [{ team: loaded.team, root: loaded.root, dir: dirname(loaded.path) }], skipped: [] };
  }
  if (options.all) {
    let teams: ReturnType<typeof readTeams>;
    try {
      teams = readTeams(home);
    } catch (error) {
      return { ok: false, kind: 'io', message: plainText(error instanceof Error ? error.message : String(error)) };
    }
    const records = Object.entries(teams)
      .sort(([leftId, left], [rightId, right]) => (left.project === right.project ? leftId.localeCompare(rightId) : left.project.localeCompare(right.project)));
    if (records.length === 0) return { ok: false, kind: 'team', message: 'no team is registered on this machine' };
    const targets: PauseTarget[] = [];
    const skipped: string[] = [];
    for (const [, record] of records) {
      const loaded = readTeamConfig(record.root, { home });
      if (!loaded.ok) {
        skipped.push(`${record.project}: ${problemsOf(loaded)}`);
        continue;
      }
      targets.push({ team: loaded.team, root: loaded.root, dir: dirname(loaded.path) });
    }
    if (targets.length === 0) {
      return { ok: false, kind: 'file', message: `no registered team file could be read: ${skipped.join('; ')}` };
    }
    return { ok: true, targets, skipped };
  }
  const current = currentTeam(options.io.cwd, undefined, options.now(), options.home, options.owner);
  if (!current.ok) return { ok: false, kind: 'file', message: problemsOf(current) };
  return {
    ok: true,
    targets: [{
      team: current.team,
      root: current.root,
      dir: current.dir,
      ...(current.notice !== undefined ? { notice: plainText(current.notice) } : {}),
    }],
    skipped: [],
  };
}

/** The team file's own problems as one line, in the shape `hold` prints them: the line number
 *  when there is one, and without the `--file` offer — neither command takes that flag. */
function problemsOf(loaded: { errors: Array<{ line?: number; message: string }> }): string {
  return loaded.errors
    .map((problem) => `${problem.line ? `team.yaml line ${problem.line}: ` : ''}${withoutFileOffer(plainText(problem.message))}`)
    .join('; ');
}

/**
 * The stop points a pause records: one per seat the file declares that is not a human's, in the
 * file's order. A human seat is left out entirely — a pause types nothing into it and records
 * nothing about it. Each point is what the tool already holds: the stage and last activity of
 * the seat's record, and the branch and folder of the worktree it was given, when it had one.
 */
export function pauseStops(team: TeamFile, state: SessionState | undefined): PauseStop[] {
  const stops: PauseStop[] = [];
  for (const seat of team.seats) {
    if (seat.human === true) continue;
    const recorded: SeatState | undefined = state?.seats[seat.name];
    const worktree = worktreeOf(state, seat.name);
    stops.push({
      seat: seat.name,
      ...(recorded?.stage !== undefined ? { stage: recorded.stage } : {}),
      ...(worktree?.branch !== undefined ? { branch: worktree.branch } : {}),
      ...(worktree?.path !== undefined ? { path: worktree.path } : {}),
      ...(recorded?.last_active !== undefined ? { last_active: recorded.last_active } : {}),
    });
  }
  return stops;
}

/** The worktree a seat was given: the record a launch wrote under the seat's name, else the one
 *  whose `seat` names it. A task keyed by another word is still the seat's when it says so. */
function worktreeOf(state: SessionState | undefined, seat: string): WorktreeState | undefined {
  if (state === undefined) return undefined;
  const named = state.worktrees[seat];
  if (named !== undefined) return named;
  return Object.values(state.worktrees).find((worktree) => worktree.seat === seat);
}
