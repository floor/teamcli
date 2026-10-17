// Line 2 of a running seat, the watch's side: the file's display and effort, replaced by a model
// or an effort the pane actually shows. The observation itself lives in `labels/observe.ts` —
// this module is the watch's name for it, so the pass, the sweep between passes and the tests
// read one function. A screen this version cannot read keeps the file's display — never the
// CLI's name. The effort word, once seen, stays until a later screen shows a different one.
import { observeLabel, type LabelSeat } from '../labels/observe.ts';

export type { LabelSeat };

/** The display_agent line for one seat this pass, and the effort word the screen showed, when
 *  it showed one. Absence of that word is not a value: the caller keeps the last word it saw. */
export function liveDisplayAgent(
  seat: LabelSeat,
  screen: string | undefined,
  rememberedEffort?: string,
): { line: string; effort?: string } {
  return observeLabel(seat, screen, rememberedEffort);
}
