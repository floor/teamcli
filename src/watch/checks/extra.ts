import { modelRuleAllowsUnclaimed } from '../../policy/model-rule.ts';
import { watchLabel } from '../pane.ts';
import { type Report, type TeamCheck } from '../check.ts';

// An agent herdr lists in a pane no seat of the file answers for: started outside the team, and
// nobody's. The watch's own workspace is the watch itself, and never extra. A pane whose screen
// names a model of a lab the entity model rule refuses for an unclaimed seat is reported for
// that too — to its lead, the operator channel the other reports use — and never closed, since
// it may be doing work someone started by hand (OD-20261019-03). Only a model a shipped profile
// can read is judged; an unread pane stays the existing extra report.
export const extra: TeamCheck = {
  name: 'extra',
  run(team, ctx) {
    const labels = new Map(team.live.workspaces.map((workspace) => [workspace.id, workspace.label]));
    const reports: Report[] = [];
    for (const agent of team.live.agents) {
      if (team.known.has(agent.pane) || labels.get(agent.workspace) === watchLabel(team.team.project)) continue;
      const label = `${agent.name ?? `an unnamed ${agent.agent ?? 'agent'}`} (${agent.pane})`;
      const report = ctx.once(`extra:${agent.pane}`, `${label} is running and is not in the file`);
      if (report) reports.push(report);
      const pane = team.paneModels.get(agent.pane);
      if (pane === undefined || team.modelRule === null || !team.modelRule.ok) continue;
      if (modelRuleAllowsUnclaimed(team.modelRule.entries, pane.lab)) continue;
      const breach = ctx.once(
        `model-rule:extra:${agent.pane}`,
        `${label} runs ${pane.model} ${pane.version}, of the lab ${pane.lab}, which the entity model rule ${team.modelRule.rule} refuses for an unclaimed seat — reported, never closed`,
      );
      if (breach) reports.push(breach);
    }
    return reports;
  },
};
