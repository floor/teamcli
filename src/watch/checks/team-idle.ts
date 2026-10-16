import type { TeamCheck, TeamObservation } from '../check.ts';

export function idleQueueSummary(team: TeamObservation): { key: string; text: string } | null {
  if (!team.queueDepths) return null;
  const workers = team.seats.filter((seat) => !seat.lead && !seat.parked && !seat.stopped);
  if (!workers.length || workers.some((seat) => !seat.running || team.queueDepths?.[seat.name] !== 0)) return null;
  const idle = workers.filter((seat) => seat.quiet && !seat.working && seat.screen.kind === 'idle'
    && seat.identity !== 'gone' && (seat.identity !== 'replaced' || seat.continuity === 'restored'));
  if (!idle.length) return null;
  const limited = workers.filter((seat) => !seat.working && seat.screen.kind === 'rate limit').map((seat) => seat.name);
  // Claimable backlog work is named in the same sentence: the queues are empty, but the team is
  // not out of work, and this report is the moment the orchestrator refills them. An unreadable
  // or absent backlog file adds nothing, and the sentence's own words are unchanged.
  const backlog = team.queueBacklog ?? 0;
  return {
    key: JSON.stringify([team.team.orchestrator, team.team.watch.queueDir, idle.map((seat) => seat.name), limited]),
    text: `${idle.length} ${idle.length === 1 ? 'seat' : 'seats'} idle, queues empty`
      + `${limited.length ? `; at a quota or limit: ${limited.join(', ')}` : ''}`
      + `${backlog > 0 ? `; ${backlog} unclaimed backlog item${backlog === 1 ? '' : 's'}` : ''}`,
  };
}

// Every worker idle at once, reported once per idle stretch, after `team_idle`. A worker that
// works again re-arms it. The leads and parked seats never count as the team's workers.
export const teamIdle: TeamCheck = {
  name: 'team-idle',
  run(team, ctx) {
    const memory = ctx.memory<{ since: number | null; told: boolean }>('team-idle', () => ({ since: null, told: false }));
    if (team.queueDepths) {
      memory.since = null;
      memory.told = false;
      const summary = idleQueueSummary(team);
      const slot = ctx.memory<{ key: string | null; since: number; told: boolean }>('queue-idle', () => ({ key: null, since: ctx.now, told: false }));
      if (slot.key !== (summary?.key ?? null)) {
        slot.key = summary?.key ?? null;
        slot.since = ctx.now;
        slot.told = false;
      }
      if (!summary || slot.told || ctx.now - slot.since < ctx.watch.teamIdle * 1000) return [];
      slot.told = true;
      return [{ key: 'queue-idle', text: summary.text, to: 'orchestrator' }];
    }
    // Reconfiguring queues starts a fresh reporting period.
    const queueSlot = ctx.memory<{ key: string | null; since: number; told: boolean }>('queue-idle', () => ({ key: null, since: ctx.now, told: false }));
    queueSlot.key = null;
    queueSlot.told = false;
    if (!team.workers.length || !team.workers.every((worker) => worker.idle)) {
      memory.since = null;
      memory.told = false;
      return [];
    }
    memory.since ??= ctx.now;
    if (memory.told || ctx.now - memory.since < ctx.watch.teamIdle * 1000) return [];
    memory.told = true;
    return [{ key: 'team-idle', text: 'every agent is idle', to: 'operator' }];
  },
};
