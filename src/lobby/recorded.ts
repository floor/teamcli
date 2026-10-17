// The lobby a team operates on once the registry has seen it. `resolveLobby` derives from the
// file on every call, so editing a running team's `entity` silently moved its lobby — the seats'
// working folder and the trust entry with it. Once the registry holds a team's lobby, the entity
// never derives it again: the recorded path stands, and only a team the registry holds no lobby
// for derives from its entity. An explicit `lobby:` stays the owner's own declaration rather
// than a derivation: it still wins, and the next note records it.
//
// The registry is keyed by the root, and two team files can share one checkout, so a record
// describes this team when its project and session are the file's — the two fields the registry
// notes an identity under. A file whose project or session differs is another team in the same
// checkout and derives from its own entity, exactly as a team the registry holds no record of
// does. (One team's entity edit moves neither field, so the record it already holds stands.)
import { getTeam, teamIdOf, TeamsError } from '../registry/teams.ts';
import { resolveLobby, type LobbyConfig } from './gate.ts';

export type LobbySeed = LobbyConfig & { project?: string; session?: string | null };

export function lobbyOf(home: string, root: string, seed?: LobbySeed): string {
  if (seed?.lobby) return resolveLobby(home, { lobby: seed.lobby });
  let recorded = '';
  try {
    const team = getTeam(home, teamIdOf(root));
    if (team !== null && team.project === seed?.project && team.session === seed?.session) recorded = team.lobby;
  } catch (error) {
    // An unreadable registry cannot say where the team's lobby is, so the file's own derivation
    // stands; the commands that use the registry name its corruption themselves.
    if (!(error instanceof TeamsError)) throw error;
  }
  if (recorded) return recorded;
  return resolveLobby(home, seed);
}
