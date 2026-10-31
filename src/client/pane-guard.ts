// The client pane guard: a client key is the client's, never a seat's. Every client invocation
// (`team send --client`, `team messages --client`, `team client keygen`, and every
// grant-verified form such as `team up --client` or `team down --client`) is placed by the same
// parent-process walk the owner gates use (`walkCaller`), never by an environment variable, and a
// caller that runs inside a team pane — a seat, or any process a seat started — is refused before
// the grant or the key is opened. The walk guards against a mistaken agent, not a hostile one:
// every seat runs as the owner's user, so the key file itself stays readable by any same-user
// process outside the panes.
//
// This is a machine guard, and no dev-mode setting lifts it (OD-20261019-49): a lift would hand a
// seat's own process the key the guard exists to keep out of it, which is exactly the boundary the
// owner's widening left in place. Every mode refuses a pane caller alike; the repair is the
// client's own shell, outside the terminal host.

import { describeCaller, walkCaller, type Caller } from '../caller.ts';
import type { Io } from '../io.ts';

/** True when the walk placed the caller inside a team pane: a team seat or its children. */
export function insideTeamPane(caller: Caller): boolean {
  if (caller.kind === 'seat' || caller.kind === 'pane') return true;
  return caller.kind === 'unplaced' && /under herdr|in pane |herdr pane/.test(caller.reason);
}

/** The refusal sentence, one place, so send and messages read alike. */
export function clientPaneRefusal(caller: Caller): string {
  return `a client key is not used from inside a team pane; this call is ${describeCaller(caller)}. ` +
    "Run the client from outside the terminal host (the client's own shell)";
}

export type ClientPaneVerdict =
  | { ok: true }
  | { ok: false; why: string };

/** Whether this client invocation may go on. */
export function clientPaneGuard(io: Io): ClientPaneVerdict {
  const caller = walkCaller(io);
  if (!insideTeamPane(caller)) return { ok: true };
  return { ok: false, why: clientPaneRefusal(caller) };
}
