// The lobby a team operates on in one session, once the registry has seen it. `resolveLobby`
// derives from the file on every call, so editing a running team's `entity` silently moved its
// lobby — the seats' working folder and the trust entry with it. Once the registry holds a
// session's lobby, the entity never derives it again: the recorded path stands, and only a
// session the registry holds no lobby for derives from its entity. An explicit `lobby:` stays
// the owner's own declaration rather than a derivation: it still wins, and the next note
// records it.
//
// The record keeps one entry per session (`TeamRecord.lobbies`). The registry is keyed by the
// root, so two team files can share one checkout, and `up --session alt` speaks for another
// session than the file names: each session records its own lobby and never takes another's
// entry away. The caller passes the session it acts on — `team.session` for a file, or the
// `--session` it was given — so every command reads the entry for the session it addresses.
import { getTeam, teamIdOf, TeamsError } from '../registry/teams.ts';
import { resolveLobby, type LobbyConfig } from './gate.ts';

export type LobbySeed = LobbyConfig & { project?: string; session?: string | null };

export function lobbyOf(home: string, root: string, seed?: LobbySeed): string {
  if (seed?.lobby) return resolveLobby(home, { lobby: seed.lobby });
  let recorded = '';
  try {
    const team = getTeam(home, teamIdOf(root));
    if (team !== null && seed?.session) recorded = team.lobbies[seed.session] ?? '';
  } catch (error) {
    // An unreadable registry cannot say where the team's lobby is, so the file's own derivation
    // stands; the commands that use the registry name its corruption themselves.
    if (!(error instanceof TeamsError)) throw error;
  }
  if (recorded) return recorded;
  return resolveLobby(home, seed);
}
