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

// The agent herdr attributes a pane to, read as the CLI the seat's profile declares. Herdr names
// an agent by kind, and the kind is a process name for every CLI but Cursor: its process is
// `cursor-agent`, and herdr lists the pane as `cursor` (measured 2026-11-05 on herdr 0.7.1
// against a live Grok 4.7 seat — the agent's `agent` read `cursor`, and its `agent_session`
// carried `source: "herdr:cursor"`). The profile's own `cli` is the other spelling of the same
// CLI, so either names it; any other kind is another agent's, and a reading carrying it is never
// this seat's. A null kind is no attribution at all, never a match: the callers decide what an
// unattributed pane means for them.
export function reportedAgentIsCli(
  agent: string | null,
  cli: string,
  processNames: readonly string[],
): boolean {
  if (!agent) return false;
  return agent === cli || processNameMatches(agent, processNames);
}
