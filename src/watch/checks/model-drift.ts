import { modelDiffers } from '../../status/statusline.ts';
import { reported, type SeatCheck } from '../check.ts';

// A seat that runs a model other than the one the file declares: what it signs with is not what
// the owner approved. A temporary seat has no file model, and a screen the profile cannot read is
// unread, never a mismatch.
export const modelDrift: SeatCheck = {
  name: 'model-drift',
  run(seat, ctx) {
    const file = seat.seat;
    const running = seat.model;
    const baseline = seat.signing === undefined ? file : seat.signing;
    if (!baseline || !modelDiffers(running, baseline)) return [];
    const repair = seat.lead
      ? 'team down, then team up (to restart the whole team)'
      : `team remove ${seat.name} --keep, then team add ${seat.name}`;
    return reported(ctx.once(
      `model:${seat.name}`,
      `${seat.name} runs ${running.model} ${running.version}; the registry says ${baseline.model} ${baseline.version}: it signs with the wrong model — ${repair}`,
    ));
  },
};
