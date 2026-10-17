import { WATCH_LABEL } from '../../status/compare.ts';
import { reported, type Report, type TeamCheck } from '../check.ts';

// An agent herdr lists in a pane no seat of the file answers for: started outside the team, and
// nobody's. The watch's own workspace is the watch itself, and never extra.
export const extra: TeamCheck = {
  name: 'extra',
  run(team, ctx) {
    const labels = new Map(team.live.workspaces.map((workspace) => [workspace.id, workspace.label]));
    const reports: Report[] = [];
    for (const agent of team.live.agents) {
      if (team.known.has(agent.pane) || labels.get(agent.workspace) === WATCH_LABEL) continue;
      const report = ctx.once(
        `extra:${agent.pane}`,
        `${agent.name ?? `an unnamed ${agent.agent ?? 'agent'}`} (${agent.pane}) is running and is not in the file`,
      );
      if (report) reports.push(report);
    }
    return reports;
  },
};
