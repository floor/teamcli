import { reported, type SeatCheck } from '../check.ts';

// A declared seat of this team whose vendor the entity's model rule refuses (Policies rule 10):
// reported once, naming the rule, the seat's vendor and the swap the rule proposes — or why
// there is none. The same breach list `team check` prints, narrowed to this team. The screen's
// own contradiction of the file is model-drift's, and a temporary seat signs with no file model.
export const modelRule: SeatCheck = {
  name: 'model-rule',
  run(seat, ctx) {
    if (!seat.seat || !seat.rule) return [];
    const action = seat.rule.proposal !== null
      ? `a swap to ${seat.rule.proposal} is proposed`
      : (seat.rule.reason ?? 'no recipe is available');
    return reported(ctx.once(
      `model-rule:${seat.name}`,
      `${seat.name}: declares vendor ${seat.rule.vendor}, which the entity model rule ${seat.rule.rule} refuses; ${action}`,
    ));
  },
};
