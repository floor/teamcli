import { resolve } from 'node:path';
import { defaultFs, lobbyTrustEntry, type FsReader } from '../lobby/gate.ts';
import { lobbyOf } from '../lobby/recorded.ts';
import { absoluteTrustProblem, fixedFolder, insideProject } from './paths.ts';
import type { TeamFile } from './types.ts';

/** The keys of the file the block is computed from — `seatStart`'s own Pick, so every printer
 *  passes the team it already holds. The lobby entry it suggests is the one the registry records
 *  for the team's session (`src/lobby/recorded.ts`), which `entity` and `lobby` derive only
 *  before a registration. `session` names the session a run addresses, when it is not the file's
 *  own: a printer passes the team it is about to launch spread with the run's session. */
export type MigrationTeam = Pick<TeamFile, 'project' | 'workspace' | 'trust' | 'seats' | 'entity' | 'lobby' | 'session'>;

/** One entry the migrated file's trust lists, and the key of the file it comes from. */
export type TrustSuggestion = { entry: string; from: string };

/** An entry the next launch needs but a rule of trust refuses — the home, an ancestor of the
 *  project, of the lobby or of the store. Never suggested: the key that forces it is named, and
 *  the owner chooses the folder. */
export type TrustRefusal = { key: string; entry: string; why: string };

export type MigrationTrust = { suggestions: TrustSuggestion[]; refusals: TrustRefusal[] };

// What `init` wrote before this release, uncommented by the owner: the project itself and the
// worktrees folder beside it. Both are replaced by entries computed from the file's own keys.
const legacyInitEntries = (project: string): readonly string[] => ['.', `../worktrees/${project}/*`];

/**
 * Every entry the next `up` will require of a legacy file's trust, computed from the file —
 * never guessed — and checked against the same rule the validator applies, so that pasting the
 * block as printed passes validation. Each entry names the key it comes from; nothing the block
 * lists widens what the old file trusted: every old relative entry is either replaced by one of
 * these or kept in its absolute form.
 */
export function migrationTrust(team: MigrationTeam, root: string, home: string, fs: FsReader = defaultFs): MigrationTrust {
  const suggestions: TrustSuggestion[] = [];
  const refusals: TrustRefusal[] = [];
  const old = team.trust ?? [];
  const landing = (folder: string): string => resolve(root, folder);
  const add = (entry: string, from: string, key: string): void => {
    const why = absoluteTrustProblem(entry, home, fs, root);
    if (why) refusals.push({ key, entry, why });
    else suggestions.push({ entry, from });
  };

  // The lobby this team's session operates on — the one the registry records, the file's
  // derivation before there is a record — so the entry must be the one every reader resolves:
  // `lobbyOf` here, `placedProblems` and `seatStart` on the other side. A block computed from
  // the entity alone named a folder a recorded team never starts in, and pasting it failed the
  // placement check.
  const lobby = lobbyOf(home, root, team);
  suggestions.push({
    entry: lobbyTrustEntry(home, { lobby }),
    from:
      team.entity || team.lobby
        ? 'the team\'s lobby, where its seats start now'
        : 'the machine lobby, where every seat starts now',
  });

  const initEntries = legacyInitEntries(team.project);
  const replaced = new Set<string>();
  if (old.includes('.')) replaced.add('.');
  suggestions.push({
    entry: root,
    from: `the project root${old.includes('.') ? ', replacing "."' : ''}`,
  });

  // The folder workspace.path places worktrees in — the old pattern's fixed folder, no wider.
  // A folder inside the project needs no entry of its own (the root entry covers it); the load's
  // own refusal names that shape for a migrated file, so the block stays quiet about it.
  if (team.workspace.path) {
    const template =
      team.workspace.path.split('/').slice(0, -1).join('/').replaceAll('{repo}', team.project) || '.';
    if (!insideProject(template)) {
      const folder = landing(template);
      const pattern = old.find((one) => landing(fixedFolder(one)) === folder);
      if (pattern) replaced.add(pattern);
      add(
        folder,
        `the folder workspace.path "${team.workspace.path}" places worktrees in${pattern ? `, replacing "${pattern}"` : ''}`,
        `workspace.path "${team.workspace.path}"`,
      );
    }
  }

  for (const seat of team.seats) {
    if (seat.stopped || seat.cwd === '.' || insideProject(seat.cwd)) continue;
    const folder = landing(seat.cwd);
    if (suggestions.some((one) => one.entry === folder)) continue;
    const pattern = old.find((one) => landing(fixedFolder(one)) === folder);
    if (pattern) replaced.add(pattern);
    add(
      folder,
      `where seat ${seat.name}'s cwd "${seat.cwd}" starts${pattern ? `, replacing "${pattern}"` : ''}`,
      `seat ${seat.name}: cwd "${seat.cwd}"`,
    );
  }

  // Entries the owner added by hand: kept, in absolute form. What init wrote is replaced above.
  for (const pattern of old) {
    if (replaced.has(pattern) || initEntries.includes(pattern)) continue;
    const folder = landing(fixedFolder(pattern));
    const held = suggestions.find((one) => one.entry === folder);
    if (held) {
      held.from += `, and your own "${pattern}"`;
      continue;
    }
    add(folder, `your own "${pattern}" entry, kept in absolute form`, `trust: "${pattern}"`);
  }

  return { suggestions, refusals };
}

/**
 * The trust block a legacy file's owner pastes, as `up`, `add`, `doctor` and a seat's start
 * problem print it: the entries, one line saying where each comes from, and one line for every
 * entry team cannot suggest.
 */
export function migrationText(team: MigrationTeam, root: string, home: string, fs: FsReader = defaultFs): string {
  const { suggestions, refusals } = migrationTrust(team, root, home, fs);
  const from = suggestions.map((one) => `${one.entry} is ${one.from}`).join('; ');
  return [
    'trust:',
    ...suggestions.map((one) => `  - ${one.entry}`),
    from,
    ...refusals.map((one) =>
      `${one.key} would need ${one.entry}, which ${one.why}; team cannot choose it for you: pick a folder yourself and write it into trust`
    ),
  ].join('\n');
}

