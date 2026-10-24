// The client pane guard: a client key is the client's, never a seat's. Every client invocation
// (`team send --client`, `team messages --client`, `team client keygen`, and every
// grant-verified form such as `team up --client` or `team down --client`) is placed by the same parent-process walk the
// owner gates use (`walkCaller`), never by an environment variable, and a caller that runs inside
// a herdr pane — a seat, or any process a seat started — is refused before the grant or the key
// is opened. The walk guards against a mistaken agent, not a hostile one: every seat runs as the
// owner's user, so the key file itself stays readable by any same-user process outside herdr.
//
// The guard is a policy, not a hard-coded wall: the owner's dev mode lifts it, through the same
// `devModeOwnerLiftAtCwd` admission every owner-only gate shares (the orchestrator or a lead on
// its recorded pane, with dev mode on for its place). A lifted run prints the warning and goes on.

import { homedir } from 'node:os';
import { describeCaller, walkCaller, type Caller } from '../caller.ts';
import { devModeOwnerLiftAtCwd } from '../dev_mode.ts';
import type { Io } from '../io.ts';

/** True when the walk placed the caller inside a herdr pane: a team seat or its children. */
export function insideTeamPane(caller: Caller): boolean {
  if (caller.kind === 'seat' || caller.kind === 'pane') return true;
  return caller.kind === 'unplaced' && /under herdr|in pane |herdr pane/.test(caller.reason);
}

/** The refusal sentence, one place, so send and messages read alike. */
export function clientPaneRefusal(caller: Caller): string {
  return `a client key is not used from inside a team pane; this call is ${describeCaller(caller)}. ` +
    'Run the client from outside herdr (the client\'s own shell), or turn on dev mode to lift this guard';
}

export type ClientPaneVerdict =
  | { ok: true; warning?: string }
  | { ok: false; why: string };

/** Whether this client invocation may go on. */
export function clientPaneGuard(
  io: Io,
  command: string,
  home: string = homedir(),
): ClientPaneVerdict {
  const caller = walkCaller(io);
  if (!insideTeamPane(caller)) return { ok: true };
  const why = clientPaneRefusal(caller);
  const lift = devModeOwnerLiftAtCwd(io, { command: command === 'client keygen' ? command : `${command} --client`, refusal: why, home });
  if (lift !== null && lift.lifted && lift.warning !== null) return { ok: true, warning: lift.warning };
  return { ok: false, why };
}
