// Which team, or teams, a pause or a resume acts on. The same resolution serves both commands:
// no name is the team file of this folder, `<team>` is a registered team by its name,
// project or id, `<seat>` is a seat the current folder's team declares, `--seat <seat>` and
// `--team <team>` name either one without ambiguity, and `--all` is every registered team whose
// file still loads. Nothing here judges the caller or writes a state; the commands do both,
// each under its own exit ids.
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
  /** The seat this target pauses on its own; absent for a team-wide target. */
  seat?: string;
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
 * The teams or seats one run acts on. `key` is the positional the caller typed, if any;
 * `seat` and `team` are the explicit flags; `all` asks for every registered team. A team whose
 * file does not load is named in `skipped` when `--all` was asked for, and the run goes on with
 * the ones that do; asking for that team by name is a refusal instead, because then it is the
 * only thing the run was for.
 *
 * A positional that the current folder's team declares as a seat is that seat; a positional
 * that is not a declared seat is resolved as a registered team, as it always was. A name that
 * is both is refused, and the two flags keep either meaning reachable; `command` is the word
 * that refusal's repair names, because the same resolution serves pause and resume.
 */
export function resolveTargets(options: {
  key: string | undefined;
  seat?: string;
  team?: string;
  all: boolean;
  command?: 'pause' | 'resume';
  io: Pick<Io, 'cwd'>;
  home?: string;
  now: () => Date;
  owner: boolean;
}): TargetResult {
  const home = options.home ?? homedir();
  const command = options.command ?? 'pause';
  if (options.seat !== undefined) {
    const current = currentTarget(options, home);
    if (!current.ok) return current;
    return seatTarget(current.target, options.seat);
  }
  if (options.team !== undefined) return teamTarget(options.team, home);
  if (options.key !== undefined) {
    // The seat the current folder's team declares, before the registry: a seat name is the
    // narrower target and the one the command words use. A name that is both is refused.
    const current = currentTarget(options, home);
    const declared = current.ok ? current.target.team.seats.find((seat) => seat.name === options.key) : undefined;
    let found: ReturnType<typeof findTeams>;
    try {
      found = findTeams(home, options.key);
    } catch (error) {
      return { ok: false, kind: 'io', message: plainText(error instanceof Error ? error.message : String(error)) };
    }
    const project = current.ok ? current.target.team.project : undefined;
    if (declared !== undefined && found.length > 0) {
      return {
        ok: false,
        kind: 'team',
        message: `"${plainText(options.key)}" names both a seat of ${project ?? 'this folder'} and a registered team; use team ${command} --seat ${plainText(options.key)} or team ${command} --team ${plainText(options.key)}`,
      };
    }
    if (declared !== undefined && current.ok) return seatTarget(current.target, options.key);
    if (found.length === 0) {
      if (project !== undefined) {
        return {
          ok: false,
          kind: 'team',
          message: `no seat named "${plainText(options.key)}" is declared in ${project}, and no registered team has that name`,
        };
      }
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
  const current = currentTarget(options, home);
  if (!current.ok) return current;
  return { ok: true, targets: [current.target], skipped: [] };
}

/** The team file of this folder, the target a bare pause or resume and a seat name start from. */
function currentTarget(
  options: { io: Pick<Io, 'cwd'>; home?: string; now: () => Date; owner: boolean },
  home: string,
): { ok: true; target: PauseTarget } | TargetFailure {
  const current = currentTeam(options.io.cwd, undefined, options.now(), options.home, options.owner);
  if (!current.ok) return { ok: false, kind: 'file', message: problemsOf(current) };
  return {
    ok: true,
    target: {
      team: current.team,
      root: current.root,
      dir: current.dir,
      ...(current.notice !== undefined ? { notice: plainText(current.notice) } : {}),
    },
  };
}

/** One team by name, project or id, loaded: the explicit `--team` path and the positional path
 *  that names no declared seat both end here. */
function teamTarget(key: string, home: string): TargetResult {
  let found: ReturnType<typeof findTeams>;
  try {
    found = findTeams(home, key);
  } catch (error) {
    return { ok: false, kind: 'io', message: plainText(error instanceof Error ? error.message : String(error)) };
  }
  if (found.length === 0) {
    return { ok: false, kind: 'team', message: `no team named "${plainText(key)}" is registered on this machine` };
  }
  if (found.length > 1) {
    return { ok: false, kind: 'team', message: `"${plainText(key)}" names more than one team on this machine; name one by its id` };
  }
  const record = found[0] as (typeof found)[number];
  const loaded = readTeamConfig(record.root, { home });
  if (!loaded.ok) {
    return { ok: false, kind: 'file', message: `${record.project}: ${problemsOf(loaded)}` };
  }
  return { ok: true, targets: [{ team: loaded.team, root: loaded.root, dir: dirname(loaded.path) }], skipped: [] };
}

/** A seat of one team, checked against the file before anything is written: a name the file
 *  does not declare is refused, and a human seat is never a target — a pause does not touch it. */
function seatTarget(target: PauseTarget, name: string): TargetResult {
  const seat = target.team.seats.find((entry) => entry.name === name);
  if (seat === undefined) {
    return {
      ok: false,
      kind: 'team',
      message: `no seat named "${plainText(name)}" is declared in ${target.team.project}`,
    };
  }
  if (seat.human === true) {
    return { ok: false, kind: 'team', message: `${plainText(name)} is a human seat; a pause never touches it` };
  }
  return { ok: true, targets: [{ ...target, seat: name }], skipped: [] };
}

/** The team file's own problems as one line, in the shape `hold` prints them: the line number
 *  when there is one, and without the `--file` offer — neither command takes that flag. */
function problemsOf(loaded: { errors: Array<{ line?: number; message: string }> }): string {
  return loaded.errors
    .map((problem) => `${problem.line ? `team config line ${problem.line}: ` : ''}${withoutFileOffer(plainText(problem.message))}`)
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
