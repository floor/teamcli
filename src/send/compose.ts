import { NO_PANE_MESSAGING } from './no-pane-messaging.ts';
// A compose delivery would have the profile's own module walk the CLI's screens and type the
// brief where the CLI asks for it. That is pane messaging, so it is never run: the entry point
// refuses the delivery before the module sees the pane, and the send reports the seat as
// unreachable. The caller keeps the seat lock, writes the drop record and the history.
import type { ComposeProfile } from '../profiles/compose.ts';
import type { NativePane } from './native.ts';

/** What one compose delivery names besides the pane. The send glue still builds it. */
export type ComposeRun = {
  profile: ComposeProfile;
  /** The profile's launch binary, for listing repos. */
  binary: string;
  session: string;
  pane: string;
  /** The folder the seat's record carries, used when the pane names none. */
  seatCwd: string;
  /** The profile's idle timeout in seconds. */
  idleTimeout: number;
  /** The brief, whole: rules and sender header included. */
  message: string;
};

/** The send's three outcomes, in the words the walk already reports. */
export type ComposeResult =
  | { outcome: 'delivered'; evidence: string }
  | { outcome: 'not-submitted'; reason: string }
  | { outcome: 'unreachable'; reason: string };

/** `owner/repo` from a git remote URL, or null. Both the scp form
 *  (`git@github.com:owner/repo.git`) and a URL (`https://github.com/owner/repo.git`,
 *  `ssh://git@github.com/owner/repo`) end at the same two path segments. */
export function repoFromUrl(url: string): string | null {
  const match = /[:/]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match === null ? null : match[1]!;
}

/**
 * A compose delivery is refused: a compose box is never typed into, so the module never runs and
 * nothing is submitted. The walk reports it as unreachable and carries the rule's reason.
 */
export async function deliverCompose(native: NativePane, run: ComposeRun): Promise<ComposeResult> {
  void native;
  void run;
  return { outcome: 'unreachable', reason: NO_PANE_MESSAGING };
}
