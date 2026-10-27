// The session a team runs in, when the definition does not name one.
//
// A definition that omits `session:` used to be given `<entity>-<project>`, or the project name
// alone. That derivation is wrong once the registry has already recorded the session: a team
// whose registry entry says `docs` must not be addressed as `floor-docs` because the definition
// never wrote the key. The file fallback and a migrated config record both apply this — the
// stored text often still omits `session:`, and reading it back as `<entity>-<project>` sends
// `up`, `send`, `status` and `restart` at a herdr session the crew is not in. An explicit
// `session:` is the definition's own word and is left as written. `--file` does not apply it:
// the file it names is read as written.

import { getTeam, teamIdOf, TeamsError } from '../registry/teams.ts';
import { parseYaml } from '../yaml.ts';
import type { TeamFile } from './types.ts';

/** Whether the definition writes a top-level `session:` key. A key that does not parse is not
 *  a declaration: the caller keeps the session the validator derived. */
export function textDeclaresSession(text: string): boolean {
  try {
    const node = parseYaml(text);
    return node.kind === 'map' && node.entries.some((entry) => entry.key === 'session');
  } catch {
    return false;
  }
}

/** The registry's team for this root, or null when the registry does not list it or cannot be
 *  read. A registry that cannot be read is not "unlisted": the caller treats it as unknown. */
export function listedTeam(home: string, root: string): { session: string } | null | undefined {
  try {
    const team = getTeam(home, teamIdOf(root));
    if (team === null) return null;
    return { session: team.session };
  } catch (error) {
    if (error instanceof TeamsError) return undefined;
    throw error;
  }
}

/** The session the registry records for this root, when it lists the team and the session is
 *  one a team may run in. */
export function recordedSession(home: string, root: string): string | null {
  const listed = listedTeam(home, root);
  if (listed === null || listed === undefined) return null;
  if (listed.session === '' || listed.session === 'default') return null;
  return listed.session;
}

/** The team with the registry's session, when the definition declares none and the registry
 *  records one. A derived `<entity>-<project>` that is not the recorded session is not kept.
 *  The grant's session is the team's, so a grant that named the derived session moves with it. */
export function withRecordedSession(team: TeamFile, text: string, home: string, root: string): TeamFile {
  if (textDeclaresSession(text)) return team;
  const recorded = recordedSession(home, root);
  if (recorded === null || recorded === team.session) return team;
  const grant = team.grant !== null && team.grant.session === team.session
    ? { ...team.grant, session: recorded }
    : team.grant;
  return { ...team, session: recorded, grant };
}
