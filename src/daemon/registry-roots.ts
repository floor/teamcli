// Which team folders the machine daemon hosts when its unit names none. The registry is the list:
// a team whose lifecycle is `running`, and no other. `team start` writes that record and then
// sends `root.added`; the heartbeat reads this same set, so a notice that never arrives still
// lands on the next beat. A defined, stopped or archived team is not hosted from here.

import { readTeamConfig } from '../file/team-config.ts';
import { readStoredTeamConfig } from '../registry/team-config-store.ts';
import { canonicalRoot } from './routes.ts';

export type RegistryRoot = { root: string; source: 'registry' };

type RegistryTeam = { root: string; lifecycle: string; lobby?: string; project?: string; session?: string; entity?: string | null };
export type SkippedRegistryTeam = { id: string; team: string; session: string; lobby: string; why: string };
export type RegistryHosting = { roots: RegistryRoot[]; skipped: SkippedRegistryTeam[] };

const folderKey = (path: string): string => canonicalRoot(path) ?? path;

/** A lobby-only row and a rooted row with the same recorded run describe one team. Names
 * alone are insufficient: unrelated teams can share a name or a machine-global lobby. */
function sameRun(a: RegistryTeam, b: RegistryTeam): boolean {
  return !!a.project && !!a.session && !!a.lobby && a.project === b.project
    && a.session === b.session && a.entity === b.entity && !!b.lobby
    && folderKey(a.lobby) === folderKey(b.lobby);
}

/** Resolve lobby-only teams through the ordinary configuration reader, never by interpreting
 * the lobby as the daemon's working directory. A stored definition can recover a missing
 * registry root; otherwise the lobby itself can be the team's plain-folder root. Failures stay
 * named rather than silently disappearing from the hosted set. */
export function registryHosting(teams: Readonly<Record<string, RegistryTeam>>, home?: string): RegistryHosting {
  const running = Object.entries(teams).filter(([, team]) => team.lifecycle === 'running');
  const rooted = running.filter(([, team]) => team.root !== '');
  const roots = new Set(rooted.map(([, team]) => folderKey(team.root)));
  const skipped: SkippedRegistryTeam[] = [];
  for (const [id, team] of running) {
    if (team.root !== '') continue;
    if (rooted.some(([, other]) => {
      if (!sameRun(team, other)) return false;
      if (home === undefined) return true;
      try {
        const loaded = readTeamConfig(other.root, { home });
        return loaded.ok && loaded.team.project === team.project && loaded.team.session === team.session
          && loaded.team.entity === team.entity;
      } catch { return false; }
    })) continue;
    const skip = (why: string): void => {
      skipped.push({ id, team: team.project ?? id, session: team.session ?? '', lobby: team.lobby ?? '', why });
    };
    const candidates = new Set<string>();
    if (home !== undefined) {
      try {
        const stored = readStoredTeamConfig(home, id);
        if (stored?.root) candidates.add(stored.root);
      } catch {
        skip('the registered team definition cannot be read');
        continue;
      }
    }
    // A lobby can be shared by unrelated teams. Another row for this same recorded run
    // can retain its checkout even when only the lobby-only row is marked running. Use
    // that recorded location, then validate its identity through the ordinary reader.
    for (const other of Object.values(teams)) {
      if (other.root !== '' && sameRun(team, other)) candidates.add(other.root);
    }
    if (team.lobby) candidates.add(team.lobby);
    if (candidates.size === 0) {
      skip('no root or lobby is recorded');
      continue;
    }
    let root: string | undefined;
    let why = 'the recorded folder has no readable team configuration';
    for (const candidate of candidates) {
      if (home === undefined) { root = folderKey(candidate); break; }
      let loaded: ReturnType<typeof readTeamConfig>;
      try { loaded = readTeamConfig(candidate, { home }); }
      catch {
        why = 'the recorded folder team configuration cannot be read';
        continue;
      }
      if (!loaded.ok) {
        continue;
      }
      if ((team.project !== undefined && loaded.team.project !== team.project)
        || (team.session !== undefined && loaded.team.session !== team.session)
        || (team.entity !== undefined && loaded.team.entity !== team.entity)) {
        why = 'the recorded folder belongs to a different team or session';
        continue;
      }
      const canonical = canonicalRoot(loaded.root);
      if (canonical === null) {
        why = 'the recorded team folder cannot be resolved';
        continue;
      }
      root = canonical;
      break;
    }
    if (root === undefined) skip(why);
    else roots.add(root);
  }
  return { roots: [...roots].sort().map((root) => ({ root, source: 'registry' as const })), skipped };
}

/** Every checkout a running registry team names, once each, in path order. */
export function runningRegistryRoots(teams: Readonly<Record<string, RegistryTeam>>, home?: string): RegistryRoot[] {
  return registryHosting(teams, home).roots;
}

/**
 * The set a `root.added` notice asks the daemon to host. Null when the line is not that notice.
 * A checkout the registry does not mark `running` is left out: the notice does not host a team
 * the record does not, and the next heartbeat reads the record again.
 */
export function rootsFromAddedNotice(
  teams: Readonly<Record<string, RegistryTeam>>,
  notice: { op?: string; root?: string },
): RegistryRoot[] | null {
  if (notice.op !== 'root.added') return null;
  if (typeof notice.root !== 'string' || notice.root === '') return null;
  return runningRegistryRoots(teams);
}
