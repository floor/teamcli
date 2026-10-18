import { reported, type SeatCheck } from '../check.ts';

// A seat whose pane no longer holds the process team launched: its session was restored by
// something else, or its CLI was restarted by hand. Whatever runs in the pane now is not the
// seat — its model, account and rules are not the ones team delivered, and a brief sent to it
// would be done by another process. Reported at the first pass that reads it, and again only
// after the seat was the seat once more and stopped being it anew (the report-once rule).
export const restored: SeatCheck = {
  name: 'restored',
  run(seat, ctx) {
    const key = `restored:${seat.name}`;
    // A reading herdr can't give is no change: `unknown` keeps the mark (a failed read must not
    // make the same condition report twice). Only `same` — the seat is the seat again — clears
    // it, by neither reporting nor keeping.
    const launchKey = `launcher:${seat.name}`;
    if (seat.identity === 'unknown') {
      ctx.keep(key);
      ctx.keep(launchKey);
      return [];
    }
    const reports = [];
    // The stored agent session is on this pane: the seat came back. The generic line stays
    // quiet. A launch line that names a launcher is still said: the process is the CLI
    // without that program, and nothing here starts it again.
    if (seat.continuity !== 'restored' && (seat.identity === 'gone' || seat.identity === 'replaced')) {
      reports.push(ctx.once(
        key,
        `${seat.name} is no longer the process team launched (its session was restored, or its CLI was restarted)`,
      ));
    }
    if (seat.identity === 'replaced' && seat.launcher) {
      // A lead's own seat is never restarted alone, and the whole-team restart is not the
      // repair: the note says what the process is, with no command that stops the team.
      const line = seat.lead
        ? `${seat.name}: started by a launcher; team cannot tell its process from the one it launched`
        : `${seat.name}: its launch line starts a launcher, and the process in its pane is not the one team launched — team restart ${seat.name}`;
      reports.push(ctx.once(launchKey, line));
    }
    return reports.flatMap(reported);
  },
};
