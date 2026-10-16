import { processNameMatches } from '../clis.ts';

// Herdr reports a live agent when one foreground argv0 is that CLI. An unreadable
// pane, or the shell left after the CLI has exited, is not one: those are the panes
// a nudge, a first message, or an exit must not be typed into.
//
// Null is not a live agent, so nothing is typed, and the watch's quota read asks this
// same question: a figure is only read where the CLI was seen. `paneStillRunning`
// reads that same null as still there — an unreadable list is not a departure — and
// that reading is only for the departure wait in `down` and `remove`.
export function reportedLiveAgent(foreground: readonly string[] | null, processNames: readonly string[]): boolean {
  if (!foreground || processNames.length === 0) return false;
  return foreground.some((name) => processNameMatches(name, processNames));
}
