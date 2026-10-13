import type { SeatCheck } from '../check.ts';

// A seat the file holds that no agent answers for. A stopped seat is not started: absent from
// herdr is its normal state, and draws nothing. And when the session itself doesn't answer, every
// seat is absent for the same reason — the watch reports none of them.
//
// A seat this watch has seen running is not the same condition as one it never saw: the line tells
// which. A state stage of `named` or `ready` counts as having run, even when no pass saw the
// agent — the seat was named and then gone between passes. `launched` does not. The told mark
// is the sentence last given, and it drops when the seat is seen running again, so a later
// disappearance is reported, and so is "gone" after an earlier "not running".
export const missing: SeatCheck = {
  name: 'missing',
  run(seat, ctx) {
    const seen = ctx.memory<Record<string, true>>('missing-seen', () => ({}));
    const told = ctx.memory<Record<string, 'absent' | 'gone'>>('missing-told', () => ({}));
    if (seat.running) {
      seen[seat.name] = true;
      delete told[seat.name];
      return [];
    }
    if (seat.stopped || !seat.herdr) {
      delete told[seat.name];
      return [];
    }
    const wasRunning = Boolean(seen[seat.name]) || seat.recorded === 'named' || seat.recorded === 'ready';
    if (wasRunning) seen[seat.name] = true;
    const kind = wasRunning ? 'gone' : 'absent';
    if (told[seat.name] === kind) return [];
    told[seat.name] = kind;
    return [{
      key: `missing:${seat.name}`,
      text: wasRunning
        ? `${seat.name} was running and is gone (its pane closed, or its CLI ended)`
        : `${seat.name} is in the file and is not running`,
      to: 'operator',
    }];
  },
};
