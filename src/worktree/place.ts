import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { migrationText } from '../file/migrate.ts';
import { insideTrust, isLegacyTrust, isMigratedTrust, protectedBy } from '../file/paths.ts';
import { isLeadSeat } from '../file/sections/lead.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { lobbyOf } from '../lobby/recorded.ts';

// A task name is one path segment. It is also the last segment of the folder and part of the branch.
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function taskProblem(task: string): string | null {
  if (!TASK_NAME.test(task)) {
    return 'a task name is one segment of letters, digits, ".", "_" and "-", and it starts with a letter or a digit';
  }
  return null;
}

// Fills `{kind}` and `{task}`. Null when a placeholder has no value, or one is left that this command doesn't know.
export function fillPattern(pattern: string, values: Record<string, string | undefined>): string | null {
  let unknown = false;
  const filled = pattern.replace(/\{([^}]*)\}/g, (token, name: string) => {
    const value = values[name];
    if (value === undefined) {
      unknown = true;
      return token;
    }
    return value;
  });
  return unknown ? null : filled;
}

// The lobby: the neutral folder a seat that works in worktrees waits in until a brief names its
// worktree — the folder the worktrees go in, with ".lobby" beside them, so a trust pattern that
// covers the worktrees covers it too. Null when the file names no folder to take a parent from.
export function lobbyPath(team: Pick<TeamFile, 'project' | 'workspace'>): string | null {
  const path = team.workspace.path;
  if (!path) return null;
  const parent = path.split('/').slice(0, -1).join('/').replaceAll('{repo}', team.project) || '.';
  return join(parent, '.lobby');
}

// Where a folder will really land, `root` being the project root: `logical` is the path the file
// names; `real` follows a symlink in an ancestor that already exists. The worktree command tests
// both, and so does a seat's start: a worktrees folder that is a symlink into the project puts the
// lobby — and any folder under it — physically inside the protected checkout.
export function realLanding(root: string, folder: string): { logical: string; real: string } {
  const logical = resolve(root, folder);
  const tail: string[] = [];
  let current = logical;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return { logical, real: logical };
    tail.push(basename(current));
    current = parent;
  }
  return { logical, real: join(realpathSync(current), ...tail.reverse()) };
}

// The protected checkout `folder` is in, in the text and then on disk: `protectedBy` reads the path
// as written, then the folder and the checkouts are resolved — symlinks in the ancestors that exist
// today followed — and tested again, so a folder that is physically inside one is inside it here.
export function protectedLanding(root: string, folder: string, checkouts: readonly string[]): string | null {
  const written = protectedBy(folder, checkouts);
  if (written) return written;
  const real = realLanding(root, folder).real;
  for (const checkout of checkouts) {
    const land = realLanding(root, checkout).real;
    if (real === land || real.startsWith(`${land}${sep}`)) return checkout;
  }
  return null;
}

/** Where a seat starts: the folder it waits in, or why it can't start. */
export type SeatStart = { cwd: string; lobby?: true } | { problem: string; once?: true };

// Where a seat starts. In a migrated file, the orchestrator and the operator start in the
// project root, and every other seat (shared and worktree-mode alike) starts in the folder its
// `cwd` names when the file sets one (resolved against the project root), else in the resolved
// lobby. In a legacy file, a shared seat starts in its cwd, and a worktree seat starts in the
// old derived lobby.
export function seatStart(
  team: Pick<TeamFile, 'project' | 'session' | 'workspace' | 'trust' | 'seats' | 'entity' | 'lobby' | 'orchestrator' | 'operator'>, seat: Seat, root: string, home: string = homedir(), verifiedLobby?: string,
): SeatStart {
  if (!team.trust || team.trust.length === 0) {
    const lobby = lobbyOf(home, root, team);
    return {
      problem:
        `the file is legacy: migrate trust to absolute paths including the lobby ${lobby}:\n${migrationText(team, root, home)}`,
      once: true,
    };
  }

  if (isLegacyTrust(team.trust)) {
    if (seat.mode === 'shared') return { cwd: seat.cwd };
    if (seat.cwd !== '.') {
      const hit = protectedLanding(root, seat.cwd, team.workspace.protected);
      if (hit) {
        return {
          problem:
            `seat ${seat.name} would start in ${seat.cwd}, inside the protected checkout ${hit}; ` +
            "a seat that isn't `mode: shared` never starts in one",
        };
      }
      return { cwd: seat.cwd };
    }
    const lobby = lobbyPath(team);
    if (lobby === null) {
      return {
        problem: 'a seat that works in worktrees has no lobby to wait in: workspace.path must name the folder {task} goes under',
        once: true,
      };
    }
    const hit = protectedLanding(root, lobby, team.workspace.protected);
    if (hit) {
      return {
        problem:
          `seat ${seat.name} would start in the lobby ${lobby}, inside the protected checkout ${hit}; ` +
          "a seat that isn't `mode: shared` never starts in one",
      };
    }
    if (!insideTrust(lobby, team.trust)) {
      return {
        problem:
          `the lobby ${lobby} matches no trust pattern (${team.trust.join(', ') || 'none'}): ` +
          'add one that covers it',
        once: true,
      };
    }
    return { cwd: lobby, lobby: true };
  }

  if (isMigratedTrust(team.trust)) {
    if (seat.cwd !== '.') {
      const hit = protectedLanding(root, seat.cwd, team.workspace.protected);
      if (hit) {
        return {
          problem:
            `seat ${seat.name} would start in ${seat.cwd}, inside the protected checkout ${hit}; ` +
            (seat.mode === 'shared'
              ? 'a shared seat never works in a protected checkout'
              : "a seat that isn't `mode: shared` never starts in one"),
        };
      }
    }
    if (team.workspace.path) {
      const folder = team.workspace.path.split('/').slice(0, -1).join('/').replaceAll('{repo}', team.project) || '.';
      const hit = protectedLanding(root, folder, team.workspace.protected);
      if (hit) {
        return {
          problem:
            `seat ${seat.name} workspace would land in ${folder}, inside the protected checkout ${hit}; ` +
            'worktrees never land in a protected checkout',
        };
      }
    }
    // `.` is this project, which is where a lead starts. The check is whether that root
    // physically lands inside some other protected checkout.
    if (isLeadSeat(team, seat.name)) {
      const others = team.workspace.protected.filter((checkout) => checkout !== '.');
      const hit = others.length > 0 ? protectedLanding(root, '.', others) : null;
      if (hit) {
        return {
          problem:
            `seat ${seat.name} would start in the project, inside the protected checkout ${hit}; ` +
            'a lead never starts in one',
        };
      }
      return { cwd: root };
    }
    // An explicit cwd in the file is where any other seat starts too (never the lobby). The
    // loader already refused one outside trust or behind a symlink, and the protected-checkout
    // check above has run on it. `.` is the default for an absent cwd, so it means "not set".
    if (seat.cwd !== '.') return { cwd: resolve(root, seat.cwd) };
    return { cwd: verifiedLobby ?? lobbyOf(home, root, team), lobby: true };
  }

  return { problem: 'trust configuration is invalid', once: true };
}

// The first name a public project's forbidden_public pattern matches, as "name matches pattern".
export function publicNameHit(team: Pick<TeamFile, 'visibility' | 'identity'>, names: string[]): string | null {
  if (team.visibility !== 'public') return null;
  for (const source of team.identity.forbiddenPublic) {
    let regex: RegExp;
    try {
      regex = new RegExp(source);
    } catch (error) {
      return `forbidden_public pattern ${JSON.stringify(source)} is not a regular expression: ${(error as Error).message}`;
    }
    for (const name of names) {
      if (regex.test(name)) return `${JSON.stringify(name)} matches forbidden_public ${JSON.stringify(source)}`;
    }
  }
  return null;
}
