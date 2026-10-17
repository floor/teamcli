import { minutes, type Report, type SeatCheck } from '../check.ts';

// A seat that has stopped: quiet, with no running turn, no prompt and no unsent text. The
// duration counts from the last moment it was seen working. A seat never seen working was already
// idle when the watch started: it is reported that way, with no duration from another source.
//
// Two liveness defaults drive it. At `liveness.idle_lead_seconds` the lead is told; at
// `liveness.idle_owner_seconds` the owner is told, once per idle period. The lead's report is
// repeated every `watch.idle_repeat` when that is set; the owner's is not — it is an escalation,
// not a reminder. A seat that works, or shows a prompt, starts a new period and reports again.
// The leads and parked seats are reported on, but their idle time is not the team's: skipped.
export const idle: SeatCheck = {
  name: 'idle',
  run(seat, ctx) {
    const told = ctx.memory<Record<string, { lead?: number; owner?: number }>>('idle', () => ({}));
    if (!seat.running) return [];
    if (!seat.quiet || seat.working || seat.prompt) {
      delete told[seat.name];
      return [];
    }
    if (seat.lead || seat.parked) return [];
    const worked = seat.history.lastWorking;
    const since = ctx.now - (worked ?? seat.history.idleSince ?? ctx.now);
    const mine = (told[seat.name] ??= {});
    const line = worked === undefined
      ? `${seat.name} has been idle since the watch started`
      : `${seat.name} has been idle for ${minutes(since)} minutes`;
    const reports: Report[] = [];
    if (since >= ctx.liveness.idle_lead_seconds * 1000
      && (mine.lead === undefined || (ctx.watch.idleRepeat !== undefined && ctx.now - mine.lead >= ctx.watch.idleRepeat * 1000))) {
      mine.lead = ctx.now;
      reports.push({ key: `idle:${seat.name}`, text: line, to: 'operator' });
    }
    if (since >= ctx.liveness.idle_owner_seconds * 1000 && mine.owner === undefined) {
      mine.owner = ctx.now;
      reports.push({ key: `idle-owner:${seat.name}`, text: `${line} — reported to the owner`, to: 'owner' });
    }
    return reports;
  },
};
