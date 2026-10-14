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
    if (seat.identity === 'unknown') {
      ctx.keep(key);
      return [];
    }
    // The stored agent session is on this pane: the seat came back. Not a report.
    if (seat.continuity === 'restored') return [];
    if (seat.identity !== 'gone' && seat.identity !== 'replaced') return [];
    return reported(
      ctx.once(
        key,
        `${seat.name} is no longer the process team launched (its session was restored, or its CLI was restarted)`,
      ),
    );
  },
};
