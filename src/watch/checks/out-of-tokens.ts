// A seat whose live screen is out of tokens. One message to its lead — the seat, the vendor,
// what it was holding — and the seat marked unavailable so send and review routing skip it.
// The automatic swap is the hook and nothing else: this check does not restart the seat.
import { reported, type SeatCheck } from '../check.ts';
import {
  heldWork,
  recordTokenMark,
  tokenLeadLine,
  tokenSwapHook,
} from '../../quota/token-fallback.ts';

export const outOfTokens: SeatCheck = {
  name: 'out-of-tokens',
  run(seat, ctx) {
    const tokens = seat.running && !seat.working && seat.screen.kind === 'rate limit' && seat.screen.reason === 'out of tokens';
    const dir = seat.agentsDir;
    if (!tokens) {
      if (dir !== undefined) recordTokenMark(dir, seat.name, null);
      return [];
    }
    const held = heldWork(seat.role);
    // The swap waits here. Nothing is written to the seat and nothing is re-sent.
    tokenSwapHook({ seat: seat.name, vendor: seat.vendor, held });
    if (dir !== undefined) {
      recordTokenMark(dir, seat.name, { vendor: seat.vendor, held, at: ctx.now });
    }
    const text = tokenLeadLine(seat.name, seat.vendor, held);
    return [...reported(ctx.once(`out-of-tokens:${seat.name}`, text, 'orchestrator'))];
  },
};
