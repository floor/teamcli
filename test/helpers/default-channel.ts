import { isLeadSeat } from '../../src/file/sections/lead.ts';
import { mkdirSync } from 'node:fs';
import { loadTeamFile } from '../../src/file/load.ts';
import { lobbyOf } from '../../src/lobby/recorded.ts';
import { planChannelPair, publishChannelPair } from '../../src/mcp/launch-config.ts';
import { findAgent } from '../../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../../src/registry/teams.ts';

/** Default launch/resume fixtures keep a unique registered root and the same declared roster/lobby. */
export function registerDefaultChannelFixture(root: string, home: string, projectSeat?: string): void {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error('the default-channel fixture must load');
  const team = loaded.team;
  const lobby = lobbyOf(home, root, team);
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  upsertTeam(home, teamIdOf(root), {
    root, project: team.project, session: team.session, lobby,
    lobbies: { [team.session]: lobby },
    roster: team.seats.map((seat, index) => ({
      agent: findAgent(home, { team: teamIdOf(root), seat: seat.name })?.id ?? `agt_${String(index + 1).padStart(12, '0')}`,
      seat: seat.name, role: seat.role, leads: isLeadSeat(team, seat.name),
    })),
  });
  if (projectSeat !== undefined) {
    // A lead keeps its project cwd and therefore needs its own project pair before planning.
    const prepared = publishChannelPair(planChannelPair({ root, cwd: root, seat: projectSeat, session: team.session }, false), () => {});
    if (!prepared.ok) throw new Error(prepared.reason);
    prepared.lease.check();
    prepared.lease.release();
  }
}
