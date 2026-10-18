// The label sweep between passes: a running seat's status line reaches line 2 in about five
// seconds — the pace the CLI changes under the owner's hand — rather than a whole watch
// interval. The pass stays the authority: it paints both lines from one whole read, and this
// sweep repeats the pass's own rule — the same seats, the same memory, the same line — on the
// panes the last live read named. A line already remembered reports nothing, so a quiet fleet
// costs one pane read per seat per tick and no output. Observed ≠ file is the label's business
// only: nothing here writes the file, and a seat whose observed value differs is reported by the
// pass's own checks, not by the sweep.
import type { LabelSeat } from '../labels/observe.ts';
import { observeLabel } from '../labels/observe.ts';
import type { Memory } from './pass.ts';

export type SweptLabel = { name: string; pane: string; line: string };

/** A file seat as the sweep needs it: the name to match the agent, and what line 2 is built
 *  from. A whole `Seat` satisfies this. */
export type SweepSeat = LabelSeat & { name: string };

export function labelSweep(input: {
  seats: readonly SweepSeat[];
  /** The agents the last whole read named — the pass's live view, not a fresh one. An agent
   *  herdr gave no name for is no file seat and is skipped, as the pass skips it. */
  agents: readonly { name?: string | null; pane: string }[];
  memory: Memory;
  /** One pane's text as it reads now: the reading line 2 is built from. */
  read: (pane: string) => string | null | undefined;
  /** Line 2 of the pane's label; false leaves the memory untouched, as the pass does. */
  report: (pane: string, text: string) => boolean;
}): { reported: SweptLabel[]; failed: SweptLabel[] } {
  const { seats, agents, memory, read, report } = input;
  const reported: SweptLabel[] = [];
  const failed: SweptLabel[] = [];
  for (const agent of agents) {
    if (!agent.name) continue;
    const seat = seats.find((one) => one.name === agent.name);
    if (!seat) continue;
    const slot = (memory.seatLabels[seat.name] ??= {});
    const live = observeLabel(seat, read(agent.pane) ?? undefined, slot.effort);
    if (live.effort) slot.effort = live.effort;
    if (slot.line === live.line) continue;
    const swept = { name: seat.name, pane: agent.pane, line: live.line };
    if (report(agent.pane, live.line)) {
      slot.line = live.line;
      reported.push(swept);
    } else {
      failed.push(swept);
    }
  }
  return { reported, failed };
}
